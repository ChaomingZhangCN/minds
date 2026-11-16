import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Annotation, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { chartSchema, findEmbedBlocks, parseJson, resourceEmbedSchema, type EmbedBlock } from '../shared/embeds';
import { paragraphRange } from '../shared/text';
import type { AgentMode, ClientContext } from '../shared/types';
import { ChartBlock } from './components/ChartBlock';
import { DiagramPreview } from './components/DiagramPreview';

const remoteUpdate = Annotation.define<boolean>();
interface Card { from: number; to: number; node: HTMLElement }
const refresh = StateEffect.define<undefined>();
const setCard = StateEffect.define<Card | undefined>();
export interface MarkdownEditorHandle {
  text(): string;
  selection(): { from: number; to: number };
  target(): { from: number; to: number };
  replace(text: string): void;
  select(from: number, to: number): void;
  insert(text: string): void;
  focus(): void;
}
interface Props {
  initialText: string;
  context: ClientContext;
  resourceStamp?: string;
  card?: Card;
  onChange(text: string): void;
  onAgent(mode: AgentMode): void;
  onEditEmbed(block: EmbedBlock): void;
  onExport(svg: string): void;
  onNative(command: 'save' | 'undo' | 'redo'): void;
  onImage(file: File): void;
}
class StaticWidget extends WidgetType {
  constructor(private html: string, private position: number, private edit: () => void) { super(); }
  eq(other: StaticWidget): boolean { return this.html === other.html && this.position === other.position; }
  toDOM(): HTMLElement {
    const dom = document.createElement('div'); dom.className = 'minds-rendered'; dom.innerHTML = this.html;
    dom.addEventListener('dblclick', this.edit); return dom;
  }
  ignoreEvent(event: Event): boolean { return event.type !== 'dblclick'; }
}
const embedRoots = new WeakMap<HTMLElement, { root: Root; kind: string; from: number }>();
class EmbedWidget extends WidgetType {
  private root?: Root;
  constructor(private block: EmbedBlock, private props: () => Props, private view: () => EditorView, private stamp: string) { super(); }
  eq(other: EmbedWidget): boolean { return this.block.kind === other.block.kind && this.block.from === other.block.from && this.block.contentFrom === other.block.contentFrom && this.block.contentTo === other.block.contentTo && this.block.content === other.block.content && this.stamp === other.stamp; }
  toDOM(): HTMLElement {
    const dom = document.createElement('div'); dom.className = 'minds-embed-widget'; this.root = createRoot(dom);
    embedRoots.set(dom, { root: this.root, kind: this.block.kind, from: this.block.from }); this.render(); return dom;
  }
  updateDOM(dom: HTMLElement): boolean {
    const previous = embedRoots.get(dom);
    if (!previous || previous.kind !== this.block.kind || previous.from !== this.block.from) return false;
    this.root = previous.root; this.render(); return true;
  }
  private render(): void {
    const block = this.block, config = parseJson(block.content), p = this.props();
    const editSource = () => { const view = this.view(); view.dispatch({ selection: { anchor: block.contentFrom }, scrollIntoView: true }); view.focus(); };
    if (block.kind === 'charts') {
      const spec = chartSchema.safeParse(config);
      this.root!.render(spec.success ? <div><ChartBlock spec={spec.data} onChange={next => this.view().dispatch({ changes: { from: block.contentFrom, to: block.contentTo, insert: JSON.stringify(next, null, 2) + '\n' } })} onExport={p.onExport} /><button onClick={editSource}>Charts 源码</button></div> : <div className="embed-error">Charts 配置无效<button onClick={editSource}>编辑源码</button></div>);
    } else {
      const resource = resourceEmbedSchema.safeParse(config);
      this.root!.render(resource.success ? <DiagramPreview kind={block.kind} src={resource.data.src} context={p.context} resourceStamp={this.stamp} onEdit={() => this.props().onEditEmbed(block)} onSource={editSource} /> : <div className="embed-error">图形引用配置无效<button onClick={editSource}>编辑源码</button></div>);
    }
  }
  destroy(dom: HTMLElement): void { const root = embedRoots.get(dom)?.root; embedRoots.delete(dom); queueMicrotask(() => root?.unmount()); }
  ignoreEvent(): boolean { return true; }
}
class MentionWidget extends WidgetType {
  constructor(private pick: (mode: AgentMode) => void) { super(); }
  toDOM(): HTMLElement {
    const menu = document.createElement('span'); menu.className = 'mention-menu'; menu.contentEditable = 'false';
    for (const [mode, label] of [['ask', '@ask · 提问'], ['rewrite', '@writer · 改写']] as const) {
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = () => this.pick(mode); menu.append(button);
    }
    return menu;
  }
  ignoreEvent(): boolean { return true; }
}
class CardWidget extends WidgetType {
  constructor(private node: HTMLElement) { super(); }
  eq(other: CardWidget): boolean { return this.node === other.node; }
  toDOM(): HTMLElement { return this.node; }
  ignoreEvent(): boolean { return true; }
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const container = useRef<HTMLDivElement>(null), view = useRef<EditorView>();
  const latest = useRef(props); latest.current = props;
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
    replace: text => { const editor = view.current!; if (editor.state.doc.toString() !== text) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, annotations: remoteUpdate.of(true) }); },
    select: (from, to) => { const editor = view.current!; editor.dispatch({ selection: { anchor: Math.min(from, editor.state.doc.length), head: Math.min(to, editor.state.doc.length) }, scrollIntoView: true }); editor.focus(); },
    insert: text => { const editor = view.current!; const s = editor.state.selection.main; editor.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length } }); editor.focus(); },
    focus: () => view.current?.focus(),
  }));
  useEffect(() => {
    let card: Card | undefined;
    const buildDecorations = (state: EditorState): DecorationSet => {
      const text = state.doc.toString(), selection = state.selection.main;
      const activeLine = state.doc.lineAt(selection.head);
      const md = new MarkdownIt({ html: false, linkify: false });
      md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => { tokens[index].attrSet('href', ''); return renderer.renderToken(tokens, index, options); };
      md.renderer.rules.image = (tokens, index) => {
        const src = tokens[index].attrGet('src') ?? '', url = latest.current.context.document.resourceUrls[src];
        if (!url) return '<span class="missing-image">[图片未加载：外链、无效或未授权资源]</span>';
        return `<img src="${md.utils.escapeHtml(url)}" alt="${md.utils.escapeHtml(tokens[index].content)}">`;
      };
      const offsets = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
      const tokens = md.parse(text, {}), embeds = findEmbedBlocks(text), decorations: ReturnType<Decoration['range']>[] = [];
      for (const token of tokens) {
        if (token.level !== 0 || !token.map || token.nesting === -1) continue;
        const from = offsets[token.map[0]], to = offsets[token.map[1]] ?? text.length;
        if (from === undefined || to <= from || (from <= activeLine.to && to > activeLine.from) || (!selection.empty && from < selection.to && to > selection.from)) continue;
        if (card && from <= card.to && to > card.from) continue;
        const embed = embeds.find(block => block.from === from);
        if (embed) decorations.push(Decoration.replace({ widget: new EmbedWidget(embed, () => latest.current, () => view.current!, latest.current.resourceStamp ?? ''), block: true }).range(from, to));
        else {
          const html = DOMPurify.sanitize(md.render(text.slice(from, to)), { FORBID_TAGS: ['script', 'iframe', 'object', 'style', 'form'], FORBID_ATTR: ['style', 'srcset', 'href'], ALLOW_DATA_ATTR: false });
          decorations.push(Decoration.replace({ widget: new StaticWidget(html, from, () => { view.current!.dispatch({ selection: { anchor: from }, scrollIntoView: true }); view.current!.focus(); }), block: true }).range(from, to));
        }
      }
      const mention = /^\s*@(a(?:s(?:k)?)?|w(?:r(?:i(?:t(?:e(?:r)?)?)?)?)?)?\s*$/.test(activeLine.text);
      const code = tokens.some(token => ['fence', 'code_block'].includes(token.type) && token.map && activeLine.number - 1 >= token.map[0] && activeLine.number - 1 < token.map[1]);
      if (mention && !code && selection.empty) decorations.push(Decoration.widget({ widget: new MentionWidget(mode => {
        const editor = view.current!;
        if (editor.state.doc.lineAt(Math.min(activeLine.from, editor.state.doc.length)).text !== activeLine.text) return;
        editor.dispatch({ changes: { from: activeLine.from, to: activeLine.to, insert: '' } });
        queueMicrotask(() => latest.current.onAgent(mode));
      }), side: 1 }).range(activeLine.to));
      if (card) {
        const pos = state.doc.lineAt(Math.min(card.to, state.doc.length)).to;
        decorations.push(Decoration.widget({ widget: new CardWidget(card.node), block: true, side: 1 }).range(pos));
      }
      return Decoration.set(decorations, true);
    };
    const field = StateField.define<DecorationSet>({
      create: state => buildDecorations(state),
      update: (value, transaction) => {
        for (const effect of transaction.effects) if (effect.is(setCard)) card = effect.value;
        if (card && transaction.docChanged) card = { ...card, from: transaction.changes.mapPos(card.from), to: transaction.changes.mapPos(card.to) };
        return transaction.docChanged || transaction.selection || transaction.effects.length ? buildDecorations(transaction.state) : value;
      }, provide: field => EditorView.decorations.from(field),
    });
    const native = (command: 'save' | 'undo' | 'redo') => { latest.current.onNative(command); return true; };
    const editor = new EditorView({ parent: container.current!, state: EditorState.create({ doc: props.initialText, extensions: [markdown(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, field,
      keymap.of([{ key: 'Mod-s', run: () => native('save') }, { key: 'Mod-z', run: () => native('undo') }, { key: 'Mod-Shift-z', run: () => native('redo') }, { key: 'Mod-y', run: () => native('redo') }, ...defaultKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        beforeinput: event => { if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); return native(event.inputType === 'historyUndo' ? 'undo' : 'redo'); } return false; },
        paste: event => { const file = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); latest.current.onImage(file); return true; } return false; },
        drop: event => { const file = [...(event.dataTransfer?.files ?? [])].find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); latest.current.onImage(file); return true; } return false; },
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || update.transactions.some(transaction => transaction.annotation(remoteUpdate))) return;
        latest.current.onChange(update.state.doc.toString());
        // A mention only offers choices. It never removes source, changes the
        // selection, or calls a provider until the user explicitly picks one.
      }),
    ] }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, []);
  useEffect(() => { view.current?.dispatch({ effects: refresh.of(undefined) }); }, [props.resourceStamp]);
  useEffect(() => { view.current?.dispatch({ effects: setCard.of(props.card) }); }, [props.card]);
  return <div className="markdown-editor" data-testid="markdown-editor" ref={container} />;
});
