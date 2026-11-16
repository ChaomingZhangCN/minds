// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../src/webview/bridge', () => ({ request: vi.fn() }));
import { EmbedCard } from '../src/webview/components/EmbedCard';
import type { ClientContext } from '../src/shared/types';
import { findEmbedBlocks } from '../src/shared/embeds';
import { graphDrafts, removeGraphDraft } from '../src/webview/drafts';
import { validateMermaidSource, sanitizeMermaidSvg, renderMermaid } from '../src/webview/components/MermaidBlock';
import { validateSvg } from '../src/utils/security';
import { sampleMermaid } from '../src/shared/embeds';
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Real Mermaid parser/renderer with deterministic DOM geometry, not browser layout.
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 140, height: 40 }) });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 100 });
});
describe('local strict Mermaid', () => {
  it.each(['%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B', '---\nconfig:\n---\nflowchart LR\nA-->B', 'flowchart LR\nclick A "https://evil.example"', 'flowchart LR\nA[<img src=x>]', 'flowchart LR\nA@{ img: "https://evil.example/a.png" }'])('rejects active source %s', source => expect(() => validateMermaidSource(source)).toThrow());
  it('removes active SVG and keyframes without weakening the export boundary', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100%"><style>@keyframes pulse {from {opacity:0} to {opacity:1}} rect{fill:#fff}</style><script>alert(1)</script><rect width="10" height="10"/></svg>';
    const safe = sanitizeMermaidSvg(source); expect(safe).not.toContain('<script'); expect(safe).not.toContain('@keyframes'); expect(validateSvg(safe)).toBe(safe);
    expect(() => sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path fill="u\\72l(https://evil.example)"/></svg>')).toThrow();
  });
  it('renders actual local diagrams serially in both themes and exports Host-valid SVG', async () => {
    const outputs = await Promise.all([renderMermaid(sampleMermaid, 'light'), renderMermaid('sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Done', 'dark')]);
    for (const svg of outputs) { expect(svg).toContain('<svg'); expect(svg).not.toContain('<foreignObject'); expect(validateSvg(svg)).toBe(svg); }
    expect(document.querySelector('.mermaid-render-runtime')).toBeNull();
  }, 30000);
  it('blocks source apply until the current draft has actually rendered, preserving invalid text and the valid SVG', async () => {
    const text = '```mermaid\n' + sampleMermaid + '\n```', block = findEmbedBlocks(text)[0];
    const context: ClientContext = { document: { uri: 'file:///test.md', fileName: 'test.md', text, version: 1, dirty: false, eol: '\n', resourceUrls: {} }, trusted: true, provider: { provider: 'none', model: '', configured: false, executionHost: 'test', refusalFallback: false }, drawioUrl: '', excalidrawAssetUrl: '' };
    const parent = document.createElement('div'); document.body.append(parent); const root = createRoot(parent), onChange = vi.fn();
    const button = (label: string) => [...parent.querySelectorAll('button')].find(node => node.textContent === label)!;
    const input = async (value: string) => { const textarea = parent.querySelector('textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); };
    try {
      await act(async () => root.render(React.createElement(EmbedCard, { block, context, stamp: '', onChange, onExport: vi.fn() })));
      await act(async () => button('展开源码').click());
      await vi.waitFor(async () => { await act(async () => {}); expect((button('应用源码') as HTMLButtonElement).disabled).toBe(false); }, { timeout: 30000 });
      const previous = parent.querySelector('img')?.getAttribute('src'); expect(previous).toBeTruthy();
      await input('not a diagram'); expect((button('应用源码') as HTMLButtonElement).disabled).toBe(true);
      await vi.waitFor(async () => { await act(async () => {}); expect(parent.querySelector('.mermaid-block [role="alert"]')).not.toBeNull(); });
      expect(parent.querySelector('img')?.getAttribute('src')).toBe(previous); expect(parent.querySelector('textarea')?.value).toBe('not a diagram');
      await act(async () => parent.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))); expect(onChange).not.toHaveBeenCalled();
      const valid = 'flowchart LR\nX-->Y'; await input(valid);
      await vi.waitFor(async () => { await act(async () => {}); expect((button('应用源码') as HTMLButtonElement).disabled).toBe(false); }, { timeout: 30000 });
      await act(async () => button('应用源码').click()); expect(onChange).toHaveBeenCalledWith(valid + '\n', block.content);
    } finally { await act(async () => root.unmount()); parent.remove(); for (const draft of graphDrafts()) removeGraphDraft(draft.id); }
  }, 30000);
  it('recovers the render queue after a syntax error', async () => {
    await expect(renderMermaid('not a diagram')).rejects.toThrow(); expect(await renderMermaid('flowchart LR\nA-->B')).toContain('<svg');
  }, 30000);
});
