'use strict';
// Billing (since 2026-11-02). Money is in Toman (IRT), 2 decimals.
//  * price per SMS PART, per key AND provider: token_providers.price. NULL = that provider is free for
//    that key (no charge, no balance check). 0 = free, but the balance check still runs.
//  * api_tokens.balance and api_tokens.credit_limit (the allowed debt, a positive number):
//    a send is refused (402 insufficient_balance) if balance - cost would go below -credit_limit.
//  * every change of a balance is a row in `transactions`, so balance = SUM(transactions.amount).
//    kinds: 'payment' (admin, > 0), 'adjust' (admin, + or -), 'sms' (one charged SMS, < 0).
//  * an SMS is charged when the provider ACCEPTS it. The money is reserved before the send and given
//    back (the 'sms' row is removed) if the provider refuses it. A later "failed" delivery report
//    does not give money back (the provider charges us anyway).
const { q, tx } = require('./db');

const CURRENCY = 'IRT';

// GSM 03.38: basic table (1 septet) and extension table (2 septets: escape + char)
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';

/** SMS parts of a text: GSM-7 160 / 153 per part, else UCS-2 70 / 67 (UTF-16 units). Persian is UCS-2. */
function countParts(text) {
  const s = String(text ?? '');
  let septets = 0;
  for (const ch of s) {
    if (GSM7.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;
    else return s.length <= 70 ? 1 : Math.ceil(s.length / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

/** Template body with the values put in: {{name}}, {name} and %name are replaced. */
function fillTemplate(body, params) {
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}|%(\w+)/g, (all, a, b, c) => {
    const k = a || b || c;
    return Object.prototype.hasOwnProperty.call(params || {}, k) ? String(params[k]) : all;
  });
}

/** Parts of a template SMS: counted from the admin's template body; no body = 1 part. */
const templateParts = (body, params) => (String(body || '').trim() ? countParts(fillTemplate(body, params)) : 1);

const round2 = (n) => Math.round(n * 100) / 100;

/** Price per part for this key + provider, or null (free, not billed). */
async function priceFor(tokenId, providerId) {
  const r = (await q('SELECT price FROM token_providers WHERE token_id=$1 AND provider_id=$2', [tokenId, providerId])).rows[0];
  return r?.price ?? null;
}

/**
 * Takes the cost of one SMS from the balance (one atomic UPDATE, safe for parallel sends).
 * Returns { cost, balance } or null when the balance is not enough.
 */
async function reserve(tokenId, messageId, parts, price) {
  const cost = round2(parts * price);
  return tx(async (c) => {
    const r = (await c.query(
      'UPDATE api_tokens SET balance = balance - $2 WHERE id=$1 AND balance - $2 >= -credit_limit RETURNING balance',
      [tokenId, cost],
    )).rows[0];
    if (!r) return null;
    if (cost > 0) {
      await c.query(
        `INSERT INTO transactions (token_id, kind, amount, message_id, parts, unit_price) VALUES ($1,'sms',$2,$3,$4,$5)`,
        [tokenId, -cost, messageId, parts, price],
      );
    }
    await c.query('UPDATE messages SET cost=$2 WHERE id=$1', [messageId, cost]);
    return { cost, balance: r.balance };
  });
}

/** The provider refused the SMS: give the reserved money back. */
async function release(tokenId, messageId) {
  await tx(async (c) => {
    const t = (await c.query(`DELETE FROM transactions WHERE message_id=$1 AND kind='sms' RETURNING amount`, [messageId])).rows[0];
    if (t) await c.query('UPDATE api_tokens SET balance = balance - $2 WHERE id=$1', [tokenId, t.amount]);
    await c.query('UPDATE messages SET cost=NULL WHERE id=$1', [messageId]);
  });
}

/** Admin: a payment (amount > 0) or a correction (+ or -). Returns the new balance. */
async function addTransaction(tokenId, kind, amount, note) {
  return tx(async (c) => {
    await c.query('INSERT INTO transactions (token_id, kind, amount, note) VALUES ($1,$2,$3,$4)', [tokenId, kind, amount, note]);
    return (await c.query('UPDATE api_tokens SET balance = balance + $2 WHERE id=$1 RETURNING balance', [tokenId, amount])).rows[0].balance;
  });
}

/** Newest first, with the balance after each row (running sum). */
async function history(tokenId, { limit = 100, beforeId = null } = {}) {
  return (await q(
    `SELECT * FROM (SELECT t.*, SUM(t.amount) OVER (ORDER BY t.id) AS balance_after FROM transactions t WHERE t.token_id=$1) x
     WHERE $2::bigint IS NULL OR x.id < $2 ORDER BY x.id DESC LIMIT $3`,
    [tokenId, beforeId, limit],
  )).rows;
}

/** Balance view for the API (GET /balance, GET /me). */
async function summary(token) {
  const t = (await q('SELECT balance, credit_limit FROM api_tokens WHERE id=$1', [token.id])).rows[0];
  const prices = (await q(
    `SELECT p.slug, tp.price FROM token_providers tp JOIN providers p ON p.id=tp.provider_id
     WHERE tp.token_id=$1 AND p.enabled ORDER BY tp.position, p.id`, [token.id],
  )).rows;
  return {
    currency: CURRENCY,
    balance: t.balance,
    allowed_debt: t.credit_limit,
    available: round2(t.balance + t.credit_limit),
    prices: prices.map((r) => ({ provider: r.slug, price_per_part: r.price })),
  };
}

const fmtMoney = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

module.exports = {
  CURRENCY, countParts, fillTemplate, templateParts, round2, priceFor, reserve, release, addTransaction, history, summary, fmtMoney,
};
