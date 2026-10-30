/* ---------- icons: inlined Lucide subset (src/00-icons.js), rendered to inline svg ---------- */
import { ICONS } from 'virtual:icons';
import { esc } from './utils.js';

export const _icCache = {};
export function ic(name, size = 16, cls = '') {
  const k = name + '|' + size + '|' + cls;
  if (_icCache[k]) return _icCache[k];
  const inner = ICONS[name] || '<rect x="5" y="5" width="14" height="14" rx="3"/>';
  return (_icCache[k] =
    `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
}
/* Gr8r brand (src/assets/logo.svg): the wordmark follows the theme's text colour; the app icon is the white wordmark on a black tile. */
export const LOGO_D =
  'M99.1462 184.663C94.0907 182.417 85.7476 181.12 76.352 179.822C69.5385 178.874 67.8899 178.404 67.8899 176.278C67.8899 174.392 69.5385 173.683 76.938 173.563C99.2654 173.323 105.374 167.424 105.374 156.324C105.374 150.894 103.496 146.521 97.9742 144.275L107.251 142.508L107.489 131.049H79.5204C52.3857 131.049 47.9163 142.508 47.9163 152.421C47.9163 160.337 49.7935 166.596 57.7888 170.139C49.5649 171.557 46.6251 174.621 46.6251 179.942C46.6251 188.207 55.435 189.744 67.3039 191.511C76.819 192.929 86.1055 192.809 86.1055 197.65C86.1055 200.255 83.9899 202.372 77.8816 202.372C68.4759 202.372 67.7707 199.067 67.5423 195.174H46.0391C46.0391 209.579 53.091 216.546 77.7624 216.546C101.967 216.546 107.837 206.983 107.837 197.061C107.837 190.562 104.907 187.029 99.1462 184.663ZM67.5818 145.663H84.7049V161.744H67.5818V145.663Z M131.104 138.36L127.469 131.033H115.133V191.256H137.222V161.27C137.222 153.593 138.98 147.684 152.021 149.101V129.975C140.271 128.907 134.749 132.451 131.104 138.36Z M210.119 152.285C217.757 150.398 223.041 145.207 223.041 136.113C223.041 123.117 214.698 114.502 191.903 114.502C169.109 114.502 160.766 123.117 160.766 136.113C160.766 145.207 166.06 150.398 173.697 152.285C164.878 154.77 159.355 161.029 159.355 170.243C159.355 182.76 167.699 192.443 192.022 192.443C216.108 192.443 224.451 182.76 224.451 170.243C224.451 161.029 218.929 154.77 210.119 152.285ZM204.03 176.172H180.193V160.091H204.03V176.172ZM204.03 144.029H180.193V130.553H204.03V144.029Z M247.211 138.36L243.566 131.033H231.23V191.256H253.32V161.27C253.32 153.593 255.088 147.684 268.128 149.101V129.975C256.379 128.907 250.856 132.451 247.211 138.36Z M284.807 114.502H267.684V130.583H284.807V114.502Z';
export const LOGO = (h = 22) =>
  `<svg class="logo" height="${h}" width="${Math.round((h * 241.47) / 102.27)}" viewBox="45.53 114.5 241.47 102.27" role="img" aria-label="Sudo Sapient"><path d="${LOGO_D}" fill="currentColor"/></svg>`;
export const MARK = (px = 22) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 332 332" aria-hidden="true"><rect width="332" height="332" fill="#000"/><path d="${LOGO_D}" fill="#fff"/></svg>`;
export function wsLogo(w, px = 22) {
  return w && w.brand
    ? `<span class="ws-logo brand" style="width:${px}px;height:${px}px">${MARK(px)}</span>`
    : `<span class="ws-logo" style="--c:${w.c};width:${px}px;height:${px}px;font-size:${Math.max(9, Math.round(px * 0.46))}px">${esc(w.name[0])}</span>`;
}
