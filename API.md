# smsgw API

Base URL: `https://smsgw.kimiasoft.ir/api/v1`

Send your token in every request: `Authorization: Bearer <token>` (or header `X-API-Key`).
Tokens are made by the admin. Bodies are JSON (`Content-Type: application/json`).

Success: `{"ok": true, ...}`. Error: `{"ok": false, "error": {"code": "...", "message": "...", "details": {...}}}`.

## Rate limits

Per token **and per caller IP**. Defaults: 20 / minute, 100 / hour, 300 / day (the admin can change them, also per token).
Windows are fixed: minute and hour reset on the clock, day resets at 00:00 Tehran time.
Every response has `X-RateLimit-Limit`, `-Remaining`, `-Reset` (unix time), `-Window` (the tightest window)
and `X-RateLimit-Limit-<minute|hour|day>` / `X-RateLimit-Remaining-<...>`.
Over the limit: HTTP `429`, code `rate_limited`, header `Retry-After` (seconds).
Many wrong tokens from one IP also give `429` (`too_many_failures`).

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/me` | Key name, allowed providers, effective default provider, `balance` (same as `/balance`) |
| GET | `/balance` | Balance, allowed debt, what you can still spend, price per SMS part of each provider |
| GET | `/transactions` | Payments and SMS charges, newest first. `limit` (≤200), `before_id` |
| GET | `/usage` | Your limits and how much this IP has used |
| GET | `/providers` | Allowed providers: `type` (`text`/`template`), `is_default`, templates |
| GET | `/providers/{slug}/templates` | Templates of a template provider |
| POST | `/sms/send` (alias `POST /sms`) | Send an SMS |
| GET | `/sms` | Sent messages. `limit` (≤200), `before_id`, `status` |
| GET | `/sms/{id}` | One sent message and its status |
| GET | `/inbox` | Received SMS. `limit`, `after_id`, `unread=1`, `ack=1` (mark returned ones as read) |
| POST | `/inbox/ack` | Mark as read: `{"ids":[1,2]}` or `{"up_to_id":10}` |
| GET | `/webhooks` | Your webhooks |
| POST | `/webhooks` | Create. Body `{"url":"https://...","events":["sms.received","sms.status"]}`. The reply includes the signing `secret` (only here) |
| GET / PATCH / DELETE | `/webhooks/{id}` | Read, change (`url`, `events`, `enabled`), delete |
| POST | `/webhooks/{id}/test` | Send a `ping` now and report the HTTP status |

Templates are managed by the admin only; there is no API to create them.

## Sending

The provider decides what you must send. Ask `GET /providers` once and cache the result.

**Text provider**

```bash
curl -X POST https://smsgw.kimiasoft.ir/api/v1/sms/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"09121234567","text":"Hello"}'
```

**Template provider** — send the template ID and exactly the parameters of that template:

```bash
curl -X POST https://smsgw.kimiasoft.ir/api/v1/sms/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"09121234567","template":"verify","params":{"code":"4821","minutes":"5"}}'
```

| Field | Notes |
|---|---|
| `to` | Phone number, digits with optional leading `+` (5–20 digits). Spaces and dashes are removed. |
| `text` | Text providers only. Max 2000 characters. |
| `template`, `params` | Template providers only. `params` keys must match the template exactly. Values: string or number. |
| `provider` | Optional provider short name. Leave out to use your key's default provider. |
| `reference` | Optional string (≤100), returned with the message. Use it as your own ID. |

Reply `201`:

```json
{"ok":true,"message":{"id":42,"direction":"out","provider":"txt","to":"09121234567","text":"Hello",
 "status":"sent","provider_message_id":"123","error":null,"reference":null,"parts":1,"cost":150,
 "created_at":"2026-11-01T10:00:00.000Z","updated_at":"2026-11-01T10:00:00.000Z"}}
```

Status: `queued` → `sent` → `delivered` (if the provider reports it) or `failed`.

`parts` = number of SMS parts. `cost` = what this SMS cost in IRT (`null` = not charged: free provider, or the send failed).

### Errors

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `missing_token`, `invalid_token` | No or wrong token (also if the key is turned off) |
| 403 | `provider_not_allowed` | `provider` is unknown, disabled or not allowed for your key (`details.allowed` lists yours) |
| 409 | `no_provider` | Your key has no enabled provider |
| 422 | `invalid_to` | Bad number |
| 422 | `text_required`, `text_too_long` | Text provider needs `text` |
| 422 | `template_not_supported` | You sent `template`/`params` to a **text** provider |
| 422 | `text_not_supported` | You sent `text` to a **template** provider |
| 422 | `template_required`, `template_not_found` | Template provider needs a known `template` (`details.templates` lists them) |
| 422 | `params_invalid` | `details.expected`, `missing`, `unknown` |
| 402 | `insufficient_balance` | Not enough money. Nothing is sent. `details`: `cost`, `parts`, `price_per_part`, `balance`, `allowed_debt`, `available`, `message` (saved as `failed`) |
| 403 | `number_blacklisted` | The recipient sent `11` (opt-out): nothing is sent to it, from any key, until it sends `12`. The message is saved as `failed` (`details.message`) |
| 429 | `rate_limited` | See Rate limits |
| 502 | `provider_error`, `provider_rejected`, `network_error` | The provider failed. The message is saved as `failed` and returned in `details.message` |

These checks also apply when the default provider is used.

## Balance and prices

Money is in Toman (`IRT`). The admin sets, for your key, a **price for one SMS part** for each provider, and an
**allowed debt**. The admin adds your payments.

```bash
curl -s https://smsgw.kimiasoft.ir/api/v1/balance -H "Authorization: Bearer $TOKEN"
```

```json
{"ok":true,"currency":"IRT","balance":25000,"allowed_debt":10000,"available":35000,
 "prices":[{"provider":"mihan","price_per_part":150},{"provider":"kavenegar","price_per_part":null}]}
```

- `price_per_part: null` = that provider is free for your key (no charge, no balance check).
- Cost of one SMS = `parts × price_per_part`. Parts: text with only Latin (GSM-7) characters = 160 characters for 1 part,
  153 per part when longer. Any other character (Persian, emoji) = 70 for 1 part, 67 per part. The footer `\nلغو11` is
  part of the text, so a text SMS is always counted as Persian. A template SMS is counted from the template text the admin saved
  (no saved text = 1 part).
- The SMS is charged when the provider **accepts** it. If the provider refuses it (`502`), nothing is charged.
  A later `failed` delivery report does not give money back.
- A send is refused with `402 insufficient_balance` if `balance - cost` would go below `-allowed_debt`.
  Example: allowed debt 10000 → the balance may go down to −10,000; the next SMS is refused.

`GET /transactions`:

```json
{"ok":true,"currency":"IRT","transactions":[
 {"id":9,"kind":"sms","amount":-300,"balance_after":24700,"note":null,"message_id":42,"parts":2,"price_per_part":150,"created_at":"..."},
 {"id":8,"kind":"payment","amount":25000,"balance_after":25000,"note":"receipt 1234","message_id":null,"parts":null,"price_per_part":null,"created_at":"..."}]}
```

`kind`: `payment` (money added by the admin), `adjust` (a correction by the admin, + or −), `sms` (one charged SMS).

## Receiving SMS

**Option 1 — webhook.** Create one in the admin (token page) or with `POST /webhooks`. We send:

```json
{"event":"sms.received","created_at":"...","data":{"id":7,"direction":"in","provider":"txt",
 "from":"09129999999","to":"3000111","text":"hello","status":"received","read":false,...}}
```

`sms.status` has the same shape with the outgoing message (new `status`). Headers:
`X-SMSGW-Event`, `X-SMSGW-Timestamp`, `X-SMSGW-Signature: sha256=<hex>`.
Check it: `hex(HMAC_SHA256(secret, timestamp + "." + rawBody))`. Answer with any `2xx`.
Failed deliveries are retried after 10 s, 1 min, 5 min, 30 min and 2 h.

**Option 2 — polling.** `GET /inbox?unread=1&ack=1` returns new messages (oldest first) and marks them read.
For safer processing use `GET /inbox?unread=1`, handle them, then `POST /inbox/ack`.
Or keep your own cursor with `after_id`.

An incoming SMS is given to your key if it arrived on one of your key's *incoming numbers*
(admin setting), or if you last sent an SMS to that sender.
