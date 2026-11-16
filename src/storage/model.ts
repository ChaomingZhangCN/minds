import { posix } from 'node:path';
import { sha256, SHA256_PATTERN } from './blobStore';
import { assertKeys, assertObject, jsonBytes, StorageCorruptionError } from './fs';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface SnapshotResource { path: string; hash: string; size: number; kind: string; mime?: string }
export interface SnapshotManifest {
  schemaVersion: 1;
  id: string;
  documentId: string;
  savedAt: number;
  contentHash: string;
  relativePath: string;
  markdown: { hash: string; size: number };
  resources: SnapshotResource[];
  warnings: string[];
  reason: string;
  restoredFrom?: string;
  manifestHash: string;
}
export interface DocumentIndex { relativePath: string; head: string | null; retained: string[] }
export interface StoreIndex {
  schemaVersion: 1;
  generation: number;
  registry: Record<string, string>;
  documents: Record<string, DocumentIndex>;
  gcCandidates: Record<string, { firstSeenAt: number }>;
  checksum: string;
}
export interface PendingRecord {
  schemaVersion: 1;
  state: 'prepared';
  createdAt: number;
  baseHead: string | null;
  manifest: SnapshotManifest;
  checksum: string;
}

export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new StorageCorruptionError('Invalid snapshot/document UUID');
}

export function relativePath(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('Invalid relative resource/document path');
  const normalized = path.replace(/\\/g, '/');
  if (posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('Storage paths must be normalized, workspace-relative paths');
  }
  return normalized;
}

export function assertTime(time: unknown): asserts time is number {
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000) {
    throw new StorageCorruptionError('Invalid storage timestamp');
  }
}

function validHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new StorageCorruptionError('Invalid storage checksum');
}
function size(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new StorageCorruptionError('Invalid blob size');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new StorageCorruptionError('Invalid storage string');
}

export function contentHash(markdown: SnapshotManifest['markdown'], resources: readonly SnapshotResource[]): string {
  return sha256(jsonBytes({ markdown, resources }));
}

function manifestPayload(manifest: Omit<SnapshotManifest, 'manifestHash'> | SnapshotManifest): Omit<SnapshotManifest, 'manifestHash'> {
  return {
    schemaVersion: 1, id: manifest.id, documentId: manifest.documentId, savedAt: manifest.savedAt,
    contentHash: manifest.contentHash, relativePath: manifest.relativePath,
    markdown: { hash: manifest.markdown.hash, size: manifest.markdown.size },
    resources: manifest.resources.map(resource => ({
      path: resource.path, hash: resource.hash, size: resource.size, kind: resource.kind,
      ...(resource.mime === undefined ? {} : { mime: resource.mime }),
    })),
    warnings: [...manifest.warnings], reason: manifest.reason,
    ...(manifest.restoredFrom === undefined ? {} : { restoredFrom: manifest.restoredFrom }),
  };
}

export function sealManifest(payload: Omit<SnapshotManifest, 'manifestHash'>): SnapshotManifest {
  const canonical = manifestPayload(payload);
  return { ...canonical, manifestHash: sha256(jsonBytes(canonical)) };
}

export function parseManifest(value: unknown): SnapshotManifest {
  assertObject(value, 'snapshot manifest');
  assertKeys(value, ['schemaVersion', 'id', 'documentId', 'savedAt', 'contentHash', 'relativePath', 'markdown', 'resources', 'warnings', 'reason', 'manifestHash'], ['restoredFrom']);
  if (value.schemaVersion !== 1) throw new StorageCorruptionError('Unknown snapshot manifest version');
  assertId(value.id); assertId(value.documentId); assertTime(value.savedAt);
  validHash(value.contentHash); validHash(value.manifestHash);
  text(value.relativePath); relativePath(value.relativePath);
  assertObject(value.markdown, 'markdown blob');
  assertKeys(value.markdown, ['hash', 'size']); validHash(value.markdown.hash); size(value.markdown.size);
  if (!Array.isArray(value.resources) || !Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string')) {
    throw new StorageCorruptionError('Invalid manifest resources/warnings');
  }
  const paths = new Set<string>();
  for (const resource of value.resources) {
    assertObject(resource, 'snapshot resource');
    assertKeys(resource, ['path', 'hash', 'size', 'kind'], ['mime']);
    text(resource.path); relativePath(resource.path); validHash(resource.hash); size(resource.size); text(resource.kind);
    if (Object.hasOwn(resource, 'mime')) text(resource.mime);
    if (paths.has(resource.path)) throw new StorageCorruptionError('Duplicate snapshot resource path');
    paths.add(resource.path);
  }
  text(value.reason);
  if (Object.hasOwn(value, 'restoredFrom')) assertId(value.restoredFrom);
  const manifest = value as unknown as SnapshotManifest;
  if (contentHash(manifest.markdown, manifest.resources) !== manifest.contentHash || sealManifest(manifest).manifestHash !== manifest.manifestHash) {
    throw new StorageCorruptionError(`Manifest checksum mismatch: ${manifest.id}`);
  }
  return manifestPayloadWithHash(manifest);
}

function manifestPayloadWithHash(manifest: SnapshotManifest): SnapshotManifest {
  return { ...manifestPayload(manifest), manifestHash: manifest.manifestHash };
}

export function sealIndex(index: Omit<StoreIndex, 'checksum'> | StoreIndex): StoreIndex {
  const payload = {
    schemaVersion: 1 as const, generation: index.generation,
    registry: index.registry, documents: index.documents, gcCandidates: index.gcCandidates,
  };
  return { ...payload, checksum: sha256(jsonBytes(payload)) };
}

export function parseIndex(value: unknown): StoreIndex {
  assertObject(value, 'snapshot index');
  assertKeys(value, ['schemaVersion', 'generation', 'registry', 'documents', 'gcCandidates', 'checksum']);
  if (value.schemaVersion !== 1) throw new StorageCorruptionError('Unknown snapshot index version');
  size(value.generation); validHash(value.checksum);
  assertObject(value.registry, 'document registry');
  assertObject(value.documents, 'document index');
  assertObject(value.gcCandidates, 'GC candidates');
  const documentPaths = new Set<string>();
  for (const [id, document] of Object.entries(value.documents)) {
    assertId(id); assertObject(document, 'document index entry');
    assertKeys(document, ['relativePath', 'head', 'retained']);
    text(document.relativePath); relativePath(document.relativePath);
    if (documentPaths.has(document.relativePath)) throw new StorageCorruptionError('Duplicate document registry path');
    documentPaths.add(document.relativePath);
    if (!Array.isArray(document.retained)) throw new StorageCorruptionError('Invalid retained snapshot list');
    document.retained.forEach(assertId);
    if (new Set(document.retained).size !== document.retained.length) throw new StorageCorruptionError('Duplicate retained snapshot');
    if (document.head === null) {
      if (document.retained.length) throw new StorageCorruptionError('Headless document has retained snapshots');
    } else {
      assertId(document.head);
      if (document.retained[0] !== document.head) throw new StorageCorruptionError('Document head is not retained');
    }
    if (!Object.hasOwn(value.registry, document.relativePath) || value.registry[document.relativePath] !== id) {
      throw new StorageCorruptionError('Registry/document index mismatch');
    }
  }
  for (const [path, id] of Object.entries(value.registry)) {
    relativePath(path); assertId(id);
    if (!Object.hasOwn(value.documents, id) || (value.documents[id] as DocumentIndex).relativePath !== path) {
      throw new StorageCorruptionError('Registry refers to an unknown document');
    }
  }
  for (const [hash, candidate] of Object.entries(value.gcCandidates)) {
    validHash(hash); assertObject(candidate, 'GC candidate'); assertKeys(candidate, ['firstSeenAt']); assertTime(candidate.firstSeenAt);
  }
  const index = value as unknown as StoreIndex;
  if (sealIndex(index).checksum !== index.checksum) throw new StorageCorruptionError('Snapshot index checksum mismatch');
  return {
    ...index,
    registry: Object.assign(Object.create(null) as StoreIndex['registry'], index.registry),
    documents: Object.assign(Object.create(null) as StoreIndex['documents'], index.documents),
    gcCandidates: Object.assign(Object.create(null) as StoreIndex['gcCandidates'], index.gcCandidates),
  };
}

export function sealPending(pending: Omit<PendingRecord, 'checksum'>): PendingRecord {
  return { ...pending, checksum: sha256(jsonBytes(pending)) };
}

export function parsePending(value: unknown): PendingRecord {
  assertObject(value, 'pending snapshot journal');
  assertKeys(value, ['schemaVersion', 'state', 'createdAt', 'baseHead', 'manifest', 'checksum']);
  if (value.schemaVersion !== 1 || value.state !== 'prepared') throw new StorageCorruptionError('Unknown pending journal state');
  assertTime(value.createdAt); validHash(value.checksum);
  if (value.baseHead !== null) assertId(value.baseHead);
  const manifest = parseManifest(value.manifest);
  const payload = { schemaVersion: 1 as const, state: 'prepared' as const, createdAt: value.createdAt, baseHead: value.baseHead as string | null, manifest };
  const expected = sealPending(payload);
  if (expected.checksum !== value.checksum) throw new StorageCorruptionError('Pending journal checksum mismatch');
  return expected;
}
