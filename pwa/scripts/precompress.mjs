// Write .br and .gz siblings for every compressible file in dist/, so the
// bridge can serve them straight off disk.
//
// This matters because the bridge may be a Raspberry Pi Zero W: compressing on
// the fly would cost it CPU on every single request, while precompressed files
// cost it nothing at all and cut the cold-load payload by ~3x. Both formats are
// written because a phone on a plain-http LAN URL may only offer gzip.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const DIST = new URL('../dist/', import.meta.url).pathname;
// Fonts (woff2) and images are already compressed — running them through again
// only wastes build time and disk.
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest', '.map']);
const MIN_BYTES = 1024;

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : join(dir, e.name))),
  );
  return files.flat();
};

const kb = (n) => (n / 1024).toFixed(1).padStart(6) + ' KB';

let rawTotal = 0;
let brTotal = 0;
let gzTotal = 0;

for (const file of await walk(DIST)) {
  if (!COMPRESSIBLE.has(extname(file))) continue;
  const { size } = await stat(file);
  if (size < MIN_BYTES) continue;

  const source = await readFile(file);
  const [br, gz] = await Promise.all([
    brotli(source, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }),
    gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
  ]);

  // Keep a variant only if it actually saves bytes; a stale larger sibling
  // would otherwise be served in preference to the original.
  if (br.length < source.length) await writeFile(`${file}.br`, br);
  if (gz.length < source.length) await writeFile(`${file}.gz`, gz);

  rawTotal += source.length;
  brTotal += Math.min(br.length, source.length);
  gzTotal += Math.min(gz.length, source.length);
  console.log(`${kb(source.length)} -> br ${kb(br.length)}  gz ${kb(gz.length)}  ${file.slice(DIST.length)}`);
}

console.log(
  `\nprecompressed: ${kb(rawTotal)} raw -> ${kb(brTotal)} brotli / ${kb(gzTotal)} gzip`,
);
