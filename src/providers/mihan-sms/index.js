'use strict';
// MihanSMSCenter (http://www.mihansmscenter.com/webservice/help), free-text provider over SOAP 1.1 (rpc/encoded).
// Sending: method "send". Received SMS:
//   - push: set the account's receive URL to /hook/<slug>/<secret>; each POST is checked with verifyReceive;
//   - pull: setting "Fetch received SMS" = yes calls getNewMessages every minute (marks them read at Mihan).
// Use only one of the two, and do not turn pull on if another system already reads this account.
const { ProviderError } = require('../_errors');
const { request } = require('../_http');

const NS = 'http://www.mihansmscenter.com/webservice/';

const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const xmlUnesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function envelope(op, params) {
  const parts = Object.entries(params).map(([k, v]) => {
    const t = typeof v === 'number' ? 'xsd:int' : typeof v === 'boolean' ? 'xsd:boolean' : 'xsd:string';
    return `<${k} xsi:type="${t}">${xmlEsc(v)}</${k}>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" `
    + 'xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    + 'xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<SOAP-ENV:Body><ns1:${op} xmlns:ns1="${NS}">${parts}</ns1:${op}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

// First scalar element with this name inside xml, or null.
function field(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlUnesc(m[1]) : null;
}

// Messages array of getNewMessages: [{ messageId, to, from, message, timestamp }]
function parseMessages(xml) {
  const block = /<messages(?:\s[^>]*)?>([\s\S]*?)<\/messages>/.exec(xml);
  if (!block) return [];
  return [...block[1].matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map((m) => ({
    messageId: field(m[1], 'messageId'),
    to: field(m[1], 'to'),
    from: field(m[1], 'from'),
    message: field(m[1], 'message') ?? '',
    timestamp: field(m[1], 'timestamp'),
  }));
}

async function call(settings, op, params) {
  const { username, password } = settings;
  if (!username || !password) throw new ProviderError('Mihan user name / password are not set', { code: 'not_configured' });
  const r = await request(settings.endpoint || `${NS}index.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${NS}#${op}` },
    body: envelope(op, { username, password, ...params }),
  });
  if (r.status !== 200 || !r.text.includes('Envelope')) {
    throw new ProviderError(`Mihan replied HTTP ${r.status}`, { code: 'network_error', retryable: r.status >= 500 });
  }
  const status = Number(field(r.text, 'status'));
  return { status, message: field(r.text, 'status_message') || '', xml: r.text };
}

// Mihan wants local format 09xxxxxxxxx. Anything else is sent as given.
function localNumber(n) {
  const m = /^(?:\+98|0098|98|0)?(9\d{9})$/.exec(n);
  return m ? `0${m[1]}` : n;
}

module.exports = {
  driver: 'mihan-sms',
  label: 'MihanSMSCenter (free text, SOAP)',
  type: 'text',
  settings: [
    { key: 'username', label: 'Web service user name', required: true },
    { key: 'password', label: 'Web service password', type: 'password', required: true },
    { key: 'sender', label: 'Sender number', required: true, help: 'One of the numbers of the account, e.g. 3000250005.' },
    { key: 'convert_to', label: 'Convert numbers to 09xxxxxxxxx', type: 'select', options: ['yes', 'no'], default: 'yes', help: '+98912..., 98912... and 912... become 0912...' },
    { key: 'poll_inbound', label: 'Fetch received SMS (getNewMessages, every minute)', type: 'select', options: ['no', 'yes'], default: 'no',
      help: 'Marks fetched SMS as read at Mihan. Leave "no" if the receive URL is used (here or by another system).' },
    { key: 'endpoint', label: 'Endpoint (leave empty)', default: '', help: `Default ${NS}index.php` },
  ],

  async send(ctx, msg) {
    const s = ctx.settings;
    if (!s.sender) throw new ProviderError('Mihan sender number is not set', { code: 'not_configured' });
    const to = s.convert_to === 'no' ? msg.to : localNumber(msg.to);
    const r = await call(s, 'send', { to, from: s.sender, message: msg.text, check_duplicate: false });
    if (r.status !== 0) {
      throw new ProviderError(`Mihan error ${r.status}: ${r.message}`, {
        code: 'provider_rejected', retryable: [5, 8].includes(r.status),
      });
    }
    return { providerMessageId: field(r.xml, 'identifier'), status: 'sent' };
  },

  inbound: {
    // Mihan POSTs to, from, message, timestamp. verifyReceive stops forged posts (and marks the SMS read).
    async parse(req, ctx) {
      const b = { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };
      if (!b.from || b.message == null) return [];
      const v = await call(ctx.settings, 'verifyReceive', {
        to: String(b.to ?? ''), from: String(b.from), message: String(b.message), timestamp: String(b.timestamp ?? ''),
      });
      if (v.status !== 0) return [];
      return [{ kind: 'sms', from: String(b.from), to: b.to ?? null, text: String(b.message), providerMessageId: null }];
    },

    async poll(ctx) {
      if (ctx.settings.poll_inbound !== 'yes') return { events: [] };
      const r = await call(ctx.settings, 'getNewMessages', {});
      if (r.status !== 0) throw new ProviderError(`Mihan error ${r.status}: ${r.message}`);
      return {
        events: parseMessages(r.xml).map((m) => ({
          kind: 'sms', from: m.from, to: m.to, text: m.message, providerMessageId: m.messageId,
        })),
      };
    },
  },

  // exported for tests
  _internal: { envelope, field, parseMessages, localNumber },
};
