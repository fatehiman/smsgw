# smsgw — small SMS gateway

An API gateway to **send and receive SMS** through any provider. Live at `https://smsgw.kimiasoft.ir`.

- One admin (`/mainadmin`), many **API tokens** (one per project).
- Provider-agnostic: a new provider is a new folder of files.
- Two provider types: **text** (any SMS text) and **template** (template ID + parameters).
- **Billing**: price per SMS part per token and provider, a balance and an allowed debt per token, payments as transactions.
- Per-token, per-caller-IP **rate limits** (default 20/min, 100/hour, 300/day, fixed windows).
- **Sending queue**: the API answers at once with our own message ID; a background worker sends, with retries.
- Receive SMS by **webhook** (we call you) or by **polling** an API endpoint.
- Node.js 22+ (runs on 24), PostgreSQL, one npm package (`pg`). No framework.

Docs: [API.md](API.md) (for callers) · [DEPLOY.md](DEPLOY.md) (server) · this file (design).

## Public surface

| Path | What |
|---|---|
| `/` | "Under construction" static page |
| `/api/v1/*` | JSON API, Bearer token |
| `/mainadmin` | Admin panel (one login) |
| `/hook/<provider>/<secret>` | Providers call this for received SMS and delivery reports |
| anything else | `404 Not Found` (answered by Apache, never reaches Node) |

## Admin panel

- **Providers**: add an instance of a driver, edit its settings, enable/disable, choose the **global default**.
  Template providers also have a **Templates** table (template ID, name, parameter names). There is no API for templates.
- **API tokens**: create (name, allowed providers with a **price per SMS part** each, default provider, **allowed debt**,
  incoming numbers, optional own limits), **rotate**, turn off, delete, manage **webhooks**. The token page has
  **Balance and payments**: the balance, a form to save a payment or a correction, and all transactions. A token is shown **once**; only its SHA-256 hash is stored.
- **Rate limits**: global defaults and the time zone offset that decides when "00:00" is.
- **Messages**: log of sent and received SMS.
- **Alerts**: low provider-balance alert. See below.
- **Blacklist**: numbers that sent `11` (no SMS goes to them until `12`) and the log of 11 / 12. See below.

## Sending queue (since 2026-11-08)

Code: `src/outbox.js`, called from `src/sms.js` and started in `src/server.js`.

- `POST /sms/send` only does the checks (token, provider, fields, blacklist, balance), holds the money, saves the
  SMS as `queued` and answers `201` with **our** `id`. It never waits for the provider (Mihan sometimes takes > 10 s).
- **One worker, no overlap.** A run starts every 10 s and sends due SMS one after another while it is inside a
  **9 s budget**. The budget is soft: a send that starts at 8.9 s and takes 20 s ends the run at ~29 s; the next run
  starts only after that. Never two runs, never two sends at the same time. A new SMS wakes an idle worker at once.
- **Order:** `next_at`, then `id`. An SMS is taken with `UPDATE … FOR UPDATE SKIP LOCKED` and marked `sending`.
- **Retry** only when the driver throws `ProviderError` with `retryable: true` (network error, timeout, HTTP 5xx,
  Mihan codes 5 / 8). Waits after try 1–5: 30 s, 2 min, 5 min, 15 min, 30 min → 6 tries in ~52 min. A waiting
  retry just has a later `next_at`, so it never blocks other SMS. Other errors fail at once.
  Not sent 60 min after it was queued → `failed`. Columns `messages.attempts`, `messages.next_at` (migration 4).
- **Duplicates.** A retry gets `msg.retry = true`. `mihan-sms` then sends with `check_duplicate=true`: if the first
  try reached Mihan (answer lost by a timeout), Mihan returns its ID and does not send again. Other drivers just send
  again (a rare duplicate is better than a lost OTP).
- Checked again just before the send: key not deleted, provider enabled, driver installed, number not blacklisted,
  template still there. If not → `failed`.
- **Money:** held when queued; given back when the SMS ends `failed`.
- **Webhook** `sms.status` on `sent` and on `failed`.
- **Stop / crash.** On SIGTERM the worker lets the running send finish, then the process exits. An SMS left in
  `sending` (crash) is queued again at start and sent as a retry.
- Admin: Dashboard shows "SMS in queue"; Messages shows tries and the next try time.
- Test a retry with the `mock-text` provider setting "Temporary failure if number contains".

## Low provider-balance alert (since 2026-11-08)

This is the credit of **our account at the SMS provider**, not the balance of an API key.

- After every SMS the provider accepts, the queue worker asks the provider for its balance, in the background.
  A driver can support this with an optional `async balance(ctx)` that returns `{ amount, remaining_sms? }`. Today only `mihan-sms` does (SOAP `accountInfo`).
  Other drivers are skipped. Only text providers can send the alert.
- If `amount < threshold`, one alert SMS (Persian text) goes to the alert number through the same provider.
  While the balance stays low it repeats at most every N hours. When the balance is above the threshold again, the next drop alerts at once.
  If the alert cannot be sent, it is tried again after the next SMS.
- Settings (admin page **Alerts**, table `settings`): `alert_phone` (default `09031238058`), `alert_threshold` (default `0` = **off**; the unit is the
  provider's balance unit), `alert_repeat_hours` (default 24). The page also shows the last known balance and last alert per provider, with a refresh button per provider that fetches the balance now (works even when alerts are off).
  State per provider is in `settings` too: `bal_<id>`, `alert_at_<id>`. No migration.
- The alert is sent straight through the driver: no billing, no blacklist check, no footer, not saved in `messages`.
- Code: `src/lowbalance.js`, test: `test/lowbalance.test.js`.

## Opt-out and the blacklist (fixed rules, since 2026-11-01)

These rules are written in the code (`src/blacklist.js`) and cannot be changed in the admin panel or per key.

- **Footer.** Every **text** SMS ends with a line break and `لغو11`. The gateway adds it (once); the stored message and
  the delivered SMS contain it. Template providers cannot get a footer (the provider owns the template text): the
  footer must be inside the template itself. Today only the text provider `mihan` exists.
- **11 = stop.** An incoming SMS whose text is `11` (also `۱۱`, or the footer `لغو11` typed back) puts the sender
  on the **blacklist**. The message is kept in the Messages log but belongs to **no key**: no inbox and no webhook of any
  project ever sees it (so it can never be taken for "I paid").
- **Blocked means blocked.** A send to a listed number, from any key and any project, is **refused**: HTTP `403`,
  error code `number_blacklisted`, and the message is saved as `failed`. The list uses the last 10 digits
  (`09121234567` = `+989121234567`).
- **12 = start again.** An incoming SMS `12` removes the sender from the list.
- **Logs.** Every `11` and `12` is written to `blacklist_log`; a log row is deleted after **1 year** (hourly job).
  The list itself stays until the number sends `12`.
- **Admin page: Blacklist** (`/mainadmin/blacklist`): blocked numbers, the 11 / 12 log, search by number. Read only.

## Billing (since 2026-11-02)

Code: `src/billing.js`. Money is in Toman (`IRT`), 2 decimals.

- **Price** of one SMS **part**, per token **and** provider (`token_providers.price`). Empty = that provider is free for
  that token: no charge and no balance check. So old tokens keep working until a price is set. `0` = free, but a token
  below its debt limit is still blocked.
- **Parts.** GSM-7 text: 160 / 153 per part. Anything else (Persian): 70 / 67 per part (UTF-16 units). The footer is
  counted, so every text SMS is UCS-2. Template SMS: the template's saved text ("Preview text" in the admin) with the
  values put in (`{{name}}`, `{name}` or `%name`); no saved text = 1 part.
- **Balance and allowed debt** on the token (`api_tokens.balance`, `credit_limit`, a positive number). A send is refused
  with `402 insufficient_balance` when `balance - cost < -credit_limit`. The message is saved as `failed`.
- **When we charge.** The cost is taken (one atomic `UPDATE`) when the SMS is queued. If the SMS ends `failed` in the
  queue, the money goes back and the `sms` transaction row is removed. So we charge only what the provider accepted.
  A later `failed` delivery report gives nothing back (the provider charges us anyway).
- **Transactions** (`transactions` table): `payment` (admin, > 0), `adjust` (admin, + or −, note required), `sms` (charge).
  They cannot be edited or deleted. `balance = SUM(amount)` is always true; "balance after" is a running sum.
  Deleting a token deletes its transactions too.
- API: `GET /balance`, `GET /transactions`, and `parts` / `cost` on every sent message. Admin → Messages shows them too.

## Rules worth knowing

**Default provider for a token** = the token's own default → else the global default (if the token may use it)
→ else the first provider in the token's list. Disabled providers are ignored.

**Type checks (also for the default provider).** A text provider rejects `template`/`params`
(`template_not_supported`). A template provider rejects `text` (`text_not_supported`), needs a known `template`
(`template_required`, `template_not_found`) and exactly the template's parameter names (`params_invalid`,
with `missing` / `unknown` lists).

**Rate limits.** Counted per token **and** per caller IP, in fixed calendar windows. Minute at second 0,
hour at the top of the hour, day at 00:00 in the configured time zone (default Tehran, +210 min) — the same
moment for all tokens. A token can override each limit (empty = global default, 0 = no limit).
Responses carry `X-RateLimit-*` headers; over the limit → `429` with `Retry-After`.

**Who gets a received SMS?** (1) the token whose *incoming numbers* contain the line it came to,
(2) else the token that last sent an SMS to that sender through the same provider, (3) else nobody
(still visible in admin → Messages).

**Webhooks.** `sms.received` and `sms.status`. JSON POST, header `X-SMSGW-Signature: sha256=<hmac>` over
`<X-SMSGW-Timestamp>.<body>` with the webhook secret. Retries after 10 s, 1 min, 5 min, 30 min, 2 h. Webhook URLs
must be public http(s) hosts (private/loopback addresses are refused).

**Client IP behind the CDN.** Apache (`mod_remoteip`) accepts `AR-Real-IP` only from ArvanCloud addresses and
passes the result to Node in `X-Gw-Client-IP`; Node trusts that header only from loopback.

## Layout

```
src/server.js          HTTP server, routing, background loops
src/api.js             public API routes
src/admin.js           admin panel (+ admin-ui.js: HTML/CSS helpers)
src/sms.js             provider choice + type validation + queueing
src/outbox.js          sending queue worker (retries, one run at a time)
src/billing.js         SMS parts, prices, balance, transactions
src/lowbalance.js      low provider-balance alert
src/inbound.js         /hook endpoint, who-owns-this-SMS logic, polling
src/webhooks.js        webhook queue, signing, retries, URL guard
src/ratelimit.js       fixed-window counters in PostgreSQL
src/db.js              pool + migrations (append to MIGRATIONS, never edit old ones)
src/providers/<name>/  one folder per driver (auto-loaded)
public/index.html      under-construction page
deploy/                systemd unit, Apache vhost, deploy script, Arvan IP updater, DB backup
test/unit.test.js      `npm test` (no DB needed)
test/smoke.js          end-to-end against a running gateway + empty throwaway DB
```

## Adding a provider

Create `src/providers/<driver-name>/index.js`. It is picked up on the next start; nothing else changes.

```js
const { ProviderError } = require('../_errors');
const { request } = require('../_http');          // fetch with timeout

module.exports = {
  driver: 'my-provider',            // unique id, same as the folder name
  label: 'My Provider (template)',  // shown in the admin
  type: 'template',                 // 'text' or 'template'
  settings: [                       // admin edits these; type: text|password|textarea|select
    { key: 'api_key', label: 'API key', type: 'password', required: true },
  ],

  // msg (text):     { to, text, retry }
  // msg (template): { to, template, params, paramList, retry }   paramList = values in template order
  // retry = true when an earlier try failed: avoid a duplicate if the provider can (see Sending queue).
  // Throw ProviderError(msg, { retryable: true }) for temporary errors; the queue tries again later.
  async send(ctx, msg) {            // ctx.settings = this provider's saved settings
    const r = await request('https://api.example.com/send', { method: 'POST', body: '...' });
    if (r.status !== 200) throw new ProviderError(`HTTP ${r.status}`);   // -> message becomes "failed"
    return { providerMessageId: r.json.id, status: 'sent' };
  },

  inbound: {                        // optional: received SMS and delivery reports
    // req = { method, query, body, headers, raw }. Return a list of events:
    //   { kind: 'sms', from, to, text, providerMessageId }
    //   { kind: 'status', providerMessageId, status: 'delivered'|'failed', error }
    parse(req, ctx) { return []; },
    // poll(ctx) -> { events, state }   for providers you must ask (called once a minute)
  },
};
```

Included drivers: `generic-http` (text) and `generic-http-template` (template) — connect most simple HTTP SMS APIs
from the admin panel with URL/body templates, no code; `kavenegar-lookup` (template); `mihan-sms` (MihanSMSCenter, text, SOAP; send, receive by push or pull, balance); `mock-text` and
`mock-template` (send nothing; for testing). Files starting with `_` in `src/providers/` are shared helpers.

## Development

```bash
cp .env.example .env     # fill DATABASE_URL, ADMIN_PASS_HASH (npm run hash -- "pw"), SESSION_SECRET
npm install
npm test                 # unit tests
npm start                # migrations run at start
# e2e on an EMPTY throwaway database, gateway started with ALLOW_PRIVATE_WEBHOOKS=1:
BASE=http://127.0.0.1:25465 ADMIN_PASS=... node test/smoke.js
```

`credentials.md` (git-ignored) holds the real passwords. The `reference-docs/` folder is for non-code files and is never deployed.
