// @vitest-environment jsdom
import React, { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientContext } from '../src/shared/types';
// Real CodeMirror and React lifecycle; graph canvas/CSP acceptance is in Playwright.
vi.mock('../src/webview/components/ChartBlock', async importOriginal => ({ ...await importOriginal<object>(), ChartBlock: ({ spec }: { spec: { title: string } }) => { const id = useRef(crypto.randomUUID()); return <div data-chart-instance={id.current}>{spec.title}</div>; } }));
vi.mock('../src/webview/components/DiagramPreview', () => ({ DiagramPreview: () => <div>diagram stub</div> }));
import { MarkdownEditor, type MarkdownEditorHandle } from '../src/webview/MarkdownEditor';
import { formatSelection } from '../src/webview/richMarkdown';
import { graphDrafts, removeGraphDraft, restoreGraphDrafts } from '../src/webview/drafts';
let root: Root | undefined, parent: HTMLDivElement;
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Range.prototype.getClientRects ??= (() => []) as unknown as typeof Range.prototype.getClientRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 100, 20);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; parent?.remove(); for (const draft of graphDrafts()) removeGraphDraft(draft.id); });
async function mount(text: string) {
  parent = document.createElement('div'); document.body.append(parent); root = createRoot(parent);
  const ref = createRef<MarkdownEditorHandle>(), onAgent = vi.fn(), onChange = vi.fn(), onInsertEmbed = vi.fn();
  const context: ClientContext = { document: { uri: 'file:///test.md', fileName: 'test.md', version: 1, text, dirty: false, eol: '\n', resourceUrls: {} }, provider: { provider: 'none', model: '', configured: false, executionHost: 'DOM test', refusalFallback: false }, trusted: true, drawioUrl: '', excalidrawAssetUrl: '' };
  const props = { ref, initialText: text, context, onChange, onAgent, onInsertEmbed, onExport: vi.fn(), onNative: vi.fn(), onImage: vi.fn() };
  await act(async () => root!.render(<MarkdownEditor {...props} />));
  const view = EditorView.findFromDOM(parent.querySelector('.cm-editor')!)!; expect(view).toBeDefined(); return { view, ref, props, onAgent, onChange, onInsertEmbed };
}
const chart = '# title\n\n```chart\n{"type":"bar","title":"first","xKey":"x","series":[{"key":"y","name":"Series"}],"data":[{"x":"a","y":1}]}\n```\n\nlast';
const button = (name: string) => [...parent.querySelectorAll('button')].find(node => node.textContent === name)!;
async function key(view: EditorView, key: string, ctrlKey = false) { await act(async () => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true })); }); }
describe('directly editable Markdown DOM', () => {
  it('fills @writer without sending, then binds a task to the previous paragraph', async () => {
    const text = '# title\n\nparagraph\n\n@writer', { view, onAgent } = await mount(text);
    await act(async () => view.dispatch({ selection: { anchor: text.length } }));
    expect(parent.querySelectorAll('.mention-menu button')).toHaveLength(1); expect(onAgent).not.toHaveBeenCalled();
    await key(view, 'Enter'); expect(view.state.doc.toString()).toBe(text + ' '); expect(onAgent).not.toHaveBeenCalled();
    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: 'make concise' }, selection: { anchor: view.state.doc.length + 12 } }));
    await key(view, 'Enter', true);
    expect(onAgent).toHaveBeenCalledWith('rewrite', { prompt: 'make concise', range: { from: 9, to: 18 } });
  });
  it('supports menu arrows and Escape without deleting input', async () => {
    const { view, onAgent } = await mount('@'); await act(async () => view.dispatch({ selection: { anchor: 1 } }));
    await key(view, 'ArrowDown'); expect(parent.querySelector('.menu-selected')?.textContent).toContain('@writer');
    await key(view, 'Escape'); expect(parent.querySelector('.mention-menu')).toBeNull(); expect(view.state.doc.toString()).toBe('@'); expect(onAgent).not.toHaveBeenCalled();
  });
  it('does not suggest mentions inside email, fenced or indented code', async () => {
    for (const text of ['user@example.com', '# title\n\n```text\n@writer\n```', '# title\n\n    @writer']) {
      const mounted = await mount(text); await act(async () => mounted.view.dispatch({ selection: { anchor: text.includes('@writer') ? text.indexOf('@writer') + 7 : text.length } })); expect(parent.querySelector('.mention-menu')).toBeNull();
      await act(async () => root!.unmount()); root = undefined; parent.remove();
    }
  });
  it('inserts a task through / with keyboard confirmation and graph inserts through Host', async () => {
    const { view, onInsertEmbed } = await mount('/task'); await act(async () => view.dispatch({ selection: { anchor: 5 } })); await key(view, 'Enter'); expect(view.state.doc.toString()).toBe('- [ ] ');
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '/mermaid' }, selection: { anchor: 8 } })); await key(view, 'Enter');
    expect(onInsertEmbed).toHaveBeenCalledWith('mermaid', { from: 0, to: 8 }); expect(view.state.doc.toString()).toBe('/mermaid');
  });
  it('keeps title and emphasis as editable text rather than a preview widget', async () => {
    const text = '# title\n\n**bold** and *italic*\n\nlast', { view, onChange } = await mount(text);
    expect(parent.querySelector('.rich-h1')?.textContent).toBe('title'); expect(parent.querySelector('.rich-bold')?.textContent).toBe('bold'); expect(parent.querySelector('.rich-italic')?.textContent).toBe('italic'); expect(parent.querySelector('.minds-rendered')).toBeNull();
    await act(async () => view.dispatch({ changes: { from: 3, to: 4, insert: 'X' }, selection: { anchor: 4 } }));
    expect(parent.querySelector('.rich-h1')?.textContent).toBe('tXtle'); expect(view.state.doc.toString()).toBe(text.replace('title', 'tXtle')); expect(onChange).toHaveBeenCalled();
  });
  it('makes only hidden syntax atomic, not the styled editable text', async () => {
    const { view } = await mount('**bold**'); await act(async () => view.dispatch({ selection: { anchor: 0 } })); await key(view, 'ArrowRight'); expect(view.state.selection.main.head).toBe(2);
    await key(view, 'ArrowRight'); expect(view.state.selection.main.head).toBe(3);
  });
  it('formats only selected text and toggles the same markers', async () => {
    const { view } = await mount('before word after'); await act(async () => { view.dispatch({ selection: { anchor: 7, head: 11 } }); formatSelection(view, 'bold'); }); expect(view.state.doc.toString()).toBe('before **word** after');
    await act(async () => formatSelection(view, 'bold')); expect(view.state.doc.toString()).toBe('before word after');
  });
  it('toggles a task with a three-character source edit', async () => {
    const { view } = await mount('- [ ] task\n\nlast'); await act(async () => (parent.querySelector('.rich-task') as HTMLInputElement).click()); expect(view.state.doc.toString()).toBe('- [x] task\n\nlast');
  });
  it('retains the graph root across data edits, edits above it and selection inside it', async () => {
    const { view, ref } = await mount(chart), id = parent.querySelector('[data-chart-instance]')?.getAttribute('data-chart-instance'); expect(id).toBeTruthy();
    const at = chart.indexOf('first'); await act(async () => view.dispatch({ changes: { from: at, to: at + 5, insert: 'second' } }));
    await act(async () => view.dispatch({ changes: { from: 0, insert: 'above\n\n' } }));
    await act(async () => view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('```chart') + 10 } }));
    expect(parent.querySelector('[data-chart-instance]')?.getAttribute('data-chart-instance')).toBe(id); expect(parent.querySelector('[data-chart-instance]')?.textContent).toBe('second');
    await act(async () => ref.current!.replace('remote\n\n' + view.state.doc.toString())); expect(parent.querySelector('[data-chart-instance]')?.getAttribute('data-chart-instance')).toBe(id);
  });
  it('preserves invalid source across collapse and graph deletion, and rejects stale apply', async () => {
    const { view } = await mount(chart); await act(async () => button('展开源码').click()); const textarea = parent.querySelector('.embed-source textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, '{invalid'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('收起源码').click()); await act(async () => button('展开源码').click()); expect((parent.querySelector('.embed-source textarea') as HTMLTextAreaElement).value).toBe('{invalid'); expect(parent.querySelector('[data-chart-instance]')).not.toBeNull();
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'deleted' } })); expect(graphDrafts().some(draft => draft.content === '{invalid')).toBe(true);
  });
  it('rejects a valid source draft if the same graph changed externally', async () => {
    const { view } = await mount(chart); await act(async () => button('展开源码').click()); const textarea = parent.querySelector('.embed-source textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, textarea.value.replace('first', 'draft')); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    const at = view.state.doc.toString().indexOf('first'); await act(async () => view.dispatch({ changes: { from: at, to: at + 5, insert: 'external' } }));
    expect((button('应用源码') as HTMLButtonElement).disabled).toBe(true); await act(async () => button('应用源码').click());
    expect(view.state.doc.toString()).toContain('external'); expect(view.state.doc.toString()).not.toContain('draft'); expect(textarea.value).toContain('draft');
    expect(graphDrafts().some(item => item.content.includes('draft'))).toBe(true);
  });
  it('ignores corrupt persisted draft entries without losing complete valid content', () => {
    restoreGraphDrafts(null); restoreGraphDrafts({ id: 'not-array' }); restoreGraphDrafts([null, false, {}, { id: 'valid', label: 'Chart', content: '{invalid draft' }]);
    expect(graphDrafts()).toEqual([{ id: 'valid', label: 'Chart', content: '{invalid draft' }]);
  });
  it('keeps an AI anchor visible when the cursor leaves the bound paragraph', async () => {
    const text = '# title\n\nparagraph\n\nlast', { view, props } = await mount(text); const node = document.createElement('div'); node.dataset.testid = 'card-anchor';
    await act(async () => root!.render(<MarkdownEditor {...props} card={{ from: text.indexOf('paragraph'), to: text.indexOf('paragraph') + 9, node }} />));
    await act(async () => view.dispatch({ selection: { anchor: text.length } })); expect(parent.querySelector('[data-testid="card-anchor"]')).toBe(node);
  });
  it('keeps HTML literal and never creates a navigable link', async () => {
    await mount('# title\n\n[external](https://evil.example) <script>alert(1)</script>\n\nlast'); expect(parent.querySelector('.rich-link')?.textContent).toBe('external'); expect(parent.querySelector('a[href],script')).toBeNull(); expect(parent.querySelector('.cm-content')?.textContent).toContain('<script>alert(1)</script>');
  });
});
