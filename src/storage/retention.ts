export interface RetentionPolicyConfig {
  maxSnapshots: number;
  detailedDays: number;
  expireDays: number;
  timeZone: string;
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicyConfig> = Object.freeze({
  maxSnapshots: 100, detailedDays: 7, expireDays: 30, timeZone: 'UTC',
});
export const DAY_MS = 24 * 60 * 60 * 1000;

export function validatePolicy(policy: RetentionPolicyConfig): RetentionPolicyConfig {
  if (!Number.isSafeInteger(policy.maxSnapshots) || policy.maxSnapshots < 1 ||
      !Number.isFinite(policy.detailedDays) || policy.detailedDays < 0 ||
      !Number.isFinite(policy.expireDays) || policy.expireDays <= 0 ||
      policy.detailedDays > policy.expireDays || typeof policy.timeZone !== 'string') {
    throw new TypeError('Invalid snapshot retention policy');
  }
  // Validate IANA timezone names now, rather than failing partway through a save.
  new Intl.DateTimeFormat('en-US', { timeZone: policy.timeZone }).format(0);
  return { ...policy };
}

export interface RetentionCandidate { id: string; savedAt: number }

/** Head is pinned; daily anchors get slots before recent detailed saves. Never rewrites savedAt. */
export function selectRetained<T extends RetentionCandidate>(
  entries: readonly T[], head: string | null, policy: RetentionPolicyConfig, now: number,
): T[] {
  const config = validatePolicy(policy);
  if (!Number.isFinite(now)) throw new TypeError('Invalid retention clock');
  if (head === null) {
    if (entries.length) throw new TypeError('Snapshots require a head');
    return [];
  }
  const pinned = entries.find(entry => entry.id === head);
  if (!pinned) throw new TypeError('Snapshot head is missing');
  const rank = new Map(entries.map((entry, index) => [entry.id, index]));
  const newest = (a: T, b: T) => b.savedAt - a.savedAt || rank.get(a.id)! - rank.get(b.id)!;
  const eligible = entries.filter(entry => entry.id !== head && now - entry.savedAt < config.expireDays * DAY_MS).sort(newest);
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const daily = new Map<string, T>();
  const pinnedAge = now - pinned.savedAt;
  if (pinnedAge >= config.detailedDays * DAY_MS && pinnedAge < config.expireDays * DAY_MS) {
    daily.set(format.format(pinned.savedAt), pinned);
  }
  const detailed: T[] = [];
  for (const entry of eligible) {
    if (now - entry.savedAt < config.detailedDays * DAY_MS) detailed.push(entry);
    else {
      const day = format.format(entry.savedAt);
      const existing = daily.get(day);
      if (!existing || (existing.id === head && newest(entry, existing) < 0)) daily.set(day, entry);
    }
  }
  const anchors = [...daily.values()].filter(entry => entry.id !== head).sort(newest);
  const selected = [pinned, ...anchors.slice(0, config.maxSnapshots - 1)];
  selected.push(...detailed.slice(0, config.maxSnapshots - selected.length));
  return [pinned, ...selected.slice(1).sort(newest)];
}
