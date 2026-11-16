import { z } from 'zod';
import MarkdownIt from 'markdown-it';
import type { EmbedKind } from './types';

export const chartSchema = z.object({
  version: z.literal(1), type: z.enum(['bar', 'line', 'pie']), title: z.string().max(300),
  data: z.array(z.record(z.union([z.string().max(2000), z.number().finite(), z.null()]))).min(1).max(5000),
  x: z.string().min(1).max(100), y: z.string().min(1).max(100),
  series: z.string().min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  for (let i = 0; i < value.data.length; i++) {
    if (value.data[i][value.x] == null || typeof value.data[i][value.y] !== 'number') {
      ctx.addIssue({ code: 'custom', path: ['data', i], message: '每行必须包含 x 字段和有限数值 y 字段' });
    }
  }
  const seriesCount = new Set(value.data.map(row => String(row[value.series ?? value.x]))).size;
  if ((value.type === 'pie' || value.series) && seriesCount > 8) ctx.addIssue({ code: 'custom', message: '最多 8 个系列；请合并为其他或拆分图表' });
});
export type ChartSpec = z.infer<typeof chartSchema>;
export const resourceEmbedSchema = z.object({ src: z.string().min(1).max(2048), page: z.string().max(300).optional() }).strict();
export interface EmbedBlock { kind: EmbedKind; from: number; to: number; contentFrom: number; contentTo: number; content: string }
const parser = new MarkdownIt({ html: false });

export function findEmbedBlocks(text: string): EmbedBlock[] {
  const lineOffsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineOffsets.push(i + 1);
  return parser.parse(text, {}).filter(token => token.type === 'fence' && ['charts', 'excalidraw', 'drawio'].includes(token.info.trim()) && token.map).map(token => {
    const [start, end] = token.map!;
    const from = lineOffsets[start];
    const to = lineOffsets[end] ?? text.length;
    const contentFrom = lineOffsets[start + 1] ?? to;
    const closingLine = end - 1;
    const line = text.slice(lineOffsets[closingLine] ?? to, lineOffsets[end] ?? text.length).trim();
    const closed = /^(?:`{3,}|~{3,})$/.test(line);
    const contentTo = closed ? (lineOffsets[closingLine] ?? to) : to;
    return { kind: token.info.trim() as EmbedKind, from, to, contentFrom, contentTo, content: token.content };
  });
}

export function collectResourceRefs(text: string): { local: string[]; remote: string[] } {
  const local = new Set<string>();
  const remote = new Set<string>();
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
