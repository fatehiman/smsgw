'use strict';
// Public API: /api/v1/*  (Bearer token). Docs: API.md
const { q } = require('./db');
const providers = require('./providers');
const ratelimit = require('./ratelimit');
const sms = require('./sms');
const webhooks = require('./webhooks');
const { ApiError, sha256, randomHex, readBody, parseBody } = require('./util');

// Failed-auth throttle per IP (memory only): 30 bad tokens a minute -> 429.
const authFails = new Map();
function failedTooMuch(ip) {
  const e = authFails.get(ip);
  return e && e.reset > Date.now() && e.count >= 30;
}
function noteFail(ip) {
  const now = Date.now();
  const e = authFails.get(ip);
  if (!e || e.reset <= now) authFails.set(ip, { count: 1, reset: now + 60000 });
  else e.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authFails) if (v.reset <= now) authFails.delete(k);
}, 60000).unref();

const lastUsed = new Map();

async function authenticate(req, ip) {
  if (failedTooMuch(ip)) throw new ApiError(429, 'too_many_failures', 'Too many invalid tokens from this IP. Try again in a minute.');
  const h = req.headers.authorization || '';
  const raw = /^Bearer\s+(\S+)$/i.exec(h)?.[1] || req.headers['x-api-key'];
  if (!raw || typeof raw !== 'string') {
    noteFail(ip);
    throw new ApiError(401, 'missing_token', 'Send your API token as "Authorization: Bearer <token>"');
  }
  const token = (await q('SELECT * FROM api_tokens WHERE token_hash=$1', [sha256(raw)])).rows[0];
  if (!token || !token.enabled) {
    noteFail(ip);
    throw new ApiError(401, 'invalid_token', 'The API token is not valid');
  }
  if (Date.now() - (lastUsed.get(token.id) || 0) > 60000) {
    lastUsed.set(token.id, Date.now());
    q('UPDATE api_tokens SET last_used_at = now() WHERE id=$1', [token.id]).catch(() => {});
  }
  return token;
}

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

async function providerView(token, p, globalDefaultId, allowed) {
  const driver = providers.get(p.driver);
  const out = {
    slug: p.slug,
    name: p.name,
    type: driver?.type ?? 'unknown',
    is_default: sms.effectiveDefault(token, allowed, globalDefaultId)?.id === p.id,
  };
  if (out.type === 'template') {
    out.templates = (await q('SELECT code, name, param_names FROM templates WHERE provider_id=$1 ORDER BY code', [p.id]))
      .rows.map((t) => ({ template: t.code, name: t.name, params: t.param_names }));
  }
  return out;
}

const hookView = (w, withSecret) => ({
  id: w.id, url: w.url, events: w.events, enabled: w.enabled, created_at: w.created_at,
  ...(withSecret ? { secret: w.secret } : {}),
});

async function ownHook(token, id) {
  const w = (await q('SELECT * FROM webhooks WHERE id=$1 AND token_id=$2', [Number(id) || 0, token.id])).rows[0];
  if (!w) throw new ApiError(404, 'not_found', 'Webhook not found');
  return w;
}

function validateHook(body, partial) {
  const out = {};
  if (!partial || body.url !== undefined) {
    if (typeof body.url !== 'string') throw new ApiError(422, 'invalid_url', '"url" is required');
    const bad = webhooks.checkUrlSyntax(body.url);
    if (bad) throw new ApiError(422, 'invalid_url', bad);
    out.url = body.url;
  }
  if (body.events !== undefined) {
    const ev = [].concat(body.events);
    if (!ev.length || ev.some((e) => !webhooks.EVENTS.includes(e))) {
      throw new ApiError(422, 'invalid_events', `"events" must be a list of: ${webhooks.EVENTS.join(', ')}`);
    }
    out.events = [...new Set(ev)];
  }
  if (body.enabled !== undefined) out.enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
  return out;
}

// routes: [method, regex, handler(ctx)]; ctx = { token, req, body, query, params, ip }
const routes = [
  ['GET', /^\/api\/v1\/me$/, async ({ token }) => {
    const allowed = await sms.allowedProviders(token.id);
    const globalDefault = (await q('SELECT id FROM providers WHERE is_default AND enabled')).rows[0]?.id ?? null;
    return {
      name: token.name,
      default_provider: sms.effectiveDefault(token, allowed, globalDefault)?.slug ?? null,
      providers: allowed.map((p) => p.slug),
    };
  }],

  ['GET', /^\/api\/v1\/usage$/, async ({ token, ip }) => ({ ip, limits: await ratelimit.usage(token, ip) })],

  ['GET', /^\/api\/v1\/providers$/, async ({ token }) => {
    const allowed = await sms.allowedProviders(token.id);
    const globalDefault = (await q('SELECT id FROM providers WHERE is_default AND enabled')).rows[0]?.id ?? null;
    return { providers: await Promise.all(allowed.map((p) => providerView(token, p, globalDefault, allowed))) };
  }],

  ['GET', /^\/api\/v1\/providers\/([\w-]+)\/templates$/, async ({ token, params }) => {
    const allowed = await sms.allowedProviders(token.id);
    const p = allowed.find((x) => x.slug === params[0]);
    if (!p) throw new ApiError(404, 'not_found', 'Provider not found for this API key');
    const v = await providerView(token, p, null, allowed);
    if (v.type !== 'template') throw new ApiError(422, 'template_not_supported', `Provider "${p.slug}" sends free text and has no templates`);
    return { templates: v.templates };
  }],

  ['POST', /^\/api\/v1\/sms(?:\/send)?$/, async ({ token, body }) => ({ message: await sms.sendSms(token, body) }), 201],

  ['GET', /^\/api\/v1\/sms$/, async ({ token, query }) => {
    const limit = clampInt(query.limit, 50, 1, 200);
    const before = clampInt(query.before_id, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const args = [token.id, before, limit];
    let status = '';
    if (query.status) { args.push(String(query.status)); status = 'AND m.status = $4'; }
    const rows = (await q(
      `${sms.SELECT} WHERE m.token_id=$1 AND m.direction='out' AND m.id < $2 ${status} ORDER BY m.id DESC LIMIT $3`, args,
    )).rows;
    return { messages: rows.map(sms.present) };
  }],

  ['GET', /^\/api\/v1\/sms\/(\d+)$/, async ({ token, params }) => {
    const m = await sms.getMessage(token.id, Number(params[0]));
    if (!m || m.direction !== 'out') throw new ApiError(404, 'not_found', 'Message not found');
    return { message: m };
  }],

  // Fetch received SMS. unread=1: only new ones. ack=1: mark what is returned as read.
  ['GET', /^\/api\/v1\/inbox$/, async ({ token, query }) => {
    const limit = clampInt(query.limit, 50, 1, 200);
    const after = clampInt(query.after_id, 0, 0, Number.MAX_SAFE_INTEGER);
    const unread = ['1', 'true'].includes(String(query.unread)) ? 'AND m.read_at IS NULL' : '';
    const rows = (await q(
      `${sms.SELECT} WHERE m.token_id=$1 AND m.direction='in' AND m.id > $2 ${unread} ORDER BY m.id ASC LIMIT $3`,
      [token.id, after, limit],
    )).rows;
    if (['1', 'true'].includes(String(query.ack)) && rows.length) {
      await q('UPDATE messages SET read_at = now() WHERE token_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [token.id, rows.map((r) => r.id)]);
    }
    return { messages: rows.map(sms.present) };
  }],

  ['POST', /^\/api\/v1\/inbox\/ack$/, async ({ token, body }) => {
    let r;
    if (Number.isInteger(body.up_to_id)) {
      r = await q(`UPDATE messages SET read_at=now() WHERE token_id=$1 AND direction='in' AND id <= $2 AND read_at IS NULL`, [token.id, body.up_to_id]);
    } else if (Array.isArray(body.ids) && body.ids.every(Number.isInteger)) {
      r = await q(`UPDATE messages SET read_at=now() WHERE token_id=$1 AND direction='in' AND id = ANY($2::bigint[]) AND read_at IS NULL`, [token.id, body.ids]);
    } else {
      throw new ApiError(422, 'invalid_body', 'Send {"ids":[1,2]} or {"up_to_id":10}');
    }
    return { acknowledged: r.rowCount };
  }],

  ['GET', /^\/api\/v1\/webhooks$/, async ({ token }) => ({
    webhooks: (await q('SELECT * FROM webhooks WHERE token_id=$1 ORDER BY id', [token.id])).rows.map((w) => hookView(w, false)),
  })],

  ['POST', /^\/api\/v1\/webhooks$/, async ({ token, body }) => {
    const n = (await q('SELECT count(*)::int AS n FROM webhooks WHERE token_id=$1', [token.id])).rows[0].n;
    if (n >= 10) throw new ApiError(409, 'too_many_webhooks', 'At most 10 webhooks per API key');
    const v = validateHook(body, false);
    const w = (await q(
      'INSERT INTO webhooks (token_id, url, secret, events) VALUES ($1,$2,$3,$4) RETURNING *',
      [token.id, v.url, randomHex(24), v.events || webhooks.EVENTS],
    )).rows[0];
    return { webhook: hookView(w, true) };
  }, 201],

  ['GET', /^\/api\/v1\/webhooks\/(\d+)$/, async ({ token, params }) => ({ webhook: hookView(await ownHook(token, params[0]), false) })],

  ['PATCH', /^\/api\/v1\/webhooks\/(\d+)$/, async ({ token, params, body }) => {
    const w = await ownHook(token, params[0]);
    const v = validateHook(body, true);
    const r = (await q(
      'UPDATE webhooks SET url=$2, events=$3, enabled=$4 WHERE id=$1 RETURNING *',
      [w.id, v.url ?? w.url, v.events ?? w.events, v.enabled ?? w.enabled],
    )).rows[0];
    return { webhook: hookView(r, false) };
  }],

  ['DELETE', /^\/api\/v1\/webhooks\/(\d+)$/, async ({ token, params }) => {
    const w = await ownHook(token, params[0]);
    await q('DELETE FROM webhooks WHERE id=$1', [w.id]);
    return { deleted: true };
  }],

  ['POST', /^\/api\/v1\/webhooks\/(\d+)\/test$/, async ({ token, params }) => {
    const w = await ownHook(token, params[0]);
    let code = null;
    let error = null;
    try {
      code = await webhooks.deliver(w, { event: 'ping', created_at: new Date().toISOString(), data: { webhook_id: w.id } });
    } catch (e) { error = e.cause?.code || e.message; }
    return { delivered: code !== null && code >= 200 && code < 300, http_status: code, error };
  }],
];

async function handle(req, res, url, ip, send) {
  const json = (status, obj, headers = {}) => send(status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  let extra = {};
  try {
    const path = url.pathname.replace(/\/+$/, '');
    const matches = routes.filter((r) => r[1].test(path));
    if (!matches.length) return json(404, { ok: false, error: { code: 'not_found', message: 'Not found' } });
    const route = matches.find((r) => r[0] === req.method);
    if (!route) {
      return json(405, { ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { Allow: matches.map((m) => m[0]).join(', ') });
    }

    const token = await authenticate(req, ip);
    const rl = await ratelimit.hit(token, ip);
    extra = rl.headers;
    if (!rl.allowed) {
      return json(429, { ok: false, error: { code: 'rate_limited', message: 'Rate limit exceeded', retry_after: rl.retryAfter } }, extra);
    }

    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) body = parseBody(await readBody(req), req.headers['content-type']);
    const result = await route[2]({ token, req, body, query: Object.fromEntries(url.searchParams), params: path.match(route[1]).slice(1), ip });
    return json(route[3] || 200, { ok: true, ...result }, extra);
  } catch (e) {
    if (e instanceof ApiError) {
      const headers = e.status === 429 ? { 'Retry-After': '60', ...extra } : extra;
      return json(e.status, { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, headers);
    }
    console.error('api error:', e);
    return json(500, { ok: false, error: { code: 'internal_error', message: 'Internal error' } }, extra);
  }
}

module.exports = { handle };
