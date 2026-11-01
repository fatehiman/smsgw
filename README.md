# smsgw — small SMS gateway

An API gateway to **send and receive SMS** through any provider. Live at `https://smsgw.kimiasoft.ir`.

- One admin (`/mainadmin`), many **API tokens** (one per project).
- Provider-agnostic: a new provider is a new folder of files.
- Two provider types: **text** (any SMS text) and **template** (template ID + parameters).
- Per-token, per-caller-IP **rate limits** (default 20/min, 100/hour, 300/day, fixed windows).
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
- **API tokens**: create (name, allowed providers, default provider, incoming numbers, optional own limits),
  **rotate**, turn off, delete, manage **webhooks**. A token is shown **once**; only its SHA-256 hash is stored.
- **Rate limits**: global defaults and the time zone offset that decides when "00:00" is.
- **Messages**: log of sent and received SMS.

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
src/sms.js             provider choice + type validation + sending
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

  // msg (text):     { to, text }
  // msg (template): { to, template, params, paramList }   paramList = values in template order
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
from the admin panel with URL/body templates, no code; `kavenegar-lookup` (template); `mock-text` and
`mock-template` (send nothing; for testing). Files starting with `_` in `src/providers/` are shared helpers.

## Development

```bash
cp .env.example .env     # fill DATABASE_URL, ADMIN_PASS_HASH (npm run hash -- "pw"), SESSION_SECRET
npm install
npm test                 # unit tests
npm start                # migrations run at start
# e2e on an EMPTY throwaway database, gateway started with ALLOW_PRIVATE_WEBHOOKS=1:
BASE=http://127.0.0.1:25464 ADMIN_PASS=... node test/smoke.js
```

`credentials.md` (git-ignored) holds the real passwords. The `reference-docs/` folder is for non-code files and is never deployed.
