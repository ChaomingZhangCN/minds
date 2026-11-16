import { mkdtemp, readFile, readdir, rm, writeFile, utimes, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobStore, DAY_MS, DEFAULT_RETENTION_POLICY, SnapshotRecordError, SnapshotStore, sha256 } from '../src/storage';
import { atomicWrite } from '../src/storage/fs';
import { withTransactionLock } from '../src/storage/lock';

const directories: string[] = [];
const children: ChildProcess[] = [];
const NOW = Date.parse('2026-11-16T12:00:00Z');
const sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms));
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'minds-storage-test-'));
  directories.push(root);
  return root;
}
async function fixture(maxSnapshots = 100, grace = DAY_MS) {
  const root = await temp();
  let now = NOW;
  const store = new SnapshotStore(root, { ...DEFAULT_RETENTION_POLICY, maxSnapshots }, { clock: () => now, gcGraceMs: grace });
  await store.initialize();
  const id = await store.getDocumentId('doc.md');
  const save = (markdown: string, resources: { path: string; bytes: Uint8Array; kind: string; mime?: string }[] = [], savedAt?: number) =>
    store.record({ documentId: id, relativePath: 'doc.md', markdown, resources, ...(savedAt === undefined ? {} : { savedAt }) });
  return { root, store, id, save, advance(ms: number) { now += ms; } };
}
function manifestPath(root: string, documentId: string, id: string) {
  return join(root, 'documents', documentId, 'snapshots', `${id}.json`);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('BlobStore', () => {
  it('deduplicates identical bytes under concurrent puts and validates hashes', async () => {
    const root = await temp();
    const store = new BlobStore(root);
    const values = await Promise.all(Array.from({ length: 20 }, () => store.put(Buffer.from('same bytes'))));
    expect(new Set(values.map(value => value.path)).size).toBe(1);
    expect(await readdir(root)).toEqual([sha256(Buffer.from('same bytes'))]);
    expect(values[0].size).toBe(10);
    expect(await store.get(values[0].hash)).toEqual(Buffer.from('same bytes'));
    await writeFile(values[0].path, 'corruption');
    await expect(store.get(values[0].hash)).rejects.toThrow('checksum');
    await expect(store.put(Buffer.from('same bytes'))).rejects.toThrow();
    expect(await readFile(values[0].path, 'utf8')).toBe('corruption');
  });

  it('has a strict image extension whitelist and rejects hash/path injection', async () => {
    const store = new BlobStore(await temp());
    for (const extension of ['png', '.jpeg', 'jpg', 'webp', 'gif']) {
      const blob = await store.put(Buffer.from('image'), extension);
      expect(blob.path).toMatch(new RegExp(`\\.${extension.replace('.', '')}$`));
      expect(await store.get(blob.hash, extension)).toEqual(Buffer.from('image'));
    }
    for (const extension of ['../png', 'png/../other', '.svg', 'exe', 'PNG', 'png\0']) {
      await expect(store.put(Buffer.from('x'), extension)).rejects.toThrow();
    }
    for (const hash of ['../index.json', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}/x`]) {
      await expect(store.get(hash)).rejects.toThrow();
    }
  });
});

describe('SnapshotStore transactions and restore', () => {
  it('records a new metadata entry on every save, while same bytes share blobs/contentHash', async () => {
    const f = await fixture();
    const resource = { path: 'images/a.png', bytes: Buffer.from('png'), kind: 'image', mime: 'image/png' };
    const first = await f.save('same', [resource]);
    const second = await f.save('same', [resource]);
    expect(first.id).not.toBe(second.id);
    expect(first.contentHash).toBe(second.contentHash);
    expect(await readdir(join(f.root, 'objects'))).toHaveLength(2);
    expect(await f.store.list(f.id)).toEqual([{ ...second, head: true }, { ...first, head: false }]);
    expect(Object.keys(second).sort()).toEqual(['contentHash', 'documentId', 'head', 'id', 'reason', 'resourceCount', 'savedAt']);
  });

  it('keeps the saved retained index <= 100 after every save, including same-content saves', async () => {
    const f = await fixture();
    const saved: string[] = [];
    for (let index = 0; index < 110; index++) {
      saved.push((await f.save('same')).id);
      const entries = await f.store.list(f.id);
      expect(entries).toHaveLength(Math.min(index + 1, 100));
      expect(entries.filter(entry => entry.head)).toHaveLength(1);
      const onDisk = JSON.parse(await readFile(join(f.root, 'index.json'), 'utf8'));
      expect(onDisk.documents[f.id].retained.length).toBeLessThanOrEqual(100);
    }
    expect((await f.store.list(f.id)).map(entry => entry.id)).toEqual(saved.slice(-100).reverse());
    expect(await readdir(join(f.root, 'objects'))).toHaveLength(1);
  }, 30_000);

  it('keeps head older than TTL and makes cap 1 a hard transactional limit', async () => {
    const f = await fixture(1);
    const old = await f.save('ancient head', [], NOW - 60 * DAY_MS);
    expect((await f.store.maintain({ dryRun: false })).expiredSnapshots).toBe(0);
    expect(await f.store.list(f.id)).toEqual([old]);
    const next = await f.save('new');
    expect(await f.store.list(f.id)).toEqual([next]);
    await expect(f.store.readSnapshot(f.id, old.id)).rejects.toThrow('not retained');
  });

  it('maintains all documents and never refreshes savedAt when making daily anchors', async () => {
    const f = await fixture();
    const secondId = await f.store.getDocumentId('second.md');
    const firstA = await f.save('first-a', [], NOW - 6 * DAY_MS);
    const firstB = await f.save('first-b', [], NOW - 6 * DAY_MS + 1000);
    await f.save('head');
    const other = await f.store.record({ documentId: secondId, relativePath: 'second.md', markdown: 'other-old', resources: [], savedAt: NOW - 6 * DAY_MS });
    await f.store.record({ documentId: secondId, relativePath: 'second.md', markdown: 'other-head', resources: [] });
    f.advance(2 * DAY_MS);
    expect((await f.store.maintain({ dryRun: true })).expiredSnapshots).toBe(1);
    expect((await f.store.maintain({ dryRun: false })).expiredSnapshots).toBe(1);
    expect((await f.store.list(f.id)).find(entry => entry.id === firstB.id)?.savedAt).toBe(firstB.savedAt);
    expect((await f.store.list(f.id)).some(entry => entry.id === firstA.id)).toBe(false);
    f.advance(30 * DAY_MS);
    expect((await f.store.maintain({ dryRun: false })).expiredSnapshots).toBe(2);
    expect(await f.store.list(f.id)).toHaveLength(1);
    expect((await f.store.list(secondId)).some(entry => entry.id === other.id)).toBe(false);
  });

  it('reads independent full snapshots and every resource after workspace live files are gone', async () => {
    const f = await fixture();
    const liveRoot = await temp();
    const imageBytes = Buffer.from([0, 1, 2, 255]);
    const live = await new BlobStore(liveRoot).put(imageBytes, 'png');
    const resources = [
      { path: '.minds/blobs/image.png', bytes: imageBytes, kind: 'image', mime: 'image/png' },
      { path: 'draw/diagram.drawio', bytes: Buffer.from('<mxfile/>'), kind: 'drawio' },
      { path: 'draw/scene.excalidraw', bytes: Buffer.from('{"type":"excalidraw"}'), kind: 'excalidraw' },
      { path: 'images/same.png', bytes: imageBytes, kind: 'image', mime: 'image/png' },
    ];
    const entry = await f.store.record({ documentId: f.id, relativePath: 'doc.md', markdown: '# original\r\n', resources, warnings: ['remote not backed up'], reason: 'restore', restoredFrom: randomUUID() });
    await rm(live.path);
    await f.save('later snapshot');
    const snapshot = await f.store.readSnapshot(f.id, entry.id);
    expect(snapshot.markdown).toBe('# original\r\n');
    expect(snapshot.resources).toHaveLength(4);
    for (const resource of resources) {
      expect(snapshot.resources.find(value => value.path === resource.path)?.bytes).toEqual(resource.bytes);
    }
    expect(snapshot.manifest.restoredFrom).toBeDefined();
    const preview = await f.store.preview(f.id, entry.id);
    expect(preview.warnings).toEqual(['remote not backed up']);
    expect(preview.resources.every(resource => Object.keys(resource).sort().join(',') === 'hash,kind,path,size')).toBe(true);
    expect(preview.entry.head).toBe(false);
    await f.store.maintain({ dryRun: false });
    f.advance(DAY_MS);
    await f.store.maintain({ dryRun: false });
    expect((await f.store.readSnapshot(f.id, entry.id)).resources).toHaveLength(4);
  });

  it('returns all verified restore bytes before concurrent pruning/GC and keeps them usable afterward', async () => {
    const f = await fixture(1, 0);
    const bytes = Buffer.from('restore resource');
    const old = await f.save('restore markdown', [{ path: 'image.png', bytes, kind: 'image' }]);
    const [snapshot] = await Promise.all([
      f.store.readSnapshot(f.id, old.id), f.save('new head'),
    ]);
    await f.store.maintain({ dryRun: false });
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(2);
    expect(snapshot.markdown).toBe('restore markdown');
    expect(snapshot.resources[0].bytes).toEqual(bytes);
    await expect(readFile(join(f.root, 'objects', snapshot.resources[0].hash))).rejects.toThrow();
  });

  it('keeps stable UUID registry through restart and rename; rejects conflicting renames', async () => {
    const f = await fixture();
    const old = await f.save('before rename');
    await f.store.renameDocument('doc.md', 'nested/renamed.md');
    const reopened = new SnapshotStore(f.root, DEFAULT_RETENTION_POLICY, { clock: () => NOW });
    expect(await reopened.getDocumentId('nested/renamed.md')).toBe(f.id);
    expect((await reopened.readSnapshot(f.id, old.id)).manifest.relativePath).toBe('doc.md');
    await reopened.record({ documentId: f.id, relativePath: 'nested/renamed.md', markdown: 'after', resources: [] });
    const other = await reopened.getDocumentId('other.md');
    expect(other).not.toBe(f.id);
    await expect(reopened.renameDocument('nested/renamed.md', 'other.md')).rejects.toThrow('already registered');
    // These are legitimate filenames, not object prototype accessors.
    expect(await reopened.getDocumentId('__proto__')).toBe(await reopened.getDocumentId('__proto__'));
    await expect(reopened.getDocumentId('../outside.md')).rejects.toThrow();
  });

  it('serializes concurrent Promise transactions from multiple store instances without lost saves', async () => {
    const f = await fixture();
    const other = new SnapshotStore(f.root, DEFAULT_RETENTION_POLICY, { clock: () => NOW });
    const entries = await Promise.all(Array.from({ length: 35 }, (_, index) => (index % 2 ? other : f.store).record({
      documentId: f.id, relativePath: 'doc.md', markdown: `save-${index}`, resources: [],
    })));
    const listed = await f.store.list(f.id);
    expect(new Set(listed.map(entry => entry.id))).toEqual(new Set(entries.map(entry => entry.id)));
    expect(listed.filter(entry => entry.head)).toHaveLength(1);
  });

  it('protects incomplete pending objects and retries with original savedAt after missing bytes arrive', async () => {
    const f = await fixture(100, 0);
    const originalPut = BlobStore.prototype.put;
    let calls = 0;
    vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (this: BlobStore, bytes, extension) {
      if (++calls === 2) throw new Error('simulated resource write failure');
      return originalPut.call(this, bytes, extension);
    });
    const resourceBytes = Buffer.from('pending resource');
    let failure: SnapshotRecordError | undefined;
    try { await f.save('prepared markdown', [{ path: 'a.png', bytes: resourceBytes, kind: 'image' }], NOW - DAY_MS); }
    catch (error) { failure = error as SnapshotRecordError; }
    vi.restoreAllMocks();
    expect(failure).toBeInstanceOf(SnapshotRecordError);
    expect(await f.store.list(f.id)).toEqual([]);
    expect((await f.store.maintain({ dryRun: false })).warnings.join(' ')).toContain('protected');
    f.advance(10 * DAY_MS);
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(0);
    await expect(f.store.retryRecord(f.id, failure!.snapshotId)).rejects.toThrow();
    await new BlobStore(join(f.root, 'objects')).put(resourceBytes);
    const retried = await f.store.retryRecord(f.id, failure!.snapshotId);
    expect(retried.id).toBe(failure!.snapshotId);
    expect(retried.savedAt).toBe(NOW - DAY_MS);
    expect((await f.store.readSnapshot(f.id, retried.id)).resources[0].bytes).toEqual(resourceBytes);
    expect(await readdir(join(f.root, 'pending'))).toEqual([]);
  });

  it('does not resurrect a manifest written before an interrupted index commit; explicit retry works', async () => {
    const f = await fixture();
    const writeIndex = vi.spyOn(f.store as unknown as { writeIndex: () => Promise<void> }, 'writeIndex').mockRejectedValueOnce(new Error('index write interrupted'));
    let failure: SnapshotRecordError | undefined;
    try { await f.save('objects and manifest prepared'); } catch (error) { failure = error as SnapshotRecordError; }
    writeIndex.mockRestore();
    expect(failure).toBeInstanceOf(SnapshotRecordError);
    expect(await readFile(manifestPath(f.root, f.id, failure!.snapshotId), 'utf8')).toContain('manifestHash');
    const reopened = new SnapshotStore(f.root, DEFAULT_RETENTION_POLICY, { clock: () => NOW });
    expect(await reopened.list(f.id)).toEqual([]);
    const entry = await reopened.retryRecord(f.id, failure!.snapshotId);
    expect(entry.id).toBe(failure!.snapshotId);
    expect(await reopened.list(f.id)).toEqual([entry]);
  });

  it('refuses to retry a superseded prepared snapshot and safely discards only its journal', async () => {
    const f = await fixture(1, 0);
    const writeIndex = vi.spyOn(f.store as unknown as { writeIndex: () => Promise<void> }, 'writeIndex').mockRejectedValueOnce(new Error('interrupted'));
    let failure: SnapshotRecordError | undefined;
    try { await f.save('old prepared'); } catch (error) { failure = error as SnapshotRecordError; }
    writeIndex.mockRestore();
    const head = await f.save('new committed');
    await expect(f.store.retryRecord(f.id, failure!.snapshotId)).rejects.toThrow('superseded');
    await f.store.discardPending(f.id, failure!.snapshotId);
    expect(await f.store.list(f.id)).toEqual([head]);
    expect(await readFile(join(f.root, 'objects', sha256(Buffer.from('old prepared'))), 'utf8')).toBe('old prepared');
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(0);
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(1);
  });

  it('checks every resource checksum and rejects mutated saved metadata', async () => {
    const f = await fixture();
    const entry = await f.save('markdown', [{ path: 'r.png', bytes: Buffer.from('bytes'), kind: 'image' }]);
    const snapshot = await f.store.readSnapshot(f.id, entry.id);
    await writeFile(join(f.root, 'objects', snapshot.resources[0].hash), 'BYTES');
    await expect(f.store.readSnapshot(f.id, entry.id)).rejects.toThrow('checksum');
    await expect(f.store.preview(f.id, entry.id)).rejects.toThrow('checksum');
    const file = manifestPath(f.root, f.id, entry.id);
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.savedAt++;
    await writeFile(file, JSON.stringify(manifest));
    await expect(f.store.list(f.id)).rejects.toThrow('checksum');
  });
});

describe('private GC fail-closed safety', () => {
  it('requires persistent observation plus 24h grace and a second full scan; shared/old-mtime blobs stay', async () => {
    const f = await fixture(1);
    const shared = { path: 'shared.png', bytes: Buffer.from('shared'), kind: 'image' };
    await f.save('old markdown', [shared]);
    const other = await f.store.getDocumentId('other.md');
    await f.store.record({ documentId: other, relativePath: 'other.md', markdown: 'other', resources: [shared] });
    await f.save('new markdown');
    const extra = await new BlobStore(join(f.root, 'objects')).put(Buffer.from('orphan'));
    await utimes(extra.path, new Date(0), new Date(0));
    const sharedPath = join(f.root, 'objects', sha256(shared.bytes));
    await utimes(sharedPath, new Date(0), new Date(0));
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(0);
    f.advance(DAY_MS - 1);
    expect((await f.store.maintain({ dryRun: false })).collectibleBlobs).toBe(0);
    f.advance(1);
    const preview = await f.store.maintain({ dryRun: true });
    expect(preview.collectibleBlobs).toBe(2);
    expect(preview.deletedBlobs).toBe(0);
    expect(await readFile(extra.path, 'utf8')).toBe('orphan');
    const report = await f.store.maintain({ dryRun: false });
    expect(report.deletedBlobs).toBe(2);
    expect(report.collectibleBytes).toBe(Buffer.byteLength('orphan') + Buffer.byteLength('old markdown'));
    expect(await readFile(sharedPath, 'utf8')).toBe('shared');
    expect((await f.store.readSnapshot(other, (await f.store.list(other))[0].id)).resources[0].bytes).toEqual(shared.bytes);
  });

  it('resets the observation clock when an orphan hash becomes referenced again', async () => {
    const f = await fixture(1);
    await f.save('reused'); await f.save('other');
    await f.store.maintain({ dryRun: false });
    f.advance(DAY_MS / 2);
    await f.save('reused'); await f.save('head');
    f.advance(DAY_MS / 2);
    await f.store.maintain({ dryRun: false });
    const path = join(f.root, 'objects', sha256(Buffer.from('reused')));
    expect(await readFile(path, 'utf8')).toBe('reused');
    f.advance(DAY_MS - 1);
    await f.store.maintain({ dryRun: false });
    expect(await readFile(path, 'utf8')).toBe('reused');
    f.advance(1);
    await f.store.maintain({ dryRun: false });
    await expect(readFile(path)).rejects.toThrow();
  });

  it('checks manifests again after the first scan and aborts before any blob deletion on new damage', async () => {
    const f = await fixture(1, 0);
    await f.save('orphan'); const head = await f.save('head');
    await f.store.maintain({ dryRun: false });
    const target = f.store as unknown as { scan: (index: unknown) => Promise<unknown> };
    const originalScan = target.scan.bind(f.store);
    let scans = 0;
    vi.spyOn(target, 'scan').mockImplementation(async index => {
      const result = await originalScan(index);
      if (++scans === 1) await writeFile(manifestPath(f.root, f.id, head.id), '{damaged between scans');
      return result;
    });
    const report = await f.store.maintain({ dryRun: false });
    expect(scans).toBe(1); // The second scan starts and detects corruption before returning.
    expect(report.deletedBlobs).toBe(0);
    expect(report.warnings.join(' ')).toContain('ERROR');
    expect(await readFile(join(f.root, 'objects', sha256(Buffer.from('orphan'))), 'utf8')).toBe('orphan');
  });

  it('fails closed rather than following a private-object symlink to workspace live bytes', async () => {
    const f = await fixture(1, 0);
    await f.save('old'); await f.save('head');
    await f.store.maintain({ dryRun: false });
    const liveRoot = await temp();
    const livePath = join(liveRoot, 'live.png');
    await writeFile(livePath, 'live bytes');
    const objectPath = join(f.root, 'objects', sha256(Buffer.from('old')));
    await rm(objectPath); await symlink(livePath, objectPath);
    const report = await f.store.maintain({ dryRun: false });
    expect(report.deletedBlobs).toBe(0);
    expect(report.warnings.join(' ')).toContain('ERROR');
    expect(await readFile(livePath, 'utf8')).toBe('live bytes');
  });

  it('dry runs do not change index, manifests, objects, or start a grace countdown', async () => {
    const f = await fixture(1);
    await f.save('old');
    await f.save('new');
    const before = await readFile(join(f.root, 'index.json'));
    const manifestsBefore = await readdir(join(f.root, 'documents', f.id, 'snapshots'));
    await f.store.maintain({ dryRun: true });
    f.advance(2 * DAY_MS);
    expect((await f.store.maintain({ dryRun: true })).collectibleBlobs).toBe(0);
    expect(await readFile(join(f.root, 'index.json'))).toEqual(before);
    expect(await readdir(join(f.root, 'documents', f.id, 'snapshots'))).toEqual(manifestsBefore);
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(0);
    f.advance(DAY_MS);
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(1);
  });

  it('never deletes workspace live resources, even when private copies become collectible', async () => {
    const f = await fixture(1, 0);
    const liveRoot = await temp();
    const live = await new BlobStore(join(liveRoot, '.minds', 'blobs')).put(Buffer.from('image'), 'png');
    await f.save('old', [{ path: '.minds/blobs/image.png', bytes: Buffer.from('image'), kind: 'image' }]);
    await f.save('head');
    await f.store.maintain({ dryRun: false });
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(2);
    expect(await readFile(live.path, 'utf8')).toBe('image');
  });

  it.each(['corrupt', 'missing'])('aborts GC on %s index without scanning orphan manifests into history', async damage => {
    const f = await fixture(1, 0);
    await f.save('orphan'); await f.save('head');
    await f.store.maintain({ dryRun: false });
    const before = await readdir(join(f.root, 'objects'));
    if (damage === 'corrupt') await writeFile(join(f.root, 'index.json'), '{broken');
    else await rm(join(f.root, 'index.json'));
    const report = await f.store.maintain({ dryRun: false });
    expect(report.warnings.join(' ')).toContain('ERROR');
    expect(report.deletedBlobs).toBe(0);
    expect(await readdir(join(f.root, 'objects'))).toEqual(before);
    await expect(f.store.list(f.id)).rejects.toThrow();
    await expect(new SnapshotStore(f.root, DEFAULT_RETENTION_POLICY).initialize()).rejects.toThrow();
  });

  it('aborts all deletion on corrupt retained manifest or unknown storage state', async () => {
    const f = await fixture(1, 0);
    await f.save('orphan'); const head = await f.save('head');
    await f.store.maintain({ dryRun: false });
    const original = await readFile(manifestPath(f.root, f.id, head.id));
    await writeFile(manifestPath(f.root, f.id, head.id), '{broken');
    expect((await f.store.maintain({ dryRun: false })).deletedBlobs).toBe(0);
    await writeFile(manifestPath(f.root, f.id, head.id), original);
    await writeFile(join(f.root, 'unknown-state'), 'unknown');
    const report = await f.store.maintain({ dryRun: false });
    expect(report.deletedBlobs).toBe(0);
    expect(report.warnings.join(' ')).toContain('Unknown');
  });

  it('also aborts GC for a damaged orphan manifest and unknown pending state', async () => {
    const f = await fixture(1, 0);
    const orphan = await f.save('orphan'); await f.save('head');
    // An orphan is not revived, but corruption is still not a license to destroy its bytes.
    await writeFile(manifestPath(f.root, f.id, orphan.id), '{broken');
    const report = await f.store.maintain({ dryRun: false });
    expect(report.deletedBlobs).toBe(0);
    expect(report.warnings.join(' ')).toContain('ERROR');
    await rm(manifestPath(f.root, f.id, orphan.id));
    await writeFile(join(f.root, 'pending', `${randomUUID()}.json`), JSON.stringify({ schemaVersion: 2, state: 'unknown' }));
    expect((await f.store.maintain({ dryRun: false })).warnings.join(' ')).toContain('ERROR');
  });
});

async function runWorker(code: string, args: string[]): Promise<void> {
  const child = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let errors = '';
  child.stderr!.on('data', data => { errors += String(data); });
  const [status] = await once(child, 'exit');
  if (status !== 0) throw new Error(`Storage worker failed (${status}): ${errors}`);
}
async function fakeOwner(root: string, owner: { pid: number; host: string; nonce: string; startedAt: number }) {
  const lock = join(root, '.transaction.lock');
  await mkdir(lock);
  await writeFile(join(lock, `owner-${owner.nonce}.json`), JSON.stringify(owner));
  await utimes(lock, new Date(0), new Date(0));
}

describe('cross-process locks and owner metadata', () => {
  it('serializes actual concurrent Node processes, including competing dead-owner recovery, without lost commits', async () => {
    const f = await fixture();
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    children.push(dead);
    await once(dead, 'exit');
    await fakeOwner(f.root, { pid: dead.pid!, host: hostname(), nonce: randomUUID(), startedAt: NOW });
    const project = resolve(import.meta.dirname, '..');
    const bundle = await build({
      stdin: {
        contents: `import {SnapshotStore, DEFAULT_RETENTION_POLICY} from ${JSON.stringify(join(project, 'src/storage/index.ts'))};
          (async () => {
            const store = new SnapshotStore(process.argv[1], DEFAULT_RETENTION_POLICY, {clock: () => Number(process.argv[3])});
            for (let i = 0; i < 12; i++) await store.record({documentId: process.argv[2], relativePath: 'doc.md', markdown: process.argv[4] + i, resources: []});
          })().catch(e => { console.error(e); process.exitCode = 1; });`,
        resolveDir: project,
      }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
    });
    await Promise.all(['a', 'b', 'c'].map(prefix => runWorker(bundle.outputFiles[0].text, [f.root, f.id, String(NOW), prefix])));
    const entries = await f.store.list(f.id);
    expect(entries).toHaveLength(36);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(36);
    expect(entries.filter(entry => entry.head)).toHaveLength(1);
  }, 30_000);

  it('does not steal an expired-heartbeat alive owner, then recovers the killed owner', async () => {
    const root = await temp();
    const script = `const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
      const lock = path.join(process.argv[1], '.transaction.lock'); fs.mkdirSync(lock);
      const owner = {pid: process.pid, host: os.hostname(), nonce: crypto.randomUUID(), startedAt: Date.now()};
      fs.writeFileSync(path.join(lock, 'owner-' + owner.nonce + '.json'), JSON.stringify(owner));
      fs.utimesSync(lock, new Date(0), new Date(0)); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await once(child.stdout!, 'data');
    let entered = false;
    const attempt = withTransactionLock(root, async lock => { await lock.assertOwned(); entered = true; });
    await sleep(300);
    expect(entered).toBe(false);
    child.kill('SIGKILL');
    await once(child, 'exit');
    await attempt;
    expect(entered).toBe(true);
  });

  it.each(['foreign', 'missing', 'eperm'])('fails closed for %s owner metadata instead of using stale mtime', async mode => {
    const root = await temp();
    const nonce = randomUUID();
    if (mode === 'missing') { await mkdir(join(root, '.transaction.lock')); await utimes(join(root, '.transaction.lock'), new Date(0), new Date(0)); }
    else await fakeOwner(root, { pid: process.pid, host: mode === 'foreign' ? `${hostname()}-other` : hostname(), nonce, startedAt: NOW });
    if (mode === 'eperm') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
    let entered = false;
    await expect(withTransactionLock(root, async () => { entered = true; })).rejects.toThrow();
    expect(entered).toBe(false);
    expect(await readdir(join(root, '.transaction.lock'))).toEqual(mode === 'missing' ? [] : [`owner-${nonce}.json`]);
  }, 10_000);

  it('onCompromised invalidates guarded atomic commits and releases only its own owner token', async () => {
    const root = await temp();
    const target = join(root, 'protected.json');
    await writeFile(target, 'original');
    await withTransactionLock(root, async lock => {
      await utimes(join(root, '.transaction.lock'), new Date(0), new Date(0));
      await sleep(2200);
      await expect(lock.assertOwned()).rejects.toThrow('compromised');
      await expect(atomicWrite(target, Buffer.from('must-not-commit'), () => lock.assertOwned())).rejects.toThrow('compromised');
    });
    expect(await readFile(target, 'utf8')).toBe('original');
    expect((await readdir(root)).includes('.transaction.lock')).toBe(false);
  });
});
