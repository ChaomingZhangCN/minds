import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function prepareNpmNotices(root = defaultRoot) {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const output = path.join(root, 'dist/licenses/npm'); await fs.rm(output, { recursive: true, force: true }); await fs.mkdir(output, { recursive: true });
  const notices = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith('node_modules/') || entry.dev || entry.link) continue;
    const directory = path.join(root, relative);
    let metadata; try { metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); } catch { if (entry.optional) continue; throw new Error(`缺少生产依赖许可元数据：${relative}`); }
    const destination = path.join(output, relative.replaceAll('/', '__'));
    await fs.mkdir(destination, { recursive: true });
    const files = [];
    const visit = async (base, depth) => {
      if (depth > 8) return;
      for (const item of await fs.readdir(base, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory() && !['node_modules', '.git'].includes(item.name)) await visit(path.join(base, item.name), depth + 1);
        else if (item.isFile() && /^(?:licen[sc]e|notice|copying|copyright|authors)(?:[._-]|$)/i.test(item.name)) {
          const src = path.join(base, item.name), relativeFile = path.relative(directory, src), bytes = await fs.readFile(src);
          const target = path.join(destination, relativeFile); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
          files.push({ path: path.relative(path.join(root, 'dist'), target).split(path.sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      }
    };
    await visit(directory, 0);
    notices.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? entry.license ?? '待确认', repository: metadata.repository ?? null, files });
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, scope: 'Installed production dependencies; a conservative superset of bundled packages, not a legal clearance.', packages: notices }, null, 2));
  console.log(`保留 ${notices.length} 个 npm 生产依赖的许可元数据与 ${notices.reduce((sum, entry) => sum + entry.files.length, 0)} 份声明。draw.io 公开再分发审计仍未通过。`);
  return notices;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareNpmNotices();
