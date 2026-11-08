'use strict';
// Low provider-balance alert, no database: settings is replaced by a Map.  npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/settings');

const store = new Map();
settings.all = async () => Object.fromEntries(store);
settings.set = async (k, v) => { store.set(k, String(v)); };
const lowbalance = require('../src/lowbalance');

const provider = { id: 1, slug: 'mihan', name: 'Mihan', settings: {} };
const mk = (amount, fail) => {
  const sent = [];
  return {
    sent, type: 'text',
    balance: async () => ({ amount, remaining_sms: 10 }),
    send: async (ctx, msg) => { if (fail) throw new Error('boom'); sent.push(msg); },
  };
};

test('off when threshold is 0; default phone', async () => {
  store.clear();
  assert.equal((await lowbalance.getConfig()).phone, '09031238058');
  const d = mk(5);
  assert.equal(await lowbalance.check(provider, d), null);
  assert.equal(d.sent.length, 0);
});

test('alerts once, repeats after N hours, resets when balance is ok', async () => {
  store.clear();
  store.set('alert_threshold', '100');
  const d = mk(50);
  await lowbalance.check(provider, d);
  await lowbalance.check(provider, d);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].to, '09031238058');
  store.set('alert_at_1', String(Date.now() - 25 * 3600 * 1000));
  await lowbalance.check(provider, d);
  assert.equal(d.sent.length, 2);
  await lowbalance.check(provider, mk(500)); // above: state reset
  assert.equal(store.get('alert_at_1'), '0');
  await lowbalance.check(provider, d);
  assert.equal(d.sent.length, 3);
});

test('failed alert is retried on the next check; no balance API = ignored', async () => {
  store.clear();
  store.set('alert_threshold', '100');
  await lowbalance.check(provider, mk(50, true));
  assert.equal(store.get('alert_at_1'), '0');
  assert.equal(await lowbalance.check(provider, { type: 'text', send() {} }), null);
});
