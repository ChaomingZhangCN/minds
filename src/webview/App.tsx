import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownEditor, type AgentInput, type MarkdownEditorHandle } from './MarkdownEditor';
import { SyncController } from '../editor/SyncController';
import { post, request, subscribe, persistDraft, persistedDraft } from './bridge';
import type { AgentMode, ClientContext, EmbedKind, HistoryEntry, MaintenanceReport, Proposal, SnapshotPreview } from '../shared/types';
import { paragraphRange } from '../shared/text';
import { graphDrafts, restoreGraphDrafts, subscribeGraphDrafts, removeGraphDraft, type GraphDraft } from './drafts';
import './styles.css';
import './components/diagrams.css';
interface AiCard { mode: AgentMode; from: number; to: number; baseVersion: number; original: string; prompt: string; scope: 'selection' | 'section' | 'document'; answer: string; busy: boolean; requestId?: string; proposal?: Proposal; error?: string; history: { role: 'user' | 'assistant'; content: string }[]; node: HTMLElement }

export function App() {
  const [context, setContext] = useState<ClientContext>(), [notice, setNotice] = useState(''), [ai, setAi] = useState<AiCard>(), [historyOpen, setHistoryOpen] = useState(false), [history, setHistory] = useState<HistoryEntry[]>([]), [preview, setPreview] = useState<SnapshotPreview>(), [maintenance, setMaintenance] = useState<MaintenanceReport>(), [revision, setRevision] = useState(0);
  const [recovery, setRecovery] = useState<GraphDraft[]>([]);
  const contextRef = useRef(context); contextRef.current = context;
  const sync = useRef<SyncController>(), editor = useRef<MarkdownEditorHandle>(null), imageInput = useRef<HTMLInputElement>(null);
  const error = (value: unknown) => setNotice(value instanceof Error ? value.message : '操作失败');
  useEffect(() => { restoreGraphDrafts(persistedDraft().graphDrafts ?? []); setRecovery(graphDrafts()); return subscribeGraphDrafts(() => { const values = graphDrafts(); setRecovery(values); persistDraft(sync.current?.conflictDraft, values); }); }, []);
  useEffect(() => {
    const off = subscribe(message => {
      if (message.type === 'init') {
        sync.current = new SyncController(message.context.document, edit => post({ type: 'edit', id: edit.id, baseVersion: edit.baseVersion, change: edit.change }));
        const saved = persistedDraft().conflictDraft;
        if (saved) { sync.current.conflictDraft = saved; sync.current.blocked = true; }
        setContext(message.context);
      } else if (message.type === 'document') {
        if (!sync.current || message.document.version < sync.current.version) return;
        if (sync.current.receive(message.document)) editor.current?.replace(sync.current.draft);
        persistDraft(sync.current.conflictDraft);
        setContext(current => current && ({ ...current, document: message.document }));
      } else if (message.type === 'provider') setContext(current => current && ({ ...current, provider: message.provider, trusted: message.trusted }));
      else if (message.type === 'notice') setNotice(message.message);
      else if (message.type === 'openHistory') { setHistoryOpen(true); void request<HistoryEntry[]>({ type: 'historyList' }).then(setHistory).catch(error); }
      else if (message.type === 'result' && !message.ok) {
        if (message.document && sync.current?.reject(message.id, message.document)) { editor.current?.replace(sync.current.draft); persistDraft(sync.current.conflictDraft); setRevision(value => value + 1); }
        setAi(current => current?.requestId === message.id ? { ...current, busy: false, error: message.error } : current);
        setNotice(message.error);
      } else if (message.type === 'aiChunk') setAi(current => current?.requestId === message.requestId ? { ...current, answer: current.answer + message.text } : current);
      else if (message.type === 'aiDone') setAi(current => current?.requestId === message.requestId ? { ...current, answer: message.text, busy: false, proposal: message.proposal, history: current.mode === 'ask' ? [...current.history, { role: 'user' as const, content: current.prompt }, { role: 'assistant' as const, content: message.text }].slice(-20) : current.history } : current);
      else if (message.type === 'aiError') setAi(current => current?.requestId === message.requestId ? { ...current, busy: false, error: message.error } : current);
    });
    post({ type: 'ready', id: crypto.randomUUID() }); return off;
  }, []);
  const native = async (command: 'save' | 'undo' | 'redo') => { try { await sync.current!.whenIdle(); await request({ type: command }); } catch (value) { error(value); } };
  const openAi = async (mode: AgentMode, input?: AgentInput) => {
    try {
      if (ai?.busy) throw new Error('请先取消已有请求');
      const range = input?.range ?? editor.current!.target(), text = editor.current!.text();
      await sync.current!.whenIdle();
      if (editor.current!.text() !== text) throw new Error('正文已变化，请重新选择段落');
      if (ai?.proposal) await request({ type: 'proposalReject', proposalId: ai.proposal.id });
      const node = document.createElement('div'); node.className = 'ai-card-anchor';
      setAi({ mode, ...range, baseVersion: sync.current!.version, original: text.slice(range.from, range.to), prompt: input?.prompt ?? '', scope: 'selection', answer: '', busy: false, history: [], node });
      editor.current!.select(range.from, range.to);
    } catch (value) { error(value); }
  };
  const runAi = async () => {
    if (!ai || ai.busy || !ai.prompt.trim() || !contextRef.current?.trusted || !contextRef.current.provider.configured) return;
    try {
      await sync.current!.whenIdle();
      const text = editor.current!.text(), original = text.slice(ai.from, ai.to), id = crypto.randomUUID();
      if (original !== ai.original) throw new Error('原文已变化，请关闭卡片后基于新选区发起');
      setAi(current => current && ({ ...current, baseVersion: sync.current!.version, requestId: id, busy: true, answer: '', error: undefined, proposal: undefined }));
      post({ type: 'aiStart', id, mode: ai.mode, prompt: ai.prompt, scope: ai.scope, from: ai.from, to: ai.to, expectedText: original, baseVersion: sync.current!.version, history: ai.history });
    } catch (value) { error(value); }
  };
  const closeAi = () => { if (ai?.requestId && ai.busy) post({ type: 'aiCancel', id: crypto.randomUUID(), requestId: ai.requestId }); if (ai?.proposal) void request({ type: 'proposalReject', proposalId: ai.proposal.id }); setAi(undefined); };
  const accept = async () => { try { await sync.current!.whenIdle(); await request({ type: 'proposalAccept', proposalId: ai!.proposal!.id }); setAi(undefined); } catch (value) { error(value); } };
  const insertEmbed = async (kind: EmbedKind, selected?: { from: number; to: number }) => {
    try {
      const range = selected ?? editor.current!.selection(), text = editor.current!.text();
      await sync.current!.whenIdle();
      if (text !== editor.current!.text()) throw new Error('插入位置已变化，请重新打开菜单');
      await request({ type: 'insertEmbed', kind, baseVersion: sync.current!.version, ...range });
    } catch (value) { error(value); }
  };
  const exportSvg = (svg: string) => { void request({ type: 'exportSvg', name: 'minds-diagram', svg }).catch(error); };
  const importImage = async (file: File) => {
    try {
      if (file.size > 12_000_000) throw new Error('图片超过 12 MB');
      await sync.current!.whenIdle(); const baseVersion = sync.current!.version, range = editor.current!.selection();
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let from = 0; from < bytes.length; from += 32768) binary += String.fromCharCode(...bytes.subarray(from, from + 32768));
      await request({ type: 'importImage', name: file.name, mime: file.type, data: btoa(binary), baseVersion, ...range });
    } catch (value) { error(value); }
  };
  const openHistory = async () => { setHistoryOpen(true); try { setHistory(await request<HistoryEntry[]>({ type: 'historyList' })); } catch (value) { error(value); } };
  const restore = async () => { try { await sync.current!.whenIdle(); await request({ type: 'historyRestore', snapshotId: preview!.entry.id }, 120000); setRevision(value => value + 1); await openHistory(); } catch (value) { error(value); } };
  if (!context) return <div className="loading">minds · 正在连接原生文档…</div>;
  const conflict = sync.current?.conflictDraft;
  const sendContext = ai ? ai.scope === 'document' ? editor.current?.text() ?? context.document.text : ai.scope === 'section' ? (() => { const text = editor.current?.text() ?? context.document.text, range = paragraphRange(text, ai.from); return text.slice(range.from, range.to); })() : ai.original : '';
  return <div className="minds-app">
    <header className="app-toolbar"><strong>minds</strong><span className="filename">{context.document.fileName}{context.document.dirty ? ' ●' : ''}</span>
      <button onClick={() => void native('save')}>保存</button><button onClick={() => void request({ type: 'openSource' }).catch(error)}>源码</button>
      <button onClick={() => void openAi('ask')}>@ 提问</button><button onClick={() => void openAi('rewrite')}>@ 改写</button>
      <button disabled={!context.trusted} onClick={() => void insertEmbed('charts')}>＋ Chart</button><button disabled={!context.trusted} onClick={() => void insertEmbed('mermaid')}>＋ Mermaid</button><button disabled={!context.trusted} onClick={() => void insertEmbed('excalidraw')}>＋ 手绘</button><button disabled={!context.trusted} onClick={() => void insertEmbed('drawio')}>＋ draw.io</button>
      <button disabled={!context.trusted} onClick={() => imageInput.current?.click()}>＋ 图片</button><button onClick={() => void openHistory()}>历史</button>
      <button className="provider-button" onClick={() => void request({ type: 'configureProvider' }).catch(error)}>{context.provider.configured ? `${context.provider.provider} · ${context.provider.model}` : '配置 Provider'}</button>
      <input ref={imageInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void importImage(file); event.target.value = ''; }} />
    </header>
    {!context.trusted && <div className="warning">未信任工作区：正文编辑可用；AI 外发、资源写入和私有历史关闭。</div>}
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')}>关闭</button></div>}
    {conflict && <section className="conflict"><strong>存在未提交草稿，不会自动覆盖原生文档。</strong><details><summary>查看完整草稿</summary><textarea readOnly value={conflict} aria-label="未提交草稿" /></details><button onClick={() => { editor.current?.insert(`\n\n${conflict}\n`); sync.current?.resume(); setRevision(value => value + 1); }}>将草稿追加到当前文档</button><button onClick={() => { sync.current?.discardConflict(); persistDraft(); setRevision(value => value + 1); }}>我已保存草稿，解除暂停</button></section>}
    {!!recovery.length && <details className="conflict graph-draft-recovery"><summary>本地未应用图形草稿（{recovery.length}）</summary><p>即使图形块被删除，草稿仍可复制恢复；不自动写回正文或资源，不发送给 Provider。保存/取消对应草稿后移除。</p>{recovery.map(draft => <details key={draft.id}><summary>{draft.label}</summary><textarea readOnly aria-label={`${draft.label} 备份草稿`} value={draft.content} /><button onClick={() => removeGraphDraft(draft.id)}>我已复制，移除此备份</button></details>)}</details>}
    <MarkdownEditor ref={editor} initialText={context.document.text} context={context} resourceStamp={`${context.document.resourceStamp ?? ''}:${revision}`} card={ai ? { from: ai.from, to: ai.to, node: ai.node } : undefined} onChange={text => { sync.current!.local(text); }} onAgent={(mode, input) => void openAi(mode, input)} onInsertEmbed={(kind, range) => void insertEmbed(kind, range)} onExport={exportSvg} onNative={command => void native(command)} onImage={file => void importImage(file)} />
    {ai && createPortal(<section className="ai-card" data-testid="ai-card"><div className="card-heading"><strong>{ai.mode === 'ask' ? '文档内提问' : '改写建议'}</strong><span>绑定选区 {ai.from}–{ai.to} · v{ai.baseVersion}</span><button onClick={closeAi}>关闭</button></div>
      <blockquote>{ai.original || '（空选区）'}</blockquote><label>发送范围 <select disabled={ai.busy} value={ai.scope} onChange={event => setAi({ ...ai, scope: event.target.value as AiCard['scope'] })}><option value="selection">选区</option><option value="section">当前段落</option><option value="document">全文（显式选择）</option></select></label>
      <details><summary>实际发送的正文上下文（{sendContext.length} 字符）</summary><pre>{sendContext}</pre><p>另包含此问题、固定任务提示和卡片内的历史问答；不发送工作区其他文件、图形资源原始字节或凭证。</p></details>
      <textarea aria-label="AI 问题或改写指令" placeholder={ai.mode === 'ask' ? '针对选区提问…' : '如何改写这段文字？'} value={ai.prompt} disabled={ai.busy} onChange={event => setAi({ ...ai, prompt: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void runAi(); } }} />
      <div className="card-actions"><button disabled={ai.busy || !ai.prompt.trim() || !context.trusted || !context.provider.configured} onClick={() => void runAi()}>{ai.history.length ? '追问' : '发送'}</button>{ai.busy && <button onClick={() => post({ type: 'aiCancel', id: crypto.randomUUID(), requestId: ai.requestId! })}>取消</button>}<span className="muted">请求在 {context.provider.executionHost} 执行 · 不自动应用</span></div>
      {ai.error && <p className="embed-error">{ai.error}</p>}{ai.busy && <p aria-live="polite">正在生成…</p>}
      {ai.mode === 'rewrite' && ai.answer ? <div className="proposal-diff"><div><h4>原文</h4><pre>{ai.original}</pre></div><div><h4>建议</h4><pre>{ai.answer}</pre></div></div> : ai.answer && <pre className="ai-answer">{ai.answer}</pre>}
      {ai.proposal && <div className="card-actions"><button disabled={context.document.version !== ai.proposal.baseVersion} onClick={() => void accept()}>接受改写</button><button onClick={closeAi}>拒绝</button>{context.document.version !== ai.proposal.baseVersion && <span className="warning-text">文档已变化，旧建议不能应用</span>}</div>}
    </section>, ai.node)}
    {historyOpen && <aside className="history-panel"><div className="card-heading"><strong>私有快照历史</strong><button onClick={() => setHistoryOpen(false)}>关闭</button></div><p className="muted">不写入项目；每次成功保存创建记录。工作区 live 图片不会自动 GC。</p><div className="card-actions"><button onClick={() => void openHistory()}>刷新</button><button onClick={() => void request<MaintenanceReport>({ type: 'maintenance', dryRun: true }).then(setMaintenance).catch(error)}>维护预览</button><button onClick={() => void request<MaintenanceReport>({ type: 'maintenance', dryRun: false }, 60000).then(setMaintenance).catch(error)}>整理</button></div>
      {maintenance && <p>快照移除候选 {maintenance.expiredSnapshots} · Blob 候选 {maintenance.collectibleBlobs} · 实际删除 {maintenance.deletedBlobs}<br />{maintenance.warnings.join('\n')}</p>}
      <div className="history-layout"><ul>{history.map(entry => <li key={entry.id}><button onClick={() => void request<SnapshotPreview>({ type: 'historyPreview', snapshotId: entry.id }).then(setPreview).catch(error)}>{entry.head ? 'HEAD · ' : ''}{new Date(entry.savedAt).toLocaleString()}<small>{entry.reason} · {entry.resourceCount} 个资源</small></button></li>)}</ul><div>{preview ? <><h3>{new Date(preview.entry.savedAt).toLocaleString()}</h3><button onClick={() => void restore()}>恢复为新快照（需确认）</button>{preview.warnings.map((warning, index) => <p className="warning-text" key={index}>{warning}</p>)}<pre className="snapshot-source">{preview.markdown}</pre><details><summary>完整归档资源</summary><ul>{preview.resources.map(resource => <li key={resource.path}>{resource.path} · {resource.size} bytes · {resource.hash.slice(0, 12)}</li>)}</ul></details></> : <p>选择一个快照查看正文与资源。</p>}</div></div>
    </aside>}
  </div>;
}
