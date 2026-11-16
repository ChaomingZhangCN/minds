import { describe, expect, it } from 'vitest';
import { DAY_MS, DEFAULT_RETENTION_POLICY, selectRetained, validatePolicy } from '../src/storage/retention';

const now = Date.parse('2026-11-16T12:00:00Z');
const atAge = (id: string, days: number) => ({ id, savedAt: now - days * DAY_MS });
const ids = (entries: { id: string }[]) => entries.map(entry => entry.id);

describe('snapshot retention', () => {
  it('has the agreed 100 / 7 / 30 / UTC defaults', () => {
    expect(DEFAULT_RETENTION_POLICY).toEqual({ maxSnapshots: 100, detailedDays: 7, expireDays: 30, timeZone: 'UTC' });
  });

  it('pins a head older than 30 days and counts it against the cap', () => {
    const entries = [atAge('head', 80), atAge('recent', 1), atAge('expired', 31)];
    expect(ids(selectRetained(entries, 'head', { ...DEFAULT_RETENTION_POLICY, maxSnapshots: 2 }, now))).toEqual(['head', 'recent']);
  });

  it('uses exact 7/30 day boundaries without refreshing original savedAt', () => {
    const entries = [atAge('head', 0), atAge('detail', 7 - 1 / DAY_MS), atAge('daily', 7), atAge('last', 30 - 1 / DAY_MS), atAge('expired', 30)];
    const result = selectRetained(entries, 'head', DEFAULT_RETENTION_POLICY, now);
    expect(ids(result)).toEqual(['head', 'detail', 'daily', 'last']);
    expect(result.find(entry => entry.id === 'daily')?.savedAt).toBe(now - 7 * DAY_MS);
    expect(entries[4].savedAt).toBe(now - 30 * DAY_MS);
  });

  it('keeps the latest representative on each UTC date, not rolling 24h buckets', () => {
    const entries = [atAge('head', 0),
      { id: 'older-same-date', savedAt: Date.parse('2026-11-07T00:01:00Z') },
      { id: 'latest-same-date', savedAt: Date.parse('2026-11-07T23:59:00Z') },
      { id: 'next-date', savedAt: Date.parse('2026-11-08T00:01:00Z') },
    ];
    expect(ids(selectRetained(entries, 'head', DEFAULT_RETENTION_POLICY, now))).toEqual(['head', 'next-date', 'latest-same-date']);
  });

  it('reserves daily anchors before using remaining slots for recent detailed saves', () => {
    const entries = [atAge('head', 0), atAge('recent1', 1), atAge('recent2', 2), atAge('daily1', 8), atAge('daily2', 9)];
    expect(ids(selectRetained(entries, 'head', { ...DEFAULT_RETENTION_POLICY, maxSnapshots: 4 }, now))).toEqual(['head', 'recent1', 'daily1', 'daily2']);
  });

  it('lets an aged head serve as its date anchor but keeps a newer same-date representative if needed', () => {
    const entries = [atAge('head', 8), atAge('older-same-date', 8.1), atAge('other-date', 9)];
    expect(ids(selectRetained(entries, 'head', DEFAULT_RETENTION_POLICY, now))).toEqual(['head', 'other-date']);
    entries.push(atAge('newer-same-date', 7.9));
    expect(ids(selectRetained(entries, 'head', DEFAULT_RETENTION_POLICY, now))).toEqual(['head', 'newer-same-date', 'other-date']);
  });

  it('cap 1 keeps only head; small caps take closer daily dates', () => {
    const entries = [atAge('head', 0), atAge('recent', 1), atAge('daily-near', 8), atAge('daily-far', 20)];
    expect(ids(selectRetained(entries, 'head', { ...DEFAULT_RETENTION_POLICY, maxSnapshots: 1 }, now))).toEqual(['head']);
    expect(ids(selectRetained(entries, 'head', { ...DEFAULT_RETENTION_POLICY, maxSnapshots: 2 }, now))).toEqual(['head', 'daily-near']);
  });

  it('keeps at most 100 latest recent snapshots including head', () => {
    const entries = Array.from({ length: 150 }, (_, index) => ({ id: String(index), savedAt: now - index }));
    expect(selectRetained(entries, '0', DEFAULT_RETENTION_POLICY, now)).toEqual(entries.slice(0, 100));
  });

  it('respects a configured timezone while default UTC ignores the process timezone', () => {
    const entries = [atAge('head', 0),
      { id: 'utc-first', savedAt: Date.parse('2026-11-07T23:59:00Z') },
      { id: 'utc-second', savedAt: Date.parse('2026-11-08T00:01:00Z') },
    ];
    expect(selectRetained(entries, 'head', DEFAULT_RETENTION_POLICY, now)).toHaveLength(3);
    expect(ids(selectRetained(entries, 'head', { ...DEFAULT_RETENTION_POLICY, timeZone: 'Asia/Shanghai' }, now))).toEqual(['head', 'utc-second']);
  });

  it('is stable for identical timestamps and preserves future-dated saves', () => {
    const entries = [atAge('head', 0), atAge('first', 1), atAge('second', 1), atAge('future', -1)];
    expect(ids(selectRetained(entries, 'head', DEFAULT_RETENTION_POLICY, now))).toEqual(['head', 'future', 'first', 'second']);
  });

  it('rejects invalid policy and missing heads rather than guessing', () => {
    expect(() => validatePolicy({ ...DEFAULT_RETENTION_POLICY, maxSnapshots: 0 })).toThrow();
    expect(() => validatePolicy({ ...DEFAULT_RETENTION_POLICY, detailedDays: 31 })).toThrow();
    expect(() => validatePolicy({ ...DEFAULT_RETENTION_POLICY, timeZone: 'not/a-zone' })).toThrow();
    expect(() => selectRetained([atAge('a', 1)], 'missing', DEFAULT_RETENTION_POLICY, now)).toThrow();
  });
});
