import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
const host = vi.hoisted(() => ({ saved: [] as ((document: vscode.TextDocument) => void)[], trust: [] as (() => void)[], root: '', trusted: true }));
vi.mock('vscode', () => ({ workspace: {
  get isTrusted() { return host.trusted; }, workspaceFolders: [],
  getConfiguration: () => ({ inspect: () => undefined }),
  getWorkspaceFolder: () => ({ uri: { fsPath: host.root, scheme: 'file', toString: () => `file://${host.root}` } }),
  onDidSaveTextDocument: (fn: (document: vscode.TextDocument) => void) => { host.saved.push(fn); return { dispose() {} }; },
  onDidGrantWorkspaceTrust: (fn: () => void) => { host.trust.push(fn); return { dispose() {} }; },
  onDidRenameFiles: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
} }));
import { HistoryService, SaveArchiveError } from '../src/storageIntegration';
let root: string, history: HistoryService;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'minds-host-history-')); host.root = path.join(root, 'workspace'); await fs.mkdir(host.root);
  host.saved = []; host.trust = []; host.trusted = true;
  history = new HistoryService({ globalStorageUri: { fsPath: path.join(root, 'private') } } as vscode.ExtensionContext, () => {});
});
afterEach(async () => { history.dispose(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function document(text = '# hello') {
  const file = path.join(host.root, 'doc.md');
  const value = { uri: { fsPath: file, scheme: 'file', toString: () => `file://${file}` }, fileName: file, getText: () => text, isDirty: false,
    save: async () => { await fs.writeFile(file, text); host.saved.forEach(fn => fn(value as unknown as vscode.TextDocument)); return true; },
  }; return value as unknown as vscode.TextDocument;
}
describe('Host save/history integration (mock VS Code, real storage)', () => {
  it('archives each same-content native save once', async () => {
    const doc = document(); await history.save(doc); await history.save(doc);
    const { store, documentId } = await history.identity(doc); const list = await store.list(documentId);
    expect(list).toHaveLength(2); expect(list[0].contentHash).toBe(list[1].contentHash); expect(list[0].id).not.toBe(list[1].id);
  });
  it('attaches restore provenance to the single native save record', async () => {
    const doc = document(); await history.save(doc); const { store, documentId } = await history.identity(doc); const original = (await store.list(documentId))[0];
    await history.save(doc, 'restore', original.id); const list = await store.list(documentId);
    expect(list).toHaveLength(2); expect(list[0].reason).toBe('restore'); expect((await store.readSnapshot(documentId, list[0].id)).manifest.restoredFrom).toBe(original.id);
  });
  it('freezes savedAt before queued resource IO', async () => {
    const doc = document(); const savedAt = Date.now(); const entry = await history.record(doc, 'save', undefined, doc.getText(), savedAt); expect(entry.savedAt).toBe(savedAt);
  });
  it('propagates archive failure without pretending the file save failed', async () => {
    const doc = document(); await history.save(doc); const { store } = await history.identity(doc);
    vi.spyOn(store, 'record').mockRejectedValueOnce(new Error('injected archive failure'));
    await expect(history.save(doc)).rejects.toBeInstanceOf(SaveArchiveError); expect(await fs.readFile(doc.uri.fsPath, 'utf8')).toBe('# hello');
  });
  it('archives duplicate image references once and refuses non-image files', async () => {
    await fs.writeFile(path.join(host.root, 'image.png'), 'image'); await fs.writeFile(path.join(host.root, 'private.env'), 'not an image');
    const doc = document('![one](image.png) ![two](./image.png) ![invalid](private.env)'); await history.save(doc);
    const { store, documentId } = await history.identity(doc), snapshot = await store.readSnapshot(documentId, (await store.list(documentId))[0].id);
    expect(snapshot.resources).toHaveLength(1); expect(snapshot.resources[0].path).toBe('image.png'); expect(snapshot.manifest.warnings.join()).toContain('不支持');
  });
  it('does not archive native saves in an untrusted workspace', async () => {
    host.trusted = false; await history.save(document()); expect(history.saveCount(document())).toBe(0); await expect(history.identity(document())).rejects.toThrow('受信任');
  });
});
