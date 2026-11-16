import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SnapshotStore } from './storage/snapshotStore';
import { collectResourceRefs } from './shared/embeds';
import { resolveWorkspaceResource } from './utils/security';
import type { HistoryEntry } from './shared/types';

function setting<T>(name: string, fallback: T): T {
  const config = vscode.workspace.getConfiguration('minds').inspect<T>(name);
  return config?.globalValue ?? config?.defaultValue ?? fallback;
}
export class HistoryService implements vscode.Disposable {
  private stores = new Map<string, Promise<SnapshotStore>>();
  private tails = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private listeners: vscode.Disposable[] = [];
  private saves = new Map<string, number>();
  private saveTails = new Map<string, Promise<unknown>>();
  private saveReasons = new Map<string, { text: string; reason: string; restoredFrom?: string }>();
  constructor(private context: vscode.ExtensionContext, private warn: (message: string) => void) {
    this.listeners.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (!/\.(md|markdown)$/i.test(document.fileName) || !vscode.workspace.isTrusted || !setting('history.enabled', true)) return;
      const raw = document.getText();
      this.saves.set(document.uri.toString(), this.saveCount(document) + 1);
      const metadata = this.saveReasons.get(document.uri.toString());
      const matched = metadata?.text === raw ? metadata : undefined;
      void this.record(document, matched?.reason ?? 'save', matched?.restoredFrom, raw, Date.now()).catch(error => warn(`文档已保存，但历史归档失败：${safeError(error)}`));
    }));
    this.listeners.push(vscode.workspace.onDidRenameFiles(event => {
      for (const file of event.files) {
        const folder = vscode.workspace.getWorkspaceFolder(file.oldUri), destination = vscode.workspace.getWorkspaceFolder(file.newUri);
        if (!folder || destination?.uri.toString() !== folder.uri.toString() || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) continue;
        void Promise.all([this.tails.get(file.oldUri.toString()), this.tails.get(file.newUri.toString())]).then(() => this.store(folder)).then(store => store.renameDocument(path.relative(folder.uri.fsPath, file.oldUri.fsPath).split(path.sep).join('/'), path.relative(folder.uri.fsPath, file.newUri.fsPath).split(path.sep).join('/'))).catch(error => warn(`历史重命名失败：${safeError(error)}`));
      }
    }));
    this.listeners.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('minds.history')) this.schedule(); }));
    this.listeners.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()));
    this.schedule();
  }
  async save(document: vscode.TextDocument, reason = 'save', restoredFrom?: string): Promise<void> {
    const uri = document.uri.toString();
    const work = async () => {
      const count = this.saveCount(document);
      this.saveReasons.set(uri, { text: document.getText(), reason, restoredFrom });
      try {
        if (!await document.save()) throw new Error('文件未保存');
        if (vscode.workspace.isTrusted && setting('history.enabled', true)) {
          try {
            if (this.saveCount(document) === count) await this.record(document, reason, restoredFrom);
            else await this.wait(document);
          } catch { throw new SaveArchiveError(); }
        }
      } finally { this.saveReasons.delete(uri); }
    };
    const result = (this.saveTails.get(uri) ?? Promise.resolve()).then(work, work);
    this.saveTails.set(uri, result.catch(() => undefined)); return result;
  }
  saveCount(document: vscode.TextDocument): number { return this.saves.get(document.uri.toString()) ?? 0; }
  private policy() { return { maxSnapshots: setting('history.maxSnapshotsPerDocument', 100), detailedDays: setting('history.detailedRetentionDays', 7), expireDays: setting('history.expireAfterDays', 30), timeZone: setting('history.timeZone', 'UTC') }; }
  async store(folder: vscode.WorkspaceFolder): Promise<SnapshotStore> {
    if (!vscode.workspace.isTrusted || folder.uri.scheme !== 'file') throw new Error('历史需要受信任的文件工作区');
    const key = folder.uri.toString();
    if (!this.stores.has(key)) {
      const hash = createHash('sha256').update(key).digest('hex');
      const pending = (async () => {
        const store = new SnapshotStore(path.join(this.context.globalStorageUri.fsPath, 'history', hash), this.policy(), { gcGraceMs: setting('history.gcGraceHours', 24) * 3600000 });
        await store.initialize(); return store;
      })();
      this.stores.set(key, pending);
      pending.catch(() => this.stores.delete(key));
    }
    const store = await this.stores.get(key)!; store.updatePolicy(this.policy()); return store;
  }
  async identity(document: vscode.TextDocument) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || document.uri.scheme !== 'file') throw new Error('请将 Markdown 放入文件工作区');
    const relativePath = path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
    const store = await this.store(folder);
    return { folder, relativePath, store, documentId: await store.getDocumentId(relativePath) };
  }
  async record(document: vscode.TextDocument, reason = 'save', restoredFrom?: string, captured = document.getText(), savedAt = Date.now()): Promise<HistoryEntry> {
    const uri = document.uri.toString(), documentPath = document.uri.fsPath;
    const identity = this.identity(document); void identity.catch(() => undefined);
    const work = async () => {
      const { folder, relativePath, store, documentId } = await identity;
      const refs = collectResourceRefs(captured);
      const warnings = refs.remote.map(src => `外链未归档：${src.slice(0, 200)}`);
      const resources: { path: string; bytes: Uint8Array; kind: string; mime?: string }[] = [];
      let size = 0;
      const archived = new Set<string>();
      for (const src of refs.local) {
        try {
          const file = await resolveWorkspaceResource(folder.uri.fsPath, documentPath, src);
          if (!/\.(png|jpe?g|gif|webp|drawio|excalidraw)$/i.test(file)) throw new Error('不支持的图片或图形资源类型，未归档任意文件');
          if (archived.has(file)) continue;
          const before = await fs.stat(file);
          if (!before.isFile() || before.size > 20_000_000 || size + before.size > 100_000_000) throw new Error('资源超过归档大小限制');
          const bytes = await fs.readFile(file); const after = await fs.stat(file);
          if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || bytes.length !== before.size || await resolveWorkspaceResource(folder.uri.fsPath, documentPath, src) !== file) throw new Error('资源在归档过程中变化');
          size += bytes.length; archived.add(file);
          resources.push({ path: path.relative(folder.uri.fsPath, file).split(path.sep).join('/'), bytes, kind: /\.drawio$/i.test(file) ? 'drawio' : /\.excalidraw$/i.test(file) ? 'excalidraw' : 'image' });
        } catch (error) { warnings.push(`${src.slice(0, 200)}：${safeError(error)}`); }
      }
      const entry = await store.record({ documentId, relativePath, markdown: captured, resources, warnings, reason, restoredFrom, savedAt });
      if (warnings.length) this.warn(`快照已记录，${warnings.length} 个资源不能完整离线恢复；在历史预览查看原因。`);
      return entry;
    };
    const result = (this.tails.get(uri) ?? Promise.resolve()).then(work, work);
    this.tails.set(uri, result); return result;
  }
  async wait(document: vscode.TextDocument): Promise<void> { await this.tails.get(document.uri.toString()); }
  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    if (!vscode.workspace.isTrusted || !setting('history.enabled', true)) return;
    const run = async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') continue;
        try { await (await this.store(folder)).maintain({ dryRun: false }); } catch (error) { this.warn(`历史维护暂停：${safeError(error)}`); }
      }
    };
    void run(); this.timer = setInterval(() => void run(), Math.max(5, setting('history.maintenanceIntervalMinutes', 60)) * 60000);
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.listeners.forEach(listener => listener.dispose()); }
}
export class SaveArchiveError extends Error {
  constructor() { super('正文已成功保存，但历史归档失败；未撤回文件保存，请检查通知与私有 pending 日志'); }
}
export function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : '操作失败'; }
