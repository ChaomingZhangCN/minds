import { z } from 'zod';

const id = z.string().min(1).max(128);
const offset = z.number().int().nonnegative();
const change = z.object({
  from: offset, to: offset, insert: z.string().max(10_000_000), expectedText: z.string().max(10_000_000),
}).strict().refine(v => v.to >= v.from, 'Invalid text range');
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), id }).strict(),
  z.object({ type: z.literal('edit'), id, baseVersion: offset, change }).strict(),
  z.object({ type: z.literal('save'), id }).strict(),
  z.object({ type: z.literal('undo'), id }).strict(),
  z.object({ type: z.literal('redo'), id }).strict(),
  z.object({ type: z.literal('openSource'), id }).strict(),
  z.object({ type: z.literal('configureProvider'), id }).strict(),
  z.object({ type: z.literal('aiStart'), id, mode: z.enum(['ask', 'rewrite']), prompt: z.string().min(1).max(10000), baseVersion: offset, from: offset, to: offset, expectedText: z.string().max(500000), scope: z.enum(['selection', 'section', 'document']), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(100000) }).strict()).max(20).optional() }).strict(),
  z.object({ type: z.literal('aiCancel'), id, requestId: id }).strict(),
  z.object({ type: z.literal('proposalAccept'), id, proposalId: id }).strict(),
  z.object({ type: z.literal('proposalReject'), id, proposalId: id }).strict(),
  z.object({ type: z.literal('historyList'), id }).strict(),
  z.object({ type: z.literal('historyPreview'), id, snapshotId: id }).strict(),
  z.object({ type: z.literal('historyRestore'), id, snapshotId: id }).strict(),
  z.object({ type: z.literal('maintenance'), id, dryRun: z.boolean() }).strict(),
  z.object({ type: z.literal('importImage'), id, name: z.string().max(256), mime: z.string().max(128), data: z.string().max(16_000_000), baseVersion: offset, from: offset, to: offset }).strict(),
  z.object({ type: z.literal('insertEmbed'), id, kind: z.enum(['charts', 'mermaid', 'excalidraw', 'drawio']), baseVersion: offset, from: offset, to: offset }).strict(),
  z.object({ type: z.literal('readEmbed'), id, kind: z.enum(['excalidraw', 'drawio']), src: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal('saveEmbed'), id, sessionId: id, content: z.string().max(20_000_000) }).strict(),
  z.object({ type: z.literal('closeEmbed'), id, sessionId: id }).strict(),
  z.object({ type: z.literal('exportSvg'), id, name: z.string().max(256), svg: z.string().max(20_000_000) }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
