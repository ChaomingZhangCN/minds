import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { await fs.access(path.join(root, 'dist/webview/app.js')); await fs.access(path.join(root, 'dist/drawio/index.html')); }
catch { throw new Error('先执行 npm run build，测试页只使用完整本地构建资源。'); }
const outdir = path.join(root, '.cache/browser-harness');
await build({ entryPoints: [path.join(root, 'test/browser/harness.ts')], outdir, bundle: true, platform: 'browser', format: 'esm', target: 'chrome128', conditions: ['production'] });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.json': 'application/json', '.xml': 'application/xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
function server(port, diagramOnly) {
  const instance = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      if (!diagramOnly && url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src http://127.0.0.1:5174; base-uri 'none'; form-action 'none'`);
        response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/webview/app.css"><title>minds · 模拟 Host 测试</title></head><body class="vscode-light"><p style="padding:8px;margin:0;background:#fff2cd">模拟 VS Code Host，仅用于 UI 验收；不保存真实文件、不调用任何模型。</p><div id="root"></div><script nonce="${nonce}" type="module" src="/harness.js"></script></body></html>`); return;
      }
      const requested = decodeURIComponent(url.pathname);
      if (requested.includes('\0') || requested.includes('\\') || (diagramOnly && !requested.startsWith('/drawio/'))) throw new Error('Forbidden path');
      const base = requested === '/harness.js' ? outdir : path.join(root, 'dist');
      const file = path.resolve(base, '.' + requested);
      if (!file.startsWith(base + path.sep)) throw new Error('Forbidden path');
      const real = await fs.realpath(file); if (!real.startsWith(base + path.sep)) throw new Error('Forbidden symlink');
      if (!(await fs.stat(real)).isFile()) throw new Error('Not a file');
      response.setHeader('Content-Type', (mime[path.extname(real)] ?? 'application/octet-stream') + (/\.(html|js|css)$/.test(real) ? '; charset=utf-8' : ''));
      response.setHeader('Cache-Control', 'no-store');
      response.end(request.method === 'HEAD' ? undefined : await fs.readFile(real));
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  instance.listen(port, '127.0.0.1', () => console.log(`minds test ${diagramOnly ? 'draw.io' : 'Webview'}: http://127.0.0.1:${port}`));
  return instance;
}
const main = server(5173, false), drawio = server(5174, true);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { main.close(); drawio.close(); process.exit(0); });
