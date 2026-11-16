import { z } from 'zod';
import MarkdownIt from 'markdown-it';
import type { EmbedKind } from './types';

const field = z.string().min(1).max(100);
const rows = z.array(z.record(z.union([z.string().max(2000), z.number().finite(), z.null()]))).min(1).max(5000);
const size = z.number().finite().int().min(200).max(4096);
const dimensions = {
  width: z.union([size, z.string().regex(/^(?:[1-9]\d?|100)%$/)]).optional(),
  height: size.optional(),
  yDomain: z.tuple([z.number().finite(), z.number().finite()]).refine(([min, max]) => min < max, 'yDomain 必须递增').optional(),
};
const common = { type: z.enum(['bar', 'line', 'pie']), title: z.string().max(300), data: rows, ...dimensions };
const legacyChartSchema = z.object({ ...common, version: z.literal(1), x: field, y: field, series: field.optional() }).strict();
const wideChartSchema = z.object({
  ...common, version: z.literal(1).optional(), xKey: field,
  series: z.array(z.object({ key: field, name: z.string().min(1).max(200), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }).strict()).min(1).max(3),
}).strict();
export const chartSchema = z.union([legacyChartSchema, wideChartSchema]).superRefine((value, ctx) => {
  const wide = 'xKey' in value;
  const x = wide ? value.xKey : value.x;
  const ys = wide ? value.series.map(series => series.key) : [value.y];
  if (wide && new Set(value.series.map(series => series.key)).size !== value.series.length) ctx.addIssue({ code: 'custom', path: ['series'], message: '系列 key 不能重复' });
  if (wide && new Set(value.series.map(series => series.name)).size !== value.series.length) ctx.addIssue({ code: 'custom', path: ['series'], message: '系列名称不能重复' });
  if (wide && ys.includes(x)) ctx.addIssue({ code: 'custom', path: ['series'], message: '系列 key 不能与 xKey 相同' });
  if (wide && value.type === 'pie' && value.series.length !== 1) ctx.addIssue({ code: 'custom', path: ['series'], message: '饼图只支持一个数值系列' });
  for (let i = 0; i < value.data.length; i++) {
    const row = value.data[i];
    if (!Object.hasOwn(row, x) || row[x] == null || ys.some(y => !Object.hasOwn(row, y) || typeof row[y] !== 'number')) {
      ctx.addIssue({ code: 'custom', path: ['data', i], message: '每行必须包含类别字段和有限数值系列字段' });
    }
  }
  if (!wide) {
    const seriesCount = new Set(value.data.map(row => String(row[value.series ?? value.x]))).size;
    if ((value.type === 'pie' || value.series) && seriesCount > 8) ctx.addIssue({ code: 'custom', message: '最多 8 个系列；请合并为其他或拆分图表' });
  }
});
export type ChartSpec = z.infer<typeof chartSchema>;
export type LegacyChartSpec = z.infer<typeof legacyChartSchema>;
export type WideChartSpec = z.infer<typeof wideChartSchema>;
export interface NormalizedChartSpec extends LegacyChartSpec { definitions?: WideChartSpec['series']; categoryLabel?: string }

/** Rendering-only adaptation. The original JSON dialect is never rewritten by parsing. */
export function normalizeChart(spec: ChartSpec): NormalizedChartSpec {
  if (!('xKey' in spec)) return spec;
  const { type, title, width, height, yDomain } = spec;
  if (type === 'pie') return { version: 1, type, title, width, height, yDomain, x: spec.xKey, y: spec.series[0].key, data: spec.data, definitions: spec.series };
  return {
    version: 1, type, title, width, height, yDomain, x: 'category', categoryLabel: spec.xKey, y: 'value', series: 'series', definitions: spec.series,
    data: spec.data.flatMap(row => spec.series.map(series => ({ category: row[spec.xKey], value: row[series.key], series: series.key }))),
  };
}
export const resourceEmbedSchema = z.object({ src: z.string().min(1).max(2048), page: z.string().max(300).optional() }).strict();
export interface EmbedBlock { kind: EmbedKind; from: number; to: number; contentFrom: number; contentTo: number; content: string }
const parser = new MarkdownIt({ html: false });

export function findEmbedBlocks(text: string): EmbedBlock[] {
  const lineOffsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineOffsets.push(i + 1);
  return parser.parse(text, {}).filter(token => token.type === 'fence' && ['chart', 'charts', 'mermaid', 'excalidraw', 'drawio'].includes(token.info.trim()) && token.map).map(token => {
    const [start, end] = token.map!;
    const from = lineOffsets[start], to = lineOffsets[end] ?? text.length;
    const contentFrom = lineOffsets[start + 1] ?? to;
    const opener = token.markup;
    const closingStart = lineOffsets[end - 1] ?? to;
    const line = text.slice(closingStart, to).trim();
    const closed = new RegExp(`^${opener[0]}{${opener.length},}$`).test(line) && end - 1 > start;
    const contentTo = closed ? closingStart : to;
    return { kind: (token.info.trim() === 'chart' ? 'charts' : token.info.trim()) as EmbedKind, from, to, contentFrom, contentTo, content: text.slice(contentFrom, contentTo) };
  });
}

export function collectResourceRefs(text: string): { local: string[]; remote: string[] } {
  const local = new Set<string>(), remote = new Set<string>();
  const add = (src: string) => {
    if (!src || src.startsWith('#')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) { remote.add(src); return; }
    local.add(src);
  };
  for (const token of parser.parse(text, {})) {
    for (const child of token.children ?? []) if (child.type === 'image') add(child.attrGet('src') ?? '');
    if (token.type === 'fence' && ['excalidraw', 'drawio'].includes(token.info.trim())) {
      const parsed = resourceEmbedSchema.safeParse(parseJson(token.content));
      if (parsed.success) add(parsed.data.src);
    }
  }
  return { local: [...local], remote: [...remote] };
}
export function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
export const sampleChart: ChartSpec = {
  version: 1, type: 'bar', title: '月度请求量',
  data: [{ month: '一月', requests: 120 }, { month: '二月', requests: 180 }, { month: '三月', requests: 150 }], x: 'month', y: 'requests',
};
export const sampleMermaid = 'flowchart LR\n  A[提出问题] --> B[收集证据] --> C[形成结论] --> D[分享与迭代]\n';
