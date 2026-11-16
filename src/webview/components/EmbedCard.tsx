import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { ClientContext } from '../../shared/types';
import { parseJson, resourceEmbedSchema, type EmbedBlock, type ChartSpec } from '../../shared/embeds';
import { ChartBlock, validateChartSpec } from './ChartBlock';
import { DiagramPreview } from './DiagramPreview';
import { keepGraphDraft, removeGraphDraft } from '../drafts';
const MermaidBlock = lazy(() => import('./MermaidBlock').then(module => ({ default: module.MermaidBlock })));
const names = { charts: 'Chart', mermaid: 'Mermaid', excalidraw: 'Excalidraw', drawio: 'draw.io' };

export function EmbedCard({ block, context, stamp, onChange, onExport }: { block: EmbedBlock; context: ClientContext; stamp: string; onChange(source: string, expected: string): void; onExport(svg: string): void }) {
  const [sourceOpen, setSourceOpen] = useState(false), [draftActive, setDraftActive] = useState(false), [draft, setDraft] = useState(block.content), [error, setError] = useState('');
  const [validatedMermaid, setValidatedMermaid] = useState('');
  const draftId = useRef(crypto.randomUUID());
  const original = useRef(block.content), lastChart = useRef<ChartSpec>(), lastResource = useRef<{ src: string; page?: string }>();
  const source = draftActive ? draft : block.content, conflict = draftActive && block.content !== original.current;
  const checked = useMemo(() => {
    if (block.kind === 'mermaid') return { error: '' };
    try {
      if (block.kind === 'charts') return { chart: validateChartSpec(parseJson(source)), error: '' };
      return { resource: resourceEmbedSchema.parse(parseJson(source)), error: '' };
    } catch (cause) { return { error: cause instanceof Error ? cause.message : '图形配置无效' }; }
  }, [source, block.kind]);
  if (checked.chart) lastChart.current = checked.chart;
  if (checked.resource) lastResource.current = checked.resource;
  const chart = checked.chart ?? lastChart.current, resource = checked.resource ?? lastResource.current;
  const open = () => { if (!draftActive) { original.current = block.content; setDraft(block.content); setError(''); setDraftActive(true); } setSourceOpen(true); };
  const apply = () => {
    if (conflict) return;
    try {
      if (checked.error) throw new Error(checked.error);
      if (block.kind === 'mermaid' && source !== validatedMermaid) throw new Error('Mermaid 草稿尚未通过渲染校验；请修复语法后应用。');
      onChange(draft.endsWith('\n') ? draft : draft + '\n', original.current); removeGraphDraft(draftId.current); setDraftActive(false); setSourceOpen(false); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '源码应用失败'); }
  };
  return <section className="embed-card" data-embed-kind={block.kind} onKeyDown={event => event.stopPropagation()}>
    <header className="embed-heading"><strong>{names[block.kind]}</strong><button type="button" aria-expanded={sourceOpen} onClick={() => sourceOpen ? setSourceOpen(false) : open()}>{sourceOpen ? '收起源码' : '展开源码'}</button></header>
    <div className="embed-body">
      {block.kind === 'charts' ? chart && <ChartBlock spec={chart} readOnly={!context.trusted || draftActive} onChange={next => onChange(JSON.stringify(next, null, 2) + '\n', block.content)} onExport={onExport} />
        : block.kind === 'mermaid' ? <Suspense fallback={<p>加载本地 Mermaid…</p>}><MermaidBlock source={source} onExport={onExport} onValidated={setValidatedMermaid} /></Suspense>
        : resource && <DiagramPreview kind={block.kind} src={resource.src} context={context} resourceStamp={stamp} onExport={onExport} />}
    </div>
    {checked.error && <p role="alert" className="diagram-error">{checked.error}{chart || resource ? '（保留上一版有效图形）' : ''}</p>}
    {sourceOpen && <div className="embed-source"><label>{names[block.kind]} 源码<textarea aria-label={`${names[block.kind]} 源码`} spellCheck={false} value={draft} onChange={event => { setDraft(event.target.value); keepGraphDraft(draftId.current, `${names[block.kind]} 源码`, event.target.value); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); apply(); } }} /></label>
      <p className="muted">源码与图形在同一块内；合法草稿实时渲染，应用后才写入正文。资源图形的原生 JSON/XML 使用“编辑图形”。</p>
      {conflict && <p role="alert" className="diagram-error">正文中的图形源码已变更；草稿仍保留，请复制后取消并重新打开。</p>}
      <div className="diagram-actions"><button type="button" disabled={conflict || !!checked.error || (block.kind === 'mermaid' && source !== validatedMermaid)} onClick={apply}>应用源码</button><button type="button" onClick={() => { removeGraphDraft(draftId.current); setDraft(block.content); setDraftActive(false); setSourceOpen(false); setError(''); }}>取消源码草稿</button></div>
    </div>}
    {error && <p role="alert" className="diagram-error">{error}</p>}
  </section>;
}
