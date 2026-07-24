// Rasterize public/icon.svg into the PNGs iOS/Android want for install, and
// derive the dark-variant favicon. icon.svg carries both themes behind a
// prefers-color-scheme media query; rasterizers don't evaluate media queries,
// so each variant is forced here by swapping the <style> block.
//
// Home-screen PNGs use the DARK art on purpose (owner's pick, Jul 2026):
// iOS gives web clips exactly one icon with no dark-variant mechanism
// (native apps get Icon Composer variants; PWAs get nothing — see
// https://developer.apple.com/forums/thread/787919), so one tile must serve
// both home-screen modes and we prefer it to blend with dark.
//
// Run once:  npm i -D sharp && npm run icons
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const sharp = (await import('sharp')).default;
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = await readFile(resolve(publicDir, 'icon.svg'), 'utf8');

const STYLE = /<style>[\s\S]*?<\/style>/;
const force = (variant) =>
  svg.replace(
    STYLE,
    variant === 'dark'
      ? '<style>.ic-light{display:none}</style>'
      : '<style>.ic-dark{display:none}</style>',
  );

// Version lives in the FILENAME, not a query string: iOS caches the home-screen
// icon per URL path and ignores ?v= busting, so a new path is the only reliable
// way to make an iPhone refetch it. Bump on any art change, then update the
// references in index.html, manifest.webmanifest, and sw.js.
const VERSION = 5;

const targets = [
  [`icon-192.v${VERSION}.png`, 192],
  [`icon-512.v${VERSION}.png`, 512],
  [`apple-touch-icon.v${VERSION}.png`, 180],
];

for (const [name, size] of targets) {
  const png = await sharp(Buffer.from(force('dark'))).resize(size, size).png().toBuffer();
  await writeFile(resolve(publicDir, name), png);
  console.log('wrote', name, `(${size}x${size})`);
}

// Forced-dark SVG for the favicon swap in useTheme.ts — Safari ignores the
// media query inside icon.svg, so it needs a dedicated dark file.
await writeFile(resolve(publicDir, 'icon-dark.svg'), force('dark'));
console.log('wrote icon-dark.svg');
