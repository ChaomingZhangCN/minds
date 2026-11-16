export interface GraphDraft { id: string; label: string; content: string }
const drafts = new Map<string, GraphDraft>();
const listeners = new Set<() => void>();
export function graphDrafts(): GraphDraft[] { return [...drafts.values()]; }
export function keepGraphDraft(id: string, label: string, content: string): void { drafts.set(id, { id, label, content }); listeners.forEach(listener => listener()); }
export function removeGraphDraft(id: string): void { if (drafts.delete(id)) listeners.forEach(listener => listener()); }
export function restoreGraphDrafts(values: unknown): void { if (!Array.isArray(values)) return; for (const value of values) if (value && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.content === 'string') drafts.set(value.id, { id: value.id, label: value.label, content: value.content }); }
export function subscribeGraphDrafts(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
