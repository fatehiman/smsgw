'use strict';
// Outgoing SMS queue (since 2026-11-08). The API only checks and saves an SMS as 'queued' and answers at
// once with our own message id. This worker sends it in the background, so a slow provider never delays
// the API caller.
//
//  * One worker, one run at a time (no overlap, no parallel sends). A run starts every 10 s and sends
//    the due SMS one after another while it is still inside its 9 s budget. The budget is soft: a send
//    that starts at 8.9 s may take 20 s; the next run then starts right after this one ends.
//    A new SMS wakes an idle worker at once, so a single SMS is not kept waiting up to 10 s.
//  * Order: the SMS whose time has come first (next_at), then the oldest (id). A failed SMS gets a later
//    next_at, so it never blocks the others.
//  * Retry only temporary errors (ProviderError.retryable: network error, timeout, HTTP 5xx, provider
//    "try later" codes). Waits: 30 s, 2 min, 5 min, 15 min, 30 min = 6 tries in about 52 min.
//    Any other error fails the SMS at once. An SMS not sent 60 min after it was queued is failed.
//  * A retry gets msg.retry = true. A driver that can avoid a duplicate uses it (mihan-sms sends
//    check_duplicate=true: if the first try reached the provider, it returns that id and does not send
//    again). Other drivers just send again: a rare duplicate is better than a lost SMS.
//  * Money: reserved by the API when the SMS is queued (src/billing.js); given back if it ends 'failed'.
//  * Status changes 'sent' and 'failed' go to the key's sms.status webhooks.
const { q } = require('./db');
const providers = require('./providers');
const webhooks = require('./webhooks');
const blacklist = require('./blacklist');
const billing = require('./billing');
const lowbalance = require('./lowbalance');

const TICK_MS = 10000;
const BUDGET_MS = 9000;
const RETRY_SEC = [30, 120, 300, 900, 1800];
const MAX_TRIES = RETRY_SEC.length + 1;
const MAX_AGE_MIN = 60;
const SEND_TIMEOUT_MS = 45000; // safety net only; drivers have their own HTTP timeout (15 s)

/**
 * What to do after try number `attempts` failed. Pure (unit tested).
 * Returns { retry: true, nextAt } or { retry: false, reason }.
 */
function afterFailure(attempts, retryable, createdAtMs, nowMs) {
  if (!retryable) return { retry: false, reason: 'not a temporary error' };
  if (attempts >= MAX_TRIES) return { retry: false, reason: `${attempts} tries failed` };
  const nextAt = nowMs + RETRY_SEC[attempts - 1] * 1000;
  if (nextAt > createdAtMs + MAX_AGE_MIN * 60000) return { retry: false, reason: `not sent within ${MAX_AGE_MIN} min` };
  return { retry: true, nextAt };
}

async function notify(tokenId, id) {
  if (!tokenId) return;
  const sms = require('./sms'); // lazy: sms.js requires this file
  const m = await sms.getMessage(tokenId, id);
  if (m) await webhooks.enqueue(tokenId, 'sms.status', m);
}

async function fail(m, why) {
  if (m.cost != null && m.token_id) await billing.release(m.token_id, m.id).catch((e) => console.error('billing release:', e.message));
  await q(`UPDATE messages SET status='failed', error=$2, next_at=NULL, updated_at=now() WHERE id=$1`, [m.id, String(why).slice(0, 500)]);
  await notify(m.token_id, m.id).catch(() => {});
}

// SMS still waiting 60 min after they were queued (backlog, or the API stopped between save and charge).
async function expireOld() {
  const rows = (await q(
    `SELECT * FROM messages WHERE direction='out' AND status='queued' AND created_at < now() - make_interval(mins => $1)`,
    [MAX_AGE_MIN],
  )).rows;
  for (const m of rows) await fail(m, `expired: not sent within ${MAX_AGE_MIN} min after ${m.attempts} tr${m.attempts === 1 ? 'y' : 'ies'}${m.error ? ` (last error: ${m.error})` : ''}`);
}

// Takes the next due SMS and marks it 'sending' (SKIP LOCKED: never the same SMS twice).
async function claim() {
  return (await q(
    `UPDATE messages SET status='sending', attempts=attempts+1, updated_at=now()
     WHERE id = (SELECT id FROM messages WHERE direction='out' AND status='queued' AND next_at <= now()
                 ORDER BY next_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  )).rows[0] || null;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(`no answer after ${ms / 1000} s`), { retryable: true, code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function processOne(m) {
  if (!m.token_id) return fail(m, 'the API key was deleted before the SMS was sent');
  const provider = (await q('SELECT * FROM providers WHERE id=$1', [m.provider_id])).rows[0];
  if (!provider || !provider.enabled) return fail(m, 'the provider was disabled or deleted before the SMS was sent');
  const driver = providers.get(provider.driver);
  if (!driver) return fail(m, `the driver of provider "${provider.slug}" is not installed`);
  // checked again: the number may have sent 11 while the SMS waited
  if (await blacklist.find(m.peer)) return fail(m, 'number_blacklisted: the recipient sent 11 (opt-out) before the SMS was sent');

  let paramList = [];
  if (m.template_code) {
    const tpl = (await q('SELECT param_names FROM templates WHERE provider_id=$1 AND code=$2', [provider.id, m.template_code])).rows[0];
    if (!tpl) return fail(m, `template "${m.template_code}" was deleted before the SMS was sent`);
    paramList = tpl.param_names.map((n) => String(m.params?.[n] ?? ''));
  }
  const msg = {
    to: m.peer, text: m.body, template: m.template_code, params: m.params, paramList, parts: m.parts,
    id: m.id, attempt: m.attempts, retry: m.attempts > 1,
  };

  try {
    const r = await withTimeout(driver.send({ settings: provider.settings, provider }, msg), SEND_TIMEOUT_MS);
    await q(
      `UPDATE messages SET status=$2, provider_message_id=$3, error=NULL, next_at=NULL, updated_at=now() WHERE id=$1`,
      [m.id, r.status || 'sent', r.providerMessageId != null ? String(r.providerMessageId) : null],
    );
    await notify(m.token_id, m.id).catch(() => {});
    lowbalance.check(provider, driver).catch(() => {}); // background: alert if our credit at the provider is low
  } catch (e) {
    const err = `${e.code || 'provider_error'}: ${e.message}`;
    const d = afterFailure(m.attempts, e.retryable === true, new Date(m.created_at).getTime(), Date.now());
    if (d.retry) {
      await q(
        `UPDATE messages SET status='queued', error=$2, next_at=$3, updated_at=now() WHERE id=$1`,
        [m.id, `try ${m.attempts}/${MAX_TRIES} failed, will try again: ${err}`.slice(0, 500), new Date(d.nextAt)],
      );
    } else {
      await fail(m, `${err} (${d.reason})`);
    }
  }
}

// ---- the worker loop
let running = null; // promise of the current run
let timer = null;
let stopped = true;

function schedule(ms) {
  clearTimeout(timer);
  if (!stopped) timer = setTimeout(run, ms);
}

async function run() {
  if (running || stopped) return running;
  clearTimeout(timer);
  const started = Date.now();
  running = (async () => {
    try {
      await expireOld();
      while (!stopped && Date.now() - started < BUDGET_MS) {
        const m = await claim();
        if (!m) break;
        try {
          await processOne(m);
        } catch (e) { // DB error etc.: leave it to the 'sending' reset on the next start
          console.error(`outbox: message ${m.id}: ${e.message}`);
          break;
        }
      }
    } catch (e) {
      console.error(`outbox: ${e.message}`);
    }
  })();
  try { await running; } finally {
    running = null;
    schedule(Math.max(0, started + TICK_MS - Date.now()));
  }
  return null;
}

/** Called after an SMS is queued: start a run now if the worker is idle. */
function wake() {
  if (!stopped && !running) setImmediate(() => run().catch(() => {}));
}

async function start() {
  // 'sending' at start = the service stopped during a send. Try again (as a retry: no duplicate where the
  // driver can prevent it).
  const r = await q(`UPDATE messages SET status='queued', next_at=now(), updated_at=now() WHERE direction='out' AND status='sending'`);
  if (r.rowCount) console.log(`outbox: ${r.rowCount} interrupted SMS queued again`);
  stopped = false;
  schedule(0);
}

/** Stop starting new sends; resolves when the current send is done. */
async function stop() {
  stopped = true;
  clearTimeout(timer);
  if (running) await running.catch(() => {});
}

module.exports = { TICK_MS, BUDGET_MS, RETRY_SEC, MAX_TRIES, MAX_AGE_MIN, afterFailure, start, stop, wake, run };
