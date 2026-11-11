/* Writes the monochrome app icons from the "s" monogram in public/favicon.svg: white on
   transparent, for Android's status bar and notifications (the manifest's `monochrome` icon, which
   the Android app's notification icon is made from, and the Web Push `badge` in public/sw.js).
   Rendered with Playwright's Chromium, so it needs no other dependency:

     node scripts/monochrome-icon.js

   The mark fills PAD of the square's width or height (whichever is larger), centred: Android's
   notification icons keep their shape inside the middle 20 of 24 dp. */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const PAD = 0.8;
const OUT = [
  ['public/icons/icon-monochrome-512.png', 512],
  ['public/icons/badge-96.png', 96],
];

const svg = fs.readFileSync('public/favicon.svg', 'utf8');
// Only the glyph: the favicon's black backdrop is dropped.
const d = svg.match(/<path d="([^"]+)"/)?.[1];
if (!d) throw new Error('No <path> in public/favicon.svg');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [file, size] of OUT) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block}</style>` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><path fill="#fff" d="${d}"/></svg>`,
    );
    await page.evaluate(pad => {
      const s = document.querySelector('svg');
      const b = s.querySelector('path').getBBox();
      const side = Math.max(b.width, b.height) / pad;
      s.setAttribute('viewBox', `${b.x + b.width / 2 - side / 2} ${b.y + b.height / 2 - side / 2} ${side} ${side}`);
    }, PAD);
    fs.writeFileSync(file, await page.locator('svg').screenshot({ omitBackground: true }));
    console.info(`wrote ${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
