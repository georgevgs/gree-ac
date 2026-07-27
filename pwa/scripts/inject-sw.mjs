// Stamp dist/sw.js with this build's identity: the package version becomes the
// cache name (each deploy rolls the cache, and activate deletes the old one),
// and the hashed bundle files become part of the install-time precache (so an
// install whose first visit fetched them before the SW took control still
// launches offline).
//
// Must run AFTER `vite build` (dist/ exists) and BEFORE precompress.mjs, so
// the .br/.gz siblings are made from the injected bytes.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const PKG = new URL('../package.json', import.meta.url).pathname;

const { version } = JSON.parse(await readFile(PKG, 'utf8'));

// Precache only what a launch can actually use. Fontsource ships every subset
// of both families plus .woff fallbacks for browsers without woff2, and every
// @font-face carries a unicode-range — so rendering this app downloads the two
// latin woff2 files and nothing else. `cache.addAll` has no such judgement and
// would fetch all of them on install: bytes that can never draw a glyph here.
const isFont = (f) => /\.(woff2?|ttf|otf|eot)$/.test(f);
const isLatinWoff2 = (f) => f.endsWith('.woff2') && /-latin-/.test(f) && !/-latin-ext-/.test(f);
const usable = (f) => !isFont(f) || isLatinWoff2(f);

const built = (await readdir(join(DIST, 'assets')))
  .filter((f) => extname(f) !== '.br' && extname(f) !== '.gz')
  .sort();
const skipped = built.filter((f) => !usable(f));
const assets = built.filter(usable).map((f) => `/assets/${f}`);

const swPath = join(DIST, 'sw.js');
const source = await readFile(swPath, 'utf8');
if (!source.includes('__APP_VERSION__') || !source.includes('/* __PRECACHE_ASSETS__ */ []')) {
  throw new Error('dist/sw.js is missing an injection placeholder');
}
await writeFile(
  swPath,
  source
    .replace('__APP_VERSION__', version)
    .replace('/* __PRECACHE_ASSETS__ */ []', JSON.stringify(assets)),
);

console.log(`sw.js: cache ac-shell-${version} · ${assets.length} assets precached`);
if (skipped.length > 0) {
  console.log(`        ${skipped.length} unreachable font files left out: ${skipped.join(', ')}`);
}
