'use strict';
// Mock provider, TEMPLATE type. Sends nothing; useful to test the gateway end to end.
const { ProviderError } = require('../_errors');
const g = require('../_generic');

module.exports = {
  driver: 'mock-template',
  label: 'Mock (template ID + parameters, sends nothing)',
  type: 'template',
  settings: [
    { key: 'fail_if_to_contains', label: 'Fail if number contains', help: 'Optional. Simulates a provider error, e.g. 0000.' },
  ],

  async send(ctx, msg) {
    const bad = ctx.settings.fail_if_to_contains;
    if (bad && msg.to.includes(bad)) throw new ProviderError('Mock provider: simulated failure');
    return { providerMessageId: `mock-${Date.now()}`, status: 'sent' };
  },

  inbound: { parse: (req, ctx) => g.parseInbound(req, { settings: {} }) },
};
