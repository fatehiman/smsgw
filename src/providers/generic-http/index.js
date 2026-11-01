'use strict';
// Generic HTTP provider, TEXT type: the caller sends any text.
// Placeholders: {{to}} {{text}} {{sender}} {{api_key}}
const g = require('../_generic');

module.exports = {
  driver: 'generic-http',
  label: 'Generic HTTP (free text)',
  type: 'text',
  settings: [...g.commonSettings('{{to}}, {{text}}, {{sender}}, {{api_key}}'), ...g.inboundSettings],

  async send(ctx, msg) {
    return g.sendHttp(ctx.settings, { to: msg.to, text: msg.text });
  },

  inbound: { parse: g.parseInbound },
};
