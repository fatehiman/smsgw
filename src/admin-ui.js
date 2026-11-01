'use strict';
// HTML helpers and styles for the admin panel (icon-only action buttons, soft colors, light placeholders).
const { esc } = require('./util');

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 21 2"/><path d="M17 6l3 3"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L7 14.2 2 9.3l6.9-1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};

const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// Icon-only button. href -> link, otherwise a submit button (put it inside a <form>).
function ib(name, tip, tone, { href, confirm } = {}) {
  const cls = `btn ic-btn tone-${tone}`;
  const t = `title="${esc(tip)}" aria-label="${esc(tip)}"`;
  if (href) return `<a class="${cls}" href="${esc(href)}" ${t}>${icon(name)}</a>`;
  const c = confirm ? ` onclick="return confirm('${esc(confirm).replace(/'/g, '&#39;')}')"` : '';
  return `<button class="${cls}" type="submit" ${t}${c}>${icon(name)}</button>`;
}

// A small POST form with one icon button.
const postBtn = (action, csrf, name, tip, tone, confirm) =>
  `<form method="post" action="${esc(action)}" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}">${ib(name, tip, tone, { confirm })}</form>`;

const CSS = `
:root{--bg:#f6f7fa;--card:#fff;--text:#1f2430;--muted:#6b7385;--line:#e3e6ee;--accent:#3b64b5;--ph:#b3b9c4;
--blue-i:#3b64b5;--blue-b:#e8effc;--blue-l:#c9d8f4;--green-i:#2f7d4f;--green-b:#e6f5ec;--green-l:#c4e5d1;
--amber-i:#96681d;--amber-b:#fcf1dc;--amber-l:#f0dcb2;--red-i:#b04848;--red-b:#fbe9e9;--red-l:#f1cccc;
--purple-i:#6c52a8;--purple-b:#efeafa;--purple-l:#dcd2f1;--teal-i:#2b7a80;--teal-b:#e4f4f5;--teal-l:#c1e3e5;
--gray-i:#5d6577;--gray-b:#eef0f5;--gray-l:#dde1ea}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--card:#1b1f27;--text:#e4e7ee;--muted:#98a0b3;--line:#2c313c;--accent:#9db9ee;--ph:#5c6474;
--blue-i:#9db9ee;--blue-b:#202b44;--blue-l:#2e3d61;--green-i:#8fd0a9;--green-b:#1d3328;--green-l:#2a4a39;
--amber-i:#e3c07f;--amber-b:#3a2f1a;--amber-l:#54452a;--red-i:#eba0a0;--red-b:#3b2224;--red-l:#573134;
--purple-i:#bfaee8;--purple-b:#2c2540;--purple-l:#40375e;--teal-i:#8ccdd2;--teal-b:#1c3234;--teal-l:#2a4a4d;
--gray-i:#b0b7c8;--gray-b:#272c37;--gray-l:#373e4c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header b{margin-right:8px}header nav{display:flex;gap:12px;flex-wrap:wrap;flex:1}
header nav a{text-decoration:none;color:var(--muted);padding:2px 0}header nav a.on{color:var(--text);border-bottom:2px solid var(--accent)}
main{max-width:1060px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:6px 0 14px}h2{font-size:16px;margin:22px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.row-actions{display:flex;gap:5px;flex-wrap:wrap}.inline{display:inline;margin:0}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 3px}
input[type=text],input[type=password],input[type=number],input[type=url],select,textarea{width:100%;max-width:520px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:70px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
::placeholder{color:var(--ph);opacity:1}
select:has(option[value=""]:checked){color:var(--ph)}select option{color:initial}
.check{display:flex;align-items:center;gap:8px;margin:4px 0;color:var(--text);font-size:14px}.check input{width:auto}
.help{font-size:12px;color:var(--muted);margin-top:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:7px;cursor:pointer;font:inherit;text-decoration:none;background:var(--gray-b);color:var(--gray-i)}
.ic{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ic-btn{padding:5px}
.txt-btn{padding:7px 16px;margin-top:14px;background:var(--blue-b);border-color:var(--blue-l);color:var(--blue-i);font-weight:600}
.tone-blue{background:var(--blue-b);border-color:var(--blue-l);color:var(--blue-i)}.tone-green{background:var(--green-b);border-color:var(--green-l);color:var(--green-i)}
.tone-amber{background:var(--amber-b);border-color:var(--amber-l);color:var(--amber-i)}.tone-red{background:var(--red-b);border-color:var(--red-l);color:var(--red-i)}
.tone-purple{background:var(--purple-b);border-color:var(--purple-l);color:var(--purple-i)}.tone-teal{background:var(--teal-b);border-color:var(--teal-l);color:var(--teal-i)}
.tone-gray{background:var(--gray-b);border-color:var(--gray-l);color:var(--gray-i)}
.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--gray-b);color:var(--gray-i);border:1px solid var(--gray-l)}
.badge.ok{background:var(--green-b);color:var(--green-i);border-color:var(--green-l)}.badge.bad{background:var(--red-b);color:var(--red-i);border-color:var(--red-l)}
.badge.info{background:var(--blue-b);color:var(--blue-i);border-color:var(--blue-l)}.badge.warn{background:var(--amber-b);color:var(--amber-i);border-color:var(--amber-l)}
.msg{padding:9px 12px;border-radius:8px;margin-bottom:12px;background:var(--green-b);border:1px solid var(--green-l);color:var(--green-i)}
.msg.err{background:var(--red-b);border-color:var(--red-l);color:var(--red-i)}
.secret{font-family:ui-monospace,Consolas,monospace;background:var(--bg);border:1px dashed var(--line);padding:10px;border-radius:8px;word-break:break-all;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.stat b{display:block;font-size:22px}.stat span{font-size:12px;color:var(--muted)}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}
.login{max-width:340px;margin:12vh auto;padding:0 16px}
@media (max-width:600px){main{padding:10px}th,td{padding:6px 5px}}
`;

function layout(title, body, { nav = '', csrf = '' } = {}) {
  const link = (k, href, label) => `<a href="${href}" class="${nav === k ? 'on' : ''}">${label}</a>`;
  const bar = csrf
    ? `<header><b>SMS Gateway</b><nav>${link('home', '/mainadmin', 'Dashboard')}${link('providers', '/mainadmin/providers', 'Providers')}${link('tokens', '/mainadmin/tokens', 'API tokens')}${link('limits', '/mainadmin/limits', 'Rate limits')}${link('messages', '/mainadmin/messages', 'Messages')}</nav>${postBtn('/mainadmin/logout', csrf, 'logout', 'Log out', 'gray')}</header>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · SMS Gateway</title><style>${CSS}</style></head><body>${bar}${body}</body></html>`;
}

const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const fmtTime = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '—');

module.exports = { layout, ib, postBtn, icon, badge, fmtTime, esc };
