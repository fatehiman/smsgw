'use strict';
// Provider -> gateway: /hook/<provider slug>/<provider inbound secret>
// Stores received SMS and delivery reports, then queues the token's webhooks.
const { q } = require('./db');
const providers = require('./providers');
const sms = require('./sms');
const webhooks = require('./webhooks');
const { ApiError, readBody, parseBody, safeEqual, digitsTail } = require('./util');

// Which API token owns an incoming SMS?
//  1. a token whose "inbound numbers" contains the line the SMS came to,
//  2. else the token that last sent an SMS to this sender through the same provider,
//  3. else nobody (admin can still see it in Messages).
async function attribute(provider, from, to) {
  if (to) {
    const t = digitsTail(to);
    const rows = (await q(
      `SELECT t.id, t.inbound_numbers FROM api_tokens t JOIN token_providers tp ON tp.token_id = t.id
       WHERE t.enabled AND tp.provider_id = $1 AND cardinality(t.inbound_numbers) > 0`, [provider.id],
    )).rows;
    const hit = rows.find((r) => r.inbound_numbers.some((n) => digitsTail(n) === t));
    if (hit) return hit.id;
  }
  const last = (await q(
    `SELECT m.token_id FROM messages m JOIN api_tokens t ON t.id = m.token_id
     WHERE m.direction='out' AND m.provider_id=$1 AND t.enabled
       AND right(regexp_replace(m.peer, '\\D', '', 'g'), 10) = $2
     ORDER BY m.id DESC LIMIT 1`, [provider.id, digitsTail(from)],
  )).rows[0];
  return last?.token_id ?? null;
}

async function storeEvents(provider, events) {
  let stored = 0;
  for (const ev of events) {
    if (ev.kind === 'sms') {
      const tokenId = await attribute(provider, ev.from, ev.to);
      const row = (await q(
        `INSERT INTO messages (token_id, provider_id, direction, peer, line, body, status, provider_message_id)
         VALUES ($1,$2,'in',$3,$4,$5,'received',$6) RETURNING id`,
        [tokenId, provider.id, ev.from, ev.to ?? null, ev.text, ev.providerMessageId ?? null],
      )).rows[0];
      stored++;
      if (tokenId) {
        const m = await sms.getMessage(tokenId, row.id);
        await webhooks.enqueue(tokenId, 'sms.received', m);
      }
    } else if (ev.kind === 'status' && ev.providerMessageId) {
      const r = (await q(
        `UPDATE messages SET status=$3, error=$4, updated_at=now()
         WHERE provider_id=$1 AND provider_message_id=$2 AND direction='out' RETURNING id, token_id`,
        [provider.id, String(ev.providerMessageId), ev.status, ev.error ?? null],
      )).rows[0];
      if (r?.token_id) await webhooks.enqueue(r.token_id, 'sms.status', await sms.getMessage(r.token_id, r.id));
    }
  }
  return stored;
}

async function handle(req, res, url, send) {
  const [, , slug, secret] = url.pathname.split('/'); // '', 'hook', slug, secret
  const provider = slug ? (await q('SELECT * FROM providers WHERE slug=$1 AND enabled', [slug])).rows[0] : null;
  if (!provider || !secret || !safeEqual(secret, provider.inbound_secret)) return send(404);
  const driver = providers.get(provider.driver);
  if (!driver?.inbound?.parse) return send(404);

  const raw = ['GET', 'HEAD'].includes(req.method) ? '' : await readBody(req);
  let body = {};
  try { body = parseBody(raw, req.headers['content-type']); } catch (e) {
    if (e instanceof ApiError) return send(400, 'Bad request');
    throw e;
  }
  const query = Object.fromEntries(url.searchParams);
  const events = await driver.inbound.parse({ method: req.method, query, body, headers: req.headers, raw }, { settings: provider.settings, provider });
  await storeEvents(provider, events || []);
  return send(200, 'OK');
}

// Providers whose driver can poll (driver.inbound.poll) are asked every minute.
async function pollAll() {
  const rows = (await q('SELECT * FROM providers WHERE enabled')).rows;
  for (const p of rows) {
    const driver = providers.get(p.driver);
    if (!driver?.inbound?.poll) continue;
    try {
      const { events, state } = await driver.inbound.poll({ settings: p.settings, provider: p, state: p.state });
      await storeEvents(p, events || []);
      if (state) await q('UPDATE providers SET state=$2 WHERE id=$1', [p.id, state]);
    } catch (e) {
      console.error(`poll ${p.slug}: ${e.message}`);
    }
  }
}

module.exports = { handle, pollAll, storeEvents };
