import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicWrite, ensureDirectory, isMissing, jsonBytes, readRegularFile } from '../storage/fs';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface RestoreFile { file: string; bytes: Uint8Array }
export class RestoreError extends Error {
  constructor(readonly journal: string) { super(`恢复未完成，已尝试回滚；完整原文和资源备份保留在私有恢复日志：${journal}`); }
}
async function current(file: string): Promise<Buffer | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000_000) throw new Error('恢复目标不是普通文件或超过限制');
    return await readRegularFile(file);
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean { return a === undefined ? b === undefined : b !== undefined && hash(a) === hash(b); }

// This is a recoverable multi-file operation, not an atomic filesystem/VS Code
// transaction. Never roll back over a newer external edit; retain the journal.
export async function restoreWithRecovery(
  journalRoot: string, files: RestoreFile[], originalMarkdown: string,
  commit: () => Promise<void>, guard: (file: string) => Promise<void>,
): Promise<void> {
  if (new Set(files.map(item => item.file)).size !== files.length) throw new Error('重复的恢复目标');
  await ensureDirectory(journalRoot);
  const journal = path.join(journalRoot, randomUUID()); await ensureDirectory(journal);
  const backups: { file: string; bytes: Buffer | undefined; replacement: Uint8Array; written: boolean }[] = [];
  let size = 0;
  for (const item of files) {
    await guard(item.file); const bytes = await current(item.file);
    size += (bytes?.length ?? 0) + item.bytes.length;
    if (size > 200_000_000) throw new Error('恢复备份超过 200 MB 限制');
    backups.push({ file: item.file, bytes, replacement: item.bytes, written: false });
  }
  await atomicWrite(path.join(journal, 'original.md'), Buffer.from(originalMarkdown));
  for (let i = 0; i < backups.length; i++) if (backups[i].bytes) await atomicWrite(path.join(journal, `${i}.backup`), backups[i].bytes!);
  await atomicWrite(path.join(journal, 'journal.json'), jsonBytes({ schemaVersion: 1, state: 'prepared', createdAt: Date.now(), resources: backups.map((item, i) => ({ file: item.file, existed: item.bytes !== undefined, backup: item.bytes ? `${i}.backup` : null, originalHash: item.bytes ? hash(item.bytes) : null, replacementHash: hash(item.replacement) })) }));
  let committed = false;
  try {
    for (const item of backups) {
      await guard(item.file); await fs.mkdir(path.dirname(item.file), { recursive: true });
      // Mark before rename: fsync may fail after the replacement is installed.
      item.written = true;
      await atomicWrite(item.file, item.replacement, async () => { await guard(item.file); if (!equal(await current(item.file), item.bytes)) throw new Error('恢复目标已被其他编辑器改变'); });
    }
    await commit(); committed = true;
    await atomicWrite(path.join(journal, 'completed.json'), jsonBytes({ completedAt: Date.now() }));
  } catch {
    for (const item of [...backups].reverse()) if (!committed && item.written) {
      try {
        await guard(item.file);
        if (!equal(await current(item.file), item.replacement)) continue;
        if (item.bytes) await atomicWrite(item.file, item.bytes, async () => { await guard(item.file); if (!equal(await current(item.file), item.replacement)) throw new Error('恢复回滚目标已变化'); });
        else { await guard(item.file); if (equal(await current(item.file), item.replacement)) await fs.unlink(item.file); }
      } catch { /* Preserve the journal and never overwrite an unknown/new draft. */ }
    }
    throw new RestoreError(journal);
  }
  // Only this generated, completed journal is removed; never scan/delete live resources.
  await fs.rm(journal, { recursive: true, force: true }).catch(() => undefined);
}
