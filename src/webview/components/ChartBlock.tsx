import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import type { BarSeriesOption, EChartsOption, LineSeriesOption } from 'echarts';
import { chartSchema, type ChartSpec } from '../../shared/embeds';
import './diagrams.css';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, CanvasRenderer, SVGRenderer]);

export type ChartTheme = 'light' | 'dark';
export const chartPalettes = {
  light: { series: ['#2a78d6', '#eb6834', '#1baf7a'], surface: '#fcfcfb', ink: '#0b0b0b', secondary: '#52514e', grid: '#e1e0d9', axis: '#c3c2b7' },
  dark: { series: ['#3987e5', '#d95926', '#199e70'], surface: '#1a1a19', ink: '#ffffff', secondary: '#c3c2b7', grid: '#2c2c2a', axis: '#383835' },
} as const;

/** Additional rendering constraints are deliberately stricter than the shared storage schema. */
export function validateChartSpec(input: unknown): ChartSpec {
  const result = chartSchema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join('.') || '图表'}：${issue.message}`).join('\n'));
  const spec = result.data;
  if (spec.type === 'pie' && spec.series) throw new Error('饼图不支持 series 字段；请改用柱状图或拆分图表。');
  const entities = chartEntities(spec);
  if (entities.length > 3) throw new Error(spec.type === 'pie' ? '饼图最多支持 3 个类别；请合并类别或改用柱状图。' : '首版最多支持 3 个系列；请拆分图表。');
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
  return spec;
}

export function chartEntities(spec: ChartSpec): string[] {
  if (spec.type === 'pie') return [...new Set(spec.data.map(row => String(row[spec.x])))].sort();
  const series = spec.series;
  return series ? [...new Set(spec.data.map(row => String(row[series])))].sort() : [spec.y];
}

/** Surviving entities keep their slots when rows are reordered or entities are filtered out. */
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

/** Only known schema fields are compiled. In particular no user option, HTML, or JavaScript is executed. */
export function compileChartOption(input: unknown, theme: ChartTheme = 'light', slots?: ReadonlyMap<string, number>, texture = false): EChartsOption {
  const spec = validateChartSpec(input);
  const palette = chartPalettes[theme];
  const entities = chartEntities(spec);
  const colors = slots ?? assignChartColorSlots(entities);
  const color = (entity: string) => palette.series[colors.get(entity) ?? 0];
  const base: EChartsOption = {
    animation: false,
    backgroundColor: palette.surface,
    color: entities.map(color),
    textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: palette.ink },
    aria: { enabled: true, decal: { show: texture } },
    tooltip: {
      renderMode: 'richText', confine: true, trigger: spec.type === 'line' ? 'axis' : 'item',
      axisPointer: { type: 'cross', snap: true, lineStyle: { color: palette.secondary, width: 1 }, label: { backgroundColor: palette.surface, color: palette.ink } },
      backgroundColor: palette.surface, borderColor: palette.axis, textStyle: { color: palette.ink },
      formatter: params => {
        const items = Array.isArray(params) ? params : [params];
        return items.map(item => {
          const value = typeof item.value === 'number' ? item.value : Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
          return `${typeof value === 'number' ? numberFormat.format(value) : '—'}  ${richTextLiteral(String(item.seriesName ?? ''))} · ${richTextLiteral(String(item.name ?? ''))}`;
        }).join('\n');
      },
    },
    legend: { show: entities.length >= 2, data: entities, top: 4, type: 'scroll', textStyle: { color: palette.secondary }, icon: spec.type === 'line' ? 'roundRect' : 'rect', itemHeight: spec.type === 'line' ? 2 : 9, itemWidth: 16 },
  };
  if (spec.type === 'pie') {
    return { ...base, series: [{
      type: 'pie', name: spec.y, radius: ['0%', '61%'], center: ['50%', '53%'], stillShowZeroSum: false,
      minShowLabelAngle: 0, avoidLabelOverlap: true,
      label: { show: true, color: palette.secondary, formatter: params => `${String(params.name)} · ${numberFormat.format(Number(params.value))}`, width: 140, overflow: 'break' },
      labelLine: { lineStyle: { color: palette.axis, width: 1 } },
      data: spec.data.map(row => ({ name: String(row[spec.x]), value: Number(row[spec.y]), itemStyle: { color: color(String(row[spec.x])), borderColor: palette.surface, borderWidth: 2 } })),
    }] };
  }
  const categories = [...new Set(spec.data.map(row => String(row[spec.x])))];
  const rows = new Map(spec.data.map(row => [JSON.stringify([String(row[spec.x]), spec.series ? String(row[spec.series]) : spec.y]), row]));
  return {
    ...base,
    grid: { top: entities.length >= 2 ? 48 : 20, left: 16, right: spec.type === 'line' ? 120 : 24, bottom: 40, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    xAxis: { type: 'category', data: categories, name: spec.x, nameLocation: 'middle', nameGap: 30, nameTextStyle: { color: palette.secondary }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.axis, width: 1 } }, axisLabel: { color: palette.secondary, hideOverlap: true, width: 100, overflow: 'truncate' } },
    yAxis: { type: 'value', name: spec.y, nameTextStyle: { color: palette.secondary }, min: spec.type === 'bar' ? Math.min(0, ...spec.data.map(row => Number(row[spec.y]))) : undefined, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: palette.secondary, formatter: (value: number) => numberFormat.format(value) }, splitLine: { lineStyle: { color: palette.grid, width: 1, type: 'solid' } } },
    series: entities.map((entity, seriesIndex): BarSeriesOption | LineSeriesOption => {
      const data = categories.map(category => {
        const row = rows.get(JSON.stringify([category, entity]));
        if (!row) return null; // Missing measurements are gaps, never invented zeroes.
        const value = Number(row[spec.y]);
        return { value, itemStyle: spec.type === 'bar' ? { color: color(entity), borderRadius: value >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } : { color: color(entity), borderColor: palette.surface, borderWidth: 2 } };
      });
      const common = { name: entity, data, emphasis: { focus: 'series' as const } };
      if (spec.type === 'bar') return { ...common, type: 'bar', barMaxWidth: 24, barGap: '15%', label: { show: categories.length <= 8, position: 'top', color: palette.secondary, formatter: '{c}' } };
      return {
        ...common, type: 'line',
        lineStyle: { color: color(entity), width: 2, type: (['solid', 'dashed', 'dotted'] as const)[seriesIndex], cap: 'round', join: 'round' },
        symbol: ['circle', 'rect', 'triangle'][seriesIndex], symbolSize: 8, showSymbol: categories.length <= 40, connectNulls: false,
        endLabel: { show: entities.length >= 2, color: palette.secondary, formatter: params => String(params.seriesName), width: 100, overflow: 'truncate' },
        labelLayout: { hideOverlap: true },
      };
    }),
  };
}

/** A real ECharts SVG renderer, suitable for a Host-mediated export callback. */
export function exportChartSvg(spec: ChartSpec, theme: ChartTheme = 'light', width = 800, height = 420, slots?: ReadonlyMap<string, number>, texture = false): string {
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
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readVSCodeTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export interface ChartBlockProps {
  spec: ChartSpec;
  onChange: (next: ChartSpec) => void;
  readOnly?: boolean;
  onExport?: (svg: string) => void;
}

export function ChartBlock({ spec, onChange, readOnly = false, onExport }: ChartBlockProps) {
  const theme = useVSCodeTheme();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const colorSlots = useRef(new Map<string, number>());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [form, setForm] = useState({ type: spec.type, title: spec.title, x: spec.x, y: spec.y, series: spec.series ?? '', data: JSON.stringify(spec.data, null, 2) });
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [error, setError] = useState('');
  const [texture, setTexture] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const original = useRef('');
  const serialized = JSON.stringify(spec);
  const checked = useMemo(() => { try { return { spec: validateChartSpec(spec), error: '' }; } catch (e) { return { spec: null, error: String((e as Error).message) }; } }, [serialized]);
  if (checked.spec) colorSlots.current = assignChartColorSlots(chartEntities(checked.spec), colorSlots.current);

  useEffect(() => { if (editing && serialized !== original.current) setConflict(true); }, [serialized, editing]);
  useEffect(() => {
    if (!container.current || !checked.spec) return;
    const chart = echarts.init(container.current, undefined, { renderer: 'canvas' });
    try { chart.setOption(compileChartOption(checked.spec, theme, colorSlots.current, texture)); } catch (e) { setError((e as Error).message); }
    const resize = () => chart.resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(container.current);
    window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); chart.dispose(); };
  }, [checked, theme, texture]);

  function beginEdit() {
    original.current = serialized;
    setDraft(JSON.stringify(spec, null, 2));
    setForm({ type: spec.type, title: spec.title, x: spec.x, y: spec.y, series: spec.series ?? '', data: JSON.stringify(spec.data, null, 2) });
    setConflict(false); setError(''); setEditing(true);
  }
  function formValue(): unknown {
    return { version: 1, type: form.type, title: form.title, x: form.x, y: form.y, ...(form.series.trim() ? { series: form.series.trim() } : {}), data: JSON.parse(form.data) };
  }
  function switchMode(next: 'form' | 'json') {
    try {
      if (next === 'json') setDraft(JSON.stringify(formValue(), null, 2));
      else {
        const value = validateChartSpec(JSON.parse(draft));
        setForm({ type: value.type, title: value.title, x: value.x, y: value.y, series: value.series ?? '', data: JSON.stringify(value.data, null, 2) });
      }
      setMode(next); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  function confirm() {
    if (readOnly || conflict || serialized !== original.current) return;
    try { const next = validateChartSpec(mode === 'json' ? JSON.parse(draft) : formValue()); onChange(next); setEditing(false); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  const columns = [...new Set([spec.x, spec.y, ...(spec.series ? [spec.series] : []), ...spec.data.flatMap(row => Object.keys(row))])];
  return <section className="minds-diagram minds-chart" data-chart-theme={theme} aria-label={spec.title || '图表'} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header className="diagram-toolbar">
      <strong>{spec.title || '图表'}</strong>
      <div className="diagram-actions">
        <button type="button" aria-expanded={tableOpen} aria-controls={`${id}-table`} onClick={() => setTableOpen(!tableOpen)}>数据表</button>
        <button type="button" aria-pressed={texture} onClick={() => setTexture(!texture)}>纹理辅助</button>
        {onExport && <button type="button" disabled={!checked.spec} onClick={() => { try { onExport(exportChartSvg(spec, theme, 800, 420, colorSlots.current, texture)); } catch (e) { setError((e as Error).message); } }}>导出 SVG</button>}
        {!readOnly && <button type="button" onClick={beginEdit}>编辑图表</button>}
      </div>
    </header>
    {checked.error ? <p className="diagram-error" role="alert">{checked.error}</p> : <div ref={container} className="chart-canvas" role="img" aria-label={`${spec.title}；${spec.type === 'line' ? '折线图' : spec.type === 'bar' ? '柱状图' : '饼图'}。完整数据见数据表。`} />}
    <div id={`${id}-table`} hidden={!tableOpen} className="chart-table-wrapper" tabIndex={0} aria-label="图表原始数据">
      <table><caption>{spec.title || '图表'} — 原始数据（空值不是零）</caption><thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
        <tbody>{spec.data.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{row[column] == null ? '—' : String(row[column])}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {editing && <form className="chart-editor" aria-label="图表草稿" onSubmit={event => { event.preventDefault(); confirm(); }}>
      <div className="diagram-actions"><button type="button" aria-pressed={mode === 'form'} onClick={() => switchMode('form')}>表单</button><button type="button" aria-pressed={mode === 'json'} onClick={() => switchMode('json')}>JSON</button></div>
      {mode === 'json' ? <label>图表 JSON<textarea rows={15} value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} /></label> : <>
        <div className="chart-fields">
          <label>图表类型<select value={form.type} onChange={event => setForm({ ...form, type: event.target.value as ChartSpec['type'] })}><option value="bar">柱状图 · 比较大小</option><option value="line">折线图 · 观察趋势</option><option value="pie">饼图 · 最多三类占比</option></select></label>
          {(['title', 'x', 'y', 'series'] as const).map(key => <label key={key}>{({ title: '标题', x: '类别字段 x', y: '数值字段 y', series: '系列字段（可选）' })[key]}<input value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}
        </div>
        <label>数据行 JSON<textarea rows={10} value={form.data} onChange={event => setForm({ ...form, data: event.target.value })} spellCheck={false} /></label>
        {form.type === 'pie' && <p className="diagram-hint">饼图只表达占比，不能包含负数或全零数据；比较接近的数值建议使用柱状图。</p>}
      </>}
      {conflict && <p role="alert" className="diagram-error">图表源码已在其他位置变更；请取消并重新编辑，避免覆盖新内容。</p>}
      <div className="diagram-actions"><button type="submit" disabled={readOnly || conflict}>确认替换图表</button><button type="button" onClick={() => { setEditing(false); setError(''); }}>取消</button></div>
    </form>}
    {error && <p className="diagram-error" role="alert">{error}</p>}
  </section>;
}
