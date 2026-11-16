import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The build script deliberately has no project dependency or TypeScript runtime.
// @ts-expect-error Build-side .mjs has no declaration file.
import { fontLegalNotice, hashRuntimeFiles, includeRuntimeFile, patchRuntimeHtml, prepareDrawio } from '../scripts/prepare-drawio.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, '.cache/drawio-upstream');
const output = join(root, 'dist/drawio');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('draw.io build resource helpers', () => {
  it('ships editor libraries, local fonts, SVGs and legal files, not server/test/cache artifacts', () => {
    for (const path of ['js/app.min.js', 'js/libavoid-js/LICENSE', 'img/lib/azure2/a.svg', 'styles/fonts/ArchitectsDaughter-Regular.ttf', 'templates/LICENSE']) expect(includeRuntimeFile(path)).toBe(true);
    for (const path of ['.git/config', 'test/example.html', 'tests/data.xml', 'WEB-INF/lib/servlet.jar', 'META-INF/MANIFEST.MF', 'connect/teams/index.html', 'service-worker.js', 'workbox-05b6c01b.js', 'js/app.min.js.map']) expect(includeRuntimeFile(path)).toBe(false);
  });
  it('adds local CSP before any script; inline helper scripts get exact hashes, never unsafe-eval', () => {
    const script = 'window.localHelper = true;';
    const html = `<html><head><script>${script}</script></head><body></body></html>`;
    const patched = patchRuntimeHtml(html);
    expect(patched.indexOf('Content-Security-Policy')).toBeLessThan(patched.indexOf('<script>'));
    expect(patched).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    expect(patched).toContain("worker-src 'none'");
    expect(patched).toContain("form-action 'none'");
    expect(patched).not.toContain("'unsafe-eval'");
    expect(patched).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(patched).not.toContain('https://');
  });
});

// These are static local dependency/build integrity checks. A clean offline checkout
// without the optional dependency cache can still run pure protocol tests; no test fetches.
describe.skipIf(!existsSync(join(source, 'src/main/webapp/index.html')) || !existsSync(join(output, 'minds-runtime-manifest.json')))('pinned complete draw.io resources (not a browser run)', () => {
  it('verifies every upstream runtime file against the committed aggregate lock', async () => {
    const lock = JSON.parse(await readFile(join(root, 'vendor/drawio-upstream.json'), 'utf8'));
    const actual = await hashRuntimeFiles(join(source, lock.runtime));
    expect(actual.files.length).toBe(lock.runtimeIntegrity.files);
    expect(actual.bytes).toBe(lock.runtimeIntegrity.bytes);
    expect(actual.sha256).toBe(lock.runtimeIntegrity.sha256);
    expect(lock.commit).toBe('c72c9a98b7a6ce392556ed04c05e0ff19f43f5c3');
  }, 60000);

  it('verifies every built file and required complete runtime asset', async () => {
    const manifest = JSON.parse(await readFile(join(output, 'minds-runtime-manifest.json'), 'utf8'));
    const actual = await hashRuntimeFiles(output);
    const files = actual.files.filter((file: { path: string }) => file.path !== 'minds-runtime-manifest.json');
    expect(sha256(JSON.stringify(files))).toBe(manifest.outputSha256);
    expect(files).toEqual(manifest.files);
    for (const path of ['index.html', 'js/app.min.js', 'js/bootstrap.js', 'js/main.js', 'js/shapes-14-6-5.min.js', 'js/stencils.min.js', 'js/extensions.min.js', 'js/libavoid-js/libavoid.min.js', 'math4/es5/drawio-mathjax.min.js', 'templates/index.xml', 'resources/dia_zh.txt', 'styles/grapheditor.css', 'styles/fonts/ArchitectsDaughter-Regular.ttf', 'img/lib/azure2/app_services/Search_Services.svg']) expect(existsSync(join(output, path)), path).toBe(true);
    expect(files.length).toBeGreaterThan(3000);
    expect(files.every((file: { path: string }) => includeRuntimeFile(file.path))).toBe(true);
    const index = await readFile(join(output, 'index.html'), 'utf8');
    expect(index).toContain("script-src 'self';");
    expect(index).not.toContain("'unsafe-eval'");
    for (const match of index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      expect(match[1]).not.toMatch(/^https?:/);
      expect(existsSync(join(output, match[1]))).toBe(true);
    }
  }, 60000);

  it('keeps all legal files byte-for-byte and does not mark public distribution cleared', async () => {
    const lock = JSON.parse(await readFile(join(root, 'vendor/drawio-upstream.json'), 'utf8'));
    for (const license of lock.licenses as { path: string }[]) {
      const builtPath = license.path.replace(/^src\/main\/webapp\//, '');
      expect(await readFile(join(output, builtPath))).toEqual(await readFile(join(source, license.path)));
    }
    const font = await readFile(join(output, 'styles/fonts/ArchitectsDaughter-Regular.ttf'));
    expect(fontLegalNotice(font)).toContain('SIL OPEN FONT LICENSE Version 1.1');
    const notice = await readFile(join(output, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    expect(notice).toContain('LGPL-2.1');
    expect(notice).toContain('NOT PASSED');
    expect(notice).toContain('Atlassian');
    expect(notice).toContain('Kimberly Geswein');
    expect(lock.distributionAudit.publicDistributionReady).toBe(false);
  });

  it('uses official no-eval preload and actual init/load/save/exit/export source evidence', async () => {
    const app = await readFile(join(source, 'src/main/webapp/js/diagramly/App.js'), 'utf8');
    expect(app).toContain('mxStencilRegistry.allowEval = false;');
    expect(app).toContain("App.loadScripts(['js/shapes-14-6-5.min.js', 'js/stencils.min.js',");
    const protocol = await readFile(join(source, 'src/main/webapp/js/diagramly/EditorUi.js'), 'utf8');
    expect(protocol).toContain("JSON.stringify({event: 'init'})");
    expect(protocol).toContain("data.action == 'load'");
    expect(protocol).toContain("this.createLoadMessage('load')");
    expect(protocol).toContain("data.action == 'export'");
    expect(protocol).toContain("msg.format = 'svg'");
    expect(protocol).toContain('msg.data = data.asText? svg : Editor.createSvgDataUri(svg)');
    const menus = await readFile(join(source, 'src/main/webapp/js/diagramly/Menus.js'), 'utf8');
    expect(menus).toContain("editorUi.createLoadMessage('save')");
    expect(menus).toContain("JSON.stringify({event: 'exit',");
    const pre = await readFile(join(output, 'js/PreConfig.js'), 'utf8');
    expect(pre).toContain("urlParams['pwa'] = '0'");
    expect(pre).toContain('window.EXPORT_URL = null');
    expect(pre).toContain('window.DRAWIO_SERVER_URL = base');
    const post = await readFile(join(output, 'js/PostConfig.js'), 'utf8');
    expect(post).toContain("enabled && urlParams['chrome'] != '0'");
    expect(post).toContain('Editor.enableServiceWorker = false');
  });

  it('reuses a checksum-verified build when prepareDrawio({root}) is called again', async () => {
    const result = await prepareDrawio({ root });
    expect(result.cached).toBe(true);
    expect(result.entry).toBe(join(output, 'index.html'));
    expect(result.distributionAudit.publicDistributionReady).toBe(false);
  }, 60000);
});
