'use strict';
const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(20, Number); // bigint -> number (ids and counters stay small)
types.setTypeParser(1700, Number); // numeric -> number (money, 2 decimals)

const pool = new Pool({ connectionString: config.databaseUrl, max: 8, idleTimeoutMillis: 30000 });
pool.on('error', (e) => console.error('pg pool error:', e.message));

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATIONS = [
  `CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);

   CREATE TABLE providers (
     id serial PRIMARY KEY,
     slug text UNIQUE NOT NULL,
     name text NOT NULL,
     driver text NOT NULL,
     enabled boolean NOT NULL DEFAULT true,
     is_default boolean NOT NULL DEFAULT false,
     settings jsonb NOT NULL DEFAULT '{}',
     state jsonb NOT NULL DEFAULT '{}',
     inbound_secret text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX one_default_provider ON providers ((true)) WHERE is_default;

   CREATE TABLE templates (
     id serial PRIMARY KEY,
     provider_id int NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
     code text NOT NULL,
     name text NOT NULL,
     body text NOT NULL DEFAULT '',
     param_names text[] NOT NULL DEFAULT '{}',
     UNIQUE (provider_id, code)
   );

   CREATE TABLE api_tokens (
     id serial PRIMARY KEY,
     name text NOT NULL,
     token_hash text UNIQUE NOT NULL,
     token_prefix text NOT NULL,
     enabled boolean NOT NULL DEFAULT true,
     default_provider_id int REFERENCES providers(id) ON DELETE SET NULL,
     inbound_numbers text[] NOT NULL DEFAULT '{}',
     limit_minute int,
     limit_hour int,
     limit_day int,
     created_at timestamptz NOT NULL DEFAULT now(),
     rotated_at timestamptz,
     last_used_at timestamptz
   );

   CREATE TABLE token_providers (
     token_id int NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
     provider_id int NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
     position int NOT NULL DEFAULT 0,
     PRIMARY KEY (token_id, provider_id)
   );

   CREATE TABLE webhooks (
     id serial PRIMARY KEY,
     token_id int NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
     url text NOT NULL,
     secret text NOT NULL,
     events text[] NOT NULL DEFAULT '{sms.received,sms.status}',
     enabled boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now()
   );

   CREATE TABLE messages (
     id bigserial PRIMARY KEY,
     token_id int REFERENCES api_tokens(id) ON DELETE SET NULL,
     provider_id int REFERENCES providers(id) ON DELETE SET NULL,
     direction text NOT NULL CHECK (direction IN ('out','in')),
     peer text NOT NULL,
     line text,
     body text,
     template_code text,
     params jsonb,
     status text NOT NULL,
     provider_message_id text,
     error text,
     reference text,
     read_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX messages_token_idx ON messages (token_id, direction, id);
   CREATE INDEX messages_pmid_idx ON messages (provider_id, provider_message_id);

   CREATE TABLE webhook_deliveries (
     id bigserial PRIMARY KEY,
     webhook_id int NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
     event text NOT NULL,
     payload jsonb NOT NULL,
     attempts int NOT NULL DEFAULT 0,
     status text NOT NULL DEFAULT 'pending',
     next_at timestamptz NOT NULL DEFAULT now(),
     last_error text,
     last_code int,
     created_at timestamptz NOT NULL DEFAULT now(),
     done_at timestamptz
   );
   CREATE INDEX deliveries_due_idx ON webhook_deliveries (next_at) WHERE status = 'pending';

   CREATE TABLE rate_counters (
     token_id int NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
     ip text NOT NULL,
     kind char(1) NOT NULL,
     window_start bigint NOT NULL,
     count int NOT NULL DEFAULT 0,
     PRIMARY KEY (token_id, ip, kind, window_start)
   );

   INSERT INTO settings (key, value) VALUES
     ('limit_minute', '20'), ('limit_hour', '100'), ('limit_day', '300'), ('tz_offset_min', '210');`,
  // 2: SMS opt-out (src/blacklist.js): the list (last 10 digits) and its log (kept 1 year)
  `CREATE TABLE blacklist (
     phone text PRIMARY KEY,
     number text NOT NULL,
     provider_id int REFERENCES providers(id) ON DELETE SET NULL,
     line text,
     message_id bigint,
     since timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE blacklist_log (
     id bigserial PRIMARY KEY,
     phone text NOT NULL,
     number text NOT NULL,
     action text NOT NULL CHECK (action IN ('add','remove')),
     provider_id int REFERENCES providers(id) ON DELETE SET NULL,
     line text,
     message_id bigint,
     at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX blacklist_log_at_idx ON blacklist_log (at);`,
  // 3: billing (src/billing.js): price per part per key + provider, balance, allowed debt, transactions
  `ALTER TABLE token_providers ADD COLUMN price numeric(12,2) CHECK (price >= 0);
   ALTER TABLE api_tokens ADD COLUMN balance numeric(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN credit_limit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0);
   ALTER TABLE messages ADD COLUMN parts int, ADD COLUMN cost numeric(12,2);
   CREATE TABLE transactions (
     id bigserial PRIMARY KEY,
     token_id int NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
     kind text NOT NULL CHECK (kind IN ('payment','adjust','sms')),
     amount numeric(14,2) NOT NULL,
     message_id bigint,
     parts int,
     unit_price numeric(12,2),
     note text NOT NULL DEFAULT '',
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX transactions_token_idx ON transactions (token_id, id);
   CREATE UNIQUE INDEX transactions_message_idx ON transactions (message_id) WHERE message_id IS NOT NULL;`,
  // 4: sending queue (src/outbox.js): tries so far and when the next try is due. Old 'queued' rows (left by a
  //    stop during a send) get next_at = created_at, so the worker fails them as expired (and gives the money back).
  `ALTER TABLE messages ADD COLUMN attempts int NOT NULL DEFAULT 0, ADD COLUMN next_at timestamptz;
   UPDATE messages SET next_at = created_at WHERE direction='out' AND status IN ('queued','sending');
   CREATE INDEX messages_outbox_idx ON messages (next_at, id) WHERE status = 'queued';`,
  // 5: a received SMS can belong to SEVERAL keys (src/inbound.js recipients()): one inbox row per key, each with its
  //    own read state. api_tokens.inbound_hours = this key's window (NULL = the global setting inbound_hours, 48).
  //    messages.provider_time = the provider's own time of a received SMS (push and pull of the same SMS: stored once).
  //    The old one-owner rows become inbox rows of their owner.
  `CREATE TABLE inbox (
     token_id int NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
     message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     read_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (token_id, message_id)
   );
   CREATE INDEX inbox_message_idx ON inbox (message_id);
   CREATE INDEX inbox_unread_idx ON inbox (token_id, message_id) WHERE read_at IS NULL;
   ALTER TABLE api_tokens ADD COLUMN inbound_hours int CHECK (inbound_hours BETWEEN 1 AND 8760);
   ALTER TABLE messages ADD COLUMN provider_time bigint;
   INSERT INTO inbox (token_id, message_id, read_at, created_at)
     SELECT token_id, id, read_at, created_at FROM messages WHERE direction = 'in' AND token_id IS NOT NULL;
   INSERT INTO settings (key, value) VALUES ('inbound_hours', '48') ON CONFLICT (key) DO NOTHING;`,
];

async function migrate() {
  await q('CREATE TABLE IF NOT EXISTS schema_migrations (id int PRIMARY KEY)');
  const done = new Set((await q('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (done.has(i + 1)) continue;
    await tx(async (c) => {
      await c.query(MIGRATIONS[i]);
      await c.query('INSERT INTO schema_migrations (id) VALUES ($1)', [i + 1]);
    });
    console.log(`migration ${i + 1} applied`);
  }
}

module.exports = { pool, q, tx, migrate };
