'use strict';
const { q } = require('./db');
const providers = require('./providers');
const webhooks = require('./webhooks');
const blacklist = require('./blacklist');
const billing = require('./billing');
const { ApiError, normalizePhone } = require('./util');

const MAX_TEXT = 2000;
const MAX_PARAM = 500;

// Providers this token may use (enabled only), in the order the admin set.
async function allowedProviders(tokenId) {
  return (await q(
    `SELECT p.* FROM token_providers tp JOIN providers p ON p.id = tp.provider_id
     WHERE tp.token_id = $1 AND p.enabled ORDER BY tp.position, p.id`,
    [tokenId],
  )).rows;
}

// Effective default: the token's own default -> the global default (if the token may use it)
// -> the first provider in the token's list.
function effectiveDefault(token, allowed, globalDefaultId) {
  return allowed.find((p) => p.id === token.default_provider_id)
    || allowed.find((p) => p.id === globalDefaultId)
    || allowed[0]
    || null;
}

function pickProvider(token, allowed, globalDefaultId, slug) {
  if (slug !== undefined && slug !== null && slug !== '') {
    if (typeof slug !== 'string') throw new ApiError(422, 'invalid_provider', '"provider" must be a string');
    const p = allowed.find((x) => x.slug === slug);
    if (!p) {
      throw new ApiError(403, 'provider_not_allowed', `Provider "${slug}" does not exist, is disabled, or this API key cannot use it`, {
        allowed: allowed.map((x) => x.slug),
      });
    }
    return p;
  }
  const p = effectiveDefault(token, allowed, globalDefaultId);
  if (!p) throw new ApiError(409, 'no_provider', 'This API key has no enabled provider. Ask the admin to assign one.');
  return p;
}

// Checks the body against the provider type. Returns what the driver needs.
async function buildMessage(provider, driver, body) {
  const to = normalizePhone(body.to);
  if (!to) throw new ApiError(422, 'invalid_to', '"to" must be a phone number (digits, optional leading +)');
  const info = { provider: provider.slug, provider_type: driver.type };

  if (driver.type === 'text') {
    if (body.template !== undefined || body.params !== undefined) {
      throw new ApiError(422, 'template_not_supported',
        `Provider "${provider.slug}" sends free text. Send "text", not "template"/"params".`, info);
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      throw new ApiError(422, 'text_required', `Provider "${provider.slug}" needs a non-empty "text".`, info);
    }
    if (body.text.length > MAX_TEXT) throw new ApiError(422, 'text_too_long', `"text" is longer than ${MAX_TEXT} characters`, info);
    // every text SMS ends with «لغو11» after a line break (src/blacklist.js, fixed rule)
    const text = blacklist.withFooter(body.text);
    return { to, text, template: null, params: null, paramList: [], parts: billing.countParts(text) };
  }

  // template provider
  if (body.text !== undefined) {
    throw new ApiError(422, 'text_not_supported',
      `Provider "${provider.slug}" works with templates. Send "template" and "params", not "text".`, info);
  }
  if (typeof body.template !== 'string' && typeof body.template !== 'number') {
    throw new ApiError(422, 'template_required', `Provider "${provider.slug}" needs a "template" ID.`, info);
  }
  const code = String(body.template);
  const tpl = (await q('SELECT * FROM templates WHERE provider_id=$1 AND code=$2', [provider.id, code])).rows[0];
  if (!tpl) {
    const known = (await q('SELECT code FROM templates WHERE provider_id=$1 ORDER BY code', [provider.id])).rows.map((r) => r.code);
    throw new ApiError(422, 'template_not_found', `Template "${code}" is not defined for provider "${provider.slug}".`, { ...info, templates: known });
  }
  const params = body.params === undefined ? {} : body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new ApiError(422, 'params_invalid', '"params" must be an object, e.g. {"code":"1234"}', info);
  }
  const missing = tpl.param_names.filter((n) => !(n in params));
  const unknown = Object.keys(params).filter((n) => !tpl.param_names.includes(n));
  if (missing.length || unknown.length) {
    throw new ApiError(422, 'params_invalid', `Parameters do not match template "${code}".`, {
      ...info, expected: tpl.param_names, missing, unknown,
    });
  }
  const clean = {};
  for (const n of tpl.param_names) {
    const v = params[n];
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new ApiError(422, 'params_invalid', `Parameter "${n}" must be a string or number`, info);
    }
    if (String(v).length > MAX_PARAM) throw new ApiError(422, 'params_invalid', `Parameter "${n}" is too long`, info);
    clean[n] = String(v);
  }
  return {
    to, text: null, template: code, params: clean, paramList: tpl.param_names.map((n) => clean[n]),
    parts: billing.templateParts(tpl.body, clean), // counted from the admin's template body (no body = 1)
  };
}

async function sendSms(token, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Body must be a JSON object');
  const reference = body.reference == null ? null : String(body.reference).slice(0, 100);

  const allowed = await allowedProviders(token.id);
  const globalDefault = (await q('SELECT id FROM providers WHERE is_default AND enabled')).rows[0]?.id ?? null;
  const provider = pickProvider(token, allowed, globalDefault, body.provider);
  const driver = providers.get(provider.driver);
  if (!driver) throw new ApiError(503, 'provider_unavailable', `Driver for provider "${provider.slug}" is not installed`);

  const msg = await buildMessage(provider, driver, body);
  // a number that sent 11 gets nothing, from any key, until it sends 12 (fixed rule)
  const listed = await blacklist.find(msg.to);
  if (listed) {
    const why = 'number_blacklisted: the recipient sent 11 (opt-out) and is on the blacklist; no SMS can be sent to it until it sends 12';
    const failed = (await q(
      `INSERT INTO messages (token_id, provider_id, direction, peer, body, template_code, params, status, error, reference, parts)
       VALUES ($1,$2,'out',$3,$4,$5,$6,'failed',$7,$8,$9) RETURNING id`,
      [token.id, provider.id, msg.to, msg.text, msg.template, msg.params, why, reference, msg.parts],
    )).rows[0];
    throw new ApiError(403, 'number_blacklisted',
      `This number is in the blacklist (the recipient sent 11 to stop SMS) since ${listed.since.toISOString()}. No SMS is sent until it sends 12.`,
      { message: await getMessage(token.id, failed.id), since: listed.since });
  }
  const row = (await q(
    `INSERT INTO messages (token_id, provider_id, direction, peer, body, template_code, params, status, reference, parts)
     VALUES ($1,$2,'out',$3,$4,$5,$6,'queued',$7,$8) RETURNING id`,
    [token.id, provider.id, msg.to, msg.text, msg.template, msg.params, reference, msg.parts],
  )).rows[0];

  // billing (src/billing.js): no price for this key + provider = free, no balance check
  const price = await billing.priceFor(token.id, provider.id);
  const charged = price !== null;
  if (charged && !(await billing.reserve(token.id, row.id, msg.parts, price))) {
    const cost = billing.round2(msg.parts * price);
    const t = (await q('SELECT balance, credit_limit FROM api_tokens WHERE id=$1', [token.id])).rows[0];
    const why = `insufficient_balance: cost ${cost} ${billing.CURRENCY}, balance ${t.balance}, allowed debt ${t.credit_limit}`;
    await q(`UPDATE messages SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, why]);
    throw new ApiError(402, 'insufficient_balance',
      `Not enough balance: this SMS costs ${cost} ${billing.CURRENCY} (${msg.parts} part(s) × ${price}), the balance is ${t.balance} and the allowed debt is ${t.credit_limit}. Ask the admin to add a payment.`,
      {
        currency: billing.CURRENCY, cost, parts: msg.parts, price_per_part: price,
        balance: t.balance, allowed_debt: t.credit_limit, available: billing.round2(t.balance + t.credit_limit),
        message: await getMessage(token.id, row.id),
      });
  }

  try {
    const r = await driver.send({ settings: provider.settings, provider }, msg);
    await q(
      `UPDATE messages SET status=$2, provider_message_id=$3, updated_at=now() WHERE id=$1`,
      [row.id, r.status || 'sent', r.providerMessageId || null],
    );
  } catch (e) {
    if (charged) await billing.release(token.id, row.id).catch((x) => console.error('billing release:', x.message));
    await q(`UPDATE messages SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, String(e.message).slice(0, 500)]);
    const m = await getMessage(token.id, row.id);
    webhooks.enqueue(token.id, 'sms.status', m).catch(() => {});
    throw new ApiError(502, e.code || 'provider_error', `Provider "${provider.slug}" failed: ${e.message}`, { message: m });
  }
  return getMessage(token.id, row.id);
}

function present(r) {
  return {
    id: r.id,
    direction: r.direction,
    provider: r.provider_slug ?? null,
    [r.direction === 'out' ? 'to' : 'from']: r.peer,
    ...(r.direction === 'in' ? { to: r.line } : {}),
    text: r.body,
    ...(r.template_code ? { template: r.template_code, params: r.params } : {}),
    status: r.status,
    provider_message_id: r.provider_message_id,
    error: r.error,
    reference: r.reference,
    ...(r.direction === 'out' ? { parts: r.parts, cost: r.cost } : {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...(r.direction === 'in' ? { read: r.read_at != null } : {}),
  };
}

const SELECT = `SELECT m.*, p.slug AS provider_slug FROM messages m LEFT JOIN providers p ON p.id = m.provider_id`;

async function getMessage(tokenId, id) {
  const r = (await q(`${SELECT} WHERE m.token_id=$1 AND m.id=$2`, [tokenId, id])).rows[0];
  return r ? present(r) : null;
}

module.exports = { sendSms, getMessage, present, SELECT, allowedProviders, effectiveDefault, pickProvider, buildMessage };
