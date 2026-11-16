import { promises as fs } from 'node:fs';
import path from 'node:path';
export { validateSvg } from './svg';

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveWorkspaceResource(root: string, documentPath: string, src: string, allowMissing = false): Promise<string> {
  if (!src || src.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('\\\\')) throw new Error('只允许工作区内相对资源路径');
  let decoded = src.split(/[?#]/, 1)[0];
  try { decoded = decodeURIComponent(decoded); } catch { throw new Error('资源路径编码无效'); }
  if (path.isAbsolute(decoded) || path.win32.isAbsolute(decoded) || decoded.includes('\0')) throw new Error('资源路径不能为绝对路径');
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(path.dirname(documentPath), decoded);
  if (!isWithin(realRoot, candidate)) throw new Error('资源路径越出工作区');
  try {
    const real = await fs.realpath(candidate);
    if (!isWithin(realRoot, real)) throw new Error('符号链接资源越出工作区');
    return real;
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let ancestor = path.dirname(candidate);
  for (;;) {
    try {
      const realParent = await fs.realpath(ancestor);
      if (!isWithin(realRoot, realParent)) throw new Error('资源父目录越出工作区');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return candidate;
}

export function sniffImage(bytes: Uint8Array): { mime: string; extension: string } {
  const b = Buffer.from(bytes);
  if (b.length < 12 || b.length > 12_000_000) throw new Error('图片大小无效（最多 12 MB）');
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', extension: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', extension: 'gif' };
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  throw new Error('首版支持 PNG、JPEG、GIF、WebP 图片，不接受脚本化 SVG 图片');
}
