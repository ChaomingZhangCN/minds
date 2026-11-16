import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ClientContext, EmbedDocument } from '../../shared/types';
import { request } from '../bridge';
const DrawioPreview = lazy(() => import('./DrawioFrame').then(module => ({ default: module.DrawioPreview })));
let drawioQueue: Promise<void> = Promise.resolve();

export function DiagramPreview({ kind, src, context, resourceStamp, onEdit, onSource }: { kind: 'drawio' | 'excalidraw'; src: string; context: ClientContext; resourceStamp?: string; onEdit(): void; onSource(): void }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [content, setContent] = useState<string>(), [svg, setSvg] = useState<string>(), [error, setError] = useState<string>(), [allowed, setAllowed] = useState(false);
  const release = useRef<() => void>();
  useEffect(() => {
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '200px' });
    if (container.current) observer.observe(container.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    setSvg(undefined); setError(undefined); setContent(undefined); setAllowed(false);
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
          drawioQueue = new Promise<void>(resolve => { release.current = resolve; });
          await previous;
          if (cancelled) { release.current?.(); return; }
          setContent(embed.content); setAllowed(true);
        }
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : '预览失败'); release.current?.(); }
    };
    void run(); return () => { cancelled = true; release.current?.(); };
  }, [visible, kind, src, context.drawioUrl, context.excalidrawAssetUrl, resourceStamp]);
  const done = (svg: string) => { setSvg(svg); setAllowed(false); release.current?.(); };
  const failed = (message: string) => { setError(message); setAllowed(false); release.current?.(); };
  return <div className="diagram-preview" ref={container}>
    <div className="diagram-toolbar"><span>{kind === 'drawio' ? 'draw.io' : '手绘图'} · {src}</span><span><button onClick={onEdit}>编辑图形</button><button onClick={onSource}>引用源码</button></span></div>
    {svg ? <img className="diagram-svg-preview" alt={`${kind} 预览`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} /> : error ? <p className="embed-error">{error}</p> : <p className="muted">{visible ? '正在使用本地原生引擎生成预览…' : '图形将在进入视口时加载'}</p>}
    {kind === 'drawio' && allowed && content && <Suspense fallback={<p>加载 draw.io…</p>}><DrawioPreview url={context.drawioUrl} xml={content} onSvg={done} onError={failed} /></Suspense>}
  </div>;
}
