'use strict';
const { q } = require('./db');
const settings = require('./settings');

// Fixed calendar windows in the gateway's local time zone (tz_offset_min).
// "d" resets at local 00:00 for every token, "h" at the top of the local hour, "m" at second 0.
const KINDS = [['m', 60], ['h', 3600], ['d', 86400]];
const NAMES = { m: 'minute', h: 'hour', d: 'day' };

function windowStart(nowSec, len, offsetMin) {
  const off = offsetMin * 60;
  return Math.floor((nowSec + off) / len) * len - off;
}

// Per-token override wins; null falls back to the global default; 0 means unlimited.
function effectiveLimits(token, defaults) {
  const pick = (own, def) => (own === null || own === undefined ? def : own);
  return {
    m: pick(token.limit_minute, defaults.minute),
    h: pick(token.limit_hour, defaults.hour),
    d: pick(token.limit_day, defaults.day),
  };
}

async function hit(token, ip, nowMs = Date.now()) {
  const defaults = await settings.getLimits();
  const limits = effectiveLimits(token, defaults);
  const nowSec = Math.floor(nowMs / 1000);
  const active = KINDS.filter(([k]) => limits[k] > 0);
  if (!active.length) return { allowed: true, headers: {}, limits };

  const starts = active.map(([, len]) => windowStart(nowSec, len, defaults.tzOffsetMin));
  const rows = (await q(
    `INSERT INTO rate_counters (token_id, ip, kind, window_start, count)
     SELECT $1, $2, k, w, 1 FROM unnest($3::text[], $4::bigint[]) AS t(k, w)
     ON CONFLICT (token_id, ip, kind, window_start) DO UPDATE SET count = rate_counters.count + 1
     RETURNING kind, count`,
    [token.id, ip, active.map(([k]) => k), starts],
  )).rows;

  const headers = {};
  let allowed = true;
  let retryAfter = 0;
  let tight = null;
  for (let i = 0; i < active.length; i++) {
    const [k, len] = active[i];
    const used = rows.find((r) => r.kind === k).count;
    const remaining = Math.max(0, limits[k] - used);
    const reset = starts[i] + len;
    headers[`X-RateLimit-Limit-${NAMES[k]}`] = String(limits[k]);
    headers[`X-RateLimit-Remaining-${NAMES[k]}`] = String(remaining);
    if (used > limits[k]) {
      allowed = false;
      retryAfter = Math.max(retryAfter, reset - nowSec);
    }
    if (!tight || remaining < tight.remaining) tight = { k, remaining, reset, limit: limits[k] };
  }
  headers['X-RateLimit-Limit'] = String(tight.limit);
  headers['X-RateLimit-Remaining'] = String(tight.remaining);
  headers['X-RateLimit-Reset'] = String(tight.reset);
  headers['X-RateLimit-Window'] = NAMES[tight.k];
  if (!allowed) headers['Retry-After'] = String(Math.max(1, retryAfter));
  return { allowed, retryAfter, headers, limits };
}

// Read-only view for GET /usage (does not count as a hit by itself).
async function usage(token, ip, nowMs = Date.now()) {
  const defaults = await settings.getLimits();
  const limits = effectiveLimits(token, defaults);
  const nowSec = Math.floor(nowMs / 1000);
  const out = {};
  for (const [k, len] of KINDS) {
    const start = windowStart(nowSec, len, defaults.tzOffsetMin);
    const r = await q(
      'SELECT count FROM rate_counters WHERE token_id=$1 AND ip=$2 AND kind=$3 AND window_start=$4',
      [token.id, ip, k, start],
    );
    out[NAMES[k]] = {
      limit: limits[k],
      used: r.rows[0]?.count ?? 0,
      resets_at: new Date((start + len) * 1000).toISOString(),
    };
  }
  return out;
}

async function cleanup(nowMs = Date.now()) {
  await q('DELETE FROM rate_counters WHERE window_start < $1', [Math.floor(nowMs / 1000) - 2 * 86400]);
}

module.exports = { hit, usage, cleanup, windowStart, effectiveLimits, KINDS };
