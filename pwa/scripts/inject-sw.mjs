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
const assets = (await readdir(join(DIST, 'assets')))
  .filter((f) => extname(f) !== '.br' && extname(f) !== '.gz')
  .sort()
  .map((f) => `/assets/${f}`);

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
