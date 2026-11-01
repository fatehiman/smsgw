'use strict';
const { q } = require('./db');

let cache = null;
let cacheAt = 0;

async function all() {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  const rows = (await q('SELECT key, value FROM settings')).rows;
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

async function getLimits() {
  const s = await all();
  return {
    minute: Number(s.limit_minute ?? 20),
    hour: Number(s.limit_hour ?? 100),
    day: Number(s.limit_day ?? 300),
    tzOffsetMin: Number(s.tz_offset_min ?? 210),
  };
}

async function set(key, value) {
  await q(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)],
  );
  cache = null;
}

module.exports = { all, getLimits, set };
