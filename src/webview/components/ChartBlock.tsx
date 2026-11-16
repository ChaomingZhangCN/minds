import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import type { BarSeriesOption, EChartsOption, LineSeriesOption } from 'echarts';
import { chartSchema, normalizeChart, type ChartSpec, type NormalizedChartSpec } from '../../shared/embeds';
import { GraphViewport } from './GraphViewport';
import { keepGraphDraft, removeGraphDraft } from '../drafts';
import './diagrams.css';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, CanvasRenderer, SVGRenderer]);
export type ChartTheme = 'light' | 'dark';
export const chartPalettes = {
  light: { series: ['#2a78d6', '#eb6834', '#1baf7a'], surface: '#fcfcfb', ink: '#0b0b0b', secondary: '#52514e', grid: '#e1e0d9', axis: '#c3c2b7' },
  dark: { series: ['#3987e5', '#d95926', '#199e70'], surface: '#1a1a19', ink: '#ffffff', secondary: '#c3c2b7', grid: '#2c2c2a', axis: '#383835' },
} as const;

/** Rendering constraints, in addition to the declaration/storage schema. */
export function validateChartSpec(input: unknown): ChartSpec {
  const result = chartSchema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join('.') || '图表'}：${issue.message}`).join('\n'));
  const spec = normalizeChart(result.data);
  if (spec.type === 'pie' && spec.series) throw new Error('饼图不支持 series 字段；请改用柱状图或拆分图表。');
  if (chartEntities(spec).length > 3) throw new Error(spec.type === 'pie' ? '饼图最多支持 3 个类别；请合并类别或改用柱状图。' : '首版最多支持 3 个系列；请拆分图表。');
  const seen = new Set<string>();
  for (const [index, row] of spec.data.entries()) {
    if (!Object.hasOwn(row, spec.x) || !Object.hasOwn(row, spec.y)) throw new Error(`第 ${index + 1} 行必须包含自己的 x 和 y 字段。`);
    if (spec.series && (!Object.hasOwn(row, spec.series) || row[spec.series] == null)) throw new Error(`第 ${index + 1} 行缺少系列字段 ${spec.series}。`);
    const key = JSON.stringify([String(row[spec.x]), spec.series ? String(row[spec.series]) : '']);
    if (seen.has(key)) throw new Error(`第 ${index + 1} 行存在重复类别/系列；请先明确汇总数据，不会自动合并数值。`);
    seen.add(key);
    if (spec.type === 'pie' && Number(row[spec.y]) < 0) throw new Error('饼图的数值必须非负。');
  }
  if (spec.type === 'pie' && !spec.data.some(row => Number(row[spec.y]) > 0)) throw new Error('饼图至少需要一个大于零的数值；全零数据不能表示占比。');
  if (spec.type === 'pie' && !Number.isFinite(spec.data.reduce((sum, row) => sum + Number(row[spec.y]), 0))) throw new Error('饼图数值总和超出有限数值范围。');
  return result.data;
}
export function chartEntities(input: ChartSpec | NormalizedChartSpec): string[] {
  const spec = normalizeChart(input);
  if (spec.type === 'pie') return [...new Set(spec.data.map(row => String(row[spec.x])))].sort();
  if (spec.definitions) return spec.definitions.map(series => series.key);
  const series = spec.series;
  return series ? [...new Set(spec.data.map(row => String(row[series])))].sort() : [spec.y];
}

/** Surviving entities keep their slots across filtering and row reorder. */
export function assignChartColorSlots(entities: readonly string[], previous: ReadonlyMap<string, number> = new Map()): Map<string, number> {
  if (entities.length > 3) throw new Error('最多 3 个颜色实体；请拆分图表。');
  const next = new Map(previous);
  for (const entity of entities) {
    if (next.has(entity)) continue;
    const occupied = new Set(entities.filter(name => next.has(name)).map(name => next.get(name)!));
    const slot = [0, 1, 2].find(value => !occupied.has(value))!;
    for (const [name, value] of next) if (value === slot) next.delete(name);
    next.set(entity, slot);
  }
  return next;
}
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 12 });
const richTextLiteral = (value: string) => value.replace(/\{/g, '｛').replace(/\}/g, '｝');

/** Compile only allowlisted declarations; never user ECharts options/HTML/JavaScript. */
export function compileChartOption(input: unknown, theme: ChartTheme = 'light', slots?: ReadonlyMap<string, number>, texture = false): EChartsOption {
  const spec = normalizeChart(validateChartSpec(input)), palette = chartPalettes[theme], entities = chartEntities(spec);
  const colors = slots ?? assignChartColorSlots(entities);
  const definition = (entity: string) => spec.definitions?.find(series => series.key === entity);
  const name = (entity: string) => definition(entity)?.name ?? entity;
  const color = (entity: string) => definition(entity)?.color ?? palette.series[colors.get(entity) ?? 0];
  const base: EChartsOption = {
    animation: false, backgroundColor: palette.surface, color: entities.map(color),
    textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: palette.ink },
    aria: { enabled: true, decal: { show: texture } },
    tooltip: {
      renderMode: 'richText', confine: true, trigger: spec.type === 'line' ? 'axis' : 'item',
      axisPointer: { type: 'cross', snap: true, lineStyle: { color: palette.secondary, width: 1 }, label: { backgroundColor: palette.surface, color: palette.ink } },
      backgroundColor: palette.surface, borderColor: palette.axis, textStyle: { color: palette.ink },
      formatter: params => (Array.isArray(params) ? params : [params]).map(item => {
        const value = typeof item.value === 'number' ? item.value : Array.isArray(item.value) ? item.value.at(-1) : item.value;
        return `${typeof value === 'number' ? numberFormat.format(value) : '—'}  ${richTextLiteral(String(item.seriesName ?? ''))} · ${richTextLiteral(String(item.name ?? ''))}`;
      }).join('\n'),
    },
    legend: { show: entities.length >= 2, data: entities.map(name), top: 4, type: 'scroll', textStyle: { color: palette.secondary }, icon: spec.type === 'line' ? 'roundRect' : 'rect', itemHeight: spec.type === 'line' ? 2 : 9, itemWidth: 16 },
  };
  if (spec.type === 'pie') return { ...base, series: [{
    type: 'pie', name: spec.definitions?.[0]?.name ?? spec.y, radius: ['0%', '61%'], center: ['50%', '53%'], stillShowZeroSum: false,
    minShowLabelAngle: 0, avoidLabelOverlap: true,
    label: { show: true, color: palette.secondary, formatter: params => `${String(params.name)} · ${numberFormat.format(Number(params.value))}`, width: 140, overflow: 'break' },
    labelLine: { lineStyle: { color: palette.axis, width: 1 } },
    data: spec.data.map(row => ({ name: String(row[spec.x]), value: Number(row[spec.y]), itemStyle: { color: color(String(row[spec.x])), borderColor: palette.surface, borderWidth: 2 } })),
  }] };
  const categories = [...new Set(spec.data.map(row => String(row[spec.x])))];
  const rows = new Map(spec.data.map(row => [JSON.stringify([String(row[spec.x]), spec.series ? String(row[spec.series]) : spec.y]), row]));
  return {
    ...base,
    grid: { top: entities.length >= 2 ? 48 : 20, left: 16, right: spec.type === 'line' ? 120 : 24, bottom: 40, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    xAxis: { type: 'category', data: categories, name: spec.categoryLabel ?? spec.x, nameLocation: 'middle', nameGap: 30, nameTextStyle: { color: palette.secondary }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.axis, width: 1 } }, axisLabel: { color: palette.secondary, hideOverlap: true, interval: categories.length <= 24 ? 0 : 'auto', rotate: categories.length > 12 ? 35 : 0, width: 100, overflow: 'truncate' } },
    yAxis: { type: 'value', name: spec.definitions ? '' : spec.y, nameTextStyle: { color: palette.secondary }, min: spec.yDomain?.[0] ?? (spec.type === 'bar' ? Math.min(0, ...spec.data.map(row => Number(row[spec.y]))) : undefined), max: spec.yDomain?.[1], axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: palette.secondary, formatter: (value: number) => numberFormat.format(value) }, splitLine: { lineStyle: { color: palette.grid, width: 1, type: 'solid' } } },
    series: entities.map((entity, seriesIndex): BarSeriesOption | LineSeriesOption => {
      const data = categories.map(category => {
        const row = rows.get(JSON.stringify([category, entity]));
        if (!row) return null; // Missing measurements remain gaps, not invented zeroes.
        const value = Number(row[spec.y]);
        return { value, itemStyle: spec.type === 'bar' ? { color: color(entity), borderColor: palette.surface, borderWidth: 1, borderRadius: value >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } : { color: color(entity), borderColor: palette.surface, borderWidth: 2 } };
      });
      const common = { name: name(entity), data, emphasis: { focus: 'series' as const } };
      if (spec.type === 'bar') return { ...common, type: 'bar', barMaxWidth: 24, barGap: '15%', label: { show: categories.length <= 8, position: 'top', color: palette.secondary, formatter: '{c}' } };
      return { ...common, type: 'line', lineStyle: { color: color(entity), width: 2, type: (['solid', 'dashed', 'dotted'] as const)[seriesIndex], cap: 'round', join: 'round' }, symbol: ['circle', 'rect', 'triangle'][seriesIndex], symbolSize: 8, showSymbol: categories.length <= 40, connectNulls: false,
        endLabel: { show: entities.length >= 2, color: palette.secondary, formatter: params => String(params.seriesName), width: 100, overflow: 'truncate' }, labelLayout: { hideOverlap: true } };
    }),
  };
}
export function exportChartSvg(spec: ChartSpec, theme: ChartTheme = 'light', width = typeof spec.width === 'number' ? spec.width : 800, height = spec.height ?? 420, slots?: ReadonlyMap<string, number>, texture = false): string {
  if (![width, height].every(value => Number.isFinite(value) && value >= 200 && value <= 4096)) throw new Error('SVG 尺寸必须在 200–4096 像素之间。');
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width, height });
  try { chart.setOption(compileChartOption(spec, theme, slots, texture)); return chart.renderToSVGString(); }
  finally { chart.dispose(); }
}
export function readVSCodeTheme(): ChartTheme {
  return typeof document !== 'undefined' && (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')) ? 'dark' : 'light';
}
export function useVSCodeTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(readVSCodeTheme);
  useEffect(() => { const observer = new MutationObserver(() => setTheme(readVSCodeTheme())); observer.observe(document.body, { attributes: true, attributeFilter: ['class'] }); return () => observer.disconnect(); }, []);
  return theme;
}
export interface ChartBlockProps { spec: ChartSpec; onChange(next: ChartSpec): void; readOnly?: boolean; onExport?(svg: string): void }
export function ChartBlock({ spec, onChange, readOnly = false, onExport }: ChartBlockProps) {
  const theme = useVSCodeTheme(), id = useId(), container = useRef<HTMLDivElement>(null), colorSlots = useRef(new Map<string, number>());
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [error, setError] = useState(''), [texture, setTexture] = useState(false), [tableOpen, setTableOpen] = useState(false), [mode, setMode] = useState<'form' | 'json'>('form');
  const [dataDraft, setDataDraft] = useState(''), [dataError, setDataError] = useState('');
  const draftId = useRef(crypto.randomUUID());
  useEffect(() => { if (editing) keepGraphDraft(draftId.current, 'Chart 编辑配置', draft + (dataError ? `\n\n数据行草稿（未解析）：\n${dataDraft}` : '')); }, [editing, draft, dataDraft, dataError]);
  const original = useRef(''), lastGood = useRef(spec), serialized = JSON.stringify(spec);
  const checked = useMemo(() => { try { if (editing && dataError) throw new Error(dataError); return { spec: validateChartSpec(editing ? JSON.parse(draft) : spec), error: '' }; } catch (e) { return { spec: null, error: (e as Error).message }; } }, [serialized, editing, draft, dataError]);
  if (checked.spec) lastGood.current = checked.spec;
  const display = checked.spec ?? lastGood.current;
  const normalized = normalizeChart(display), entities = chartEntities(display);
  colorSlots.current = assignChartColorSlots(entities, colorSlots.current);
  const conflict = editing && serialized !== original.current;
  useEffect(() => {
    if (!container.current) return;
    const chart = echarts.init(container.current, undefined, { renderer: 'canvas' });
    try { chart.setOption(compileChartOption(display, theme, colorSlots.current, texture)); } catch (e) { setError((e as Error).message); }
    const resize = () => chart.resize(), observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(container.current); window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); chart.dispose(); };
  }, [display, theme, texture]);
  const beginEdit = () => { original.current = serialized; setDraft(JSON.stringify(spec, null, 2)); setDataDraft(JSON.stringify(spec.data, null, 2)); setDataError(''); setError(''); setEditing(true); };
  const changeField = (key: string, value: unknown) => { try { setDraft(JSON.stringify({ ...JSON.parse(draft), [key]: value }, null, 2)); } catch { setMode('json'); } };
  const confirm = () => {
    if (readOnly || conflict || !checked.spec) return;
    try { onChange(checked.spec); removeGraphDraft(draftId.current); setEditing(false); setError(''); } catch (e) { setError((e as Error).message); }
  };
  const columns = [...new Set(display.data.flatMap(row => Object.keys(row)))];
  const form: ChartSpec | null = (() => { try { const value = JSON.parse(draft); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } })();
  const labels = entities.map(entity => normalized.definitions?.find(series => series.key === entity)?.name ?? entity);
  return <section className="minds-diagram minds-chart" data-chart-theme={theme} aria-label={display.title || '图表'} onKeyDown={event => event.stopPropagation()}>
    <header className="diagram-toolbar"><strong>{display.title || '图表'}</strong><div className="diagram-actions">
      <button type="button" aria-expanded={tableOpen} aria-controls={`${id}-table`} onClick={() => setTableOpen(!tableOpen)}>数据表</button>
      <button type="button" aria-pressed={texture} onClick={() => setTexture(!texture)}>纹理辅助</button>
      {onExport && <button type="button" onClick={() => { try { onExport(exportChartSvg(display, theme, undefined, undefined, colorSlots.current, texture)); } catch (e) { setError((e as Error).message); } }}>导出 SVG</button>}
      {!readOnly && <button type="button" disabled={editing} onClick={beginEdit}>编辑图表</button>}
    </div></header>
    <GraphViewport label="Chart"><div ref={container} className="chart-canvas" style={{ width: display.width ?? '100%', maxWidth: '100%', height: display.height ?? 380 }} role="img" aria-label={`${display.title}；${display.type === 'line' ? '折线图' : display.type === 'bar' ? '柱状图' : '饼图'}。完整数据见数据表。`} /></GraphViewport>
    {entities.length >= 2 && <p className="chart-series-labels">系列：{labels.join(' / ')} · 共用一个数值轴</p>}
    {'xKey' in display && display.series.some(series => series.color) && <p className="diagram-hint">使用文档指定颜色；系列名称、数据表与纹理辅助可用于对比度不足或色觉差异的情况。</p>}
    <div id={`${id}-table`} hidden={!tableOpen} className="chart-table-wrapper" tabIndex={0} aria-label="图表原始数据"><table><caption>{display.title || '图表'} — 原始数据（空值不是零）</caption><thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{display.data.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{row[column] == null ? '—' : String(row[column])}</td>)}</tr>)}</tbody></table></div>
    {editing && <form className="chart-editor" aria-label="图表草稿" onSubmit={event => { event.preventDefault(); confirm(); }}>
      <div className="diagram-actions"><button type="button" aria-pressed={mode === 'form'} onClick={() => setMode('form')}>表单</button><button type="button" aria-pressed={mode === 'json'} disabled={!!dataError} title={dataError ? '请先修复数据行草稿；不会丢弃输入' : undefined} onClick={() => setMode('json')}>JSON</button></div>
      {mode === 'json' || !form ? <label>图表 JSON<textarea rows={15} value={draft} onChange={event => { setDraft(event.target.value); try { setDataDraft(JSON.stringify(JSON.parse(event.target.value).data, null, 2) ?? ''); } catch { /* Preserve incomplete JSON verbatim. */ } }} spellCheck={false} /></label> : <>
        <div className="chart-fields"><label>图表类型<select value={form.type} onChange={event => changeField('type', event.target.value)}><option value="bar">柱状图</option><option value="line">折线图</option><option value="pie">饼图</option></select></label><label>标题<input value={form.title} onChange={event => changeField('title', event.target.value)} /></label>
          <label>类别字段<input value={'xKey' in form ? form.xKey : form.x} onChange={event => changeField('xKey' in form ? 'xKey' : 'x', event.target.value)} /></label>
          {!('xKey' in form) && <label>数值字段<input value={form.y} onChange={event => changeField('y', event.target.value)} /></label>}
        </div>
        <label>数据行 JSON<textarea rows={10} value={dataDraft} onChange={event => { setDataDraft(event.target.value); try { changeField('data', JSON.parse(event.target.value)); setDataError(''); } catch { setDataError('数据行 JSON 暂时无效；输入与上一版有效图形均保留。'); } }} spellCheck={false} /></label>
        <p className="diagram-hint">合法草稿实时渲染；完整系列、颜色和坐标域可在 JSON 中修改。确认前不写入正文。</p>
      </>}
      {conflict && <p role="alert" className="diagram-error">图表源码已在其他位置变更；请保留草稿后取消并重新编辑，避免覆盖新内容。</p>}
      <div className="diagram-actions"><button type="submit" disabled={readOnly || conflict || !checked.spec}>确认替换图表</button><button type="button" onClick={() => { removeGraphDraft(draftId.current); setEditing(false); setError(''); }}>取消</button></div>
    </form>}
    {(checked.error || error) && <p className="diagram-error" role="alert">{checked.error || error}</p>}
  </section>;
}
