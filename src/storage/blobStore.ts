import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureDirectory, isAlreadyExists, isMissing, readRegularFile, StorageCorruptionError, syncDirectory } from './fs';

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertHash(hash: string): void {
  if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) throw new TypeError('Invalid SHA-256 blob hash');
}

function suffix(extension?: string): string {
  if (extension === undefined || extension === '') return '';
  if (typeof extension !== 'string') throw new TypeError('Invalid blob extension');
  const normalized = extension.startsWith('.') ? extension.slice(1) : extension;
  if (!EXTENSIONS.has(normalized)) throw new TypeError('Unsupported blob extension');
  return `.${normalized}`;
}

/** Content-addressed, immutable files. No GC is exposed here, including for workspace live blobs. */
export class BlobStore {
  readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async put(bytes: Uint8Array, extension?: string): Promise<{ hash: string; size: number; path: string }> {
    const data = Buffer.from(bytes);
    const hash = sha256(data);
    const path = resolve(this.root, `${hash}${suffix(extension)}`);
    await ensureDirectory(this.root);
    try {
      await this.verifyExisting(path, hash, data.length);
      return { hash, size: data.length, path };
    } catch (error) { if (!isMissing(error)) throw error; }

    const temporary = resolve(this.root, `.tmp-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // A hard link publishes without ever overwriting an existing object, even across processes.
      try { await link(temporary, path); }
      catch (error) { if (!isAlreadyExists(error)) throw error; }
      await this.verifyExisting(path, hash, data.length);
      await syncDirectory(this.root);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
      await syncDirectory(this.root);
    }
    return { hash, size: data.length, path };
  }

  async get(hash: string, extension?: string): Promise<Buffer> {
    assertHash(hash);
    const path = resolve(this.root, `${hash}${suffix(extension)}`);
    await ensureDirectory(this.root);
    const bytes = await readRegularFile(path);
    if (sha256(bytes) !== hash) throw new StorageCorruptionError(`Blob checksum mismatch: ${hash}`);
    return bytes;
  }

  private async verifyExisting(path: string, hash: string, size: number): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) {
      throw new StorageCorruptionError(`Invalid immutable blob: ${hash}`);
    }
    if (sha256(await readRegularFile(path)) !== hash) {
      throw new StorageCorruptionError(`Blob checksum mismatch: ${hash}`);
    }
  }
}
