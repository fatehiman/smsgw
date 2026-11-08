'use strict';
// Mock provider, TEXT type. Sends nothing; useful to test the gateway end to end.
// Inbound test: POST /hook/<slug>/<secret> with {"from":"0912...","text":"hi"}.
const { ProviderError } = require('../_errors');
const g = require('../_generic');

module.exports = {
  driver: 'mock-text',
  label: 'Mock (free text, sends nothing)',
  type: 'text',
  settings: [
    { key: 'fail_if_to_contains', label: 'Fail if number contains', help: 'Optional. Simulates a provider error, e.g. 0000.' },
    { key: 'temp_fail_if_to_contains', label: 'Temporary failure if number contains', help: 'Optional. Simulates a network error (the queue retries it), e.g. 7777.' },
  ],

  async send(ctx, msg) {
    const bad = ctx.settings.fail_if_to_contains;
    if (bad && msg.to.includes(bad)) throw new ProviderError('Mock provider: simulated failure');
    const temp = ctx.settings.temp_fail_if_to_contains;
    if (temp && msg.to.includes(temp)) throw new ProviderError('Mock provider: simulated network error', { code: 'network_error', retryable: true });
    return { providerMessageId: `mock-${Date.now()}`, status: 'sent' };
  },

  inbound: { parse: (req, ctx) => g.parseInbound(req, { settings: {} }) },
};
