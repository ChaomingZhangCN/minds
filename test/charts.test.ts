import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BarSeriesOption, LineSeriesOption } from 'echarts';
import { chartSchema, sampleChart, type ChartSpec } from '../src/shared/embeds';
import { assignChartColorSlots, ChartBlock, chartPalettes, compileChartOption, exportChartSvg, validateChartSpec } from '../src/webview/components/ChartBlock';

const series = (spec: ChartSpec) => compileChartOption(spec).series as Array<BarSeriesOption | LineSeriesOption>;
const multiseries: ChartSpec = {
  version: 1, title: '真实测量', type: 'line', x: 'time', y: 'value', series: 'team',
  data: [{ time: '一月', value: 3, team: 'Alpha' }, { time: '二月', value: 5, team: 'Alpha' }, { time: '一月', value: 2, team: 'Beta' }],
};

describe('charts schema and safe option compiler', () => {
  it('uses the existing version-one schema and rejects arbitrary option/JavaScript fields', () => {
    expect(chartSchema.safeParse(sampleChart).success).toBe(true);
    for (const input of [{ ...sampleChart, version: 2 }, { ...sampleChart, type: 'scatter' }, { ...sampleChart, formatter: 'alert(1)' }, { ...sampleChart, data: [{ month: 'A', requests: Infinity }] }, { ...sampleChart, data: [{ month: 'A', requests: '3' }] }]) {
      expect(() => compileChartOption(input)).toThrow();
    }
  });

  it('compiles bar and line options with one value axis, real measurements, and no invented zero', () => {
    const bar = compileChartOption(sampleChart);
    expect(Array.isArray(bar.yAxis)).toBe(false);
    expect(series(sampleChart)[0].type).toBe('bar');
    expect(series(sampleChart)[0].data).toMatchObject([{ value: 120 }, { value: 180 }, { value: 150 }]);
    const line = series(multiseries);
    expect(line.map(item => item.name)).toEqual(['Alpha', 'Beta']);
    expect(line[1].data).toEqual([expect.objectContaining({ value: 2 }), null]);
    expect((line[1] as LineSeriesOption).connectNulls).toBe(false);
    expect(compileChartOption(multiseries).legend).toMatchObject({ show: true, data: ['Alpha', 'Beta'] });
    expect(compileChartOption(sampleChart).legend).toMatchObject({ show: false });
  });

  it('rejects missing series values, duplicate measurements, and more than three identities', () => {
    expect(() => compileChartOption({ ...multiseries, data: [...multiseries.data, { time: '三月', value: 4 }] })).toThrow('缺少系列');
    expect(() => compileChartOption({ ...sampleChart, data: [sampleChart.data[0], sampleChart.data[0]] })).toThrow('重复');
    expect(() => compileChartOption({ ...multiseries, data: ['A', 'B', 'C', 'D'].map(team => ({ time: '一月', value: 1, team })) })).toThrow('3 个系列');
  });

  it('guards part-to-whole data without silently changing the shared schema', () => {
    const pie: ChartSpec = { ...sampleChart, type: 'pie' };
    expect(compileChartOption(pie).series).toMatchObject([{ type: 'pie' }]);
    expect(() => validateChartSpec({ ...pie, data: [{ month: 'A', requests: -1 }] })).toThrow('非负');
    expect(() => validateChartSpec({ ...pie, data: [{ month: 'A', requests: 0 }] })).toThrow('全零');
    expect(() => validateChartSpec({ ...pie, series: 'month' })).toThrow('不支持 series');
    expect(() => validateChartSpec({ ...pie, data: ['A', 'B', 'C', 'D'].map(month => ({ month, requests: 1 })) })).toThrow('3 个类别');
    expect(() => validateChartSpec({ ...pie, data: [{ month: 'A', requests: Number.MAX_VALUE }, { month: 'B', requests: Number.MAX_VALUE }] })).toThrow('总和');
    expect(compileChartOption({ ...pie, data: [{ month: 'A', requests: 0 }, { month: 'B', requests: 2 }] }).series).toMatchObject([{ data: [{ value: 0 }, { value: 2 }] }]);
  });

  it('keeps colors attached to identities across sorting, filtering and selected theme changes', () => {
    const original = assignChartColorSlots(['Alpha', 'Beta', 'Gamma']);
    const filtered = assignChartColorSlots(['Gamma', 'Beta'], original);
    expect(filtered.get('Beta')).toBe(original.get('Beta'));
    expect(filtered.get('Gamma')).toBe(original.get('Gamma'));
    const reordered = { ...multiseries, data: [...multiseries.data].reverse() };
    expect(compileChartOption(reordered).color).toEqual(compileChartOption(multiseries).color);
    expect(chartPalettes.light.series).toEqual(['#2a78d6', '#eb6834', '#1baf7a']);
    expect(chartPalettes.dark.series).toEqual(['#3987e5', '#d95926', '#199e70']);
    expect(compileChartOption(multiseries, 'dark').backgroundColor).toBe('#1a1a19');
    const withSurvivors = assignChartColorSlots(['Beta', 'New'], filtered);
    expect(withSurvivors.get('Beta')).toBe(original.get('Beta'));
    expect(new Set(['Beta', 'New'].map(name => withSurvivors.get(name))).size).toBe(2);
  });

  it('renders hostile labels as text, supplies a keyboard-accessible table, and never calls change during rendering', () => {
    const label = '<img src=https://evil.example onerror=alert(1)>{bad|label}';
    const malicious = { ...sampleChart, title: label, data: [{ month: label, requests: 12 }] };
    let changes = 0;
    const html = renderToStaticMarkup(createElement(ChartBlock, { spec: malicious, onChange: () => { changes++; }, readOnly: true }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<table>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('编辑图表');
    expect(changes).toBe(0);
    const tooltip = compileChartOption(malicious).tooltip as { renderMode: string; formatter: (value: unknown) => string };
    expect(tooltip.renderMode).toBe('richText');
    expect(tooltip.formatter({ name: label, seriesName: label, value: 12 })).toContain('｛bad|label｝');
  });

  it('exports actual ECharts-rendered SVG in light and dark, with escaped labels', () => {
    const spec = { ...sampleChart, title: 'safe', data: [{ month: '<script>alert(1)</script>', requests: 2 }] };
    for (const theme of ['light', 'dark'] as const) {
      for (const input of [spec, multiseries, { ...sampleChart, type: 'pie' as const }]) {
        const svg = exportChartSvg(input, theme);
        expect(svg).toContain('<svg');
        expect(svg).toContain('<path');
        expect(svg).not.toContain('<script>');
        expect(svg).toContain(chartPalettes[theme].series[0]);
      }
      expect(exportChartSvg(sampleChart, theme, 800, 420, undefined, true)).toContain('<pattern');
    }
    expect(() => exportChartSvg(sampleChart, 'light', Infinity, 420)).toThrow('尺寸');
  });
});
