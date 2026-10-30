/* ---------- 404 / DENIED / FAILED ---------- */
import { esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { canManage, mem } from '../core/store.js';

export function page404() {
  return `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('file-question', 20)}</div></div><span class="code">ERROR 404</span><h1>Page not found</h1><p>The page you're looking for was moved, deleted, or never existed. Check the link or head back home.</p><div class="row"><button class="btn btn-secondary" data-a="back">${ic('arrow-left', 14)}Go back</button><button class="btn btn-primary" data-a="go" data-r="home">Go to Home</button></div></div></div>`;
}
export function stateDenied(p) {
  const lead = mem(p?.lead);
  return `<div class="fullstate"><div class="box"><div class="empty-state" style="padding:0"><div class="glyph">${ic('lock', 20)}</div></div><span class="code">ERROR 403</span><h1>You don't have access</h1><p>${p ? `<b>${esc(p.name)}</b> is a private project. ` : ''}Ask ${lead ? esc(lead.name) : 'the project owner'} to add you, or request access and we'll let them know.</p><div class="row"><button class="btn btn-secondary" data-a="go" data-r="projects">Back to projects</button>${p && canManage(p) ? `<button class="btn btn-secondary" data-a="share" data-id="${p.id}">${ic('users', 14)}Manage access</button>` : ''}<button class="btn btn-primary" data-a="requestAccess" data-id="${p?.id || ''}">Request access</button></div></div></div>`;
}
export function stateFailed() {
  return `<div class="fullstate"><div class="box"><div class="empty-state err" style="padding:0"><div class="glyph">${ic('cloud-alert', 20)}</div></div><h1>Something went wrong.</h1><p>This page failed to load. Your data is safe — try again in a moment.</p><div class="row"><button class="btn btn-secondary" data-a="go" data-r="home">Go to Home</button><button class="btn btn-primary" data-a="reload">${ic('refresh-cw', 14)}Try again</button></div></div></div>`;
}
