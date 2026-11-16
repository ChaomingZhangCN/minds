import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink, link } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class StorageCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageCorruptionError';
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

export const TEMP_FILE_PATTERN = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function ensureDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StorageCorruptionError(`Storage directory is not a real directory: ${path}`);
  }
  if (firstCreated) {
    // Persist every newly created ancestor, including the parent that links the first new one.
    const stop = dirname(resolve(firstCreated));
    let directory = resolve(path);
    for (;;) {
      await syncDirectory(directory);
      if (directory === stop || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new StorageCorruptionError(`Not a regular storage file: ${path}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse((await readRegularFile(path)).toString('utf8')) as unknown; }
  catch (error) {
    if (isMissing(error)) throw error;
    if (error instanceof StorageCorruptionError) throw error;
    throw new StorageCorruptionError(`Cannot read storage JSON: ${path}`, { cause: error });
  }
}

/** The rename is the commit point. All temporary files are on the same filesystem. */
export async function atomicWrite(path: string, bytes: Uint8Array, guard?: () => Promise<void>): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(directory, `.tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await guard?.();
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
  }
}

export async function immutableWrite(path: string, bytes: Uint8Array, guard: () => Promise<void>): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(directory, `.tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await guard();
    try { await link(temporary, path); }
    catch (error) { if (!isAlreadyExists(error)) throw error; }
    if (!(await readRegularFile(path)).equals(Buffer.from(bytes))) {
      throw new StorageCorruptionError(`Immutable manifest already exists with different contents: ${path}`);
    }
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
    await syncDirectory(directory);
  }
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export function assertObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageCorruptionError(`Invalid ${context}`);
  }
}

export function assertKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new StorageCorruptionError('Unknown or missing storage schema fields');
  }
}
