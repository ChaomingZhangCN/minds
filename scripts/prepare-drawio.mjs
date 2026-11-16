import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, copyFile, writeFile, rm, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/jgraph/drawio.git';
const COMMIT = 'c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3';
const PATCH_VERSION = 1;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const excludedSegments = new Set(['.git', 'node_modules', 'test', 'tests', 'WEB-INF', 'META-INF', 'connect']);

export function includeRuntimeFile(path) {
  const parts = path.split('/');
  return !parts.some(part => excludedSegments.has(part)) && !path.endsWith('.map') &&
    !/^(?:service-worker|workbox-).*\.js$/.test(path);
}

async function git(directory, ...args) {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000,
  });
  return stdout.trim();
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function hashRuntimeFiles(directory) {
  const files = [];
  async function walk(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), path + '/');
      else if (entry.isFile()) {
        const bytes = await readFile(join(current, entry.name));
        files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error(`Unsupported symlink/special file in draw.io runtime: ${path}`);
    }
  }
  await walk(directory);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), sha256: sha256(JSON.stringify(files)) };
}

function replaceOnce(text, before, after, path) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Pinned draw.io patch does not match exactly once: ${path}`);
  return text.replace(before, after);
}

/** Every shipped HTML entry, including import helpers, gets the local-only policy. */
export function patchRuntimeHtml(html) {
  if (!/<head\b[^>]*>/i.test(html)) throw new Error('draw.io HTML has no head for CSP');
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\bsrc\s*=/i.test(match[1]) && match[2].trim()) hashes.push(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
  }
  const policy = [
    "default-src 'none'",
    `script-src 'self' ${[...new Set(hashes)].join(' ')}`.trim(),
    // mxGraph lays out and paints through DOM style attributes; scripts stay strict.
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' data:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-src 'self'",
    "worker-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ') + ';';
  // Meta CSP cannot implement sandbox/frame-ancestors: the embedding component supplies sandbox.
  return html.replace(/<head\b[^>]*>/i, match => `${match}\n<!-- minds modification: offline local CSP; original source is pinned and unchanged in the dependency cache. -->\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

const PRE_CONFIG = `
// minds modification: force a private local offline JSON embed deployment.
(function () {
  var base = new URL('./', window.location.href).href;
  window.DRAWIO_BASE_URL = base;
  window.DRAWIO_SERVER_URL = base;
  window.DRAWIO_LIGHTBOX_URL = base;
  window.DRAWIO_VIEWER_URL = base + 'js/viewer.min.js';
  window.DRAW_MATH_URL = base + 'math4/es5';
  window.EXPORT_URL = null;
  window.SAVE_URL = null;
  window.PROXY_URL = null;
  window.NOTIFICATIONS_URL = null;
  window.DRAWIO_LOG_URL = null;
  window.ALLOW_CUSTOM_PLUGINS = false;
  window.isLocalStorage = false;
  window.mxLoadSettings = false;
  window.DRAWIO_CONFIG = { enableAi: false, enableExportUrl: false, showSplashOnStart: false };
  urlParams['embed'] = '1';
  urlParams['proto'] = 'json';
  urlParams['offline'] = '1';
  urlParams['local'] = '1';
  urlParams['stealth'] = '1';
  urlParams['lockdown'] = '1';
  urlParams['pwa'] = '0';
  urlParams['plugins'] = '0';
  urlParams['sync'] = 'none';
  urlParams['gapi'] = '0';
  urlParams['picker'] = '0';
  urlParams['od'] = '0';
  urlParams['gh'] = '0';
  urlParams['gl'] = '0';
  urlParams['tr'] = '0';
  urlParams['ms365'] = '0';
})();
`;

const POST_CONFIG = `
// minds modification: no dynamic code, no service worker/API, enforce read-only embed graphs.
(function () {
  mxStencilRegistry.allowEval = false;
  mxStencil.allowEval = false;
  mxObjectCodec.allowEval = false;
  mxStylesheetCodec.allowEval = false;
  mxGraphView.prototype.allowEval = false;
  Editor.enableServiceWorker = false;
  Editor.enableAi = false;
  EditorUi.enableLogging = false;
  Editor.suppressNewWindows = true;
  var setEnabled = Graph.prototype.setEnabled;
  Graph.prototype.setEnabled = function (enabled) {
    return setEnabled.call(this, enabled && urlParams['chrome'] != '0');
  };
})();
`;

/** Extract the actual bundled font's name-table legal metadata, never fetch a replacement. */
export function fontLegalNotice(bytes) {
  const count = bytes.readUInt16BE(4);
  let nameOffset;
  for (let i = 0; i < count; i++) {
    const offset = 12 + 16 * i;
    if (bytes.toString('ascii', offset, offset + 4) === 'name') nameOffset = bytes.readUInt32BE(offset + 8);
  }
  if (nameOffset === undefined) throw new Error('Bundled font has no legal metadata name table');
  const records = bytes.readUInt16BE(nameOffset + 2);
  const strings = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  const notices = new Set();
  for (let i = 0; i < records; i++) {
    const offset = nameOffset + 6 + i * 12;
    const platform = bytes.readUInt16BE(offset);
    const id = bytes.readUInt16BE(offset + 6);
    if (![0, 13, 14].includes(id)) continue;
    const length = bytes.readUInt16BE(offset + 8);
    const start = strings + bytes.readUInt16BE(offset + 10);
    const raw = bytes.subarray(start, start + length);
    notices.add(platform === 0 || platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1'));
  }
  const result = [...notices].join('\n\n');
  if (!result.includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error('Bundled font license cannot be verified');
  return result;
}

async function verifySource(source, lock) {
  if (await git(source, 'rev-parse', 'HEAD') !== COMMIT) throw new Error('draw.io cache is not at the pinned commit');
  if (await git(source, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Pinned draw.io dependency source was modified; refusing to use it');
  for (const [path, expected] of Object.entries(lock.verifiedFiles)) {
    if (sha256(await readFile(join(source, path))) !== expected) throw new Error(`Pinned draw.io file checksum mismatch: ${path}`);
  }
  const runtime = await hashRuntimeFiles(join(source, lock.runtime));
  if (runtime.sha256 !== lock.runtimeIntegrity.sha256 || runtime.files.length !== lock.runtimeIntegrity.files || runtime.bytes !== lock.runtimeIntegrity.bytes) throw new Error('Pinned complete draw.io runtime checksum mismatch (missing, changed or extra files)');
  await writeFile(join(source, '.minds-source-integrity.json'), JSON.stringify({ commit: COMMIT, ...runtime }, null, 2));
  return runtime;
}

async function prepareSource(source) {
  if (!await exists(join(source, '.git'))) {
    await mkdir(source, { recursive: true });
    await git(source, 'init');
    await git(source, 'remote', 'add', 'origin', REPOSITORY);
  }
  // Never fetch a branch, tag, release latest, or floating remote HEAD.
  try { await git(source, 'cat-file', '-e', `${COMMIT}^{commit}`); }
  catch {
    await git(source, 'remote', 'set-url', 'origin', REPOSITORY);
    await git(source, 'fetch', '--depth=1', 'origin', COMMIT);
  }
  const current = await git(source, 'rev-parse', '--verify', 'HEAD').catch(() => '');
  if (current !== COMMIT) {
    if (await git(source, 'status', '--porcelain', '--untracked-files=no')) throw new Error('draw.io cache contains modified source; refusing checkout');
    await git(source, 'checkout', '--detach', COMMIT);
  }
}

/** Copy the real complete upstream editor runtime; this never substitutes a simplified editor. */
export async function prepareDrawio({ root = DEFAULT_ROOT, force = false } = {}) {
  root = resolve(root);
  const lockBytes = await readFile(join(root, 'vendor', 'drawio-upstream.json'));
  const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.repository !== REPOSITORY || lock.commit !== COMMIT || lock.runtime !== 'src/main/webapp') throw new Error('Unsupported/unpinned draw.io dependency lock');
  const source = join(root, '.cache', 'drawio-upstream');
  const output = join(root, 'dist', 'drawio');
  await prepareSource(source);
  const sourceRuntime = await verifySource(source, lock);
  const scriptSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const lockSha256 = sha256(lockBytes);
  const manifestPath = join(output, 'minds-runtime-manifest.json');
  if (!force && await exists(manifestPath)) {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (previous.commit === COMMIT && previous.patchVersion === PATCH_VERSION && previous.scriptSha256 === scriptSha256 && previous.lockSha256 === lockSha256) {
      const built = await hashRuntimeFiles(output);
      const files = built.files.filter(file => file.path !== 'minds-runtime-manifest.json');
      if (sha256(JSON.stringify(files)) === previous.outputSha256) return { entry: join(output, 'index.html'), manifest: manifestPath, cached: true, distributionAudit: lock.distributionAudit };
    }
  }

  // Stage under the dependency cache, never include .git, tests, server JARs or build caches.
  const staging = join(source, `.minds-runtime-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const modifications = [];
  try {
    for (const file of sourceRuntime.files) {
      if (!includeRuntimeFile(file.path)) continue;
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
      if (file.path.endsWith('.html')) {
        const original = await readFile(join(source, lock.runtime, file.path), 'utf8');
        // The association file teams.html is not an HTML document.
        if (/<head\b/i.test(original)) {
          await writeFile(target, patchRuntimeHtml(original));
          modifications.push({ path: file.path, reason: 'local-only CSP, no unsafe-eval, hash-only pre-existing inline scripts', upstreamSha256: file.sha256 });
        } else await copyFile(join(source, lock.runtime, file.path), target);
      } else await copyFile(join(source, lock.runtime, file.path), target);
    }
    for (const [path, addition] of [['js/PreConfig.js', PRE_CONFIG], ['js/PostConfig.js', POST_CONFIG]]) {
      const original = await readFile(join(staging, path), 'utf8');
      await writeFile(join(staging, path), original + addition);
      modifications.push({ path, reason: 'auditable local offline and read-only adaptation; original legal comments preserved', upstreamSha256: lock.verifiedFiles[`${lock.runtime}/${path}`] });
    }
    // Official bootstrap normally loads PostConfig after calling App.main. Load it first,
    // so all read-only/offline hardening is installed before startup or the first init event.
    const bootstrapPath = 'js/bootstrap.js';
    let bootstrap = await readFile(join(staging, bootstrapPath), 'utf8');
    bootstrap = replaceOnce(bootstrap, 'mxScriptsLoaded = true;\n                checkAllLoaded();',
      "mxscript('js/PostConfig.js', function() {\n                    mxScriptsLoaded = true;\n                    checkAllLoaded();\n                });", bootstrapPath);
    bootstrap = replaceOnce(bootstrap, "                else if (!supportedDomain)\n                {\n                    mxscript('js/PostConfig.js');\n                }", '', bootstrapPath);
    await writeFile(join(staging, bootstrapPath), '// minds modification: install local PostConfig before App.main; upstream copyright preserved below.\n' + bootstrap);
    modifications.push({ path: bootstrapPath, reason: 'load local PostConfig before App.main, remove duplicate late load', upstreamSha256: lock.verifiedFiles[`${lock.runtime}/${bootstrapPath}`] });

    await copyFile(join(source, 'LICENSE'), join(staging, 'LICENSE'));
    await copyFile(join(source, 'README.md'), join(staging, 'UPSTREAM-README.txt'));
    await copyFile(join(source, 'VERSION'), join(staging, 'VERSION'));
    const fontNotice = fontLegalNotice(await readFile(join(source, lock.runtime, 'styles/fonts/ArchitectsDaughter-Regular.ttf')));
    await writeFile(join(staging, 'styles/fonts/ArchitectsDaughter-OFL.txt'), fontNotice);
    const notices = [
      `draw.io ${lock.version}, pinned commit ${COMMIT}\n${REPOSITORY}\nSource runtime: ${lock.runtime}\n`,
      'Private local development/build only. PUBLIC REDISTRIBUTION AUDIT: NOT PASSED.\n' + lock.distributionAudit.blockers.join('\n'),
      'The complete upstream editor and all bundled shape/stencil/image libraries are retained. No Java build was needed: official committed precompiled JavaScript, math and runtime assets are used.',
      'minds changes only generated HTML CSP and js/PreConfig.js, js/PostConfig.js, js/bootstrap.js. Original fixed dependency source is unchanged. See minds-runtime-manifest.json for exact changed-file checksums. No draw.io endorsement or affiliation is claimed. See UPSTREAM-README.txt for trademark and asset restrictions.',
      'This is not a blanket Apache-2.0 distribution: code Apache-2.0; templates CC-BY-4.0 plus retained upstream asset terms; icons/stencils/shapes retain upstream Atlassian software-asset restrictions; libavoid LGPL-2.1; bundled Architects Daughter OFL-1.1. All embedded library copyright/license comments remain in their original files.',
      `Architects Daughter bundled font legal metadata (unchanged):\n${fontNotice}`,
    ];
    for (const license of lock.licenses) {
      if (license.path.endsWith('.ttf')) continue;
      notices.push(`----- ${license.path} (${license.license}) -----\n${await readFile(join(source, license.path), 'utf8')}`);
    }
    // This README carries the crucial corresponding-source/build provenance warning.
    notices.push(`----- js/libavoid-js/README.md (unchanged) -----\n${await readFile(join(source, lock.runtime, 'js/libavoid-js/README.md'), 'utf8')}`);
    await writeFile(join(staging, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n'));
    const built = await hashRuntimeFiles(staging);
    const manifest = {
      schemaVersion: 1, commit: COMMIT, version: lock.version, repository: REPOSITORY,
      entry: 'dist/drawio/index.html', sourceRuntimeSha256: sourceRuntime.sha256,
      patchVersion: PATCH_VERSION, scriptSha256, lockSha256,
      outputSha256: built.sha256, files: built.files, bytes: built.bytes,
      modifications: modifications.map(change => ({ ...change, generatedSha256: built.files.find(file => file.path === change.path)?.sha256 })),
      distributionAudit: lock.distributionAudit,
      browserVerification: 'not performed by prepareDrawio; static integrity/resource/protocol tests are not a browser run',
    };
    await writeFile(join(staging, 'minds-runtime-manifest.json'), JSON.stringify(manifest, null, 2));
    await mkdir(dirname(output), { recursive: true });
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return { entry: join(output, 'index.html'), manifest: manifestPath, cached: false, distributionAudit: lock.distributionAudit };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--force')) throw new Error('Usage: node scripts/prepare-drawio.mjs [--force]');
  const result = await prepareDrawio({ force: process.argv.includes('--force') });
  console.log(`Prepared full pinned draw.io runtime: ${result.entry}${result.cached ? ' (verified cache)' : ''}`);
  console.warn('Public redistribution audit NOT PASSED; private local build only. See vendor/drawio-upstream.json and dist/drawio/THIRD-PARTY-NOTICES.txt.');
}
