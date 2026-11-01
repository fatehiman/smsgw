'use strict';
const dns = require('dns').promises;
const net = require('net');
const { q } = require('./db');
const config = require('./config');
const { hmac } = require('./util');

const EVENTS = ['sms.received', 'sms.status'];
const BACKOFF_SEC = [10, 60, 300, 1800, 7200]; // then give up (6 attempts)

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
    || (s.startsWith('::ffff:') && isPrivateIp(s.slice(7)));
}

// Webhook URLs must be http(s) and must not point at private/loopback addresses (SSRF guard).
function checkUrlSyntax(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'URL is not valid'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'URL must start with http:// or https://';
  if (u.username || u.password) return 'URL must not contain a user name or password';
  return null;
}

async function assertPublicHost(raw) {
  if (config.allowPrivateWebhooks) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('Webhook host resolves to a private address');
}

async function enqueue(tokenId, event, data) {
  const hooks = (await q(
    'SELECT id FROM webhooks WHERE token_id=$1 AND enabled AND $2 = ANY(events)', [tokenId, event],
  )).rows;
  const payload = { event, created_at: new Date().toISOString(), data };
  for (const h of hooks) {
    await q('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,$2,$3)', [h.id, event, payload]);
  }
}

async function deliver(hook, payload) {
  await assertPublicHost(hook.url);
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(hook.url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'smsgw-webhook/1',
      'X-SMSGW-Event': payload.event,
      'X-SMSGW-Timestamp': ts,
      'X-SMSGW-Signature': `sha256=${hmac(hook.secret, `${ts}.${body}`)}`,
    },
    body,
  });
  return res.status;
}

let busy = false;
async function processDue() {
  if (busy) return;
  busy = true;
  try {
    const due = (await q(
      `SELECT d.*, w.url, w.secret, w.enabled FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status='pending' AND d.next_at <= now() ORDER BY d.next_at LIMIT 20`,
    )).rows;
    for (const d of due) {
      let code = null;
      let err = null;
      try {
        code = await deliver(d, d.payload);
        if (code < 200 || code >= 300) err = `HTTP ${code}`;
      } catch (e) {
        err = e.cause?.code || e.message;
      }
      const attempts = d.attempts + 1;
      if (!err) {
        await q(`UPDATE webhook_deliveries SET status='ok', attempts=$2, last_code=$3, last_error=NULL, done_at=now() WHERE id=$1`, [d.id, attempts, code]);
      } else if (attempts > BACKOFF_SEC.length) {
        await q(`UPDATE webhook_deliveries SET status='failed', attempts=$2, last_code=$3, last_error=$4, done_at=now() WHERE id=$1`, [d.id, attempts, code, err]);
      } else {
        await q(
          `UPDATE webhook_deliveries SET attempts=$2, last_code=$3, last_error=$4, next_at = now() + make_interval(secs => $5) WHERE id=$1`,
          [d.id, attempts, code, err, BACKOFF_SEC[attempts - 1]],
        );
      }
    }
  } finally {
    busy = false;
  }
}

async function cleanup() {
  await q(`DELETE FROM webhook_deliveries WHERE status <> 'pending' AND done_at < now() - interval '14 days'`);
}

module.exports = { EVENTS, enqueue, processDue, cleanup, checkUrlSyntax, assertPublicHost, isPrivateIp, deliver };
