import { build, context } from 'esbuild';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const skipDrawio = process.argv.includes('--skip-drawio');
await fs.mkdir(join(root, 'dist'), { recursive: true });
if (!skipDrawio) {
  const { prepareDrawio } = await import('./prepare-drawio.mjs');
  await prepareDrawio({ root });
}
const excalidrawFonts = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
try {
  await fs.cp(excalidrawFonts, join(root, 'dist/excalidraw/fonts'), { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  throw new Error('Excalidraw 本地字体不存在，不能构建离线版本');
}
if (!watch) await fs.rm(join(root, 'dist/webview'), { recursive: true, force: true });
const { prepareNpmNotices } = await import('./third-party-notices.mjs');
await prepareNpmNotices(root);
const common = { bundle: true, sourcemap: true, logLevel: 'info', absWorkingDir: root };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], minify: !watch },
  { ...common, entryPoints: { app: 'src/webview/main.tsx' }, outdir: 'dist/webview', platform: 'browser', format: 'esm', splitting: true, target: 'chrome128', minify: !watch,
    conditions: [watch ? 'development' : 'production'],
    chunkNames: 'chunks/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') } },
];
if (watch) {
  for (const options of builds) { const ctx = await context(options); await ctx.watch(); }
} else {
  await Promise.all(builds.map(options => build(options)));
}

// Generate a small PNG from a fixed pixel mark; no native image dependency is needed.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
const size = 128;
const pixels = Buffer.alloc((size * 4 + 1) * size);
const glyph = ['00000000000', '11011101110', '11111111111', '11100111001', '11000110001', '11000110001', '11000110001', '11000110001'];
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const index = y * (size * 4 + 1) + 1 + x * 4;
  const dx = Math.max(28 - x, x - 99, 0), dy = Math.max(28 - y, y - 99, 0);
  const visible = dx * dx + dy * dy <= 28 * 28;
  const gx = Math.floor((x - 25) / 7), gy = Math.floor((y - 33) / 8);
  const white = gx >= 0 && gx < 11 && gy >= 0 && gy < glyph.length && glyph[gy][gx] === '1';
  pixels.set(white ? [255, 255, 255, visible ? 255 : 0] : [22, 120, 111, visible ? 255 : 0], index);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
await fs.mkdir(join(root, 'media'), { recursive: true });
const icon = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
await fs.writeFile(join(root, 'media/icon.png'), icon);
await fs.mkdir(join(root, 'examples/assets'), { recursive: true });
await fs.writeFile(join(root, 'examples/assets/minds.png'), icon, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
