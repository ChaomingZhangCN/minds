import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { validateDrawioSvg } from './DrawioFrame';
import { useVSCodeTheme, type ChartTheme } from './ChartBlock';
import { SvgViewport } from './GraphViewport';

export function validateMermaidSource(source: string): string {
  if (!source.trim() || source.length > 100000) throw new Error('Mermaid 内容为空或超过 100,000 字符。');
  if (/%%\s*\{|^\s*---|\bclick\s|\b(?:href|src|img)\s*[:=]|https?:|data:|url\s*\(|<\/?[a-z!]/im.test(source)) throw new Error('Mermaid 不允许配置指令、点击动作、HTML 或外部资源。');
  return source;
}

/** Remove renderer-generated animations, retaining only inert visual CSS. */
function staticCss(css: string): string {
  let output = css;
  for (;;) {
    const start = output.search(/@(?:-webkit-)?keyframes\s/i);
    if (start < 0) break;
    const open = output.indexOf('{', start);
    if (open < 0) throw new Error('Mermaid CSS 无效');
    let depth = 1, end = open + 1;
    for (; end < output.length && depth; end++) { if (output[end] === '{') depth++; else if (output[end] === '}') depth--; }
    if (depth) throw new Error('Mermaid CSS 无效');
    output = output.slice(0, start) + output.slice(end);
  }
  return output;
}
export function sanitizeMermaidSvg(input: string): string {
  const clean = DOMPurify.sanitize(input, { USE_PROFILES: { svg: true }, ADD_TAGS: ['style'], FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'iframe'], FORBID_ATTR: ['onload', 'onclick', 'onerror'] });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml'), root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') throw new Error('Mermaid SVG 无效');
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite)) throw new Error('Mermaid SVG 缺少合法坐标范围');
  root.setAttribute('width', String(Math.max(1, box[2]))); root.setAttribute('height', String(Math.max(1, box[3])));
  for (const style of doc.querySelectorAll('style')) style.textContent = staticCss(style.textContent ?? '');
  return validateDrawioSvg(new XMLSerializer().serializeToString(doc));
}
let queue: Promise<unknown> = Promise.resolve();
export function renderMermaid(source: string, theme: ChartTheme = 'light'): Promise<string> {
  validateMermaidSource(source);
  const result = queue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: theme === 'dark' ? 'dark' : 'neutral', fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", suppressErrorRendering: true, maxTextSize: 100000, flowchart: { useMaxWidth: false } });
    const container = document.createElement('div'); container.className = 'mermaid-render-runtime'; document.body.append(container);
    try { const { svg } = await mermaid.render(`minds-mermaid-${crypto.randomUUID()}`, source, container); return sanitizeMermaidSvg(svg); }
    finally { container.remove(); }
  });
  queue = result.catch(() => undefined); return result;
}
export function MermaidBlock({ source, onExport, onValidated }: { source: string; onExport(svg: string): void; onValidated?(source: string): void }) {
  const theme = useVSCodeTheme(), [svg, setSvg] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const run = async () => { try { const rendered = await renderMermaid(source, theme); if (!cancelled) { setSvg(rendered); setError(''); onValidated?.(source); } } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Mermaid 渲染失败'); } };
    void run(); return () => { cancelled = true; };
  }, [source, theme]);
  return <div className="mermaid-block">{svg ? <SvgViewport svg={svg} label="Mermaid 图形" onExport={onExport} /> : !error && <p className="muted">正在加载本地 Mermaid…</p>}{error && <p role="alert" className="diagram-error">{error}{svg ? '（保留上一版有效图形）' : ''}</p>}</div>;
}
