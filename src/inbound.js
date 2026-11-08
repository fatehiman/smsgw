'use strict';
// Provider -> gateway: /hook/<provider slug>/<provider inbound secret>
// Stores received SMS and delivery reports, then queues the token's webhooks.
const { q } = require('./db');
const providers = require('./providers');
const sms = require('./sms');
const webhooks = require('./webhooks');
const blacklist = require('./blacklist');
const settings = require('./settings');
const { ApiError, readBody, parseBody, safeEqual, digitsTail } = require('./util');

// Which API keys get an incoming SMS? (since 2026-11-08 an SMS can belong to SEVERAL keys)
//  1. the keys whose "incoming numbers" contain the line the SMS came to (a line of its own),
//  2. else EVERY key that sent an SMS (not failed) to this sender through the same provider within its window:
//     api_tokens.inbound_hours, empty = the global setting inbound_hours (default 48). A project only gets the
//     answers of people it wrote to.
//  3. else nobody (admin can still see it in Messages).
// Returned latest sender first; the first one is also messages.token_id (the "main" key, for the admin list).
const PEER_TAIL = "right(regexp_replace(m.peer, '\\D', '', 'g'), 10)";

async function recipients(provider, from, to) {
  if (to) {
    const t = digitsTail(to);
    const rows = (await q(
      `SELECT t.id, t.inbound_numbers FROM api_tokens t JOIN token_providers tp ON tp.token_id = t.id
       WHERE t.enabled AND tp.provider_id = $1 AND cardinality(t.inbound_numbers) > 0 ORDER BY t.id`, [provider.id],
    )).rows;
    const hits = rows.filter((r) => r.inbound_numbers.some((n) => digitsTail(n) === t)).map((r) => r.id);
    if (hits.length) return hits;
  }
  const hours = Number((await settings.all()).inbound_hours) || 48;
  return (await q(
    `SELECT m.token_id, max(m.id) AS last FROM messages m JOIN api_tokens t ON t.id = m.token_id
     WHERE m.direction='out' AND m.provider_id=$1 AND t.enabled AND m.status <> 'failed'
       AND ${PEER_TAIL} = $2
       AND m.created_at > now() - make_interval(hours => COALESCE(t.inbound_hours, $3))
     GROUP BY m.token_id ORDER BY last DESC`, [provider.id, digitsTail(from), hours],
  )).rows.map((r) => r.token_id);
}

// The same SMS can come twice: by push (/hook, no provider id) and by the pull (with an id), or again from the
// pull after a crash. -> true when it is already stored (a push row gets the pull's id).
const SAME_SECONDS = 90;
async function alreadyStored(provider, ev) {
  const id = ev.providerMessageId != null ? String(ev.providerMessageId) : null;
  if (id && (await q(
    `SELECT 1 FROM messages WHERE provider_id=$1 AND direction='in' AND provider_message_id=$2 LIMIT 1`, [provider.id, id],
  )).rows.length) return true;
  if (!Number.isFinite(ev.time)) return false;
  const same = (await q(
    `SELECT m.id, m.provider_message_id FROM messages m WHERE m.provider_id=$1 AND m.direction='in' AND ${PEER_TAIL} = $2
       AND m.body = $3 AND m.provider_time BETWEEN $4::bigint - ${SAME_SECONDS} AND $4::bigint + ${SAME_SECONDS}
       AND ($5::text IS NULL OR m.provider_message_id IS NULL)
     ORDER BY m.id LIMIT 1`, [provider.id, digitsTail(ev.from), ev.text, Math.round(ev.time), id],
  )).rows[0];
  if (!same) return false;
  if (id && !same.provider_message_id) await q('UPDATE messages SET provider_message_id=$2 WHERE id=$1', [same.id, id]);
  return true;
}

async function storeEvents(provider, events) {
  let stored = 0;
  for (const ev of events) {
    if (ev.kind === 'sms') {
      if (await alreadyStored(provider, ev)) continue;
      const time = Number.isFinite(ev.time) ? Math.round(ev.time) : null;
      // 11 / 12 are commands to the gateway (blacklist), not messages for a project: kept in the log
      // (Messages) with no key, so no key's inbox or webhook ever sees them
      const cmd = blacklist.parseCommand(ev.text);
      if (cmd) {
        const cmdRow = (await q(
          `INSERT INTO messages (token_id, provider_id, direction, peer, line, body, status, provider_message_id, provider_time, read_at)
           VALUES (NULL,$1,'in',$2,$3,$4,'received',$5,$6, now()) RETURNING id`,
          [provider.id, ev.from, ev.to ?? null, ev.text, ev.providerMessageId ?? null, time],
        )).rows[0];
        await blacklist.apply(cmd, ev.from, { providerId: provider.id, line: ev.to ?? null, messageId: cmdRow.id });
        stored++;
        continue;
      }
      const keys = await recipients(provider, ev.from, ev.to);
      const row = (await q(
        `INSERT INTO messages (token_id, provider_id, direction, peer, line, body, status, provider_message_id, provider_time)
         VALUES ($1,$2,'in',$3,$4,$5,'received',$6,$7) RETURNING id`,
        [keys[0] ?? null, provider.id, ev.from, ev.to ?? null, ev.text, ev.providerMessageId ?? null, time],
      )).rows[0];
      stored++;
      for (const tokenId of keys) {
        await q('INSERT INTO inbox (token_id, message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tokenId, row.id]);
        await webhooks.enqueue(tokenId, 'sms.received', await sms.getInboxMessage(tokenId, row.id));
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

module.exports = { handle, pollAll, storeEvents, recipients };
