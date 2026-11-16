import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RestoreError, restoreWithRecovery } from '../src/utils/restore';
const roots: string[] = [];
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minds-restore-')); roots.push(root); return { root, journal: path.join(root, 'private'), file: path.join(root, 'diagram.drawio') }; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('recoverable resource restore', () => {
  it('commits resource bytes and removes only its completed private journal', async () => {
    const { journal, file } = await setup(); await fs.writeFile(file, 'old');
    let committed = false;
    await restoreWithRecovery(journal, [{ file, bytes: Buffer.from('restored') }], '# before', async () => { expect(await fs.readFile(file, 'utf8')).toBe('restored'); committed = true; }, async () => {});
    expect(committed).toBe(true); expect(await fs.readFile(file, 'utf8')).toBe('restored'); expect(await fs.readdir(journal)).toEqual([]);
  });
  it('rolls back bytes on native commit failure and retains complete private backups', async () => {
    const { journal, file } = await setup(); await fs.writeFile(file, 'old');
    await expect(restoreWithRecovery(journal, [{ file, bytes: Buffer.from('restored') }], '# before', async () => { throw new Error('native save failed'); }, async () => {})).rejects.toBeInstanceOf(RestoreError);
    expect(await fs.readFile(file, 'utf8')).toBe('old');
    const folder = path.join(journal, (await fs.readdir(journal))[0]); expect(await fs.readFile(path.join(folder, 'original.md'), 'utf8')).toBe('# before'); expect(await fs.readFile(path.join(folder, '0.backup'), 'utf8')).toBe('old');
  });
  it('never rolls back over a newer external resource edit', async () => {
    const { journal, file } = await setup(); await fs.writeFile(file, 'old');
    await expect(restoreWithRecovery(journal, [{ file, bytes: Buffer.from('restored') }], '# before', async () => { await fs.writeFile(file, 'new external edit'); throw new Error('failure'); }, async () => {})).rejects.toBeInstanceOf(RestoreError);
    expect(await fs.readFile(file, 'utf8')).toBe('new external edit');
  });
  it('refuses a resource changed between backup and replacement', async () => {
    const { journal, file } = await setup(); await fs.writeFile(file, 'old'); let checks = 0;
    await expect(restoreWithRecovery(journal, [{ file, bytes: Buffer.from('restored') }], '# before', async () => {}, async () => { if (++checks === 3) await fs.writeFile(file, 'changed'); })).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('changed');
  });
  it('removes a newly created resource if its native commit fails', async () => {
    const { journal, file } = await setup();
    await expect(restoreWithRecovery(journal, [{ file, bytes: Buffer.from('restored') }], '# before', async () => { throw new Error('failure'); }, async () => {})).rejects.toThrow();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
