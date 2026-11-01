'use strict';
// Shared code for the two "generic HTTP" drivers (text and template). Lets the admin connect
// any simple HTTP SMS API from the panel, without writing a driver file.
const { ProviderError } = require('./_errors');
const { request, fill, parseHeaderLines } = require('./_http');
const { getPath } = require('../util');

const commonSettings = (placeholders) => [
  { key: 'url', label: 'URL', required: true, help: `You can use ${placeholders} in the URL.` },
  { key: 'method', label: 'Method', type: 'select', options: ['POST', 'GET'], default: 'POST' },
  { key: 'body_format', label: 'Body format', type: 'select', options: ['json', 'form'], default: 'json' },
  { key: 'body', label: 'Body template', type: 'textarea', help: `Same placeholders. Ignored for GET.` },
  { key: 'headers', label: 'Headers', type: 'textarea', help: 'One per line, "Name: value". Placeholders allowed.' },
  { key: 'sender', label: 'Sender / line number', help: 'Available as {{sender}}.' },
  { key: 'api_key', label: 'API key', type: 'password', help: 'Available as {{api_key}}.' },
  { key: 'success_status', label: 'Success HTTP status', default: '200-299', help: 'e.g. 200-299 or 200' },
  { key: 'success_contains', label: 'Success text', help: 'Optional. The response body must contain this text.' },
  { key: 'id_path', label: 'Message ID path', help: 'Optional. Dot path in JSON reply, e.g. data.id' },
];

const inboundSettings = [
  { key: 'in_from', label: 'Incoming: sender field', default: 'from', help: 'Field name (dot path) in the provider webhook.' },
  { key: 'in_to', label: 'Incoming: line field', default: 'to' },
  { key: 'in_text', label: 'Incoming: text field', default: 'text' },
  { key: 'in_id', label: 'Incoming: message ID field', default: 'id' },
];

function statusOk(spec, status) {
  const m = String(spec || '200-299').match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return status >= 200 && status < 300;
  return status >= Number(m[1]) && status <= Number(m[2] || m[1]);
}

async function sendHttp(s, values) {
  if (!s.url) throw new ProviderError('Provider URL is not set', { code: 'not_configured' });
  const full = { ...values, sender: s.sender || '', api_key: s.api_key || '' };
  const method = (s.method || 'POST').toUpperCase();
  const url = fill(s.url, full, 'url');
  const headers = parseHeaderLines(fill(s.headers, full));
  let body;
  if (method !== 'GET') {
    if ((s.body_format || 'json') === 'form') {
      body = fill(s.body, full, 'url');
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else {
      body = fill(s.body, full, 'json');
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
  }
  const r = await request(url, { method, headers, body });
  const ok = statusOk(s.success_status, r.status) && (!s.success_contains || r.text.includes(s.success_contains));
  if (!ok) {
    throw new ProviderError(`Provider replied HTTP ${r.status}: ${r.text.slice(0, 200)}`, {
      code: 'provider_rejected', retryable: r.status >= 500,
    });
  }
  const id = s.id_path && r.json ? getPath(r.json, s.id_path) : null;
  return { providerMessageId: id == null ? null : String(id), status: 'sent' };
}

// Provider -> gateway webhook. Fields come from the query string and body (JSON or form).
function parseInbound(req, ctx) {
  const s = ctx.settings;
  const src = { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  const from = getPath(src, s.in_from || 'from');
  const text = getPath(src, s.in_text || 'text');
  if (!from || text == null) return [];
  return [{
    kind: 'sms',
    from: String(from),
    to: getPath(src, s.in_to || 'to') ?? null,
    text: String(text),
    providerMessageId: getPath(src, s.in_id || 'id') ?? null,
  }];
}

module.exports = { commonSettings, inboundSettings, sendHttp, parseInbound };
