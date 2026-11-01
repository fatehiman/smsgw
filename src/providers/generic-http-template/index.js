'use strict';
// Generic HTTP provider, TEMPLATE type: the caller sends a template ID and parameters.
// Placeholders: {{to}} {{template}} {{p1}}..{{pN}} (parameters in template order)
//               {{params.NAME}} (parameter by name) {{sender}} {{api_key}}
const g = require('../_generic');

module.exports = {
  driver: 'generic-http-template',
  label: 'Generic HTTP (template ID + parameters)',
  type: 'template',
  settings: [
    ...g.commonSettings('{{to}}, {{template}}, {{p1}}, {{params.NAME}}, {{sender}}, {{api_key}}'),
    ...g.inboundSettings,
  ],

  async send(ctx, msg) {
    const values = { to: msg.to, template: msg.template, params: msg.params };
    msg.paramList.forEach((v, i) => { values[`p${i + 1}`] = v; });
    return g.sendHttp(ctx.settings, values);
  },

  inbound: { parse: g.parseInbound },
};
