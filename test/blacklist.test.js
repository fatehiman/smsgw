'use strict';
// Pure unit tests, no database needed:  npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const blacklist = require('../src/blacklist');

test('blacklist: 11 blocks, 12 allows, nothing else is a command', () => {
  for (const t of ['11', ' 11 ', '۱۱', '١١', '11.', 'لغو11', 'لغو ۱۱']) assert.equal(blacklist.parseCommand(t), 'add', t);
  for (const t of ['12', '۱۲', ' 12\n']) assert.equal(blacklist.parseCommand(t), 'remove', t);
  for (const t of ['111', '1', 'yes 11', 'پرداخت کردم', '', null, undefined, '1112', '21']) {
    assert.equal(blacklist.parseCommand(t), null, String(t));
  }
});

test('every text SMS ends with a line break + لغو11, once', () => {
  assert.equal(blacklist.withFooter('سلام'), 'سلام\nلغو11');
  assert.equal(blacklist.withFooter('سلام \n\n'), 'سلام\nلغو11');
  assert.equal(blacklist.withFooter('سلام\nلغو11'), 'سلام\nلغو11');
});
