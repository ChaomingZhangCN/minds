import { randomUUID } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { resolve } from 'node:path';
import type { HistoryEntry, MaintenanceReport, SnapshotPreview } from '../shared/types';
import { BlobStore, SHA256_PATTERN, sha256 } from './blobStore';
import {
  atomicWrite, ensureDirectory, immutableWrite, isMissing, jsonBytes, readJson,
  StorageCorruptionError, syncDirectory, TEMP_FILE_PATTERN,
} from './fs';
import { withTransactionLock, type TransactionLock } from './lock';
import {
  assertId, assertTime, contentHash, parseIndex, parseManifest, parsePending, relativePath,
  sealIndex, sealManifest, sealPending, UUID_PATTERN,
  type DocumentIndex, type PendingRecord, type SnapshotManifest, type StoreIndex,
} from './model';
import { DAY_MS, selectRetained, validatePolicy, type RetentionPolicyConfig } from './retention';

export type { SnapshotManifest, SnapshotResource } from './model';
export type { RetentionPolicyConfig } from './retention';
export { DEFAULT_RETENTION_POLICY } from './retention';
export { StorageCorruptionError } from './fs';

export interface RecordSnapshotInput {
  documentId: string;
  relativePath: string;
  markdown: string;
  resources: { path: string; bytes: Uint8Array; kind: string; mime?: string }[];
  warnings?: string[];
  savedAt?: number;
  reason?: string;
  restoredFrom?: string;
}
export interface ReadSnapshotResult {
  manifest: SnapshotManifest;
  markdown: string;
  resources: { path: string; bytes: Buffer; hash: string; kind: string; mime?: string }[];
}
export class SnapshotRecordError extends Error {
  constructor(readonly documentId: string, readonly snapshotId: string, cause: unknown) {
    super(`Snapshot ${snapshotId} did not complete; inspect/retry its pending journal if present`, { cause });
    this.name = 'SnapshotRecordError';
  }
}
interface ScannedState {
  manifests: Map<string, SnapshotManifest>;
  pending: PendingRecord[];
  objects: Map<string, Stats>;
  warnings: string[];
}
const FORMAT = { schemaVersion: 1, format: 'minds-private-snapshots' };

/** A single atomic index is the only authority; orphan manifests are never rediscovered as history. */
export class SnapshotStore {
  readonly root: string;
  private readonly blobs: BlobStore;
  private readonly clock: () => number;
  private readonly gcGraceMs: number;
  private policy: RetentionPolicyConfig;
  private initialized = false;
  private initialization?: Promise<void>;

  constructor(root: string, policy: RetentionPolicyConfig, options: { clock?: () => number; gcGraceMs?: number } = {}) {
    this.root = resolve(root);
    this.blobs = new BlobStore(resolve(this.root, 'objects'));
    this.policy = validatePolicy(policy);
    this.clock = options.clock ?? Date.now;
    this.gcGraceMs = options.gcGraceMs ?? DAY_MS;
    if (!Number.isFinite(this.gcGraceMs) || this.gcGraceMs < 0) throw new TypeError('Invalid blob GC grace period');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = this.initializeOnce().then(() => { this.initialized = true; }).catch(error => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  updatePolicy(policy: RetentionPolicyConfig): void { this.policy = validatePolicy(policy); }

  async getDocumentId(path: string): Promise<string> {
    const normalized = relativePath(path);
    return this.transaction(async lock => {
      const index = await this.readIndex();
      if (Object.hasOwn(index.registry, normalized)) return index.registry[normalized];
      const id = randomUUID();
      index.registry[normalized] = id;
      index.documents[id] = { relativePath: normalized, head: null, retained: [] };
      await this.writeIndex(index, lock);
      return id;
    });
  }

  async renameDocument(oldPath: string, newPath: string): Promise<void> {
    const oldName = relativePath(oldPath);
    const newName = relativePath(newPath);
    await this.transaction(async lock => {
      const index = await this.readIndex();
      if (oldName === newName) return;
      if (!Object.hasOwn(index.registry, oldName)) throw new Error('Document is not registered');
      if (Object.hasOwn(index.registry, newName)) throw new Error('Rename destination is already registered');
      const id = index.registry[oldName];
      delete index.registry[oldName];
      index.registry[newName] = id;
      index.documents[id].relativePath = newName;
      await this.writeIndex(index, lock);
    });
  }

  async record(input: RecordSnapshotInput): Promise<HistoryEntry> {
    assertId(input.documentId);
    const path = relativePath(input.relativePath);
    if (typeof input.markdown !== 'string' || !Array.isArray(input.resources)) throw new TypeError('Invalid snapshot input');
    // Capture caller-owned byte arrays before any awaits (including time spent waiting for a lock).
    const markdownBytes = Buffer.from(input.markdown, 'utf8');
    const resources = input.resources.map(resource => ({
      path: relativePath(resource.path), bytes: Buffer.from(resource.bytes), kind: resource.kind,
      ...(resource.mime === undefined ? {} : { mime: resource.mime }),
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const savedAt = input.savedAt ?? this.now();
    assertTime(savedAt);
    const markdown = { hash: sha256(markdownBytes), size: markdownBytes.length };
    const resourceMetadata = resources.map(resource => ({
      path: resource.path, hash: sha256(resource.bytes), size: resource.bytes.length, kind: resource.kind,
      ...(resource.mime === undefined ? {} : { mime: resource.mime }),
    }));
    const manifest = parseManifest(sealManifest({
      schemaVersion: 1, id: randomUUID(), documentId: input.documentId, savedAt,
      contentHash: contentHash(markdown, resourceMetadata), relativePath: path, markdown,
      resources: resourceMetadata, warnings: [...(input.warnings ?? [])], reason: input.reason ?? 'save',
      ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
    }));
    try {
      return await this.transaction(async lock => {
        const policy = this.policy;
        const index = await this.readIndex();
        const document = this.document(index, manifest.documentId);
        if (document.relativePath !== manifest.relativePath) throw new Error('Document path changed; register/rename it before saving');
        const journal = sealPending({
          schemaVersion: 1, state: 'prepared', createdAt: this.now(), baseHead: document.head, manifest,
        });
        // Journal precedes all objects; both incomplete and complete in-flight saves protect every hash.
        await atomicWrite(this.pendingPath(manifest.id), jsonBytes(journal), () => lock.assertOwned());
        await lock.assertOwned();
        await this.blobs.put(markdownBytes);
        for (const resource of resources) {
          await lock.assertOwned();
          await this.blobs.put(resource.bytes);
        }
        await this.publishManifest(manifest, lock);
        const entry = await this.commitManifest(index, manifest, policy, lock);
        await this.removeCommittedPending(manifest.id, lock);
        return entry;
      });
    } catch (error) { throw new SnapshotRecordError(manifest.documentId, manifest.id, error); }
  }

  /** Retry a fully written prepared save without changing its original timestamp or snapshot ID. */
  async retryRecord(documentId: string, id: string): Promise<HistoryEntry> {
    assertId(documentId); assertId(id);
    return this.transaction(async lock => {
      const policy = this.policy;
      const index = await this.readIndex();
      const document = this.document(index, documentId);
      const pending = parsePending(await readJson(this.pendingPath(id)));
      if (pending.manifest.id !== id || pending.manifest.documentId !== documentId) throw new StorageCorruptionError('Pending journal identity mismatch');
      if (document.retained.includes(id)) {
        const manifest = await this.loadManifest(documentId, id);
        await this.readManifestBytes(manifest);
        await this.removeCommittedPending(id, lock);
        return this.entry(manifest, document.head);
      }
      if (document.head !== pending.baseHead || document.relativePath !== pending.manifest.relativePath) {
        throw new Error('A newer save or rename superseded this pending snapshot; discard it instead of resurrecting old history');
      }
      await this.readManifestBytes(pending.manifest);
      await this.publishManifest(pending.manifest, lock);
      const entry = await this.commitManifest(index, pending.manifest, policy, lock);
      await this.removeCommittedPending(id, lock);
      return entry;
    });
  }

  /** Explicitly abandons a journal only. Objects remain subject to normal grace/two-scan GC. */
  async discardPending(documentId: string, id: string): Promise<void> {
    assertId(documentId); assertId(id);
    await this.transaction(async lock => {
      this.document(await this.readIndex(), documentId);
      const pending = parsePending(await readJson(this.pendingPath(id)));
      if (pending.manifest.id !== id || pending.manifest.documentId !== documentId) throw new StorageCorruptionError('Pending journal identity mismatch');
      await lock.assertOwned();
      await unlink(this.pendingPath(id));
      await syncDirectory(resolve(this.root, 'pending'));
    });
  }

  async list(documentId: string): Promise<HistoryEntry[]> {
    assertId(documentId);
    return this.transaction(async () => {
      const document = this.document(await this.readIndex(), documentId);
      const entries: HistoryEntry[] = [];
      for (const id of document.retained) entries.push(this.entry(await this.loadManifest(documentId, id), document.head));
      return entries;
    });
  }

  async preview(documentId: string, id: string): Promise<SnapshotPreview> {
    assertId(documentId); assertId(id);
    return this.transaction(async () => {
      const document = this.document(await this.readIndex(), documentId);
      this.requireRetained(document, id);
      const snapshot = await this.readManifestBytes(await this.loadManifest(documentId, id));
      return {
        entry: this.entry(snapshot.manifest, document.head), markdown: snapshot.markdown,
        resources: snapshot.manifest.resources.map(({ path, hash, kind, size }) => ({ path, hash, kind, size })),
        warnings: [...snapshot.manifest.warnings],
      };
    });
  }

  async readSnapshot(documentId: string, id: string): Promise<ReadSnapshotResult> {
    assertId(documentId); assertId(id);
    // All bytes are copied and checksum/size-verified while commits and deletion are excluded.
    return this.transaction(async () => {
      const document = this.document(await this.readIndex(), documentId);
      this.requireRetained(document, id);
      return this.readManifestBytes(await this.loadManifest(documentId, id));
    });
  }

  async maintain({ dryRun }: { dryRun: boolean }): Promise<MaintenanceReport> {
    if (typeof dryRun !== 'boolean') throw new TypeError('Maintenance requires an explicit dryRun boolean');
    const report: MaintenanceReport = {
      dryRun, expiredSnapshots: 0, collectibleBlobs: 0, collectibleBytes: 0, deletedBlobs: 0, warnings: [],
    };
    try {
      await this.transaction(async lock => {
        const policy = this.policy;
        const now = this.now();
        const index = await this.readIndex();
        const first = await this.scan(index);
        const planned = structuredClone(index);
        let expired = 0;
        for (const [documentId, document] of Object.entries(planned.documents)) {
          const manifests = document.retained.map(id => first.manifests.get(this.key(documentId, id))!);
          const retained = selectRetained(manifests, document.head, policy, now).map(manifest => manifest.id);
          expired += document.retained.length - retained.length;
          document.retained = retained;
        }
        const references = this.references(planned, first).all;
        const previousCandidates = index.gcCandidates;
        planned.gcCandidates = Object.create(null) as StoreIndex['gcCandidates'];
        for (const hash of first.objects.keys()) {
          if (!references.has(hash)) planned.gcCandidates[hash] = previousCandidates[hash] ?? { firstSeenAt: now };
        }
        if (!dryRun) await this.writeIndex(planned, lock);
        report.expiredSnapshots = expired;
        // Full second scan after the retention commit. No deletion is based solely on an old mtime,
        // a single reference scan, a stale cached index, or an in-memory list from before the lock.
        const current = await this.readIndex();
        const expected = dryRun ? index : planned;
        if (current.checksum !== expected.checksum) throw new StorageCorruptionError('Snapshot index changed during maintenance');
        const second = await this.scan(current);
        const finalReferences = this.references(dryRun ? planned : current, second).all;
        const eligible: { hash: string; stat: Stats }[] = [];
        for (const [hash, candidate] of Object.entries(planned.gcCandidates)) {
          if (!Object.hasOwn(previousCandidates, hash) || now - candidate.firstSeenAt < this.gcGraceMs || finalReferences.has(hash)) continue;
          const firstStat = first.objects.get(hash);
          const secondStat = second.objects.get(hash);
          if (!firstStat || !secondStat || !sameFile(firstStat, secondStat)) throw new StorageCorruptionError('GC candidate changed between scans');
          await this.blobs.get(hash);
          const checked = await lstat(resolve(this.root, 'objects', hash));
          if (!sameFile(secondStat, checked)) throw new StorageCorruptionError('GC candidate changed during checksum verification');
          eligible.push({ hash, stat: checked });
        }
        report.collectibleBlobs = eligible.length;
        report.collectibleBytes = eligible.reduce((total, object) => total + object.stat.size, 0);
        report.warnings.push(...new Set([...first.warnings, ...second.warnings]));
        if (dryRun) return;
        for (const object of eligible) {
          await lock.assertOwned();
          if (!sameFile(object.stat, await lstat(resolve(this.root, 'objects', object.hash)))) {
            throw new StorageCorruptionError('GC candidate changed before deletion');
          }
          await unlink(resolve(this.root, 'objects', object.hash));
          report.deletedBlobs++;
          delete planned.gcCandidates[object.hash];
        }
        if (eligible.length) {
          await syncDirectory(resolve(this.root, 'objects'));
          await this.writeIndex(planned, lock);
        }
        // Retired, valid manifests may be removed only after the authoritative index committed.
        const pendingKeys = new Set(second.pending.map(pending => this.key(pending.manifest.documentId, pending.manifest.id)));
        const changedDirectories = new Set<string>();
        for (const [key, manifest] of second.manifests) {
          if (planned.documents[manifest.documentId].retained.includes(manifest.id) || pendingKeys.has(key)) continue;
          await lock.assertOwned();
          await unlink(this.manifestPath(manifest.documentId, manifest.id));
          changedDirectories.add(resolve(this.root, 'documents', manifest.documentId, 'snapshots'));
        }
        for (const directory of changedDirectories) await syncDirectory(directory);
      });
    } catch (error) {
      report.warnings.push(`ERROR: Maintenance aborted (fail-closed): ${error instanceof Error ? error.message : String(error)}`);
    }
    return report;
  }

  private now(): number { const now = this.clock(); assertTime(now); return now; }
  private key(documentId: string, id: string): string { return `${documentId}/${id}`; }
  private manifestPath(documentId: string, id: string): string { return resolve(this.root, 'documents', documentId, 'snapshots', `${id}.json`); }
  private pendingPath(id: string): string { return resolve(this.root, 'pending', `${id}.json`); }
  private async transaction<T>(action: (lock: TransactionLock) => Promise<T>): Promise<T> {
    await this.initialize();
    return withTransactionLock(this.root, action);
  }

  private async initializeOnce(): Promise<void> {
    await ensureDirectory(this.root);
    await withTransactionLock(this.root, async lock => {
      for (const name of ['objects', 'documents', 'pending']) await ensureDirectory(resolve(this.root, name));
      await syncDirectory(this.root);
      let existing: unknown;
      try { existing = await readJson(resolve(this.root, 'index.json')); }
      catch (error) {
        if (!isMissing(error)) throw error;
        let markerExists = true;
        try { await lstat(resolve(this.root, 'format.json')); } catch (markerError) { if (isMissing(markerError)) markerExists = false; else throw markerError; }
        const nonempty = (await Promise.all(['objects', 'documents', 'pending'].map(name => readdir(resolve(this.root, name))))).some(files => files.length > 0);
        if (markerExists || nonempty) throw new StorageCorruptionError('Snapshot index is missing; orphan manifests must not resurrect history');
        await atomicWrite(resolve(this.root, 'format.json'), jsonBytes(FORMAT), () => lock.assertOwned());
        await atomicWrite(resolve(this.root, 'index.json'), jsonBytes(sealIndex({
          schemaVersion: 1, generation: 0, registry: Object.create(null), documents: Object.create(null), gcCandidates: Object.create(null),
        })), () => lock.assertOwned());
        return;
      }
      parseIndex(existing);
      await this.checkFormat();
    });
  }

  private async checkFormat(): Promise<void> {
    const format = await readJson(resolve(this.root, 'format.json'));
    if (JSON.stringify(format) !== JSON.stringify(FORMAT)) throw new StorageCorruptionError('Unknown private snapshot store format');
  }
  private async readIndex(): Promise<StoreIndex> {
    try { await this.checkFormat(); return parseIndex(await readJson(resolve(this.root, 'index.json'))); }
    catch (error) {
      if (error instanceof StorageCorruptionError) throw error;
      throw new StorageCorruptionError('Snapshot index/format is missing or unreadable; no orphan recovery is allowed', { cause: error });
    }
  }
  private async writeIndex(index: StoreIndex, lock: TransactionLock): Promise<void> {
    if (!Number.isSafeInteger(index.generation + 1)) throw new StorageCorruptionError('Index generation overflow');
    index.generation++;
    const sealed = sealIndex(index);
    await atomicWrite(resolve(this.root, 'index.json'), jsonBytes(sealed), () => lock.assertOwned());
    index.checksum = sealed.checksum;
  }
  private document(index: StoreIndex, documentId: string): DocumentIndex {
    if (!Object.hasOwn(index.documents, documentId)) throw new Error('Document is not registered');
    return index.documents[documentId];
  }
  private requireRetained(document: DocumentIndex, id: string): void {
    if (!document.retained.includes(id)) throw new Error('Snapshot is not retained');
  }
  private entry(manifest: SnapshotManifest, head: string | null): HistoryEntry {
    return {
      id: manifest.id, documentId: manifest.documentId, savedAt: manifest.savedAt,
      contentHash: manifest.contentHash, resourceCount: manifest.resources.length,
      head: manifest.id === head, reason: manifest.reason,
    };
  }
  private async loadManifest(documentId: string, id: string): Promise<SnapshotManifest> {
    try {
      const manifest = parseManifest(await readJson(this.manifestPath(documentId, id)));
      if (manifest.id !== id || manifest.documentId !== documentId) throw new StorageCorruptionError('Snapshot manifest identity mismatch');
      return manifest;
    } catch (error) {
      if (error instanceof StorageCorruptionError) throw error;
      throw new StorageCorruptionError(`Snapshot manifest is missing/unreadable: ${documentId}/${id}`, { cause: error });
    }
  }
  private async publishManifest(manifest: SnapshotManifest, lock: TransactionLock): Promise<void> {
    const documentDirectory = resolve(this.root, 'documents', manifest.documentId);
    await ensureDirectory(documentDirectory);
    await syncDirectory(resolve(this.root, 'documents'));
    await ensureDirectory(resolve(documentDirectory, 'snapshots'));
    await syncDirectory(documentDirectory);
    await immutableWrite(this.manifestPath(manifest.documentId, manifest.id), jsonBytes(manifest), () => lock.assertOwned());
  }
  private async commitManifest(index: StoreIndex, manifest: SnapshotManifest, policy: RetentionPolicyConfig, lock: TransactionLock): Promise<HistoryEntry> {
    const document = this.document(index, manifest.documentId);
    const entries = [manifest];
    for (const id of document.retained) entries.push(await this.loadManifest(manifest.documentId, id));
    document.head = manifest.id;
    document.retained = selectRetained(entries, manifest.id, policy, this.now()).map(entry => entry.id);
    // Clearing candidates for newly referenced hashes also resets grace if they later become orphaned.
    for (const object of [manifest.markdown, ...manifest.resources]) delete index.gcCandidates[object.hash];
    await this.writeIndex(index, lock);
    return this.entry(manifest, manifest.id);
  }
  private async removeCommittedPending(id: string, lock: TransactionLock): Promise<void> {
    // The index already committed. Cleanup failure must not turn a successful save into a duplicate retry.
    try {
      await lock.assertOwned();
      await unlink(this.pendingPath(id));
      await syncDirectory(resolve(this.root, 'pending'));
    } catch { /* A valid leftover journal is protected and can be explicitly retried/discarded. */ }
  }
  private async readManifestBytes(manifest: SnapshotManifest): Promise<ReadSnapshotResult> {
    const markdownBytes = await this.blobs.get(manifest.markdown.hash);
    if (markdownBytes.length !== manifest.markdown.size) throw new StorageCorruptionError('Markdown size mismatch');
    const resources: ReadSnapshotResult['resources'] = [];
    for (const resource of manifest.resources) {
      const bytes = await this.blobs.get(resource.hash);
      if (bytes.length !== resource.size) throw new StorageCorruptionError(`Resource size mismatch: ${resource.path}`);
      resources.push({ path: resource.path, bytes, hash: resource.hash, kind: resource.kind, ...(resource.mime === undefined ? {} : { mime: resource.mime }) });
    }
    return { manifest, markdown: markdownBytes.toString('utf8'), resources };
  }

  private references(index: StoreIndex, scan: ScannedState): { all: Map<string, number>; retained: Set<string> } {
    const all = new Map<string, number>();
    const retained = new Set<string>();
    const add = (manifest: SnapshotManifest, required: boolean) => {
      for (const object of [manifest.markdown, ...manifest.resources]) {
        if (all.has(object.hash) && all.get(object.hash) !== object.size) throw new StorageCorruptionError('Conflicting sizes for the same blob hash');
        all.set(object.hash, object.size);
        if (required) retained.add(object.hash);
      }
    };
    for (const [documentId, document] of Object.entries(index.documents)) {
      for (const id of document.retained) {
        const manifest = scan.manifests.get(this.key(documentId, id));
        if (!manifest) throw new StorageCorruptionError(`Retained manifest is missing: ${documentId}/${id}`);
        add(manifest, true);
      }
    }
    for (const pending of scan.pending) add(pending.manifest, false);
    return { all, retained };
  }

  private async scan(index: StoreIndex): Promise<ScannedState> {
    const state: ScannedState = { manifests: new Map(), pending: [], objects: new Map(), warnings: [] };
    const rootNames = new Set(['objects', 'documents', 'pending', 'index.json', 'format.json', '.transaction.lock', '.owner.json']);
    for (const file of await readdir(this.root, { withFileTypes: true })) {
      if (TEMP_FILE_PATTERN.test(file.name) && file.isFile()) { state.warnings.push('Uncommitted temporary metadata is preserved'); continue; }
      if (!rootNames.has(file.name)) throw new StorageCorruptionError(`Unknown private store state: ${file.name}`);
    }
    for (const directory of ['objects', 'documents', 'pending']) {
      const stat = await lstat(resolve(this.root, directory));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageCorruptionError('Private store directory was replaced');
    }
    for (const file of await readdir(resolve(this.root, 'objects'), { withFileTypes: true })) {
      if (TEMP_FILE_PATTERN.test(file.name) && file.isFile()) { state.warnings.push('Uncommitted temporary blobs are preserved'); continue; }
      if (!file.isFile() || !SHA256_PATTERN.test(file.name)) throw new StorageCorruptionError(`Unknown private blob state: ${file.name}`);
      const stat = await lstat(resolve(this.root, 'objects', file.name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new StorageCorruptionError('Private blob was replaced');
      state.objects.set(file.name, stat);
    }
    for (const directory of await readdir(resolve(this.root, 'documents'), { withFileTypes: true })) {
      if (!directory.isDirectory() || !UUID_PATTERN.test(directory.name) || !Object.hasOwn(index.documents, directory.name)) {
        throw new StorageCorruptionError(`Unknown document storage state: ${directory.name}`);
      }
      const documentDirectory = resolve(this.root, 'documents', directory.name);
      if ((await readdir(documentDirectory)).some(name => name !== 'snapshots')) throw new StorageCorruptionError('Unknown document storage files');
      const snapshotsDirectory = resolve(documentDirectory, 'snapshots');
      const stat = await lstat(snapshotsDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageCorruptionError('Snapshot directory was replaced');
      for (const file of await readdir(snapshotsDirectory, { withFileTypes: true })) {
        if (TEMP_FILE_PATTERN.test(file.name) && file.isFile()) { state.warnings.push('Uncommitted temporary manifests are preserved'); continue; }
        const id = file.name.endsWith('.json') ? file.name.slice(0, -5) : '';
        if (!file.isFile() || !UUID_PATTERN.test(id)) throw new StorageCorruptionError(`Unknown snapshot file: ${file.name}`);
        state.manifests.set(this.key(directory.name, id), await this.loadManifest(directory.name, id));
      }
    }
    for (const file of await readdir(resolve(this.root, 'pending'), { withFileTypes: true })) {
      if (TEMP_FILE_PATTERN.test(file.name) && file.isFile()) { state.warnings.push('Uncommitted temporary journals are preserved'); continue; }
      const id = file.name.endsWith('.json') ? file.name.slice(0, -5) : '';
      if (!file.isFile() || !UUID_PATTERN.test(id)) throw new StorageCorruptionError('Unknown pending journal file');
      const pending = parsePending(await readJson(this.pendingPath(id)));
      if (pending.manifest.id !== id || !Object.hasOwn(index.documents, pending.manifest.documentId)) throw new StorageCorruptionError('Pending journal identity/registry mismatch');
      state.pending.push(pending);
      state.warnings.push(`Pending snapshot ${id} is protected; retry or discard explicitly`);
    }
    const references = this.references(index, state);
    for (const [hash, expectedSize] of references.all) {
      const object = state.objects.get(hash);
      if (!object) {
        if (references.retained.has(hash)) throw new StorageCorruptionError(`Retained blob is missing: ${hash}`);
        continue; // A prepared journal may have crashed before its object writes.
      }
      if (object.size !== expectedSize) throw new StorageCorruptionError(`Referenced blob size mismatch: ${hash}`);
      await this.blobs.get(hash);
    }
    return state;
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
