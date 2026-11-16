import type { TextChange } from './types';

export function normalizeText(text: string): string { return text.replace(/\r\n/g, '\n'); }

export function normalizedOffsetToRaw(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid text offset');
  let logical = 0;
  for (let raw = 0; raw < text.length; raw++) {
    if (logical === offset) return raw;
    if (text[raw] === '\r' && text[raw + 1] === '\n') raw++;
    logical++;
  }
  if (logical === offset) return text.length;
  throw new Error('Text offset is outside document');
}

export function applyNormalizedChange(raw: string, change: TextChange, eol: '\n' | '\r\n'): string {
  const normalized = normalizeText(raw);
  if (change.from > change.to || normalized.slice(change.from, change.to) !== change.expectedText) {
    throw new Error('目标文本已变化，未应用修改');
  }
  const from = normalizedOffsetToRaw(raw, change.from);
  const to = normalizedOffsetToRaw(raw, change.to);
  const insert = normalizeText(change.insert).replace(/\n/g, eol);
  return raw.slice(0, from) + insert + raw.slice(to);
}

export function smallestChange(before: string, after: string): TextChange {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  // Do not split a UTF-16 surrogate pair at either edit boundary.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(before[from] ?? after[from] ?? '')) from--;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  if (endBefore < before.length && /[\uDC00-\uDFFF]/.test(before[endBefore])) { endBefore++; endAfter++; }
  return { from, to: endBefore, insert: after.slice(from, endAfter), expectedText: before.slice(from, endBefore) };
}

export function paragraphRange(text: string, offset: number): { from: number; to: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  let from = text.lastIndexOf('\n\n', Math.max(0, safe - 1));
  from = from < 0 ? 0 : from + 2;
  let to = text.indexOf('\n\n', safe);
  if (to < 0) to = text.length;
  return { from, to };
}
