import { useEffect, useRef, useState, type ReactNode } from 'react';

export function GraphViewport({ children, onExport, label = '图形' }: { children: ReactNode; onExport?(): void; label?: string }) {
  const [scale, setScale] = useState(1), [offset, setOffset] = useState({ x: 0, y: 0 }), [expanded, setExpanded] = useState(false);
  const drag = useRef<{ x: number; y: number; origin: typeof offset }>(), area = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const zoom = (value: number) => setScale(Math.min(4, Math.max(.25, value)));
  useEffect(() => {
    const element = area.current; if (!element) return;
    const wheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setScale(current => Math.min(4, Math.max(.25, current * (event.deltaY > 0 ? .9 : 1.1)))); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
  const fit = () => { if (!area.current || !content.current) return; const width = content.current.scrollWidth, height = content.current.scrollHeight; zoom(Math.min(1, area.current.clientWidth / Math.max(1, width), (expanded ? window.innerHeight * .8 : 620) / Math.max(1, height))); setOffset({ x: 0, y: 0 }); };
  return <div className={`graph-viewport${expanded ? ' graph-expanded' : ''}`}>
    <div className="graph-view-actions" role="toolbar" aria-label={`${label}视口操作`}>
      <button type="button" aria-label="缩小" onClick={() => zoom(scale / 1.2)}>−</button><output aria-label="缩放比例">{Math.round(scale * 100)}%</output><button type="button" aria-label="放大" onClick={() => zoom(scale * 1.2)}>＋</button>
      <button type="button" onClick={fit}>适应视口</button><button type="button" onClick={reset}>复位</button>
      {onExport && <button type="button" onClick={onExport}>导出 SVG</button>}
      <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起查看' : '放大查看'}</button>
    </div>
    <div ref={area} className="graph-pan-area" tabIndex={0} aria-label={`${label}画布；拖动平移，按 Command 或 Ctrl 滚动缩放`} onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('button,input,textarea,select,a')) return;
      drag.current = { x: event.clientX, y: event.clientY, origin: offset }; event.currentTarget.setPointerCapture?.(event.pointerId);
    }} onPointerMove={event => {
      if (drag.current) setOffset({ x: drag.current.origin.x + event.clientX - drag.current.x, y: drag.current.origin.y + event.clientY - drag.current.y });
    }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onKeyDown={event => {
      if (event.key === '0') reset(); else if (event.key === '+' || event.key === '=') zoom(scale * 1.2); else if (event.key === '-') zoom(scale / 1.2);
    }}>
      <div ref={content} className="graph-transform" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}>{children}</div>
    </div>
  </div>;
}
export function SvgViewport({ svg, label, onExport }: { svg: string; label: string; onExport?(svg: string): void }) {
  return <GraphViewport label={label} onExport={onExport ? () => onExport(svg) : undefined}><img className="diagram-svg-preview" alt={label} draggable={false} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} /></GraphViewport>;
}
