/* /api/docs: a readable page rendered from the OpenAPI document, with a small "try it" console that
   sends requests with a key pasted into the page (kept in this tab only). The script is a separate
   file so the page works under the app's CSP (scripts from 'self' only). */
import { Hono } from 'hono';

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[ch]};`);
const refName = s => s?.$ref?.split('/').pop();

function typeOf(s) {
  if (!s) return '';
  if (s.$ref) return refName(s);
  if (s.enum) return s.enum.join(' | ');
  if (s.type === 'array') return `${typeOf(s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
  return s.type || '';
}
const fieldRows = s =>
  Object.entries(s.properties || {})
    .map(
      ([k, v]) =>
        `<tr><td><code>${esc(k)}</code>${(s.required || []).includes(k) ? ' <b>required</b>' : ''}</td><td><code>${esc(typeOf(v))}</code></td><td>${esc(v.description)}</td></tr>`,
    )
    .join('');

export function renderDocs(spec, { rateLimit }) {
  const ops = Object.entries(spec.paths).flatMap(([path, m]) => Object.entries(m).map(([method, op]) => ({ path, method, op })));
  const byTag = spec.tags.map(t => [t.name, ops.filter(o => o.op.tags[0] === t.name)]);
  const opHtml = ({ path, method, op }) => {
    const params = (op.parameters || []).filter(p => p.in !== 'header');
    const body = op.requestBody?.content['application/json']?.schema;
    const raw = op.requestBody?.content['application/octet-stream'];
    const res = Object.entries(op.responses).find(([s]) => s < 300);
    const out = res[1].content['application/json']?.schema;
    return `<section class="op" id="${esc(op.operationId)}">
      <h3><span class="m ${method}">${method.toUpperCase()}</span> <code>/api/v1${esc(path)}</code></h3><p>${esc(op.summary)}</p>${op.description ? `<p>${esc(op.description)}</p>` : ''}
      ${params.length ? `<table><tr><th>Parameter</th><th>In</th><th></th></tr>${params.map(p => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' <b>required</b>' : ''}</td><td>${p.in} · <code>${esc(typeOf(p.schema))}</code></td><td>${esc(p.description)}</td></tr>`).join('')}</table>` : ''}
      ${body ? `<table><tr><th>Body field</th><th>Type</th><th></th></tr>${fieldRows(body)}</table>` : ''}
      ${raw ? `<p>Body: ${esc(op.requestBody.description || 'the raw bytes')}</p>` : ''}
      <p class="ret">${res[0]} → ${out ? `<a href="#schema-${esc(refName(out))}">${esc(refName(out))}</a>` : 'the file’s bytes'}</p>
      ${raw ? '' : `<button class="try" data-method="${method.toUpperCase()}" data-path="${esc(path)}" ${body ? 'data-body' : ''}>Try it</button>`}
    </section>`;
  };
  const schemas = Object.entries(spec.components.schemas)
    .filter(([, s]) => s.properties)
    .map(([k, s]) => `<section class="op" id="schema-${esc(k)}"><h3>${esc(k)}</h3><p>${esc(s.description)}</p><table>${fieldRows(s)}</table></section>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sudo Sapient API</title><meta name="color-scheme" content="light dark"><style>
:root{--bg:#FBFAF8;--fg:#1D1C1A;--mut:#6B6860;--bd:#E3E1DC;--acc:#4B5BD6;--sunk:#F2F1EE}
@media (prefers-color-scheme:dark){:root{--bg:#1D1D1C;--fg:#ECEAE5;--mut:#A29F97;--bd:#333230;--acc:#8E9AF3;--sunk:#151514}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 80px}h1{margin:0 0 4px}h2{margin:36px 0 8px;border-bottom:1px solid var(--bd);padding-bottom:6px}
h3{margin:0;font-size:15px}code,pre,textarea,input{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}a{color:var(--acc)}
.op{border:1px solid var(--bd);border-radius:8px;padding:14px 16px;margin:12px 0}.op p{margin:6px 0;color:var(--mut)}
.m{display:inline-block;min-width:54px;text-align:center;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;color:#fff;background:#3D8E5F}
.m.post{background:var(--acc)}.m.patch,.m.put{background:#C48A1E}.m.delete{background:#C54B78}
table{border-collapse:collapse;width:100%;margin:8px 0;display:block;overflow-x:auto}td,th{text-align:left;padding:4px 8px;border-top:1px solid var(--bd);vertical-align:top}th{font-weight:600;color:var(--mut)}
b{font-size:11px;color:#C54B78}.ret{font-size:13px}button,.btn{font:inherit;border:1px solid var(--bd);background:var(--sunk);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}
#console{position:sticky;top:0;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:12px;margin:16px 0;z-index:1}
#console .row{display:flex;gap:8px;flex-wrap:wrap}#console input,#console textarea{background:var(--sunk);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:6px 8px}
#key{flex:1;min-width:200px}#path{flex:2;min-width:200px}#body{width:100%;min-height:70px;margin-top:8px}
#out{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;background:var(--sunk);border-radius:6px;padding:8px;margin:8px 0 0}#out:empty{display:none}
</style></head><body><main>
<h1>Sudo Sapient API</h1><p>${esc(spec.info.description)}</p>
<p>Base URL <code>${esc(spec.servers[0].url)}</code> · Send <code>Authorization: Bearer ssk_…</code> · Errors are <code>{ error, code, field? }</code> · Lists return <code>{ data, nextCursor }</code> · Mutating requests accept <code>Idempotency-Key</code> · <code>Sudo-Time-Zone: Asia/Dubai</code> words and reads dates on that clock for one request (a client acting for someone else) · Your keys together may make ${rateLimit} requests a minute (<code>RateLimit-*</code> headers, 429 with <code>Retry-After</code>). <a href="/api/v1/openapi.json">openapi.json</a></p>
<div id="console"><div class="row"><input id="key" type="password" placeholder="Paste a key to try requests (kept in this tab only)" autocomplete="off"><select id="method" class="btn"><option>GET</option><option>POST</option><option>PATCH</option></select><input id="path" value="/me"><button id="send">Send</button></div><textarea id="body" placeholder='JSON body, e.g. {"project":"WEB","title":"Hello"}' hidden></textarea><pre id="out"></pre></div>
${byTag.map(([tag, list]) => `<h2>${esc(tag)}</h2>${list.map(opHtml).join('')}`).join('')}
<h2>Schemas</h2>${schemas}
</main><script src="/api/docs/try.js" type="module"></script></body></html>`;
}

const TRY_JS = `const $ = s => document.querySelector(s);
const key = $('#key'), method = $('#method'), path = $('#path'), body = $('#body'), out = $('#out');
try { key.value = sessionStorage.getItem('ss-api-key') || ''; } catch {}
key.addEventListener('change', () => { try { sessionStorage.setItem('ss-api-key', key.value); } catch {} });
const sync = () => (body.hidden = method.value === 'GET');
method.addEventListener('change', sync);
document.addEventListener('click', e => {
  const b = e.target.closest('.try');
  if (!b) return;
  method.value = b.dataset.method; path.value = b.dataset.path; sync();
  if ('body' in b.dataset && !body.value) body.value = '{\\n  \\n}';
  window.scrollTo({ top: 0, behavior: 'smooth' }); path.focus();
});
$('#send').addEventListener('click', async () => {
  out.textContent = '…';
  try {
    const res = await fetch('/api/v1' + path.value.trim(), {
      method: method.value,
      headers: { authorization: 'Bearer ' + key.value.trim(), 'x-sudo-client': 'API docs', ...(method.value === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method.value === 'GET' ? undefined : body.value || '{}',
    });
    const text = await res.text();
    let shown = text; try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    out.textContent = res.status + ' ' + res.statusText + '\\n' + shown;
  } catch (err) { out.textContent = String(err); }
});
`;

export function docsRoutes({ spec }) {
  const r = new Hono();
  let html;
  r.get('/', c => c.html((html ??= renderDocs(spec(c), { rateLimit: c.var.config.apiRateLimit }))));
  r.get('/try.js', c => c.body(TRY_JS, 200, { 'content-type': 'text/javascript; charset=utf-8' }));
  return r;
}
