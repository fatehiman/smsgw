'use strict';
// Kavenegar "verify/lookup" (template based). Template parameters are sent in template order as
// token, token2, token3 (Kavenegar's own names), so name them in the template in that order.
// Inbound: set the receive webhook in the Kavenegar panel to /hook/<slug>/<secret>.
const { ProviderError } = require('../_errors');
const { request } = require('../_http');

const KEYS = ['token', 'token2', 'token3', 'token10', 'token20'];

module.exports = {
  driver: 'kavenegar-lookup',
  label: 'Kavenegar (verify/lookup, template)',
  type: 'template',
  settings: [
    { key: 'api_key', label: 'API key', type: 'password', required: true },
  ],

  async send(ctx, msg) {
    const key = ctx.settings.api_key;
    if (!key) throw new ProviderError('Kavenegar API key is not set', { code: 'not_configured' });
    const qs = new URLSearchParams({ receptor: msg.to, template: msg.template });
    msg.paramList.slice(0, KEYS.length).forEach((v, i) => qs.set(KEYS[i], v));
    const r = await request(`https://api.kavenegar.com/v1/${encodeURIComponent(key)}/verify/lookup.json?${qs}`);
    const status = r.json?.return?.status;
    if (status !== 200) {
      throw new ProviderError(`Kavenegar: ${r.json?.return?.message || `HTTP ${r.status}`}`, {
        code: 'provider_rejected', retryable: r.status >= 500,
      });
    }
    const entry = r.json.entries?.[0];
    return { providerMessageId: entry?.messageid != null ? String(entry.messageid) : null, status: 'sent' };
  },

  inbound: {
    parse(req) {
      const b = { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };
      if (!b.from || b.message == null) return [];
      return [{
        kind: 'sms', from: String(b.from), to: b.to ?? null, text: String(b.message), providerMessageId: b.messageid ?? null,
      }];
    },
  },
};
