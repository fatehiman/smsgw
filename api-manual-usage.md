# How to use the SMS gateway (smsgw)

A short guide with examples. Full reference: [API.md](API.md).

Base URL: `https://smsgw.kimiasoft.ir/api/v1`

## 1. Get an API token

1. Ask the admin to create an API key for your project (admin panel → **API tokens**).
2. The admin tells you which **providers** your key may use, and which one is the default.
3. You get the token **one time**. It looks like `sgw_AbC...`. Store it as a secret (environment variable, not in git).
4. If the token leaks, the admin can **rotate** it. The old token stops working at once.

Every request needs this header:

```
Authorization: Bearer sgw_YOUR_TOKEN
```

All examples below use `$TOKEN` and `$BASE`:

```bash
export TOKEN=sgw_YOUR_TOKEN
export BASE=https://smsgw.kimiasoft.ir/api/v1
```

## 2. Check that it works

```bash
curl -s $BASE/me -H "Authorization: Bearer $TOKEN"
```

```json
{"ok":true,"name":"Shop website","default_provider":"mihan-main","providers":["mihan-main","kavenegar"]}
```

## 3. Which providers do I have? Text or template?

```bash
curl -s $BASE/providers -H "Authorization: Bearer $TOKEN"
```

```json
{"ok":true,"providers":[
  {"slug":"mihan-main","name":"Mihan","type":"text","is_default":true},
  {"slug":"kavenegar","name":"Kavenegar","type":"template","is_default":false,
   "templates":[{"template":"verify","name":"Login code","params":["code","minutes"]}]}
]}
```

- `type: "text"` → you send your own message text (`text`).
- `type: "template"` → you send a template ID (`template`) and its parameters (`params`). No free text.

Wrong fields for the provider type give a clear error (see section 8). This is also true for the default provider.

## 4. Send an SMS

### Text provider

```bash
curl -s -X POST $BASE/sms/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"09121234567","text":"Your order #1234 was shipped."}'
```

### Template provider

```bash
curl -s -X POST $BASE/sms/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"09121234567","provider":"kavenegar","template":"verify","params":{"code":"4821","minutes":"5"}}'
```

### Choose the provider, or use the default

- Add `"provider":"<slug>"` to choose one of your providers.
- Leave it out to use your key's **default provider**.

### Your own reference

Add `"reference":"order-1234"`. It comes back in the result and in status checks, so you can match messages to your own data.

### Reply

```json
{"ok":true,"message":{"id":42,"direction":"out","provider":"mihan-main","to":"09121234567",
 "text":"Your order #1234 was shipped.","status":"sent","provider_message_id":"98765",
 "error":null,"reference":"order-1234","created_at":"2026-11-01T10:00:00.000Z","updated_at":"2026-11-01T10:00:00.000Z"}}
```

Message status: `queued` → `sent` → `delivered` (only if the provider tells us) or `failed`.

**Footer and opt-out (fixed rules).** The gateway adds a line break and `لغو11` to the end of every **text** SMS. If the
person answers `11`, the number goes on a blacklist and every later send to it (from any key) fails with HTTP `403`
`number_blacklisted` until the person sends `12`. Do not retry such a number.

## 5. Check a message later

```bash
curl -s $BASE/sms/42 -H "Authorization: Bearer $TOKEN"        # one message
curl -s "$BASE/sms?limit=20" -H "Authorization: Bearer $TOKEN" # latest sent messages
curl -s "$BASE/sms?status=failed" -H "Authorization: Bearer $TOKEN"
```

## 6. Receive SMS

There are two ways. Use one, or both.

### A. Webhook (we call you)

Create a webhook (in the admin panel on your token page, or with the API):

```bash
curl -s -X POST $BASE/webhooks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://myapp.example.com/sms-hook","events":["sms.received","sms.status"]}'
```

The reply has a `secret`. **It is shown only now.** Save it.

When an SMS arrives, we send a `POST` with JSON to your URL:

```json
{"event":"sms.received","created_at":"2026-11-01T10:05:00.000Z",
 "data":{"id":7,"direction":"in","provider":"mihan-main","from":"09129999999","to":"3000250005",
         "text":"Yes, thanks","status":"received","read":false}}
```

`sms.status` has the same shape, with an outgoing message and its new `status`.

Answer with any `2xx` status. If you do not, we retry after 10 s, 1 min, 5 min, 30 min and 2 h.
Your URL must be a public `http(s)` address.

**Verify the signature** (so nobody can fake our calls). We send the headers `X-SMSGW-Timestamp` and
`X-SMSGW-Signature: sha256=<hex>`. The hex is `HMAC_SHA256(secret, timestamp + "." + rawBody)`.

Node.js:

```js
const crypto = require('crypto');
app.post('/sms-hook', express.raw({ type: '*/*' }), (req, res) => {
  const ts = req.header('X-SMSGW-Timestamp');
  const want = 'sha256=' + crypto.createHmac('sha256', process.env.SMSGW_SECRET)
    .update(`${ts}.${req.body.toString('utf8')}`).digest('hex');
  if (req.header('X-SMSGW-Signature') !== want) return res.sendStatus(401);
  const event = JSON.parse(req.body);
  console.log(event.event, event.data.from, event.data.text);
  res.sendStatus(200);
});
```

PHP:

```php
$raw = file_get_contents('php://input');
$ts  = $_SERVER['HTTP_X_SMSGW_TIMESTAMP'] ?? '';
$want = 'sha256=' . hash_hmac('sha256', $ts . '.' . $raw, getenv('SMSGW_SECRET'));
if (!hash_equals($want, $_SERVER['HTTP_X_SMSGW_SIGNATURE'] ?? '')) { http_response_code(401); exit; }
$event = json_decode($raw, true);
http_response_code(200);
```

Test your webhook: `curl -s -X POST $BASE/webhooks/ID/test -H "Authorization: Bearer $TOKEN"`.
Other calls: `GET /webhooks`, `PATCH /webhooks/ID` (`url`, `events`, `enabled`), `DELETE /webhooks/ID`.

### B. Polling (you call us)

```bash
# new messages, and mark them as read
curl -s "$BASE/inbox?unread=1&ack=1" -H "Authorization: Bearer $TOKEN"

# safer: read first, confirm after you saved them
curl -s "$BASE/inbox?unread=1" -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/inbox/ack -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"ids":[7,8]}'      # or {"up_to_id":8}
```

You can also keep your own cursor: `GET /inbox?after_id=8&limit=50`.

**Which SMS are mine?** An incoming SMS goes to your key if it came to one of your key's *incoming numbers*
(admin setting), or if your key was the last one to send an SMS to that sender.

## 7. Rate limits

Default: **20 per minute, 100 per hour, 300 per day**, counted for each token and each caller IP.
The admin can change this (also per token). The day counter resets at 00:00 Tehran time.

Each response has headers such as `X-RateLimit-Remaining` and `X-RateLimit-Reset`.
If you go over, you get HTTP `429` with `Retry-After` (seconds). Wait, then try again.

```bash
curl -s $BASE/usage -H "Authorization: Bearer $TOKEN"     # your limits and use (this IP)
```

Tip: do not retry in a tight loop. Sleep for `Retry-After` seconds.

## 8. Errors

Errors look like this:

```json
{"ok":false,"error":{"code":"text_not_supported","message":"Provider \"kavenegar\" works with templates. Send \"template\" and \"params\", not \"text\".","details":{"provider":"kavenegar","provider_type":"template"}}}
```

| Code | What to do |
|---|---|
| `invalid_token` / `missing_token` (401) | Check the token and the `Authorization` header. |
| `provider_not_allowed` (403) | Use a provider from `GET /providers`. |
| `no_provider` (409) | Ask the admin to give your key a provider. |
| `invalid_to` (422) | Phone number: digits, optional `+`. |
| `text_required` (422) | The provider is a text provider. Send `text`. |
| `template_not_supported` (422) | You sent `template`/`params` to a text provider. Send `text`. |
| `text_not_supported` (422) | You sent `text` to a template provider. Send `template` + `params`. |
| `template_required`, `template_not_found` (422) | Use a template from `GET /providers`. |
| `params_invalid` (422) | `details` lists `expected`, `missing`, `unknown` parameter names. |
| `number_blacklisted` (403) | The recipient sent `11` (opt-out). Do not retry; it works again only after they send `12`. |
| `rate_limited` (429) | Wait `Retry-After` seconds. |
| `provider_error`, `provider_rejected`, `network_error` (502) | The provider failed (for example no credit). The message is saved as `failed`; see `details.message`. |

A `502` can be temporary. Do not blindly resend if you are not sure: look at `GET /sms?status=failed`,
or use `reference` to avoid sending the same SMS twice.

## 9. Examples in code

Node.js (18+):

```js
const BASE = 'https://smsgw.kimiasoft.ir/api/v1';
const headers = { Authorization: `Bearer ${process.env.SMSGW_TOKEN}`, 'Content-Type': 'application/json' };

async function sendSms(to, text) {
  const res = await fetch(`${BASE}/sms/send`, { method: 'POST', headers, body: JSON.stringify({ to, text }) });
  const data = await res.json();
  if (res.status === 429) throw new Error(`Rate limited, retry in ${res.headers.get('retry-after')} s`);
  if (!data.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data.message;
}

sendSms('09121234567', 'Hello from Node').then(console.log);
```

Python:

```python
import os, requests

BASE = "https://smsgw.kimiasoft.ir/api/v1"
H = {"Authorization": f"Bearer {os.environ['SMSGW_TOKEN']}"}

r = requests.post(f"{BASE}/sms/send", headers=H, json={
    "to": "09121234567", "provider": "kavenegar",
    "template": "verify", "params": {"code": "4821", "minutes": "5"},
})
data = r.json()
if not data["ok"]:
    raise RuntimeError(f'{data["error"]["code"]}: {data["error"]["message"]}')
print(data["message"]["id"], data["message"]["status"])

for m in requests.get(f"{BASE}/inbox", headers=H, params={"unread": 1, "ack": 1}).json()["messages"]:
    print(m["from"], m["text"])
```

PHP:

```php
$ch = curl_init('https://smsgw.kimiasoft.ir/api/v1/sms/send');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('SMSGW_TOKEN'), 'Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode(['to' => '09121234567', 'text' => 'Hello from PHP']),
]);
$data = json_decode(curl_exec($ch), true);
if (!$data['ok']) { throw new RuntimeException($data['error']['code'] . ': ' . $data['error']['message']); }
echo $data['message']['id'];
```
