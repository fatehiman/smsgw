'use strict';
// End-to-end smoke test against a RUNNING gateway with an EMPTY database (use a throwaway DB!).
//   BASE=http://127.0.0.1:25465 ADMIN_USER=mainadmin ADMIN_PASS=... node test/smoke.js
// Start the gateway with ALLOW_PRIVATE_WEBHOOKS=1 so the test can receive webhooks on localhost.
const http = require('http');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:25465';
const USER = process.env.ADMIN_USER || 'mainadmin';
const PASS = process.env.ADMIN_PASS;
if (!PASS) { console.error('Set ADMIN_PASS'); process.exit(1); }

let cookie = '';
let csrf = '';
const form = (o) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => [].concat(v).map((x) => [k, x]))).toString();

async function admin(method, path, data) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? form({ _csrf: csrf, ...data }) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  const m = /name="_csrf" value="([^"]+)"/.exec(text);
  if (m) csrf = m[1];
  return { status: res.status, text, location: res.headers.get('location') };
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

const step = (s) => console.log(`- ${s}`);

(async () => {
  step('everything unknown is 404');
  for (const p of ['/wp-admin', '/.env', '/wp-login.php', '/admin', '/api', '/api/v2/x']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 404, `${p} -> ${r.status}`);
  }
  assert.equal((await fetch(BASE + '/')).status, 200);

  step('admin login');
  assert.equal((await admin('GET', '/mainadmin')).status, 200);
  const bad = await fetch(BASE + '/mainadmin/login', { method: 'POST', body: form({ username: USER, password: 'nope' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(bad.status, 401);
  let r = await admin('POST', '/mainadmin/login', { username: USER, password: PASS });
  assert.equal(r.status, 303);
  r = await admin('GET', '/mainadmin');
  assert.ok(r.text.includes('Dashboard') && csrf);
  r = await admin('POST', '/mainadmin/limits', { _csrf: 'bad' });
  assert.equal(r.status, 403, 'bad CSRF must be refused');

  step('create providers (text + template) and a template');
  r = await admin('POST', '/mainadmin/providers', { driver: 'mock-text', slug: 'txt', name: 'Text provider' });
  assert.equal(r.status, 303, r.text);
  r = await admin('POST', '/mainadmin/providers', { driver: 'mock-template', slug: 'tpl', name: 'Template provider' });
  assert.equal(r.status, 303);
  const provs = await admin('GET', '/mainadmin/providers');
  const tplId = /providers\/(\d+)"[^>]*title="Edit provider"/g;
  const ids = [...provs.text.matchAll(/href="\/mainadmin\/providers\/(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  const [txtId, tplProvId] = ids;
  assert.ok(tplId);
  r = await admin('POST', `/mainadmin/providers/${tplProvId}/templates`, { code: 'verify', name: 'Verify', params: 'code, minutes' });
  assert.equal(r.status, 303);
  r = await admin('POST', `/mainadmin/providers/${tplProvId}/default`);
  assert.equal(r.status, 303);

  step('create token (both providers, default = text)');
  r = await admin('POST', '/mainadmin/tokens', { name: 'Smoke', providers: [txtId, tplProvId], default_provider_id: txtId, inbound_numbers: '3000111' });
  assert.equal(r.status, 200);
  const token = /id="tk">([^<]+)</.exec(r.text)[1];
  assert.match(token, /^sgw_/);

  step('auth');
  assert.equal((await fetch(BASE + '/api/v1/me')).status, 401);
  assert.equal((await api('sgw_wrong', 'GET', '/api/v1/me')).status, 401);
  r = await api(token, 'GET', '/api/v1/me');
  assert.equal(r.status, 200);
  assert.equal(r.json.default_provider, 'txt');

  step('type rules: text provider rejects template, template provider rejects text');
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', text: 'hello' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.message.provider, 'txt');
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', template: 'verify', params: { code: '1', minutes: '2' } });
  assert.equal(r.json.error.code, 'template_not_supported'); // default provider is the text one
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', text: 'x', provider: 'tpl' });
  assert.equal(r.json.error.code, 'text_not_supported');
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', provider: 'tpl' });
  assert.equal(r.json.error.code, 'template_required');
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', provider: 'tpl', template: 'nope', params: {} });
  assert.equal(r.json.error.code, 'template_not_found');
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', provider: 'tpl', template: 'verify', params: { code: '1', extra: 'x' } });
  assert.equal(r.json.error.code, 'params_invalid');
  assert.deepEqual(r.json.error.details.missing, ['minutes']);
  assert.deepEqual(r.json.error.details.unknown, ['extra']);
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', provider: 'tpl', template: 'verify', params: { code: '1', minutes: 2 } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.message.params, { code: '1', minutes: '2' });
  r = await api(token, 'POST', '/api/v1/sms/send', { to: '09120000001', text: 'x', provider: 'unknown' });
  assert.equal(r.json.error.code, 'provider_not_allowed');
  r = await api(token, 'POST', '/api/v1/sms/send', { to: 'abc', text: 'x' });
  assert.equal(r.json.error.code, 'invalid_to');

  step('status / list / providers');
  const id = (await api(token, 'POST', '/api/v1/sms/send', { to: '09120000002', text: 'again', reference: 'r1' })).json.message.id;
  r = await api(token, 'GET', `/api/v1/sms/${id}`);
  assert.equal(r.json.message.reference, 'r1');
  r = await api(token, 'GET', '/api/v1/sms?limit=2');
  assert.equal(r.json.messages.length, 2);
  r = await api(token, 'GET', '/api/v1/providers');
  assert.equal(r.json.providers.find((p) => p.slug === 'tpl').templates[0].template, 'verify');

  step('webhook via API + inbound SMS + fetch endpoint');
  const got = [];
  const recv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push({ headers: req.headers, body: JSON.parse(b) }); res.end('ok'); });
  });
  await new Promise((ok) => recv.listen(0, '127.0.0.1', ok));
  const port = recv.address().port;
  r = await api(token, 'POST', '/api/v1/webhooks', { url: `http://127.0.0.1:${port}/h`, events: ['sms.received'] });
  assert.equal(r.status, 201);
  const secret = r.json.webhook.secret;
  assert.ok(secret);
  const slugRow = await admin('GET', `/mainadmin/providers/${txtId}`);
  const hook = /\/hook\/txt\/[0-9a-f]+/.exec(slugRow.text)[0];
  assert.equal((await fetch(BASE + '/hook/txt/wrongsecret')).status, 404);
  let hr = await fetch(BASE + hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '09129999999', to: '3000111', text: 'hello back', id: 'in-1' }) });
  assert.equal(hr.status, 200);
  r = await api(token, 'GET', '/api/v1/inbox?unread=1&ack=1');
  assert.equal(r.json.messages.length, 1);
  assert.equal(r.json.messages[0].text, 'hello back');
  r = await api(token, 'GET', '/api/v1/inbox?unread=1');
  assert.equal(r.json.messages.length, 0);
  // reply to a number we sent to -> goes to the same token even without the line number
  await fetch(BASE + hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '+98 912 000 0002', text: 'reply' }) });
  r = await api(token, 'GET', '/api/v1/inbox?unread=1');
  assert.equal(r.json.messages.length, 1);
  for (let i = 0; i < 20 && got.length < 2; i++) await new Promise((x) => setTimeout(x, 500));
  assert.equal(got.length, 2, 'webhook deliveries');
  assert.equal(got[0].body.event, 'sms.received');
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', secret).update(`${got[0].headers['x-smsgw-timestamp']}.${JSON.stringify(got[0].body)}`).digest('hex');
  assert.equal(got[0].headers['x-smsgw-signature'], `sha256=${sig}`);
  recv.close();

  step('webhook URL rules');
  r = await api(token, 'POST', '/api/v1/webhooks', { url: 'ftp://x.com' });
  assert.equal(r.json.error.code, 'invalid_url');

  step('billing: price per part, allowed debt, payments, refused without money, no charge on provider error');
  r = await admin('POST', '/mainadmin/tokens', {
    name: 'Bill', providers: [txtId, tplProvId], default_provider_id: txtId, [`price_${txtId}`]: '100', [`price_${tplProvId}`]: '50', credit_limit: '-150',
  });
  const bill = /id="tk">([^<]+)</.exec(r.text)[1];
  const billId = [...(await admin('GET', '/mainadmin/tokens')).text.matchAll(/href="\/mainadmin\/tokens\/(\d+)"/g)].pop()[1];
  r = await api(bill, 'GET', '/api/v1/balance');
  assert.deepEqual([r.json.balance, r.json.allowed_debt, r.json.available], [0, 150, 150]);
  assert.equal(r.json.prices.find((p) => p.provider === 'txt').price_per_part, 100);
  r = await api(bill, 'POST', '/api/v1/sms/send', { to: '09120000003', text: 'hi' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.message.parts, r.json.message.cost], [1, 100]);
  r = await api(bill, 'POST', '/api/v1/sms/send', { to: '09120000003', text: 'hi' }); // -200 < -150
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, 'insufficient_balance');
  assert.equal(r.json.error.details.balance, -100);
  assert.equal(r.json.error.details.message.status, 'failed');
  r = await admin('POST', `/mainadmin/tokens/${billId}/transactions`, { kind: 'payment', amount: '-5' });
  assert.match(r.location, /err=/, 'negative payment must be refused');
  r = await admin('POST', `/mainadmin/tokens/${billId}/transactions`, { kind: 'payment', amount: '1,000', note: 'receipt 1' });
  assert.match(r.location, /ok=/);
  r = await api(bill, 'POST', '/api/v1/sms/send', { to: '09120000003', text: 'a'.repeat(200) }); // + Persian footer = UCS-2, 206 -> 4 parts
  assert.deepEqual([r.json.message.parts, r.json.message.cost], [4, 400]);
  r = await api(bill, 'POST', '/api/v1/sms/send', { to: '09120000003', provider: 'tpl', template: 'verify', params: { code: '1', minutes: '2' } });
  assert.deepEqual([r.json.message.parts, r.json.message.cost], [1, 50]);
  await admin('POST', `/mainadmin/providers/${txtId}`, { name: 'Text provider', enabled: '1', s_fail_if_to_contains: '0000' });
  r = await api(bill, 'POST', '/api/v1/sms/send', { to: '09120000000', text: 'x' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.details.message.cost, null);
  await admin('POST', `/mainadmin/providers/${txtId}`, { name: 'Text provider', enabled: '1', s_fail_if_to_contains: '' });
  r = await api(bill, 'GET', '/api/v1/transactions');
  assert.deepEqual(r.json.transactions.map((t) => t.kind), ['sms', 'sms', 'payment', 'sms']);
  assert.equal(r.json.transactions[0].balance_after, 450);
  assert.equal((await api(bill, 'GET', '/api/v1/balance')).json.balance, 450);
  r = await admin('GET', '/mainadmin/tokens'); // no prices on the first key -> billing off (no API call: its rate limit is nearly used)
  assert.ok(r.text.includes('billing off'));

  step('rotate: old token dies, new one works');
  const tokId = /href="\/mainadmin\/tokens\/(\d+)"/.exec((await admin('GET', '/mainadmin/tokens')).text)[1];
  r = await admin('POST', `/mainadmin/tokens/${tokId}/rotate`);
  const token2 = /id="tk">([^<]+)</.exec(r.text)[1];
  assert.notEqual(token, token2);
  assert.equal((await api(token, 'GET', '/api/v1/me')).status, 401);
  assert.equal((await api(token2, 'GET', '/api/v1/me')).status, 200);

  step('rate limit: 20/min per IP by default');
  await admin('POST', '/mainadmin/limits', { limit_minute: 20, limit_hour: 100, limit_day: 300, tz_offset_min: 210 });
  let limited = null;
  for (let i = 0; i < 30; i++) {
    r = await api(token2, 'GET', '/api/v1/usage');
    if (r.status === 429) { limited = r; break; }
  }
  assert.ok(limited, 'expected a 429 within 30 calls');
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  step('per-token override (no limit) and global edit');
  r = await admin('POST', `/mainadmin/tokens/${tokId}`, { name: 'Smoke', providers: [txtId, tplProvId], default_provider_id: txtId, limit_minute: 0 });
  assert.equal(r.status, 303);
  r = await api(token2, 'GET', '/api/v1/usage');
  assert.equal(r.status, 200);
  assert.equal(r.json.limits.minute.limit, 0);

  step('disabled provider is skipped as default');
  await admin('POST', `/mainadmin/providers/${txtId}`, { name: 'Text provider' }); // enabled unchecked -> disabled
  r = await api(token2, 'GET', '/api/v1/me');
  assert.equal(r.json.default_provider, 'tpl');

  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
