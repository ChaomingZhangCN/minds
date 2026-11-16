import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Annotation, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { findEmbedBlocks, type EmbedBlock } from '../shared/embeds';
import { paragraphRange, smallestChange } from '../shared/text';
import type { AgentMode, ClientContext, EmbedKind } from '../shared/types';
import { EmbedCard } from './components/EmbedCard';
import { formatSelection, parseMarkdown, richDecorations, type FormatAction } from './richMarkdown';

const remoteUpdate = Annotation.define<boolean>();
interface Card { from: number; to: number; node: HTMLElement }
const refresh = StateEffect.define<undefined>(), setCard = StateEffect.define<Card | undefined>();
export interface AgentInput { prompt?: string; range?: { from: number; to: number } }
export interface MarkdownEditorHandle {
  text(): string; selection(): { from: number; to: number }; target(): { from: number; to: number };
  replace(text: string): void; select(from: number, to: number): void; insert(text: string): void; focus(): void;
}
interface Props {
  initialText: string; context: ClientContext; resourceStamp?: string; card?: Card;
  onChange(text: string): void; onAgent(mode: AgentMode, input?: AgentInput): void;
  onInsertEmbed?(kind: EmbedKind, range: { from: number; to: number }): void;
  onExport(svg: string): void; onNative(command: 'save' | 'undo' | 'redo'): void; onImage(file: File): void;
}
interface EmbedIdentity { id: string; block: EmbedBlock }
const embedRoots = new WeakMap<HTMLElement, { root: Root; id: string }>();
class EmbedWidget extends WidgetType {
  constructor(private id: string, private block: EmbedBlock, private props: () => Props, private change: (source: string, expected: string) => void, private stamp: string) { super(); }
  eq(other: EmbedWidget) { return this.id === other.id && this.block.content === other.block.content && this.block.from === other.block.from && this.stamp === other.stamp; }
  toDOM() { const dom = document.createElement('div'); dom.className = 'minds-embed-widget'; const root = createRoot(dom); embedRoots.set(dom, { root, id: this.id }); this.render(root); return dom; }
  updateDOM(dom: HTMLElement) { const previous = embedRoots.get(dom); if (!previous || previous.id !== this.id) return false; this.render(previous.root); return true; }
  private render(root: Root) { const p = this.props(); root.render(<EmbedCard block={this.block} context={p.context} stamp={this.stamp} onChange={this.change} onExport={p.onExport} />); }
  destroy(dom: HTMLElement) { const root = embedRoots.get(dom)?.root; embedRoots.delete(dom); queueMicrotask(() => root?.unmount()); }
  ignoreEvent() { return true; }
}
interface MenuItem { label: string; detail: string; keywords: string; insert?: string; kind?: EmbedKind; agent?: AgentMode }
const agents: MenuItem[] = [
  { label: '@ask · 提问', detail: '针对段落提问', keywords: 'ask agent 提问', insert: '@ask ', agent: 'ask' },
  { label: '@writer · 改写', detail: '生成待审阅修改', keywords: 'writer rewrite 改写', insert: '@writer ', agent: 'rewrite' },
];
const blocks: MenuItem[] = [
  { label: '标题', detail: '二级标题', keywords: 'heading title 标题', insert: '## ' },
  { label: '列表', detail: '无序列表', keywords: 'list bullet 列表', insert: '- ' },
  { label: '任务列表', detail: '可勾选任务', keywords: 'task todo checklist 任务', insert: '- [ ] ' },
  { label: '引用', detail: '引用段落', keywords: 'quote 引用', insert: '> ' },
  { label: '代码块', detail: '原样代码', keywords: 'code 代码', insert: '```text\n\n```\n' },
  { label: 'Chart', detail: '可编辑图表', keywords: 'chart charts 图表', kind: 'charts' },
  { label: 'Mermaid', detail: '语法驱动图形', keywords: 'mermaid 流程图', kind: 'mermaid' },
  { label: 'Excalidraw', detail: '真实手绘画布', keywords: 'excalidraw sketch 手绘', kind: 'excalidraw' },
  { label: 'draw.io', detail: '完整本地图形编辑器', keywords: 'drawio draw.io 图形', kind: 'drawio' },
];
interface Menu { from: number; to: number; text: string; type: '@' | '/'; items: MenuItem[]; index: number }
class MenuWidget extends WidgetType {
  constructor(private menu: Menu, private pick: (item: MenuItem) => void) { super(); }
  eq(other: MenuWidget) { return this.menu.text === other.menu.text && this.menu.from === other.menu.from && this.menu.index === other.menu.index; }
  toDOM() {
    const dom = document.createElement('span'); dom.className = `document-menu ${this.menu.type === '@' ? 'mention-menu' : 'slash-menu'}`; dom.setAttribute('role', 'listbox'); dom.setAttribute('aria-label', this.menu.type === '@' ? '选择 Agent' : '插入文档块');
    const heading = document.createElement('span'); heading.className = 'menu-caption'; heading.textContent = `${this.menu.type === '@' ? '委派给' : '插入'} · ↑↓ 选择 · Enter 确认`; dom.append(heading);
    this.menu.items.forEach((item, index) => { const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-selected', String(index === this.menu.index)); button.className = index === this.menu.index ? 'menu-selected' : ''; const title = document.createElement('strong'), detail = document.createElement('small'); title.textContent = item.label; detail.textContent = item.detail; button.append(title, detail); button.onmousedown = event => event.preventDefault(); button.onclick = () => this.pick(item); dom.append(button); });
    return dom;
  }
  ignoreEvent() { return true; }
}
class CardWidget extends WidgetType {
  constructor(private node: HTMLElement) { super(); }
  eq(other: CardWidget) { return this.node === other.node; }
  toDOM() { return this.node; }
  ignoreEvent() { return true; }
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const container = useRef<HTMLDivElement>(null), view = useRef<EditorView>(), latest = useRef(props); latest.current = props;
  const [toolbar, setToolbar] = useState<{ left: number; top: number }>(), [linkOpen, setLinkOpen] = useState(false), [href, setHref] = useState('');
  useImperativeHandle(ref, () => ({
    text: () => view.current!.state.doc.toString(),
    selection: () => { const s = view.current!.state.selection.main; return { from: s.from, to: s.to }; },
    target: () => {
      const state = view.current!.state, selection = state.selection.main, text = state.doc.toString();
      if (!selection.empty) return { from: selection.from, to: selection.to };
      const current = paragraphRange(text, selection.head);
      if (!text.slice(current.from, current.to).trim() && current.from > 0) return paragraphRange(text, Math.max(0, current.from - 3));
      return current;
    },
    replace: text => { const editor = view.current!; if (editor.state.doc.toString() !== text) editor.dispatch({ changes: smallestChange(editor.state.doc.toString(), text), annotations: remoteUpdate.of(true) }); },
    select: (from, to) => { const editor = view.current!; editor.dispatch({ selection: { anchor: Math.min(from, editor.state.doc.length), head: Math.min(to, editor.state.doc.length) }, scrollIntoView: true }); editor.focus(); },
    insert: text => { const editor = view.current!, s = editor.state.selection.main; editor.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length } }); editor.focus(); },
    focus: () => view.current?.focus(),
  }));
  useEffect(() => {
    let card: Card | undefined, identities: EmbedIdentity[] = [], menu: Menu | undefined, dismissed = '';
    const pick = (item: MenuItem) => {
      const editor = view.current!; if (!menu || editor.state.doc.sliceString(menu.from, menu.to) !== menu.text) return;
      const { from, to } = menu;
      if (item.kind) { latest.current.onInsertEmbed?.(item.kind, { from, to }); return; }
      const insert = item.insert!;
      editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + (item.label === '代码块' ? 8 : insert.length) } }); editor.focus();
    };
    const build = (state: EditorState): DecorationSet => {
      const text = state.doc.toString(), embeds = findEmbedBlocks(text), selection = state.selection.main;
      identities = embeds.map(block => ({ id: identities.find(previous => previous.block.from === block.from && previous.block.kind === block.kind)?.id ?? crypto.randomUUID(), block }));
      const decorations = richDecorations(state, embeds, () => view.current!, latest.current.context.document.resourceUrls);
      for (const entry of identities) {
        const change = (source: string, expected: string) => {
          const editor = view.current!, current = identities.find(item => item.id === entry.id)?.block;
          if (!current || editor.state.doc.sliceString(current.contentFrom, current.contentTo) !== expected) throw new Error('图形源码已变化，拒绝覆盖；草稿仍保留。');
          editor.dispatch({ changes: { from: current.contentFrom, to: current.contentTo, insert: source } });
        };
        decorations.push(Decoration.replace({ widget: new EmbedWidget(entry.id, entry.block, () => latest.current, change, `${latest.current.resourceStamp ?? ''}:${latest.current.context.trusted}`), block: true, ...{ atomic: true } }).range(entry.block.from, entry.block.to));
      }
      const line = state.doc.lineAt(selection.head), match = /^\s*([@/])([^\s]*)$/.exec(line.text);
      let node = parseMarkdown(text).resolveInner(selection.head, -1), code = false;
      for (; node; node = node.parent!) if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) { code = true; break; }
      if (match && selection.empty && !code && dismissed !== `${line.from}:${line.text}`) {
        const items = (match[1] === '@' ? agents : blocks).filter(item => item.keywords.toLowerCase().includes(match[2].toLowerCase()));
        const index = menu?.text === line.text ? Math.min(menu.index, items.length - 1) : 0;
        menu = items.length ? { from: line.from, to: line.to, text: line.text, type: match[1] as '@' | '/', items, index } : undefined;
        if (menu) decorations.push(Decoration.widget({ widget: new MenuWidget(menu, pick), side: 1 }).range(line.to));
      } else menu = undefined;
      if (card) {
        let pos = state.doc.lineAt(Math.min(card.to, state.doc.length)).to;
        const embed = embeds.find(block => pos > block.from && pos < block.to); if (embed) pos = embed.to;
        decorations.push(Decoration.widget({ widget: new CardWidget(card.node), block: true, side: 1 }).range(pos));
      }
      return Decoration.set(decorations, true);
    };
    const field = StateField.define<DecorationSet>({
      create: state => build(state), update: (value, transaction) => {
        for (const effect of transaction.effects) if (effect.is(setCard)) card = effect.value;
        if (transaction.docChanged) {
          if (card) card = { ...card, from: transaction.changes.mapPos(card.from), to: transaction.changes.mapPos(card.to) };
          identities = identities.map(entry => ({ ...entry, block: { ...entry.block, from: transaction.changes.mapPos(entry.block.from, 1) } }));
        }
        return transaction.docChanged || transaction.selection || transaction.effects.length ? build(transaction.state) : value;
      }, provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field).update({ filter: (_from, _to, value) => value.spec.atomic === true }))],
    });
    const native = (command: 'save' | 'undo' | 'redo') => { latest.current.onNative(command); return true; };
    const move = (delta: number) => { if (!menu) return false; menu = { ...menu, index: (menu.index + delta + menu.items.length) % menu.items.length }; view.current!.dispatch({ effects: refresh.of(undefined) }); return true; };
    const submitCommand = () => {
      const editor = view.current!, text = editor.state.doc.toString(), line = editor.state.doc.lineAt(editor.state.selection.main.head), command = /^\s*@(ask|writer)\s+(.+)$/.exec(line.text);
      if (!command) return false;
      let node = parseMarkdown(text).resolveInner(line.from, 1);
      for (; node; node = node.parent!) if (['FencedCode', 'CodeBlock'].includes(node.name)) return false;
      const before = text.slice(0, line.from).trimEnd(), range = before ? paragraphRange(text, before.length - 1) : { from: 0, to: 0 };
      latest.current.onAgent(command[1] === 'ask' ? 'ask' : 'rewrite', { prompt: command[2], range }); return true;
    };
    const editor = new EditorView({ parent: container.current!, state: EditorState.create({ doc: props.initialText, extensions: [markdown({ extensions: GFM }), EditorView.lineWrapping, field,
      keymap.of([{ key: 'ArrowDown', run: () => move(1) }, { key: 'ArrowUp', run: () => move(-1) }, { key: 'Enter', run: () => { if (!menu) return false; pick(menu.items[menu.index]); return true; } }, { key: 'Escape', run: () => { if (!menu) return false; dismissed = `${menu.from}:${menu.text}`; menu = undefined; view.current!.dispatch({ effects: refresh.of(undefined) }); return true; } },
        { key: 'Mod-Enter', run: submitCommand }, { key: 'Mod-b', run: view => { formatSelection(view, 'bold'); return true; } }, { key: 'Mod-i', run: view => { formatSelection(view, 'italic'); return true; } },
        { key: 'Mod-s', run: () => native('save') }, { key: 'Mod-z', run: () => native('undo') }, { key: 'Mod-Shift-z', run: () => native('redo') }, { key: 'Mod-y', run: () => native('redo') }, ...defaultKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        scroll: () => { setToolbar(undefined); return false; },
        beforeinput: event => { if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); return native(event.inputType === 'historyUndo' ? 'undo' : 'redo'); } return false; },
        paste: event => { const file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); latest.current.onImage(file); return true; } return false; },
        drop: event => { const file = [...(event.dataTransfer?.files ?? [])].find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); latest.current.onImage(file); return true; } return false; },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(remoteUpdate))) latest.current.onChange(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main;
          if (selection.empty || findEmbedBlocks(update.state.doc.toString()).some(block => selection.from < block.to && selection.to > block.from)) setToolbar(undefined);
          else editor.requestMeasure({ read: view => view.coordsAtPos(selection.from), write: rect => setToolbar({ left: Math.max(8, Math.min(rect?.left ?? 20, window.innerWidth - 520)), top: Math.max(72, (rect?.top ?? 120) - 48) }) });
        }
      }),
    ] }) });
    view.current = editor; return () => { editor.destroy(); view.current = undefined; };
  }, []);
  useEffect(() => { view.current?.dispatch({ effects: refresh.of(undefined) }); }, [props.resourceStamp, props.context.trusted]);
  useEffect(() => { view.current?.dispatch({ effects: setCard.of(props.card) }); }, [props.card]);
  const format = (action: FormatAction) => { if (view.current) formatSelection(view.current, action, href); setLinkOpen(false); };
  return <div className="markdown-editor" data-testid="markdown-editor"><div ref={container} />{toolbar && <div className="selection-toolbar" role="toolbar" aria-label="选区格式与 AI" style={{ left: toolbar.left, top: toolbar.top }} onMouseDown={event => { if (!(event.target as Element).closest('input')) event.preventDefault(); }}>
    <button onClick={() => latest.current.onAgent('rewrite')}>AI 改写</button><button onClick={() => latest.current.onAgent('ask')}>提问</button><button aria-label="加粗" onClick={() => format('bold')}><b>B</b></button><button aria-label="斜体" onClick={() => format('italic')}><i>I</i></button><button onClick={() => format('heading')}>标题</button><button onClick={() => format('code')}>代码</button><button onClick={() => setLinkOpen(!linkOpen)}>链接</button>
    {linkOpen && <label>链接地址<input aria-label="链接地址" value={href} onChange={event => setHref(event.target.value)} /><button onClick={() => format('link')}>插入链接</button></label>}
  </div>}</div>;
});
