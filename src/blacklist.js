'use strict';
// SMS opt-out (blacklist). FIXED RULES, not settings (owner's decision 2026-11-01):
//  * every text SMS ends with a line break + "لغو11" (the footer);
//  * an incoming SMS "11" puts its sender on the blacklist: from then on NO SMS is sent to that
//    number from ANY key / project (the send fails with "number_blacklisted");
//  * an incoming SMS "12" takes the sender off the list again;
//  * every 11 / 12 is logged in blacklist_log, and a log row is deleted after 1 year.
// Numbers are compared by their last 10 digits (09121234567 = +989121234567 = 989121234567).
const { q } = require('./db');
const { digitsTail } = require('./util');

const FOOTER = 'لغو11';
const LOG_KEEP_DAYS = 365;

// Persian / Arabic-Indic digits -> ASCII, so «۱۱» works like 11
const toAscii = (s) => String(s ?? '')
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/** 'add' (the text is 11, or the footer «لغو11» typed back), 'remove' (12) or null. */
function parseCommand(text) {
  const t = toAscii(text).replace(/[\s‌‎‏.]+/g, '');
  if (t === '11' || t === FOOTER) return 'add';
  if (t === '12') return 'remove';
  return null;
}

/** The text with the footer after a line break (once). */
function withFooter(text) {
  const t = String(text).replace(/\s+$/, '');
  return t.endsWith(`\n${FOOTER}`) || t === FOOTER ? t : `${t}\n${FOOTER}`;
}

async function find(number) {
  const key = digitsTail(number);
  if (key.length < 5) return null;
  return (await q('SELECT * FROM blacklist WHERE phone = $1', [key])).rows[0] || null;
}

/** An incoming 11 / 12 from `number`: change the list and write the log row. */
async function apply(action, number, { providerId = null, line = null, messageId = null } = {}) {
  const key = digitsTail(number);
  if (key.length < 5) return;
  if (action === 'add') {
    await q(`INSERT INTO blacklist (phone, number, provider_id, line, message_id) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (phone) DO NOTHING`, [key, number, providerId, line, messageId]);
  } else {
    await q('DELETE FROM blacklist WHERE phone = $1', [key]);
  }
  await q(`INSERT INTO blacklist_log (phone, number, action, provider_id, line, message_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [key, number, action, providerId, line, messageId]);
}

async function cleanup() {
  await q(`DELETE FROM blacklist_log WHERE at < now() - interval '${LOG_KEEP_DAYS} days'`);
}

module.exports = { FOOTER, LOG_KEEP_DAYS, parseCommand, withFooter, find, apply, cleanup };
