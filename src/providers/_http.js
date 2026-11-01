'use strict';
const { ProviderError } = require('./_errors');
const { getPath } = require('../util');

// fetch with a timeout. Returns { status, text, json }.
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(`Network error: ${e.cause?.code || e.message}`, { code: 'network_error', retryable: true });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

// Replace {{name}} in a template. mode: 'json' escapes for a JSON string, 'url' url-encodes, 'raw' as is.
function fill(tpl, values, mode = 'raw') {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = String(getPath(values, k) ?? '');
    if (mode === 'json') return JSON.stringify(v).slice(1, -1);
    if (mode === 'url') return encodeURIComponent(v);
    return v;
  });
}

function parseHeaderLines(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

module.exports = { request, fill, parseHeaderLines };
