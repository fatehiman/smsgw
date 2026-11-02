'use strict';
// Pure unit tests, no database needed:  npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');

const { windowStart, effectiveLimits } = require('../src/ratelimit');
const { pickProvider, effectiveDefault } = require('../src/sms');
const { hashPassword, verifyPassword, normalizePhone } = require('../src/util');
const { isPrivateIp, checkUrlSyntax } = require('../src/webhooks');
const { fill } = require('../src/providers/_http');
const providers = require('../src/providers');

test('day window resets at local midnight (Tehran +3:30)', () => {
  // 2026-11-01T20:29:59Z is 23:59:59 in Tehran -> window began 2026-11-01 00:00 Tehran = 2026-10-31T20:30:00Z
  const now = Date.UTC(2026, 10, 1, 20, 29, 59) / 1000;
  assert.equal(windowStart(now, 86400, 210), Date.UTC(2026, 9, 31, 20, 30, 0) / 1000);
  // one second later it is 00:00:00 -> new window
  assert.equal(windowStart(now + 1, 86400, 210), Date.UTC(2026, 10, 1, 20, 30, 0) / 1000);
});

test('minute and hour windows are aligned', () => {
  const now = Date.UTC(2026, 10, 1, 10, 15, 42) / 1000;
  assert.equal(windowStart(now, 60, 210), Date.UTC(2026, 10, 1, 10, 15, 0) / 1000);
  assert.equal(windowStart(now, 3600, 0), Date.UTC(2026, 10, 1, 10, 0, 0) / 1000);
});

test('token limits override defaults, null falls back, 0 is unlimited', () => {
  const d = { minute: 20, hour: 100, day: 300 };
  assert.deepEqual(effectiveLimits({ limit_minute: null, limit_hour: 5, limit_day: 0 }, d), { m: 20, h: 5, d: 0 });
});

const P = (id, slug) => ({ id, slug });
test('default provider rules', () => {
  const a = P(1, 'a'); const b = P(2, 'b'); const c = P(3, 'c');
  assert.equal(effectiveDefault({ default_provider_id: 3 }, [a, b, c], 1).slug, 'c'); // token default wins
  assert.equal(effectiveDefault({ default_provider_id: null }, [a, b, c], 2).slug, 'b'); // global default
  assert.equal(effectiveDefault({ default_provider_id: null }, [b, c], 1).slug, 'b'); // global not allowed -> first
  assert.equal(effectiveDefault({ default_provider_id: 9 }, [b, c], null).slug, 'b'); // stale default -> first
  assert.equal(effectiveDefault({}, [], 1), null);
});

test('explicit provider must be allowed', () => {
  assert.equal(pickProvider({}, [P(1, 'a')], null, 'a').slug, 'a');
  assert.throws(() => pickProvider({}, [P(1, 'a')], null, 'zzz'), { code: 'provider_not_allowed' });
  assert.throws(() => pickProvider({}, [], null, undefined), { code: 'no_provider' });
});

test('password hash round trip', () => {
  const h = hashPassword('s3cret');
  assert.ok(verifyPassword('s3cret', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', ''));
});

test('phone numbers', () => {
  assert.equal(normalizePhone('+98 912-123 4567'), '+989121234567');
  assert.equal(normalizePhone('abc'), null);
});

test('webhook url guards', () => {
  assert.ok(isPrivateIp('127.0.0.1') && isPrivateIp('10.1.2.3') && isPrivateIp('192.168.0.9') && isPrivateIp('::1'));
  assert.ok(!isPrivateIp('8.8.8.8'));
  assert.ok(checkUrlSyntax('ftp://x.com'));
  assert.ok(checkUrlSyntax('https://u:p@x.com'));
  assert.equal(checkUrlSyntax('https://x.com/hook'), null);
});

test('template placeholders are escaped for the body format', () => {
  assert.equal(fill('{"t":"{{text}}"}', { text: 'say "hi"\n' }, 'json'), '{"t":"say \\"hi\\"\\n"}');
  assert.equal(fill('to={{to}}', { to: '+98 9' }, 'url'), 'to=%2B98%209');
  assert.equal(fill('{{params.code}}', { params: { code: '12' } }), '12');
});

test('all drivers load and have a valid type', () => {
  const names = providers.list().map((d) => d.driver).sort();
  assert.deepEqual(names, ['generic-http', 'generic-http-template', 'kavenegar-lookup', 'mihan-sms', 'mock-template', 'mock-text']);
});

test('mihan: SOAP envelope, field parsing, number format', () => {
  const m = require('../src/providers/mihan-sms')._internal;
  const env = m.envelope('send', { to: '0912', message: 'a<b & "c"', check_duplicate: false });
  assert.ok(env.includes('<message xsi:type="xsd:string">a&lt;b &amp; "c"</message>'));
  assert.ok(env.includes('<check_duplicate xsi:type="xsd:boolean">false</check_duplicate>'));
  const reply = '<ns1:sendResponse><status xsi:type="xsd:int">0</status><identifier xsi:type="xsd:int">77</identifier><status_message xsi:type="xsd:string">x &amp; y</status_message></ns1:sendResponse>';
  assert.equal(m.field(reply, 'identifier'), '77');
  assert.equal(m.field(reply, 'status_message'), 'x & y');
  const list = '<messages xsi:type="SOAP-ENC:Array"><item xsi:type="ns1:message"><messageId>5</messageId><to>3000</to><from>0912</from><message>hi</message><timestamp>1</timestamp></item></messages>';
  assert.deepEqual(m.parseMessages(list), [{ messageId: '5', to: '3000', from: '0912', message: 'hi', timestamp: '1' }]);
  assert.equal(m.localNumber('+989121234567'), '09121234567');
  assert.equal(m.localNumber('9121234567'), '09121234567');
  assert.equal(m.localNumber('+441234567890'), '+441234567890');
});

test('billing: SMS parts (GSM-7 160/153, UCS-2 70/67)', () => {
  const { countParts } = require('../src/billing');
  assert.equal(countParts('a'.repeat(160)), 1);
  assert.equal(countParts('a'.repeat(161)), 2);
  assert.equal(countParts('a'.repeat(306)), 2);
  assert.equal(countParts('a'.repeat(307)), 3);
  assert.equal(countParts('{'.repeat(80)), 1); // extension chars count 2
  assert.equal(countParts('{'.repeat(81)), 2);
  assert.equal(countParts('س'.repeat(70)), 1);
  assert.equal(countParts('س'.repeat(71)), 2);
  assert.equal(countParts('س'.repeat(134)), 2);
  assert.equal(countParts('س'.repeat(135)), 3);
  assert.equal(countParts(`${'a'.repeat(65)}\nلغو11`), 2); // the Persian footer makes the whole SMS UCS-2
  assert.equal(countParts(''), 1);
});

test('billing: template body is filled and counted', () => {
  const { fillTemplate, templateParts } = require('../src/billing');
  assert.equal(fillTemplate('Code {{code}} / {minutes} / %code / {x}', { code: '12', minutes: '5' }), 'Code 12 / 5 / 12 / {x}');
  assert.equal(fillTemplate('%token2 %token', { token: 'a', token2: 'b' }), 'b a');
  assert.equal(templateParts('', { code: '1' }), 1);
  assert.equal(templateParts('کد {code}', { code: 'x'.repeat(100) }), 2);
});
