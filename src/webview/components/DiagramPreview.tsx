import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ClientContext, EmbedDocument } from '../../shared/types';
import { request } from '../bridge';
import { SvgViewport } from './GraphViewport';
import { keepGraphDraft, removeGraphDraft } from '../drafts';
const DrawioPreview = lazy(() => import('./DrawioFrame').then(module => ({ default: module.DrawioPreview })));
const DrawioEditor = lazy(() => import('./DrawioFrame').then(module => ({ default: module.DrawioFrame })));
const ExcalidrawEditor = lazy(() => import('./ExcalidrawEditor'));
let drawioQueue: Promise<void> = Promise.resolve();

export function DiagramPreview({ kind, src, context, resourceStamp, onSource, onExport }: { kind: 'drawio' | 'excalidraw'; src: string; context: ClientContext; resourceStamp?: string; onSource?(): void; onExport?(svg: string): void }) {
  const container = useRef<HTMLDivElement>(null), release = useRef<() => void>(), alive = useRef(true), opening = useRef(false), sessionRef = useRef<EmbedDocument>();
  const [visible, setVisible] = useState(false), [content, setContent] = useState<string>(), [svg, setSvg] = useState<string>(), [error, setError] = useState(''), [allowed, setAllowed] = useState(false), [session, setSession] = useState<EmbedDocument>(), [saving, setSaving] = useState(false), [revision, setRevision] = useState(0);
  const draftId = useRef(crypto.randomUUID());
  const backup = (native: string) => { if (session && native !== session.content) keepGraphDraft(draftId.current, `${session.kind} · ${session.src}`, native); };
  const cancel = async () => { if (saving) return; await close(); removeGraphDraft(draftId.current); };
  sessionRef.current = session;
  const reference = useRef({ kind, src }); reference.current = { kind, src };
  useEffect(() => { setSvg(undefined); }, [kind, src]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; release.current?.(); if (sessionRef.current) void request({ type: 'closeEmbed', sessionId: sessionRef.current.sessionId }).catch(() => undefined); };
  }, []);
  useEffect(() => {
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '200px' });
    if (container.current) observer.observe(container.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || session) return;
    setError(''); setContent(undefined); setAllowed(false);
    let cancelled = false;
    const run = async () => {
      try {
        const embed = await request<EmbedDocument>({ type: 'readEmbed', kind, src });
        await request({ type: 'closeEmbed', sessionId: embed.sessionId });
        if (cancelled) return;
        if (kind === 'excalidraw') {
          const { previewExcalidraw } = await import('./ExcalidrawEditor');
          const preview = await previewExcalidraw(embed.content, context.excalidrawAssetUrl); if (!cancelled) setSvg(preview);
        } else {
          const previous = drawioQueue;
          let unlock!: () => void;
          drawioQueue = new Promise<void>(resolve => { unlock = resolve; });
          release.current = unlock;
          await previous;
          if (cancelled) { unlock(); return; }
          setContent(embed.content); setAllowed(true);
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : '预览失败'); release.current?.(); }
    };
    void run(); return () => { cancelled = true; release.current?.(); };
  }, [visible, kind, src, context.drawioUrl, context.excalidrawAssetUrl, resourceStamp, session, revision]);
  const edit = async () => {
    if (session || opening.current) return;
    opening.current = true;
    try {
      const embed = await request<EmbedDocument>({ type: 'readEmbed', kind, src });
      if (!alive.current || reference.current.kind !== kind || reference.current.src !== src) { await request({ type: 'closeEmbed', sessionId: embed.sessionId }); return; }
      sessionRef.current = embed; setSession(embed); setError('');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '打开图形失败'); }
    finally { opening.current = false; }
  };
  const close = async () => {
    if (!session) return;
    try { await request({ type: 'closeEmbed', sessionId: session.sessionId }); if (alive.current) { setSession(undefined); setRevision(value => value + 1); } }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '关闭失败'); throw cause; }
  };
  const save = async (next: string) => {
    if (!session || saving) return;
    if (session.src !== src || session.kind !== kind) { const message = '文档的图形引用已变更；请保留草稿后取消。'; setError(message); throw new Error(message); }
    setSaving(true); setError('');
    try { await request({ type: 'saveEmbed', sessionId: session.sessionId, content: next }, 60000); await close(); removeGraphDraft(draftId.current); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '保存失败；草稿仍保留在当前块'); throw cause; }
    finally { if (alive.current) setSaving(false); }
  };
  const done = (preview: string) => { setSvg(preview); setAllowed(false); release.current?.(); };
  const failed = (message: string) => { setError(message); setAllowed(false); release.current?.(); };
  return <div className="diagram-preview" ref={container}>
    <div className="diagram-toolbar"><span>{src}</span><span><button disabled={!context.trusted || saving} onClick={() => void edit()}>{session ? '正在原位编辑' : '编辑图形'}</button>{onSource && <button onClick={onSource}>引用源码</button>}</span></div>
    {session ? <Suspense fallback={<p>正在加载完整本地编辑器…</p>}>{session.kind === 'drawio'
      ? <DrawioEditor url={context.drawioUrl} xml={session.content} onSave={save} onDraft={backup} onCancel={cancel} onExport={onExport} />
      : <ExcalidrawEditor content={session.content} assetUrl={context.excalidrawAssetUrl} onSave={save} onDraft={backup} onCancel={cancel} onExport={onExport} />}</Suspense>
      : svg ? <SvgViewport svg={svg} label={`${kind} 预览`} onExport={onExport} /> : !error && <p className="muted">{visible ? '正在使用本地原生引擎生成图形…' : '图形将在进入视口时加载'}</p>}
    {error && <p role="alert" className="embed-error">{error}</p>}
    {kind === 'drawio' && allowed && content && !session && <Suspense fallback={<p>加载 draw.io…</p>}><DrawioPreview url={context.drawioUrl} xml={content} onSvg={done} onError={failed} /></Suspense>}
  </div>;
}
