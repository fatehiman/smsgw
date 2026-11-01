'use strict';
const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const randomToken = (prefix = 'sgw_') => prefix + crypto.randomBytes(32).toString('base64url');
const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Password hash format: scrypt:<N>:<salt b64url>:<hash b64url>
function hashPassword(pw, N = 16384) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N });
  return `scrypt:${N}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function verifyPassword(pw, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64url');
  const want = Buffer.from(parts[3], 'base64url');
  const got = crypto.scryptSync(String(pw), salt, want.length, { N });
  return crypto.timingSafeEqual(got, want);
}

async function readBody(req, limit = 262144) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// JSON or urlencoded. Repeated urlencoded keys become arrays.
function parseBody(raw, contentType = '') {
  if (!raw) return {};
  if (/json/i.test(contentType) || /^\s*[{[]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'invalid_json', 'Body is not valid JSON');
    }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

// Keep digits and a leading +. Provider drivers decide the final format.
function normalizePhone(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[\s\-().]/g, '');
  return /^\+?\d{5,20}$/.test(s) ? s : null;
}

const digitsTail = (v, n = 10) => String(v || '').replace(/\D/g, '').slice(-n);

function getPath(obj, dotted) {
  return String(dotted || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);
}

module.exports = {
  ApiError, esc, sha256, hmac, randomToken, randomHex, safeEqual,
  hashPassword, verifyPassword, readBody, parseBody, normalizePhone, digitsTail, getPath,
};
