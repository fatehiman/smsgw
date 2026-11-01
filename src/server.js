'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const api = require('./api');
const admin = require('./admin');
const inbound = require('./inbound');
const webhooks = require('./webhooks');
const ratelimit = require('./ratelimit');
const { ApiError } = require('./util');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));

// Only trust the client-IP header from the local reverse proxy (Apache sets it from the CDN header).
function clientIp(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer === '127.0.0.1' || peer === '::1') {
    const h = req.headers[config.clientIpHeader];
    if (typeof h === 'string' && h.trim()) return h.trim().replace(/^::ffff:/, '');
  }
  return peer;
}

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const s = (status, body, headers) => send(res, status, body === undefined ? (status === 404 ? 'Not Found' : '') : body, headers);
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/' && ['GET', 'HEAD'].includes(req.method)) return s(200, indexHtml, { 'Content-Type': 'text/html; charset=utf-8' });
    if (p === '/api' || p.startsWith('/api/')) return await api.handle(req, res, url, clientIp(req), s);
    if (p === '/mainadmin' || p.startsWith('/mainadmin/')) return await admin.handle(req, res, url, clientIp(req), s);
    if (p.startsWith('/hook/')) return await inbound.handle(req, res, url, s);
    return s(404);
  } catch (e) {
    if (e instanceof ApiError) return s(e.status, e.message);
    console.error('request error:', e);
    return s(500, 'Internal error');
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;

async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  await db.migrate();
  const every = (ms, fn) => setInterval(() => fn().catch((e) => console.error(`${fn.name}: ${e.message}`)), ms).unref();
  every(5000, webhooks.processDue);
  every(60000, inbound.pollAll);
  every(3600000, ratelimit.cleanup);
  every(3600000, webhooks.cleanup);
  server.listen(config.port, config.host, () => console.log(`smsgw listening on ${config.host}:${config.port}`));
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => db.pool.end().finally(() => process.exit(0))));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { server, main };
