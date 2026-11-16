import { parser, GFM } from '@lezer/markdown';
import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { EmbedBlock } from '../shared/embeds';

const markdownParser = parser.configure(GFM);
export const parseMarkdown = (text: string) => markdownParser.parse(text);
export type FormatAction = 'bold' | 'italic' | 'code' | 'heading' | 'link';

/** Every formatting command changes only the selected range or its markers. */
export function formatSelection(view: EditorView, action: FormatAction, href?: string): void {
  const state = view.state, selection = state.selection.main, text = state.doc.toString();
  let { from, to } = selection;
  if (action === 'heading') {
    const line = state.doc.lineAt(from), prefix = /^#{1,6}\s+/.exec(line.text)?.[0] ?? '';
    const insert = prefix ? '' : '## ';
    view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert }, selection: { anchor: Math.max(line.from + insert.length, from + insert.length - prefix.length), head: Math.max(line.from + insert.length, to + insert.length - prefix.length) } });
  } else if (action === 'link') {
    if (!href || !/^(?:https?:\/\/|mailto:|#)/i.test(href) || /[\s()<>\\]/.test(href)) return;
    const label = text.slice(from, to) || '链接', insert = `[${label}](${href})`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + 1, head: from + 1 + label.length } });
  } else {
    const marker = { bold: '**', italic: '*', code: '`' }[action], value = text.slice(from, to);
    if (text.slice(Math.max(0, from - marker.length), from) === marker && text.slice(to, to + marker.length) === marker) {
      from -= marker.length; to += marker.length;
      view.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from, head: from + value.length } });
    } else {
      const insert = marker + value + marker;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + marker.length, head: from + marker.length + value.length } });
    }
  }
  view.focus();
}
class BulletWidget extends WidgetType {
  constructor(private value: string) { super(); }
  eq(other: BulletWidget) { return this.value === other.value; }
  toDOM() { const node = document.createElement('span'); node.className = 'rich-bullet'; node.textContent = this.value; return node; }
  ignoreEvent() { return false; }
}
class TaskWidget extends WidgetType {
  constructor(private from: number, private checked: boolean, private view: () => EditorView) { super(); }
  eq(other: TaskWidget) { return this.from === other.from && this.checked === other.checked; }
  toDOM() {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked; input.className = 'rich-task'; input.setAttribute('aria-label', '切换任务完成状态');
    input.onchange = () => { const view = this.view(), current = view.state.doc.sliceString(this.from, this.from + 3); if (!/^\[[ xX]\]$/.test(current)) return; view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: input.checked ? '[x]' : '[ ]' } }); };
    return input;
  }
  ignoreEvent() { return true; }
}
class ImageWidget extends WidgetType {
  constructor(private url: string | undefined, private alt: string) { super(); }
  eq(other: ImageWidget) { return this.url === other.url && this.alt === other.alt; }
  toDOM() {
    if (!this.url) { const span = document.createElement('span'); span.className = 'missing-image'; span.textContent = `[图片未加载：${this.alt}]`; return span; }
    const image = document.createElement('img'); image.src = this.url; image.alt = this.alt; image.className = 'rich-image'; return image;
  }
  ignoreEvent() { return false; }
}

export function richDecorations(state: EditorState, embeds: EmbedBlock[], view: () => EditorView, urls: Record<string, string>): ReturnType<Decoration['range']>[] {
  const text = state.doc.toString(), ranges: ReturnType<Decoration['range']>[] = [], lines = new Map<number, Set<string>>();
  const lineClass = (from: number, to: number, name: string) => {
    for (let pos = from; pos <= to;) { const line = state.doc.lineAt(pos); const classes = lines.get(line.from) ?? new Set<string>(); classes.add(name); lines.set(line.from, classes); if (line.to >= to || line.to === state.doc.length) break; pos = line.to + 1; }
  };
  const hide = (from: number, to: number, widget?: WidgetType) => { if (to > from) ranges.push(Decoration.replace({ widget, ...{ atomic: true } }).range(from, to)); };
  parseMarkdown(text).iterate({ enter(node) {
    if (embeds.some(block => node.from >= block.from && node.to <= block.to)) return false;
    const name = node.name;
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(name)) lineClass(node.from, node.to, `rich-heading rich-h${name.at(-1)}`);
    if (name === 'Blockquote') lineClass(node.from, node.to, 'rich-quote');
    if (name === 'ListItem') lineClass(node.from, node.to, 'rich-list-item');
    if (name === 'FencedCode' || name === 'CodeBlock') { lineClass(node.from, node.to, 'rich-code-block'); return false; }
    if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'InlineCode' || name === 'Strikethrough') ranges.push(Decoration.mark({ class: ({ StrongEmphasis: 'rich-bold', Emphasis: 'rich-italic', InlineCode: 'rich-inline-code', Strikethrough: 'rich-strike' })[name] }).range(node.from, node.to));
    if (name === 'HeaderMark' || name === 'QuoteMark') {
      const line = state.doc.lineAt(node.from); let to = node.to;
      if (text[to] === ' ' && to < line.to) to++;
      hide(node.from, to);
    }
    if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') hide(node.from, node.to);
    if (name === 'ListMark') {
      const marker = text.slice(node.from, node.to), line = state.doc.lineAt(node.from), rest = text.slice(node.to, line.to);
      if (/^\s*\[[ xX]\]/.test(rest)) hide(node.from, node.to + (text[node.to] === ' ' ? 1 : 0));
      else hide(node.from, node.to + (text[node.to] === ' ' ? 1 : 0), new BulletWidget(/^\d/.test(marker) ? marker : '•'));
    }
    if (name === 'TaskMarker') hide(node.from, node.to, new TaskWidget(node.from, /x/i.test(text.slice(node.from, node.to)), view));
    if (name === 'Link') {
      const marks = node.node.getChildren('LinkMark');
      if (marks.length >= 4) {
        hide(marks[0].from, marks[0].to); hide(marks[1].from, node.to);
        ranges.push(Decoration.mark({ class: 'rich-link' }).range(marks[0].to, marks[1].from)); return false;
      }
    }
    if (name === 'Image') {
      const raw = text.slice(node.from, node.to), match = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)$/.exec(raw);
      if (match) { hide(node.from, node.to, new ImageWidget(urls[match[2]], match[1])); return false; }
    }
  } });
  for (const [from, classes] of lines) ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  return ranges;
}
