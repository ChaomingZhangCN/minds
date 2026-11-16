import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWithin, resolveWorkspaceResource, sniffImage, validateSvg } from '../src/utils/security';

describe('workspace boundary', () => {
  it('does not confuse a prefix sibling with a child', () => { expect(isWithin('/tmp/a', '/tmp/ab/image')).toBe(false); expect(isWithin('/tmp/a', '/tmp/a/images/a')).toBe(true); });
  it('rejects traversal, absolute URL and symlink escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minds-security-'));
    try {
      await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
      const doc = path.join(root, 'doc.md');
      await expect(resolveWorkspaceResource(root, doc, '../outside', true)).rejects.toThrow();
      await expect(resolveWorkspaceResource(root, doc, '%2fetc/passwd', true)).rejects.toThrow();
      await expect(resolveWorkspaceResource(root, doc, 'https://example.com/a')).rejects.toThrow();
      await expect(resolveWorkspaceResource(root, doc, 'escape/missing-file', true)).rejects.toThrow();
      expect(await resolveWorkspaceResource(root, doc, 'images/new.png', true)).toBe(path.join(root, 'images/new.png'));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
describe('active resource rejection', () => {
  it('allows ordinary SVG and rejects scripts/events/remote resources', () => {
    expect(validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>')).toContain('Hello');
    for (const svg of ['<svg><script>x()</script></svg>', '<svg onload="x()"/>', '<svg><image href="https://example.com/a.png"/></svg>', '<svg><foreignObject><div>hi</div></foreignObject></svg>', '<!DOCTYPE svg><svg/>', '<svg><style>@import "https://example.com/a.css"</style></svg>']) expect(() => validateSvg(svg)).toThrow();
  });
  it('sniffs bytes rather than trusting a claimed MIME', () => {
    expect(() => sniffImage(Buffer.from('<svg><script>x</script></svg>'))).toThrow();
    expect(sniffImage(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])).extension).toBe('png');
  });
});
