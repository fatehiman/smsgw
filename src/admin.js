'use strict';
// Admin panel: /mainadmin  (single user, cookie session, CSRF token on every POST)
const { q, tx } = require('./db');
const config = require('./config');
const providers = require('./providers');
const settings = require('./settings');
const webhooks = require('./webhooks');
const ui = require('./admin-ui');
const {
  ApiError, sha256, hmac, randomToken, randomHex, safeEqual, verifyPassword, readBody, parseBody,
} = require('./util');

const { esc, ib, postBtn, badge, fmtTime } = ui;
const SESSION_TTL = 8 * 3600;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

// ---------- session ----------
const sign = (v) => hmac(config.sessionSecret, v);

function newSession() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const nonce = randomHex(12);
  return `${exp}.${nonce}.${sign(`${exp}.${nonce}`)}`;
}

function readSession(req) {
  const m = /(?:^|;\s*)gw_sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m || !config.sessionSecret) return null;
  const [exp, nonce, mac] = m[1].split('.');
  if (!exp || !nonce || !mac || !safeEqual(mac, sign(`${exp}.${nonce}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return { value: m[1], csrf: sign(`csrf.${m[1]}`).slice(0, 32) };
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || req.headers['x-gw-scheme'] === 'https';
function cookie(req, value, maxAge) {
  return `gw_sid=${value}; Path=/mainadmin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// ---------- login throttle (memory) ----------
const fails = new Map();
const locked = (ip) => { const e = fails.get(ip); return e && e.until > Date.now() && e.count >= 5; };
function noteLoginFail(ip) {
  const now = Date.now();
  const e = fails.get(ip);
  if (!e || e.until <= now) fails.set(ip, { count: 1, until: now + 15 * 60000 });
  else e.count++;
}

// ---------- response helpers ----------
const html = (body, status = 200) => ({ status, body, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const redirect = (to, extra = {}) => ({ status: 303, body: '', headers: { Location: to, ...extra } });
const back = (to, ok, err) => redirect(`${to}${to.includes('?') ? '&' : '?'}${ok ? `ok=${encodeURIComponent(ok)}` : `err=${encodeURIComponent(err)}`}`);

const flash = (url) => {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  return (ok ? `<div class="msg">${esc(ok)}</div>` : '') + (err ? `<div class="msg err">${esc(err)}</div>` : '');
};
const page = (ctx, title, body, nav) => html(ui.layout(title, `<main>${flash(ctx.url)}${body}</main>`, { nav, csrf: ctx.s.csrf }));
const hidden = (ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.s.csrf)}">`;
const arr = (v) => (v === undefined ? [] : [].concat(v));
const intOrNull = (v) => {
  if (v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e9) throw new ApiError(422, 'invalid', 'Limits must be whole numbers, 0 or more');
  return n;
};

// ---------- login ----------
function loginPage(msg) {
  return html(ui.layout('Login', `<div class="login"><h1>SMS Gateway</h1>${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}
    <form method="post" action="/mainadmin/login" class="card">
    <label for="u">User name</label><input id="u" type="text" name="username" autocomplete="username" autofocus>
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password">
    <button class="btn txt-btn" type="submit">Log in</button></form></div>`), msg ? 401 : 200);
}

async function doLogin(req, ctx) {
  if (locked(ctx.ip)) return html(ui.layout('Login', '<div class="login"><div class="msg err">Too many attempts. Try again in 15 minutes.</div></div>'), 429);
  const okUser = safeEqual(ctx.body.username || '', config.adminUser);
  const okPass = config.adminPassHash ? verifyPassword(ctx.body.password || '', config.adminPassHash) : false;
  if (!(okUser && okPass)) {
    noteLoginFail(ctx.ip);
    return loginPage('Wrong user name or password');
  }
  fails.delete(ctx.ip);
  return redirect('/mainadmin', { 'Set-Cookie': cookie(req, newSession(), SESSION_TTL) });
}

// ---------- settings forms for a driver ----------
function settingFields(driver, values = {}) {
  return driver.settings.map((f) => {
    const id = `s_${f.key}`;
    const v = values[f.key] ?? f.default ?? '';
    const help = f.help ? `<div class="help">${esc(f.help)}</div>` : '';
    let input;
    if (f.type === 'select') {
      input = `<select id="${id}" name="${id}">${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea id="${id}" name="${id}">${esc(v)}</textarea>`;
    } else if (f.type === 'password') {
      input = `<input id="${id}" type="password" name="${id}" autocomplete="new-password" placeholder="${values[f.key] ? '•••••• saved — leave empty to keep' : ''}">`;
    } else {
      input = `<input id="${id}" type="text" name="${id}" value="${esc(v)}">`;
    }
    return `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${help}`;
  }).join('');
}

function readSettings(driver, body, old = {}) {
  const out = {};
  for (const f of driver.settings) {
    let v = body[`s_${f.key}`];
    v = v === undefined ? '' : String(v);
    if (f.type === 'password' && v === '') v = old[f.key] || '';
    if (f.required && !v.trim()) throw new ApiError(422, 'invalid', `"${f.label}" is required`);
    out[f.key] = v;
  }
  return out;
}

// ---------- pages ----------
const routes = [];
const route = (method, re, fn) => routes.push([method, re, fn]);

route('GET', /^\/mainadmin$/, async (ctx) => {
  const c = (await q(`SELECT
    (SELECT count(*) FROM providers)::int AS providers, (SELECT count(*) FROM api_tokens)::int AS tokens,
    (SELECT count(*) FROM messages WHERE direction='out' AND created_at > now() - interval '24 hours')::int AS sent,
    (SELECT count(*) FROM messages WHERE direction='out' AND status='failed' AND created_at > now() - interval '24 hours')::int AS failed,
    (SELECT count(*) FROM messages WHERE direction='in' AND created_at > now() - interval '24 hours')::int AS received,
    (SELECT count(*) FROM webhook_deliveries WHERE status='pending')::int AS pending`)).rows[0];
  const rows = (await q(messageSql('', 10), [])).rows;
  return page(ctx, 'Dashboard', `<h1>Dashboard</h1><div class="grid">
    <div class="stat"><b>${c.providers}</b><span>providers</span></div><div class="stat"><b>${c.tokens}</b><span>API tokens</span></div>
    <div class="stat"><b>${c.sent}</b><span>sent, 24 h</span></div><div class="stat"><b>${c.failed}</b><span>failed, 24 h</span></div>
    <div class="stat"><b>${c.received}</b><span>received, 24 h</span></div><div class="stat"><b>${c.pending}</b><span>webhooks waiting</span></div></div>
    <h2>Latest messages</h2><div class="card">${messageTable(rows)}</div>`, 'home');
});

// --- providers
route('GET', /^\/mainadmin\/providers$/, async (ctx) => {
  const rows = (await q(`SELECT p.*, (SELECT count(*) FROM templates t WHERE t.provider_id=p.id)::int AS tpl FROM providers p ORDER BY p.id`)).rows;
  const drivers = providers.list();
  const trs = rows.map((p) => {
    const d = providers.get(p.driver);
    return `<tr><td><b>${esc(p.name)}</b><div class="muted mono">${esc(p.slug)}</div></td>
      <td>${esc(d?.label || p.driver + ' (missing driver)')}</td>
      <td>${badge(d?.type || '?', d?.type === 'template' ? 'info' : '')}</td>
      <td>${p.enabled ? badge('enabled', 'ok') : badge('disabled', 'warn')}</td>
      <td>${p.is_default ? badge('default', 'info') : postBtn(`/mainadmin/providers/${p.id}/default`, ctx.s.csrf, 'star', 'Make default provider', 'amber')}</td>
      <td>${d?.type === 'template' ? p.tpl : '—'}</td>
      <td><div class="row-actions">${ib('pencil', 'Edit provider', 'amber', { href: `/mainadmin/providers/${p.id}` })}
        ${postBtn(`/mainadmin/providers/${p.id}/delete`, ctx.s.csrf, 'trash', 'Delete provider', 'red', `Delete provider ${p.name}?`)}</div></td></tr>`;
  }).join('');
  const options = drivers.map((d) => `<option value="${esc(d.driver)}">${esc(d.label)} — ${d.type}</option>`).join('');
  return page(ctx, 'Providers', `<h1>Providers</h1><div class="card"><table><tr><th>Name</th><th>Driver</th><th>Type</th><th>State</th><th>Default</th><th>Templates</th><th></th></tr>${trs || '<tr><td colspan="7" class="muted">No providers yet.</td></tr>'}</table></div>
    <h2>Add provider</h2><form class="card" method="get" action="/mainadmin/providers/new"><label for="d">Driver</label><select id="d" name="driver">${options}</select>
    <div><button class="btn txt-btn" type="submit">Continue</button></div></form>`, 'providers');
});

route('GET', /^\/mainadmin\/providers\/new$/, async (ctx) => {
  const d = providers.get(ctx.url.searchParams.get('driver'));
  if (!d) return back('/mainadmin/providers', null, 'Unknown driver');
  return page(ctx, 'New provider', `<h1>New provider — ${esc(d.label)}</h1><form class="card" method="post" action="/mainadmin/providers">${hidden(ctx)}
    <input type="hidden" name="driver" value="${esc(d.driver)}">
    <label for="slug">Short name (used in the API as "provider") *</label><input id="slug" type="text" name="slug" placeholder="e.g. kavenegar-main">
    <div class="help">Lower case letters, digits and dashes. Cannot be changed later.</div>
    <label for="name">Display name *</label><input id="name" type="text" name="name" placeholder="e.g. Kavenegar main line">
    ${settingFields(d)}<button class="btn txt-btn" type="submit">Create</button></form>`, 'providers');
});

route('POST', /^\/mainadmin\/providers$/, async (ctx) => {
  const d = providers.get(ctx.body.driver);
  if (!d) throw new ApiError(422, 'invalid', 'Unknown driver');
  const slug = String(ctx.body.slug || '').trim();
  const name = String(ctx.body.name || '').trim();
  if (!SLUG_RE.test(slug)) throw new ApiError(422, 'invalid', 'Short name: 2-31 characters, lower case letters, digits, dashes');
  if (!name) throw new ApiError(422, 'invalid', 'Display name is required');
  const s = readSettings(d, ctx.body);
  const none = (await q('SELECT count(*)::int AS n FROM providers')).rows[0].n === 0;
  let row;
  try {
    row = (await q('INSERT INTO providers (slug, name, driver, settings, inbound_secret, is_default) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [slug, name, d.driver, s, randomHex(16), none])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new ApiError(409, 'invalid', `Short name "${slug}" is already used`);
    throw e;
  }
  return back(`/mainadmin/providers/${row.id}`, 'Provider created', null);
});

async function loadProvider(id) {
  const p = (await q('SELECT * FROM providers WHERE id=$1', [Number(id) || 0])).rows[0];
  if (!p) throw new ApiError(404, 'not_found', 'Provider not found');
  return p;
}

route('GET', /^\/mainadmin\/providers\/(\d+)$/, async (ctx) => {
  const p = await loadProvider(ctx.params[0]);
  const d = providers.get(p.driver);
  if (!d) return back('/mainadmin/providers', null, `Driver "${p.driver}" is not installed`);
  const host = ctx.req.headers.host || 'smsgw.kimiasoft.ir';
  const proto = isHttps(ctx.req) || !/^(localhost|127\.)/.test(host) ? 'https' : 'http';
  const hook = `${proto}://${host}/hook/${p.slug}/${p.inbound_secret}`;
  let tpl = '';
  if (d.type === 'template') {
    const ts = (await q('SELECT * FROM templates WHERE provider_id=$1 ORDER BY code', [p.id])).rows;
    const rowsHtml = ts.map((t) => `<tr><td colspan="4"><form class="inline-form" method="post" action="/mainadmin/templates/${t.id}" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      ${hidden(ctx)}<input type="text" name="code" value="${esc(t.code)}" style="max-width:130px" aria-label="Template ID">
      <input type="text" name="name" value="${esc(t.name)}" style="max-width:170px" aria-label="Name">
      <input type="text" name="params" value="${esc(t.param_names.join(', '))}" style="max-width:190px" aria-label="Parameters" placeholder="code, name">
      <input type="text" name="body" value="${esc(t.body)}" style="max-width:260px" aria-label="Preview text" placeholder="optional preview text">
      ${ib('pencil', 'Save template', 'amber')}</form>
      <form method="post" action="/mainadmin/templates/${t.id}/delete" class="inline" style="margin-top:4px">${hidden(ctx)}${ib('trash', 'Delete template', 'red', { confirm: 'Delete this template?' })}</form></td></tr>`).join('');
    tpl = `<h2>Templates</h2><div class="card"><p class="muted">This provider sends a template ID and parameters, not free text. API callers must use these.
      Parameter names: comma separated, in the order the provider expects them.</p>
      <table><tr><th>Template ID</th><th>Name</th><th>Parameters</th><th>Preview text</th></tr>${rowsHtml || '<tr><td colspan="4" class="muted">No templates yet. Callers cannot send until you add one.</td></tr>'}</table>
      <form method="post" action="/mainadmin/providers/${p.id}/templates" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:12px">${hidden(ctx)}
      <input type="text" name="code" placeholder="Template ID, e.g. verify" style="max-width:150px" aria-label="Template ID">
      <input type="text" name="name" placeholder="Name" style="max-width:170px" aria-label="Name">
      <input type="text" name="params" placeholder="Params, e.g. code, minutes" style="max-width:200px" aria-label="Parameters">
      <input type="text" name="body" placeholder="Preview text (optional)" style="max-width:240px" aria-label="Preview text">${ib('plus', 'Add template', 'green')}</form></div>`;
  }
  return page(ctx, p.name, `<h1>${esc(p.name)} ${badge(d.type, d.type === 'template' ? 'info' : '')}</h1>
    <form class="card" method="post" action="/mainadmin/providers/${p.id}">${hidden(ctx)}
    <div class="muted">Short name: <span class="mono">${esc(p.slug)}</span> · Driver: ${esc(d.label)}</div>
    <label for="name">Display name *</label><input id="name" type="text" name="name" value="${esc(p.name)}">
    <label class="check"><input type="checkbox" name="enabled" value="1" ${p.enabled ? 'checked' : ''}> Enabled</label>
    ${settingFields(d, p.settings)}<button class="btn txt-btn" type="submit">Save</button></form>
    <h2>Incoming SMS (provider → gateway)</h2><div class="card"><p class="muted">Give this URL to the provider as its "receive SMS" / delivery-report webhook.</p>
    <div class="secret">${esc(hook)}</div>
    <div class="row-actions" style="margin-top:8px">${postBtn(`/mainadmin/providers/${p.id}/rotate-hook`, ctx.s.csrf, 'refresh', 'Make a new secret URL (the old one stops working)', 'blue', 'The old URL will stop working. Continue?')}</div></div>
    ${tpl}`, 'providers');
});

route('POST', /^\/mainadmin\/providers\/(\d+)$/, async (ctx) => {
  const p = await loadProvider(ctx.params[0]);
  const d = providers.get(p.driver);
  const name = String(ctx.body.name || '').trim();
  if (!name) throw new ApiError(422, 'invalid', 'Display name is required');
  const s = readSettings(d, ctx.body, p.settings);
  await q('UPDATE providers SET name=$2, enabled=$3, settings=$4 WHERE id=$1', [p.id, name, ctx.body.enabled === '1', s]);
  return back(`/mainadmin/providers/${p.id}`, 'Saved', null);
});

route('POST', /^\/mainadmin\/providers\/(\d+)\/default$/, async (ctx) => {
  const p = await loadProvider(ctx.params[0]);
  await tx(async (c) => {
    await c.query('UPDATE providers SET is_default=false WHERE is_default');
    await c.query('UPDATE providers SET is_default=true WHERE id=$1', [p.id]);
  });
  return back('/mainadmin/providers', `"${p.name}" is now the default provider`, null);
});

route('POST', /^\/mainadmin\/providers\/(\d+)\/rotate-hook$/, async (ctx) => {
  const p = await loadProvider(ctx.params[0]);
  await q('UPDATE providers SET inbound_secret=$2 WHERE id=$1', [p.id, randomHex(16)]);
  return back(`/mainadmin/providers/${p.id}`, 'New incoming URL created', null);
});

route('POST', /^\/mainadmin\/providers\/(\d+)\/delete$/, async (ctx) => {
  const p = await loadProvider(ctx.params[0]);
  await q('DELETE FROM providers WHERE id=$1', [p.id]);
  return back('/mainadmin/providers', `Provider "${p.name}" deleted`, null);
});

// --- templates
function readTemplate(body) {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim() || code;
  if (!code || code.length > 100) throw new ApiError(422, 'invalid', 'Template ID is required (max 100 characters)');
  const names = String(body.params || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.some((n) => !/^[A-Za-z0-9_]{1,40}$/.test(n))) throw new ApiError(422, 'invalid', 'Parameter names: letters, digits, underscore');
  if (new Set(names).size !== names.length) throw new ApiError(422, 'invalid', 'Parameter names must be different');
  return { code, name, names, body: String(body.body || '') };
}

route('POST', /^\/mainadmin\/providers\/(\d+)\/templates$/, async (ctx) => {
  const p = await loadProvider(ctx.params[0]);
  const t = readTemplate(ctx.body);
  try {
    await q('INSERT INTO templates (provider_id, code, name, body, param_names) VALUES ($1,$2,$3,$4,$5)', [p.id, t.code, t.name, t.body, t.names]);
  } catch (e) {
    if (e.code === '23505') throw new ApiError(409, 'invalid', `Template "${t.code}" already exists`);
    throw e;
  }
  return back(`/mainadmin/providers/${p.id}`, 'Template added', null);
});

route('POST', /^\/mainadmin\/templates\/(\d+)$/, async (ctx) => {
  const old = (await q('SELECT * FROM templates WHERE id=$1', [Number(ctx.params[0])])).rows[0];
  if (!old) throw new ApiError(404, 'not_found', 'Template not found');
  const t = readTemplate(ctx.body);
  try {
    await q('UPDATE templates SET code=$2, name=$3, body=$4, param_names=$5 WHERE id=$1', [old.id, t.code, t.name, t.body, t.names]);
  } catch (e) {
    if (e.code === '23505') throw new ApiError(409, 'invalid', `Template "${t.code}" already exists`);
    throw e;
  }
  return back(`/mainadmin/providers/${old.provider_id}`, 'Template saved', null);
});

route('POST', /^\/mainadmin\/templates\/(\d+)\/delete$/, async (ctx) => {
  const old = (await q('DELETE FROM templates WHERE id=$1 RETURNING provider_id', [Number(ctx.params[0])])).rows[0];
  return back(old ? `/mainadmin/providers/${old.provider_id}` : '/mainadmin/providers', 'Template deleted', null);
});

// --- API tokens
async function tokenForm(ctx, t, allProviders, linked) {
  const checks = allProviders.map((p) => {
    const d = providers.get(p.driver);
    return `<label class="check"><input type="checkbox" name="providers" value="${p.id}" ${linked.includes(p.id) ? 'checked' : ''}> ${esc(p.name)} <span class="muted mono">${esc(p.slug)}</span> ${badge(d?.type || '?', d?.type === 'template' ? 'info' : '')}${p.is_default ? badge('global default', 'warn') : ''}${p.enabled ? '' : badge('disabled', 'bad')}</label>`;
  }).join('');
  const opts = `<option value="">(automatic)</option>${allProviders.map((p) => `<option value="${p.id}" ${t.default_provider_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  const lim = (k, label) => `<div><label for="l${k}">${label}</label><input id="l${k}" type="number" min="0" name="limit_${k}" value="${t[`limit_${k}`] ?? ''}" placeholder="default" style="max-width:130px"></div>`;
  return `<label for="name">Name (project) *</label><input id="name" type="text" name="name" value="${esc(t.name || '')}" placeholder="e.g. Shop website">
    <label>Providers this key may use</label>${checks || '<div class="muted">Add a provider first.</div>'}
    <label for="dp">Default provider for this key</label><select id="dp" name="default_provider_id">${opts}</select>
    <div class="help">Automatic = the global default provider if this key may use it, otherwise the first provider ticked above.</div>
    <label for="inn">Incoming numbers (optional)</label><input id="inn" type="text" name="inbound_numbers" value="${esc((t.inbound_numbers || []).join(', '))}" placeholder="e.g. 3000123, 0912...">
    <div class="help">SMS received on these line numbers go to this key. Other replies go to the key that last sent to that sender.</div>
    <label>Rate limits for this key, per caller IP (empty = global default, 0 = no limit)</label>
    <div style="display:flex;gap:12px;flex-wrap:wrap">${lim('minute', 'Per minute')}${lim('hour', 'Per hour')}${lim('day', 'Per day')}</div>`;
}

route('GET', /^\/mainadmin\/tokens$/, async (ctx) => {
  const defaults = await settings.getLimits();
  const rows = (await q(`SELECT t.*, dp.name AS dp_name,
    COALESCE((SELECT string_agg(p.slug, ', ' ORDER BY tp.position, p.id) FROM token_providers tp JOIN providers p ON p.id=tp.provider_id WHERE tp.token_id=t.id), '') AS provs
    FROM api_tokens t LEFT JOIN providers dp ON dp.id=t.default_provider_id ORDER BY t.id`)).rows;
  const lim = (own, def) => (own === null ? `${def}*` : own === 0 ? '∞' : own);
  const trs = rows.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="muted mono">${esc(t.token_prefix)}…</div></td>
    <td class="mono">${esc(t.provs) || '—'}</td><td>${esc(t.dp_name || 'auto')}</td>
    <td class="mono">${lim(t.limit_minute, defaults.minute)} / ${lim(t.limit_hour, defaults.hour)} / ${lim(t.limit_day, defaults.day)}</td>
    <td>${t.enabled ? badge('active', 'ok') : badge('off', 'bad')}</td><td class="muted">${fmtTime(t.last_used_at)}</td>
    <td><div class="row-actions">${ib('pencil', 'Edit key and webhooks', 'amber', { href: `/mainadmin/tokens/${t.id}` })}
    ${postBtn(`/mainadmin/tokens/${t.id}/rotate`, ctx.s.csrf, 'key', 'Rotate token (old token stops working now)', 'purple', 'Rotate this token? The old token stops working immediately.')}
    ${postBtn(`/mainadmin/tokens/${t.id}/toggle`, ctx.s.csrf, 'power', t.enabled ? 'Turn off' : 'Turn on', 'gray')}
    ${postBtn(`/mainadmin/tokens/${t.id}/delete`, ctx.s.csrf, 'trash', 'Delete key', 'red', `Delete key ${t.name}?`)}</div></td></tr>`).join('');
  return page(ctx, 'API tokens', `<h1>API tokens ${ib('plus', 'New API token', 'green', { href: '/mainadmin/tokens/new' })}</h1>
    <div class="card"><table><tr><th>Name</th><th>Providers</th><th>Default</th><th>Limits min/hour/day</th><th>State</th><th>Last used</th><th></th></tr>${trs || '<tr><td colspan="7" class="muted">No API tokens yet.</td></tr>'}</table>
    <div class="help">* = global default. ∞ = no limit.</div></div>`, 'tokens');
});

route('GET', /^\/mainadmin\/tokens\/new$/, async (ctx) => {
  const all = (await q('SELECT * FROM providers ORDER BY id')).rows;
  return page(ctx, 'New API token', `<h1>New API token</h1><form class="card" method="post" action="/mainadmin/tokens">${hidden(ctx)}
    ${await tokenForm(ctx, {}, all, all.map((p) => p.id))}<button class="btn txt-btn" type="submit">Create</button></form>`, 'tokens');
});

async function readTokenForm(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 100) throw new ApiError(422, 'invalid', 'Name is required (max 100 characters)');
  const ids = arr(body.providers).map(Number).filter(Number.isInteger);
  const valid = ids.length ? (await q('SELECT id FROM providers WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows.map((r) => r.id) : [];
  const dp = body.default_provider_id ? Number(body.default_provider_id) : null;
  return {
    name,
    providerIds: valid,
    defaultId: dp && valid.includes(dp) ? dp : null,
    numbers: String(body.inbound_numbers || '').split(/[,\s]+/).filter(Boolean).slice(0, 20),
    lm: intOrNull(body.limit_minute),
    lh: intOrNull(body.limit_hour),
    ld: intOrNull(body.limit_day),
  };
}

async function saveLinks(c, tokenId, ids) {
  await c.query('DELETE FROM token_providers WHERE token_id=$1', [tokenId]);
  for (let i = 0; i < ids.length; i++) await c.query('INSERT INTO token_providers (token_id, provider_id, position) VALUES ($1,$2,$3)', [tokenId, ids[i], i]);
}

const showToken = (ctx, title, name, token) => html(ui.layout(title, `<main><h1>${esc(title)}</h1><div class="card">
  <p>API token for <b>${esc(name)}</b>. <b>Copy it now. It is shown only once</b> and only a hash is stored.</p>
  <div class="secret" id="tk">${esc(token)}</div>
  <p class="muted">Use it like this: <span class="mono">Authorization: Bearer ${esc(token.slice(0, 8))}…</span></p>
  <p><a href="/mainadmin/tokens">Back to API tokens</a></p></div></main>`, { nav: 'tokens', csrf: ctx.s.csrf }));

route('POST', /^\/mainadmin\/tokens$/, async (ctx) => {
  const f = await readTokenForm(ctx.body);
  const token = randomToken();
  const id = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO api_tokens (name, token_hash, token_prefix, default_provider_id, inbound_numbers, limit_minute, limit_hour, limit_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [f.name, sha256(token), token.slice(0, 8), f.defaultId, f.numbers, f.lm, f.lh, f.ld],
    );
    await saveLinks(c, r.rows[0].id, f.providerIds);
    return r.rows[0].id;
  });
  return showToken(ctx, 'API token created', f.name, token);
});

async function loadToken(id) {
  const t = (await q('SELECT * FROM api_tokens WHERE id=$1', [Number(id) || 0])).rows[0];
  if (!t) throw new ApiError(404, 'not_found', 'API token not found');
  return t;
}

route('GET', /^\/mainadmin\/tokens\/(\d+)$/, async (ctx) => {
  const t = await loadToken(ctx.params[0]);
  const all = (await q('SELECT * FROM providers ORDER BY id')).rows;
  const linked = (await q('SELECT provider_id FROM token_providers WHERE token_id=$1', [t.id])).rows.map((r) => r.provider_id);
  const hooks = (await q(`SELECT w.*, (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='failed')::int AS failed,
    (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='pending')::int AS pending FROM webhooks w WHERE w.token_id=$1 ORDER BY w.id`, [t.id])).rows;
  const hrows = hooks.map((w) => `<tr><td class="mono">${esc(w.url)}</td><td class="mono">${esc(w.events.join(', '))}</td>
    <td>${w.enabled ? badge('on', 'ok') : badge('off', 'bad')} ${w.pending ? badge(`${w.pending} waiting`, 'warn') : ''}${w.failed ? badge(`${w.failed} failed`, 'bad') : ''}</td>
    <td class="mono muted" title="Signing secret (HMAC-SHA256)">${esc(w.secret)}</td>
    <td><div class="row-actions">${postBtn(`/mainadmin/webhooks/${w.id}/toggle`, ctx.s.csrf, 'power', w.enabled ? 'Turn off' : 'Turn on', 'gray')}
    ${postBtn(`/mainadmin/webhooks/${w.id}/delete`, ctx.s.csrf, 'trash', 'Delete webhook', 'red', 'Delete this webhook?')}</div></td></tr>`).join('');
  return page(ctx, t.name, `<h1>${esc(t.name)} <span class="muted mono">${esc(t.token_prefix)}…</span></h1>
    <form class="card" method="post" action="/mainadmin/tokens/${t.id}">${hidden(ctx)}${await tokenForm(ctx, t, all, linked)}
    <button class="btn txt-btn" type="submit">Save</button></form>
    <h2>Webhooks</h2><div class="card"><p class="muted">The gateway sends a JSON POST here for received SMS and delivery status changes. Header <span class="mono">X-SMSGW-Signature</span> = sha256 HMAC of <span class="mono">timestamp.body</span> with the secret.</p>
    <table><tr><th>URL</th><th>Events</th><th>State</th><th>Secret</th><th></th></tr>${hrows || '<tr><td colspan="5" class="muted">No webhooks.</td></tr>'}</table>
    <form method="post" action="/mainadmin/tokens/${t.id}/webhooks" style="margin-top:12px">${hidden(ctx)}
    <label for="wu">New webhook URL</label><input id="wu" type="url" name="url" placeholder="https://example.com/sms-hook">
    ${webhooks.EVENTS.map((e) => `<label class="check"><input type="checkbox" name="events" value="${e}" checked> ${e}</label>`).join('')}
    <div style="margin-top:8px">${ib('plus', 'Add webhook', 'green')}</div></form></div>`, 'tokens');
});

route('POST', /^\/mainadmin\/tokens\/(\d+)$/, async (ctx) => {
  const t = await loadToken(ctx.params[0]);
  const f = await readTokenForm(ctx.body);
  await tx(async (c) => {
    await c.query(
      `UPDATE api_tokens SET name=$2, default_provider_id=$3, inbound_numbers=$4, limit_minute=$5, limit_hour=$6, limit_day=$7 WHERE id=$1`,
      [t.id, f.name, f.defaultId, f.numbers, f.lm, f.lh, f.ld],
    );
    await saveLinks(c, t.id, f.providerIds);
  });
  return back(`/mainadmin/tokens/${t.id}`, 'Saved', null);
});

route('POST', /^\/mainadmin\/tokens\/(\d+)\/rotate$/, async (ctx) => {
  const t = await loadToken(ctx.params[0]);
  const token = randomToken();
  await q('UPDATE api_tokens SET token_hash=$2, token_prefix=$3, rotated_at=now() WHERE id=$1', [t.id, sha256(token), token.slice(0, 8)]);
  return showToken(ctx, 'API token rotated', t.name, token);
});

route('POST', /^\/mainadmin\/tokens\/(\d+)\/toggle$/, async (ctx) => {
  const t = await loadToken(ctx.params[0]);
  await q('UPDATE api_tokens SET enabled = NOT enabled WHERE id=$1', [t.id]);
  return back('/mainadmin/tokens', `Key "${t.name}" ${t.enabled ? 'turned off' : 'turned on'}`, null);
});

route('POST', /^\/mainadmin\/tokens\/(\d+)\/delete$/, async (ctx) => {
  const t = await loadToken(ctx.params[0]);
  await q('DELETE FROM api_tokens WHERE id=$1', [t.id]);
  return back('/mainadmin/tokens', `Key "${t.name}" deleted`, null);
});

route('POST', /^\/mainadmin\/tokens\/(\d+)\/webhooks$/, async (ctx) => {
  const t = await loadToken(ctx.params[0]);
  const url = String(ctx.body.url || '').trim();
  const bad = webhooks.checkUrlSyntax(url);
  if (bad) throw new ApiError(422, 'invalid', bad);
  const events = arr(ctx.body.events).filter((e) => webhooks.EVENTS.includes(e));
  if (!events.length) throw new ApiError(422, 'invalid', 'Pick at least one event');
  await q('INSERT INTO webhooks (token_id, url, secret, events) VALUES ($1,$2,$3,$4)', [t.id, url, randomHex(24), events]);
  return back(`/mainadmin/tokens/${t.id}`, 'Webhook added', null);
});

route('POST', /^\/mainadmin\/webhooks\/(\d+)\/(toggle|delete)$/, async (ctx) => {
  const w = (await q('SELECT * FROM webhooks WHERE id=$1', [Number(ctx.params[0])])).rows[0];
  if (!w) throw new ApiError(404, 'not_found', 'Webhook not found');
  if (ctx.params[1] === 'delete') await q('DELETE FROM webhooks WHERE id=$1', [w.id]);
  else await q('UPDATE webhooks SET enabled = NOT enabled WHERE id=$1', [w.id]);
  return back(`/mainadmin/tokens/${w.token_id}`, 'Done', null);
});

// --- rate limits
route('GET', /^\/mainadmin\/limits$/, async (ctx) => {
  const l = await settings.getLimits();
  const field = (k, label, v, note) => `<label for="${k}">${label}</label><input id="${k}" type="number" min="0" name="${k}" value="${v}" style="max-width:140px"><div class="help">${note}</div>`;
  return page(ctx, 'Rate limits', `<h1>Rate limits</h1><form class="card" method="post" action="/mainadmin/limits">${hidden(ctx)}
    <p class="muted">Default limits for every API token, counted <b>per token and per caller IP</b>. A token can override them on its own page.
    0 = no limit. Windows are fixed: the minute counter resets at second 0, the hour counter at the top of the hour,
    and the day counter at 00:00 (local time below) for all tokens at once.</p>
    ${field('limit_minute', 'Per minute', l.minute, 'Max requests per IP per minute')}
    ${field('limit_hour', 'Per hour', l.hour, 'Max requests per IP per hour')}
    ${field('limit_day', 'Per day', l.day, 'Max requests per IP per day')}
    ${field('tz_offset_min', 'Time zone offset, minutes from UTC', l.tzOffsetMin, '210 = Tehran (UTC+3:30). Decides when "00:00" is.')}
    <button class="btn txt-btn" type="submit">Save</button></form>`, 'limits');
});

route('POST', /^\/mainadmin\/limits$/, async (ctx) => {
  const vals = {};
  for (const k of ['limit_minute', 'limit_hour', 'limit_day']) {
    vals[k] = intOrNull(ctx.body[k]);
    if (vals[k] === null) throw new ApiError(422, 'invalid', 'All limits are required');
  }
  const tz = Number(ctx.body.tz_offset_min);
  if (!Number.isInteger(tz) || tz < -720 || tz > 840) throw new ApiError(422, 'invalid', 'Time zone offset must be between -720 and 840 minutes');
  for (const [k, v] of Object.entries(vals)) await settings.set(k, v);
  await settings.set('tz_offset_min', tz);
  return back('/mainadmin/limits', 'Saved', null);
});

// --- messages
function messageSql(where, limit) {
  return `SELECT m.*, p.slug AS provider_slug, t.name AS token_name FROM messages m
    LEFT JOIN providers p ON p.id=m.provider_id LEFT JOIN api_tokens t ON t.id=m.token_id ${where} ORDER BY m.id DESC LIMIT ${limit}`;
}

function messageTable(rows) {
  const st = { sent: 'info', delivered: 'ok', failed: 'bad', received: 'ok', queued: 'warn' };
  const trs = rows.map((m) => `<tr><td class="muted">${m.id}</td><td class="muted">${fmtTime(m.created_at)}</td>
    <td>${m.direction === 'out' ? '→' : '←'}</td><td class="mono">${esc(m.peer)}</td><td>${esc(m.token_name || '—')}</td><td class="mono">${esc(m.provider_slug || '—')}</td>
    <td>${esc(m.body ?? (m.template_code ? `[${m.template_code}] ${JSON.stringify(m.params)}` : ''))}</td>
    <td>${badge(m.status, st[m.status] || '')}${m.error ? `<div class="help">${esc(m.error)}</div>` : ''}</td></tr>`).join('');
  return `<table><tr><th>#</th><th>Time (UTC)</th><th></th><th>Number</th><th>Key</th><th>Provider</th><th>Content</th><th>Status</th></tr>${trs || '<tr><td colspan="8" class="muted">No messages.</td></tr>'}</table>`;
}

route('GET', /^\/mainadmin\/messages$/, async (ctx) => {
  const sp = ctx.url.searchParams;
  const where = [];
  const args = [];
  if (['in', 'out'].includes(sp.get('dir'))) { args.push(sp.get('dir')); where.push(`m.direction=$${args.length}`); }
  if (sp.get('token')) { args.push(Number(sp.get('token')) || 0); where.push(`m.token_id=$${args.length}`); }
  if (sp.get('status')) { args.push(sp.get('status')); where.push(`m.status=$${args.length}`); }
  if (sp.get('before')) { args.push(Number(sp.get('before')) || 0); where.push(`m.id<$${args.length}`); }
  const rows = (await q(messageSql(where.length ? `WHERE ${where.join(' AND ')}` : '', 100), args)).rows;
  const tokens = (await q('SELECT id, name FROM api_tokens ORDER BY name')).rows;
  const sel = (name, cur, opts) => `<select name="${name}" style="width:auto"><option value="">${name}: all</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const next = rows.length === 100 ? `<p><a href="?${new URLSearchParams({ ...Object.fromEntries(sp), before: rows[rows.length - 1].id })}">Older messages →</a></p>` : '';
  return page(ctx, 'Messages', `<h1>Messages</h1><form method="get" class="card" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    ${sel('dir', sp.get('dir'), [['out', 'sent'], ['in', 'received']])}${sel('token', sp.get('token'), tokens.map((t) => [t.id, t.name]))}
    ${sel('status', sp.get('status'), ['queued', 'sent', 'delivered', 'failed', 'received'].map((s) => [s, s]))}
    <button class="btn txt-btn" style="margin:0" type="submit">Filter</button></form><div class="card">${messageTable(rows)}</div>${next}`, 'messages');
});

// ---------- dispatcher ----------
async function handle(req, res, url, ip, send) {
  const out = (r) => send(r.status, r.body, r.headers);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (!config.sessionSecret || !config.adminPassHash) return send(503, 'Admin is not configured', { 'Content-Type': 'text/plain' });
    if (req.method === 'POST') {
      // "Origin: null" is sent by browsers for privacy-restricted pages; SameSite=Strict + the CSRF token cover that case.
      const origin = req.headers.origin;
      let foreign = false;
      if (origin && origin !== 'null') {
        try { foreign = new URL(origin).host !== req.headers.host; } catch { foreign = true; }
      }
      if (foreign) return send(403, 'Forbidden', { 'Content-Type': 'text/plain' });
    }
    const s = readSession(req);
    const body = req.method === 'POST' ? parseBody(await readBody(req), req.headers['content-type']) : {};
    const ctx = { req, url, ip, body, s, params: [] };

    if (path === '/mainadmin/login' && req.method === 'POST') return out(await doLogin(req, ctx));
    if (!s) return out(req.method === 'GET' && path === '/mainadmin' ? loginPage() : redirect('/mainadmin'));
    if (path === '/mainadmin/logout' && req.method === 'POST') {
      if (!safeEqual(body._csrf || '', s.csrf)) return send(403, 'Forbidden', { 'Content-Type': 'text/plain' });
      return out(redirect('/mainadmin', { 'Set-Cookie': cookie(req, '', 0) }));
    }
    if (req.method === 'POST' && !safeEqual(body._csrf || '', s.csrf)) return send(403, 'Bad CSRF token. Go back and reload the page.', { 'Content-Type': 'text/plain' });

    const hit = routes.find(([m, re]) => m === req.method && re.test(path));
    if (!hit) return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
    ctx.params = path.match(hit[1]).slice(1);
    return out(await hit[2](ctx));
  } catch (e) {
    if (e instanceof ApiError) {
      const back = req.headers.referer ? new URL(req.headers.referer, 'http://x').pathname : '/mainadmin';
      if (e.status === 404) return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
      if (req.method === 'POST') return out(redirect(`${back.startsWith('/mainadmin') ? back : '/mainadmin'}?err=${encodeURIComponent(e.message)}`));
      return send(e.status, e.message, { 'Content-Type': 'text/plain' });
    }
    console.error('admin error:', e);
    return send(500, 'Internal error', { 'Content-Type': 'text/plain' });
  }
}

module.exports = { handle };
