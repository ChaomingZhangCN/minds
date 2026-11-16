import * as nativeFs from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { atomicWrite, jsonBytes, readJson, StorageCorruptionError, syncDirectory } from './fs';

interface LockOwner { pid: number; host: string; nonce: string; startedAt: number }
interface ObservedOwner { owner: LockOwner; file: string; stat: nativeFs.Stats }
const NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_PATTERN = /^owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const queues = new Map<string, Promise<void>>();

function ownerState(value: unknown): 'alive' | 'dead' | 'unknown' {
  if (!value || typeof value !== 'object') return 'unknown';
  const owner = value as Partial<LockOwner>;
  if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['pid', 'host', 'nonce', 'startedAt'].includes(key)) ||
      !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.host !== hostname() ||
      typeof owner.nonce !== 'string' || !NONCE_PATTERN.test(owner.nonce) ||
      !Number.isSafeInteger(owner.startedAt) || owner.startedAt! < 0) return 'unknown';
  try { process.kill(owner.pid!, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

export interface TransactionLock { assertOwned(): Promise<void> }

/** Heartbeat expiry alone cannot evict an alive, paused, foreign-host, or uninspectable owner. */
export async function withTransactionLock<T>(root: string, action: (lock: TransactionLock) => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  let unlockQueue!: () => void;
  const gate = new Promise<void>(resolveGate => { unlockQueue = resolveGate; });
  const tail = previous.then(() => gate, () => gate);
  queues.set(root, tail);
  await previous;
  try { return await acquire(root, action); }
  finally {
    unlockQueue();
    if (queues.get(root) === tail) queues.delete(root);
  }
}

async function acquire<T>(root: string, action: (lock: TransactionLock) => Promise<T>): Promise<T> {
  const target = resolve(root, '.transaction');
  const lockPath = `${target}.lock`;
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomUUID(), startedAt: Date.now() };
  const ownerFile = `owner-${owner.nonce}.json`;
  let createdOurDirectory = false;
  let identity: nativeFs.Stats | undefined;
  let observed: ObservedOwner | undefined;
  let compromised: Error | undefined;
  const busy = () => Object.assign(new Error('Transaction lock owner is alive, unknown, or changed'), { code: 'ELOCKED' });
  const inspect = async (): Promise<ObservedOwner> => {
    const stat = await lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy();
    const entries = await readdir(lockPath);
    if (entries.length !== 1 || !OWNER_PATTERN.test(entries[0])) throw busy();
    const metadata = await readJson(resolve(lockPath, entries[0])) as LockOwner;
    if (!metadata || entries[0] !== `owner-${metadata.nonce}.json`) throw busy();
    return { owner: metadata, file: entries[0], stat };
  };
  const checkIdentity = async (): Promise<void> => {
    const current = await inspect();
    if (!identity || current.stat.dev !== identity.dev || current.stat.ino !== identity.ino ||
        current.file !== ownerFile || current.owner.nonce !== owner.nonce ||
        current.owner.pid !== owner.pid || current.owner.host !== owner.host ||
        current.owner.startedAt !== owner.startedAt || Object.keys(current.owner).length !== 4) throw busy();
  };
  const guardedFs = {
    ...nativeFs,
    mkdir: ((path: nativeFs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
      nativeFs.mkdir(path, error => {
        if (error || String(path) !== lockPath) { callback(error); return; }
        // A unique, nonempty owner sentinel prevents a stale reclaimer from removing a new lock.
        // If a reclaimer wins the initial empty-directory window, acquisition fails before action.
        void (async () => {
          identity = await lstat(lockPath);
          await atomicWrite(resolve(lockPath, ownerFile), jsonBytes(owner));
          await checkIdentity();
          createdOurDirectory = true;
        })().then(() => callback(null), error => callback(error as NodeJS.ErrnoException));
      });
    }) as typeof nativeFs.mkdir,
    stat: ((path: nativeFs.PathLike, callback: (error: NodeJS.ErrnoException | null, stat?: nativeFs.Stats) => void) => {
      nativeFs.lstat(path, (error, stat) => {
        if (error) { callback(error); return; }
        if (String(path) !== lockPath || createdOurDirectory) { callback(null, stat); return; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) { callback(busy()); return; }
        // Only acquisition stats are adjusted. Heartbeats must compare the real owner's mtime.
        void inspect().then(current => {
          observed = current;
          if (ownerState(current.owner) !== 'dead') {
            stat.mtime = new Date();
            stat.mtimeMs = stat.mtime.getTime();
          }
          callback(null, stat);
        }, () => {
          observed = undefined;
          stat.mtime = new Date(); stat.mtimeMs = stat.mtime.getTime();
          callback(null, stat); // Unknown/EPERM/missing metadata is never reclaimable.
        });
      });
    }) as typeof nativeFs.stat,
    rmdir: ((path: nativeFs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
      if (String(path) !== lockPath) { nativeFs.rmdir(path, callback); return; }
      void (async () => {
        if (createdOurDirectory) {
          await checkIdentity();
          await unlink(resolve(lockPath, ownerFile));
        } else {
          const prior = observed;
          const current = await inspect();
          if (!prior || current.stat.dev !== prior.stat.dev || current.stat.ino !== prior.stat.ino ||
              current.file !== prior.file || ownerState(current.owner) !== 'dead') throw busy();
          // Unique filename matters: another reclaimer cannot unlink a replacement owner's token.
          // ENOENT means we lost the race and MUST NOT proceed to rmdir a potentially new lock.
          await unlink(resolve(lockPath, prior.file));
        }
        await rmdir(lockPath); // A new owner's sentinel makes this fail with ENOTEMPTY, never theft.
        await syncDirectory(root);
      })().then(() => callback(null), error => callback(error as NodeJS.ErrnoException));
    }) as typeof nativeFs.rmdir,
  };
  const release = await lockfile.lock(target, {
    realpath: false, fs: guardedFs, stale: 10_000, update: 2_000,
    retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50, randomize: false },
    onCompromised(error) { compromised = error; },
  });
  const lock: TransactionLock = {
    async assertOwned() {
      if (compromised) throw new StorageCorruptionError('Transaction lock was compromised', { cause: compromised });
      await checkIdentity();
      if (compromised) throw new StorageCorruptionError('Transaction lock was compromised', { cause: compromised });
    },
  };
  try {
    await lock.assertOwned();
    return await action(lock);
  } finally {
    // Never release a replacement owner's directory, including after onCompromised.
    let ours = false;
    try { await checkIdentity(); ours = true; } catch { /* fail closed */ }
    if (ours) {
      if (compromised) {
        await unlink(resolve(lockPath, ownerFile));
        await rmdir(lockPath);
        await syncDirectory(root);
      } else await release();
    }
  }
}
