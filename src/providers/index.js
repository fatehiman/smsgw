'use strict';
// Provider drivers are auto-loaded: every sub-folder here with an index.js is a driver.
// To add a provider, add a folder (see README "Adding a provider"). No other file changes.
const fs = require('fs');
const path = require('path');

const { ProviderError } = require('./_errors');

const drivers = new Map();

for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
  const file = path.join(__dirname, entry.name, 'index.js');
  if (!fs.existsSync(file)) continue;
  const d = require(file);
  if (!d.driver || !['text', 'template'].includes(d.type) || typeof d.send !== 'function') {
    console.error(`provider driver "${entry.name}" skipped: needs driver, type (text|template) and send()`);
    continue;
  }
  d.settings = d.settings || [];
  drivers.set(d.driver, d);
}

module.exports = {
  ProviderError,
  get: (code) => drivers.get(code),
  list: () => [...drivers.values()],
};
