import { describe, expect, it } from 'vitest';
import { applyNormalizedChange, normalizeText, normalizedOffsetToRaw, smallestChange } from '../src/shared/text';
import { SyncController, type EditRequest } from '../src/editor/SyncController';
import { clientMessageSchema } from '../src/shared/protocol';
import { ProposalService } from '../src/agent/ProposalService';

describe('source-preserving text', () => {
  it('keeps CRLF and Unicode outside changed range', () => {
    const raw = '# 标题\r\n\r\n你好😀 world\r\n';
    const before = normalizeText(raw), after = before.replace('world', '世界');
    expect(applyNormalizedChange(raw, smallestChange(before, after), '\r\n')).toBe('# 标题\r\n\r\n你好😀 世界\r\n');
    expect(normalizedOffsetToRaw('a\r\nb', 2)).toBe(3);
    expect(() => normalizedOffsetToRaw('a', 2)).toThrow();
  });
  it('never splits emoji edits', () => {
    const change = smallestChange('a😀z', 'a😃z');
    expect(change.from).toBe(1); expect(change.to).toBe(3);
    expect(applyNormalizedChange('a😀z', change, '\n')).toBe('a😃z');
  });
  it('rejects stale text', () => expect(() => applyNormalizedChange('hello', { from: 0, to: 2, expectedText: 'no', insert: '' }, '\n')).toThrow());
});
describe('single-flight native sync', () => {
  it('does not overwrite typing ahead of an acknowledgement', () => {
    const sent: EditRequest[] = [];
    const sync = new SyncController({ text: 'a', version: 1 }, value => sent.push(value));
    sync.local('ab'); sync.local('abc'); expect(sent).toHaveLength(1);
    sync.receive({ text: 'ab', version: 2, originOpId: sent[0].id });
    expect(sync.draft).toBe('abc'); expect(sent).toHaveLength(2); expect(sent[1].baseVersion).toBe(2);
    sync.receive({ text: 'abc', version: 3, originOpId: sent[1].id });
    expect(sync.busy).toBe(false);
  });
  it('preserves a conflicting unsent draft instead of retrying blindly', async () => {
    const sent: EditRequest[] = [];
    const sync = new SyncController({ text: 'a', version: 1 }, value => sent.push(value));
    sync.local('ab'); sync.receive({ text: 'external', version: 2 });
    expect(sync.conflictDraft).toBe('ab'); expect(sync.draft).toBe('external'); expect(sync.blocked).toBe(true);
    await expect(sync.whenIdle()).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
  it('ignores stale host events', () => {
    const sync = new SyncController({ text: 'b', version: 3 }, () => {});
    sync.receive({ text: 'a', version: 1 }); expect(sync.draft).toBe('b');
  });
});
describe('protocol and proposals', () => {
  it('rejects arbitrary command and surplus credentials', () => {
    expect(clientMessageSchema.safeParse({ type: 'terminal', id: 'x', command: 'anything' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'ready', id: 'x', apiKey: 'secret' }).success).toBe(false);
  });
  it('rejects proposals after any version change', () => {
    const store = new ProposalService();
    const proposal = store.create({ mode: 'rewrite', from: 0, to: 3, baseVersion: 1, original: 'old', replacement: 'new', prompt: 'rewrite' });
    expect(store.validate(proposal.id, 'old', 1).replacement).toBe('new');
    expect(() => store.validate(proposal.id, 'old', 2)).toThrow();
  });
});
