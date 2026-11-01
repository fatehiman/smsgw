'use strict';
const fs = require('fs');
const path = require('path');

// Tiny .env reader for local runs. On the server systemd loads /etc/smsgw.env instead.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const env = process.env;

module.exports = {
  port: Number(env.PORT) || 25465,
  host: env.HOST || '127.0.0.1',
  databaseUrl: env.DATABASE_URL || '',
  adminUser: env.ADMIN_USER || 'mainadmin',
  adminPassHash: env.ADMIN_PASS_HASH || '',
  sessionSecret: env.SESSION_SECRET || '',
  clientIpHeader: (env.CLIENT_IP_HEADER || 'x-gw-client-ip').toLowerCase(),
  allowPrivateWebhooks: env.ALLOW_PRIVATE_WEBHOOKS === '1',
};
