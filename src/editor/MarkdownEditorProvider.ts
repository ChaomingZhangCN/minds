import * as vscode from 'vscode';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { DocumentSession } from './DocumentSession';
import { clientMessageSchema, type ClientMessage } from '../shared/protocol';
import { normalizeText, smallestChange, paragraphRange } from '../shared/text';
import { collectResourceRefs, sampleChart } from '../shared/embeds';
import type { ClientContext, DocumentState, EmbedDocument, ServerMessage } from '../shared/types';
import { ProviderManager } from '../providers/ProviderManager';
import { AgentService } from '../agent/AgentService';
import { ProposalService } from '../agent/ProposalService';
import { BlobStore } from '../storage/blobStore';
import { HistoryService, SaveArchiveError, safeError } from '../storageIntegration';
import { restoreWithRecovery } from '../utils/restore';
import { resolveWorkspaceResource, sniffImage, validateSvg } from '../utils/security';

interface PanelState {
  panel: vscode.WebviewPanel;
  session: DocumentSession;
  proposals: ProposalService;
  requests: Map<string, AbortController>;
  embeds: Map<string, EmbedDocument & { file: string }>;
}
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  static readonly viewType = 'minds.markdown';
  private sessions = new Map<string, { session: DocumentSession; panels: Set<PanelState> }>();
  private active?: PanelState;
  private readonly listeners: vscode.Disposable[] = [];
  private resourceWatchers: vscode.Disposable[] = [];
  private resourceTimer?: ReturnType<typeof setTimeout>;
  private watchResources(): void {
    this.resourceWatchers.forEach(watcher => watcher.dispose()); this.resourceWatchers = [];
    const refresh = () => {
      if (this.resourceTimer) clearTimeout(this.resourceTimer);
      this.resourceTimer = setTimeout(() => { for (const group of this.sessions.values()) void this.broadcastDocument(group.session.document); }, 150);
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{drawio,excalidraw,png,jpg,jpeg,gif,webp}'));
      this.resourceWatchers.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
    }
  }
  constructor(private context: vscode.ExtensionContext, readonly providers: ProviderManager, private history: HistoryService) {
    this.listeners.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('minds.ai')) void this.broadcastProviders(); }));
    this.listeners.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void this.broadcastProviders()));
    this.listeners.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.watchResources()));
    this.watchResources();
  }
  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (document.uri.scheme !== 'file') throw new Error('minds 首版只支持文件型 Markdown');
    const key = document.uri.toString();
    let group = this.sessions.get(key);
    if (!group) {
      group = { session: new DocumentSession(document, origin => { void this.broadcastDocument(document, origin); }), panels: new Set() };
      this.sessions.set(key, group);
    }
    const state: PanelState = { panel, session: group.session, proposals: new ProposalService(), requests: new Map(), embeds: new Map() };
    group.panels.add(state); this.active = state;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = this.html(panel.webview);
    const receive = panel.webview.onDidReceiveMessage(raw => {
      const parsed = clientMessageSchema.safeParse(raw);
      if (!parsed.success) { void this.send(state, { type: 'notice', level: 'error', message: '拒绝无效的 Webview 消息' }); return; }
      void this.handle(state, parsed.data).catch(async error => {
        await this.send(state, { type: 'result', id: parsed.data.id, ok: false, error: safeError(error), document: await this.documentState(state) });
      });
    });
    const visibility = panel.onDidChangeViewState(event => { if (event.webviewPanel.active) this.active = state; });
    panel.onDidDispose(() => {
      receive.dispose(); visibility.dispose(); state.requests.forEach(controller => controller.abort()); state.proposals.clear(); state.embeds.clear();
      group!.panels.delete(state);
      if (!group!.panels.size) { group!.session.dispose(); this.sessions.delete(key); }
      if (this.active === state) this.active = undefined;
    });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name)).toString();
    const source = webview.cspSource;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${source}; style-src ${source} 'unsafe-inline'; img-src ${source} data: blob:; font-src ${source} data:; connect-src ${source}; worker-src ${source} blob:; frame-src ${source}; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${uri('app.css')}"><title>minds</title></head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${uri('app.js')}"></script></body></html>`;
  }
  private send(state: PanelState, message: ServerMessage): Thenable<boolean> { return state.panel.webview.postMessage(message); }
  private async documentState(state: PanelState, originOpId?: string): Promise<DocumentState> {
    const document = state.session.document;
    const raw = document.getText(), version = document.version, dirty = document.isDirty;
    const resourceUrls: Record<string, string> = {};
    const stamp = createHash('sha256');
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist')];
    if (folder) for (const src of collectResourceRefs(raw).local.slice(0, 200)) {
      try {
        const file = await resolveWorkspaceResource(folder.uri.fsPath, document.uri.fsPath, src);
        const stat = await fs.stat(file); const revision = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        stamp.update(`${src}\0${revision}\0`);
        if (stat.isFile() && /\.(png|jpe?g|gif|webp)$/i.test(file)) {
          roots.push(vscode.Uri.file(file)); resourceUrls[src] = state.panel.webview.asWebviewUri(vscode.Uri.file(file)).with({ query: `v=${encodeURIComponent(revision)}` }).toString();
        }
      } catch { /* Invalid and missing resources stay visible as source text. */ }
    }
    state.panel.webview.options = { ...state.panel.webview.options, localResourceRoots: roots };
    return { uri: document.uri.toString(), fileName: path.basename(document.fileName), text: normalizeText(raw), version, dirty, eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n', resourceUrls, resourceStamp: stamp.digest('hex'), originOpId };
  }
  private async broadcastDocument(document: vscode.TextDocument, originOpId?: string): Promise<void> {
    const group = this.sessions.get(document.uri.toString());
    if (group) await Promise.all([...group.panels].map(async state => this.send(state, { type: 'document', document: await this.documentState(state, originOpId) })));
  }
  private async broadcastProviders(): Promise<void> {
    const provider = await this.providers.status();
    for (const group of this.sessions.values()) for (const state of group.panels) await this.send(state, { type: 'provider', provider, trusted: vscode.workspace.isTrusted });
  }
  async openHistory(): Promise<void> { if (this.active) await this.send(this.active, { type: 'openHistory' }); else void vscode.window.showInformationMessage('先用 minds 打开一个 Markdown 文档'); }
  private requireTrust(): void { if (!vscode.workspace.isTrusted) throw new Error('此操作需要受信任的工作区'); }
  private target(state: PanelState, baseVersion: number, from: number, to: number): string {
    const document = state.session.document, text = normalizeText(document.getText());
    if (document.version !== baseVersion || from > to || to > text.length) throw new Error('文档版本或选区已变化');
    return text.slice(from, to);
  }
  private async handle(state: PanelState, message: ClientMessage): Promise<void> {
    const document = state.session.document;
    let data: unknown;
    switch (message.type) {
      case 'ready': {
        const context: ClientContext = { document: await this.documentState(state), provider: await this.providers.status(), trusted: vscode.workspace.isTrusted,
          drawioUrl: state.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'drawio', 'index.html')).toString(),
          excalidrawAssetUrl: state.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'excalidraw')).toString() + '/' };
        await this.send(state, { type: 'init', context }); break;
      }
      case 'edit':
        await state.session.apply(message.id, message.baseVersion, message.change);
        data = await this.documentState(state, message.id); await this.send(state, { type: 'document', document: data as DocumentState }); break;
      case 'save': {
        await this.history.save(document);
        await this.broadcastDocument(document); break;
      }
      case 'undo': case 'redo':
        if (!state.panel.active) throw new Error('请先激活目标 minds 文档');
        await state.session.enqueue(async () => { await vscode.commands.executeCommand(message.type); });
        await this.broadcastDocument(document); break;
      case 'openSource': await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); break;
      case 'configureProvider': await this.providers.configure(); await this.broadcastProviders(); break;
      case 'aiStart': {
        this.requireTrust();
        if (state.requests.size >= 2 || state.requests.has(message.id)) throw new Error('请先结束已有请求');
        const target = this.target(state, message.baseVersion, message.from, message.to);
        if (target !== message.expectedText) throw new Error('AI 选区原文已变化');
        const text = normalizeText(document.getText());
        const section = paragraphRange(text, message.from);
        const context = message.scope === 'document' ? text : message.scope === 'section' ? text.slice(section.from, section.to) : target;
        const controller = new AbortController(); state.requests.set(message.id, controller);
        const service = new AgentService(this.providers);
        void service.run({ mode: message.mode, prompt: message.prompt, target, context, history: message.history }, controller.signal, chunk => { void this.send(state, { type: 'aiChunk', requestId: message.id, text: chunk }); }).then(async text => {
          const proposal = message.mode === 'rewrite' ? state.proposals.create({ mode: message.mode, from: message.from, to: message.to, baseVersion: message.baseVersion, original: target, replacement: text, prompt: message.prompt }) : undefined;
          await this.send(state, { type: 'aiDone', requestId: message.id, text, proposal });
        }).catch(error => { void this.send(state, { type: 'aiError', requestId: message.id, error: safeError(error) }); }).finally(() => state.requests.delete(message.id));
        break;
      }
      case 'aiCancel': state.requests.get(message.requestId)?.abort(); break;
      case 'proposalAccept': {
        const proposal = state.proposals.validate(message.proposalId, normalizeText(document.getText()), document.version);
        await state.session.apply(message.id, proposal.baseVersion, { from: proposal.from, to: proposal.to, expectedText: proposal.original, insert: proposal.replacement });
        state.proposals.remove(proposal.id); await this.broadcastDocument(document); break;
      }
      case 'proposalReject': state.proposals.remove(message.proposalId); break;
      case 'historyList': { const { store, documentId } = await this.history.identity(document); await this.history.wait(document); data = await store.list(documentId); break; }
      case 'historyPreview': { const { store, documentId } = await this.history.identity(document); data = await store.preview(documentId, message.snapshotId); break; }
      case 'historyRestore': {
        this.requireTrust();
        const { store, documentId, folder, relativePath } = await this.history.identity(document);
        if (document.isDirty) throw new Error('文档有未保存内容；请先保存或另存草稿后恢复');
        await this.history.wait(document);
        const snapshot = await store.readSnapshot(documentId, message.snapshotId);
        if (path.posix.dirname(snapshot.manifest.relativePath) !== path.posix.dirname(relativePath)) throw new Error('文档已跨目录移动，旧快照的相对资源引用不能保真恢复；请在原目录恢复副本');
        const confirmed = await vscode.window.showWarningMessage('恢复将修改当前正文和同路径图形资源，并保存为新快照。其他窗口中未保存的资源无法完整观测。是否继续？', { modal: true }, '恢复');
        if (confirmed !== '恢复') break;
        const baseVersion = document.version;
        const oldText = normalizeText(document.getText());
        const files = [];
        for (const resource of snapshot.resources) {
          const file = await resolveWorkspaceResource(folder.uri.fsPath, path.join(folder.uri.fsPath, 'root.md'), resource.path, true);
          if (vscode.workspace.textDocuments.some(open => open.uri.fsPath === file && open.isDirty)) throw new Error('图形资源存在未保存草稿，拒绝覆盖');
          files.push({ file, bytes: resource.bytes });
        }
        if (document.version !== baseVersion || document.isDirty) throw new Error('确认期间文档已变化，恢复已取消');
        let archiveFailure: SaveArchiveError | undefined;
        const restoredText = normalizeText(snapshot.markdown);
        await restoreWithRecovery(path.join(this.context.globalStorageUri.fsPath, 'restore-journals'), files, document.getText(), async () => {
          if (document.version !== baseVersion || document.isDirty) throw new Error('恢复期间正文已变化');
          try {
            await state.session.apply(message.id, baseVersion, smallestChange(oldText, restoredText));
            await this.history.save(document, 'restore', message.snapshotId);
          } catch (error) {
            if (error instanceof SaveArchiveError) { archiveFailure = error; return; }
            if (normalizeText(document.getText()) === restoredText) await state.session.apply(randomUUID(), document.version, smallestChange(restoredText, oldText));
            throw error;
          }
        }, async file => {
          const src = path.relative(folder.uri.fsPath, file).split(path.sep).join('/');
          if (await resolveWorkspaceResource(folder.uri.fsPath, path.join(folder.uri.fsPath, 'root.md'), src, true) !== file) throw new Error('恢复目标路径已变化');
          if (vscode.workspace.textDocuments.some(open => open.uri.fsPath === file && open.isDirty)) throw new Error('资源存在未保存修改');
        });
        await this.broadcastDocument(document); if (archiveFailure) throw archiveFailure; break;
      }
      case 'maintenance': {
        this.requireTrust(); const { store } = await this.history.identity(document);
        if (!message.dryRun && await vscode.window.showWarningMessage('按配置整理私有快照并回收已确认无引用的私有历史 Blob？不会自动删除工作区图片。', { modal: true }, '整理') !== '整理') break;
        data = await store.maintain({ dryRun: message.dryRun }); break;
      }
      case 'importImage': {
        this.requireTrust(); const original = this.target(state, message.baseVersion, message.from, message.to);
        if (!/^[a-z0-9+/]*={0,2}$/i.test(message.data)) throw new Error('图片编码无效');
        const bytes = Buffer.from(message.data, 'base64'); const image = sniffImage(bytes);
        if (image.mime !== message.mime) throw new Error('图片类型与实际字节不符');
        const folder = vscode.workspace.getWorkspaceFolder(document.uri); if (!folder) throw new Error('图片导入需要工作区');
        const blobRoot = await resolveWorkspaceResource(folder.uri.fsPath, path.join(folder.uri.fsPath, 'root.md'), '.minds/blobs', true);
        await fs.mkdir(blobRoot, { recursive: true });
        if (await resolveWorkspaceResource(folder.uri.fsPath, path.join(folder.uri.fsPath, 'root.md'), '.minds/blobs') !== blobRoot) throw new Error('图片存储路径已变化');
        const blobs = new BlobStore(blobRoot);
        const blob = await blobs.put(bytes, image.extension);
        const src = path.relative(path.dirname(document.uri.fsPath), blob.path).split(path.sep).join('/');
        const name = message.name.replace(/[\[\]\r\n]/g, '').slice(0, 100);
        await state.session.apply(message.id, message.baseVersion, { from: message.from, to: message.to, expectedText: original, insert: `![${name}](${encodeURI(src)})` });
        await this.broadcastDocument(document); break;
      }
      case 'insertEmbed': {
        this.requireTrust(); const original = this.target(state, message.baseVersion, message.from, message.to);
        let config: unknown = sampleChart;
        if (message.kind !== 'charts') {
          const folder = vscode.workspace.getWorkspaceFolder(document.uri); if (!folder) throw new Error('图形资源需要文件工作区');
          const srcFromRoot = `.minds/diagrams/${randomUUID()}.${message.kind}`;
          const file = await resolveWorkspaceResource(folder.uri.fsPath, path.join(folder.uri.fsPath, 'root.md'), srcFromRoot, true);
          await fs.mkdir(path.dirname(file), { recursive: true });
          const content = message.kind === 'drawio' ? '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>' : JSON.stringify({ type: 'excalidraw', version: 2, source: 'minds', elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} });
          await fs.writeFile(file, content, { flag: 'wx' }); config = { src: path.relative(path.dirname(document.uri.fsPath), file).split(path.sep).join('/') };
        }
        const insert = `\n\n\`\`\`${message.kind}\n${JSON.stringify(config, null, 2)}\n\`\`\`\n`;
        await state.session.apply(message.id, message.baseVersion, { from: message.from, to: message.to, expectedText: original, insert }); await this.broadcastDocument(document); break;
      }
      case 'readEmbed': {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri); if (!folder) throw new Error('图形需要工作区');
        const refs = collectResourceRefs(document.getText()).local;
        if (!refs.includes(message.src)) throw new Error('图形不是当前文档引用的资源');
        if (state.embeds.size >= 20) throw new Error('图形会话过多，请关闭后重试');
        const file = await resolveWorkspaceResource(folder.uri.fsPath, document.uri.fsPath, message.src);
        if (!file.toLowerCase().endsWith(`.${message.kind}`)) throw new Error('图形文件类型不匹配');
        const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 20_000_000) throw new Error('图形资源过大');
        const bytes = await fs.readFile(file), content = bytes.toString('utf8');
        if (message.kind === 'drawio') this.validateDrawio(content); else if (JSON.parse(content).type !== 'excalidraw') throw new Error('手绘资源格式无效');
        const embed = { sessionId: randomUUID(), kind: message.kind, src: message.src, content, hash: createHash('sha256').update(bytes).digest('hex'), file };
        state.embeds.set(embed.sessionId, embed); const { file: _file, ...publicEmbed } = embed; data = publicEmbed; break;
      }
      case 'saveEmbed': {
        this.requireTrust(); const embed = state.embeds.get(message.sessionId); if (!embed) throw new Error('图形会话已失效');
        if (!collectResourceRefs(document.getText()).local.includes(embed.src)) throw new Error('文档不再引用该图形');
        const folder = vscode.workspace.getWorkspaceFolder(document.uri); if (!folder || await resolveWorkspaceResource(folder.uri.fsPath, document.uri.fsPath, embed.src) !== embed.file) throw new Error('图形资源路径已变化');
        const current = await fs.readFile(embed.file); if (createHash('sha256').update(current).digest('hex') !== embed.hash) throw new Error('图形文件已被其他编辑器修改；请保留草稿后重开');
        if (embed.kind === 'drawio') this.validateDrawio(message.content); else if (JSON.parse(message.content).type !== 'excalidraw') throw new Error('手绘格式无效');
        const resourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(embed.file));
        if (resourceDocument.isDirty || createHash('sha256').update(resourceDocument.getText()).digest('hex') !== embed.hash) throw new Error('原图形资源有未保存或并发修改，拒绝覆盖');
        if (await resolveWorkspaceResource(folder.uri.fsPath, document.uri.fsPath, embed.src) !== embed.file) throw new Error('图形资源路径已变化');
        const edit = new vscode.WorkspaceEdit(); edit.replace(resourceDocument.uri, new vscode.Range(resourceDocument.positionAt(0), resourceDocument.positionAt(resourceDocument.getText().length)), message.content);
        if (!await vscode.workspace.applyEdit(edit) || !await resourceDocument.save()) throw new Error('图形未成功保存');
        embed.content = message.content; embed.hash = createHash('sha256').update(message.content).digest('hex');
        await this.broadcastDocument(document); break;
      }
      case 'closeEmbed': state.embeds.delete(message.sessionId); break;
      case 'exportSvg': {
        this.requireTrust(); const svg = validateSvg(message.svg);
        const uri = await vscode.window.showSaveDialog({ saveLabel: '导出 SVG', defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), message.name.replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/\.svg$/i, '') + '.svg')), filters: { SVG: ['svg'] } });
        if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(svg)); break;
      }
    }
    await this.send(state, { type: 'result', id: message.id, ok: true, data });
  }
  private validateDrawio(content: string): void {
    if (/<!DOCTYPE|<!ENTITY/i.test(content) || XMLValidator.validate(content) !== true || !/<(?:mxfile|mxGraphModel)[\s>]/.test(content)) throw new Error('draw.io XML 格式无效或包含不允许的声明');
  }
  dispose(): void { if (this.resourceTimer) clearTimeout(this.resourceTimer); this.resourceWatchers.forEach(watcher => watcher.dispose()); this.listeners.forEach(listener => listener.dispose()); for (const group of this.sessions.values()) { group.session.dispose(); for (const state of group.panels) state.requests.forEach(controller => controller.abort()); } }
}
