// @vitest-environment jsdom
import React, { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientContext } from '../src/shared/types';
// These stubs isolate CodeMirror/widget lifecycle. Actual graph SDKs have their
// own tests; this DOM suite is not a browser/canvas/CSP acceptance result.
vi.mock('../src/webview/components/ChartBlock', () => ({ ChartBlock: ({ spec }: { spec: { title: string } }) => { const id = useRef(crypto.randomUUID()); return <div data-chart-instance={id.current}>{spec.title}</div>; } }));
vi.mock('../src/webview/components/DiagramPreview', () => ({ DiagramPreview: () => <div>diagram stub</div> }));
import { MarkdownEditor, type MarkdownEditorHandle } from '../src/webview/MarkdownEditor';
let root: Root | undefined, parent: HTMLDivElement;
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Range.prototype.getClientRects ??= (() => []) as unknown as typeof Range.prototype.getClientRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 100, 20);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; parent?.remove(); });
async function mount(text: string) {
  parent = document.createElement('div'); document.body.append(parent); root = createRoot(parent);
  const ref = createRef<MarkdownEditorHandle>(), onAgent = vi.fn(), onChange = vi.fn();
  const context: ClientContext = { document: { uri: 'file:///test.md', fileName: 'test.md', version: 1, text, dirty: false, eol: '\n', resourceUrls: {} }, provider: { provider: 'none', model: '', configured: false, executionHost: 'DOM test', refusalFallback: false }, trusted: true, drawioUrl: '', excalidrawAssetUrl: '' };
  const props = { ref, initialText: text, context, onChange, onAgent, onEditEmbed: vi.fn(), onExport: vi.fn(), onNative: vi.fn(), onImage: vi.fn() };
  await act(async () => root!.render(<MarkdownEditor {...props} />));
  const view = EditorView.findFromDOM(parent.querySelector('.cm-editor')!)!; expect(view).toBeDefined(); return { view, ref, props, onAgent, onChange };
}
describe('real CodeMirror DOM lifecycle, graph components stubbed', () => {
  it('leaves an @writer command untouched until a menu click', async () => {
    const { view, onAgent } = await mount('# title\n\n'); const value = '# title\n\n@writer';
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } }));
    expect(view.state.doc.toString()).toBe(value); expect(onAgent).not.toHaveBeenCalled(); expect(parent.querySelector('.mention-menu')).not.toBeNull();
    await act(async () => (parent.querySelectorAll('.mention-menu button')[1] as HTMLButtonElement).click()); expect(onAgent).toHaveBeenCalledWith('rewrite'); expect(view.state.doc.toString()).not.toContain('@writer');
  });
  it('does not suggest mentions inside fenced or indented code', async () => {
    for (const text of ['# title\n\n```text\n@writer\n```', '# title\n\n    @writer']) {
      const mounted = await mount(text); await act(async () => mounted.view.dispatch({ selection: { anchor: text.indexOf('@writer') + 7 } })); expect(parent.querySelector('.mention-menu')).toBeNull();
      await act(async () => root!.unmount()); root = undefined; parent.remove();
    }
  });
  it('updates rendered paragraph offsets after an edit above it', async () => {
    const { view } = await mount('# title\n\nparagraph\n\nlast');
    await act(async () => view.dispatch({ changes: { from: 0, insert: '# inserted\n\n' } }));
    const paragraph = [...parent.querySelectorAll('.minds-rendered')].find(node => node.textContent?.includes('paragraph'))!; expect(paragraph).toBeDefined();
    await act(async () => paragraph.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('paragraph'));
  });
  it('retains the React chart instance across same-position data edits', async () => {
    const before = '# title\n\n```charts\n{"version":1,"type":"bar","title":"first","x":"x","y":"y","data":[{"x":"a","y":1}]}\n```\n';
    const { view } = await mount(before); const id = parent.querySelector('[data-chart-instance]')?.getAttribute('data-chart-instance'); expect(id).toBeTruthy();
    const at = before.indexOf('first'); await act(async () => view.dispatch({ changes: { from: at, to: at + 5, insert: 'second' } }));
    expect(parent.querySelector('[data-chart-instance]')?.getAttribute('data-chart-instance')).toBe(id); expect(parent.querySelector('[data-chart-instance]')?.textContent).toBe('second');
  });
  it('keeps an AI anchor visible when the cursor leaves the bound paragraph', async () => {
    const text = '# title\n\nparagraph\n\nlast', { view, props } = await mount(text); const node = document.createElement('div'); node.dataset.testid = 'card-anchor';
    await act(async () => root!.render(<MarkdownEditor {...props} card={{ from: text.indexOf('paragraph'), to: text.indexOf('paragraph') + 9, node }} />));
    await act(async () => view.dispatch({ selection: { anchor: text.length } })); expect(parent.querySelector('[data-testid="card-anchor"]')).toBe(node);
  });
  it('renders literal HTML and removes link navigation', async () => {
    await mount('# title\n\n[external](https://evil.example) <script>alert(1)</script>\n\nlast');
    expect(parent.querySelector('.minds-rendered a')?.hasAttribute('href')).toBe(false); expect(parent.querySelector('script')).toBeNull();
  });
});
