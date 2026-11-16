import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { z } from 'zod';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ImportedDataState } from '@excalidraw/excalidraw/data/types';
import '@excalidraw/excalidraw/index.css';
import { useVSCodeTheme } from './ChartBlock';
import './diagrams.css';

export const EXCALIDRAW_LIMITS = { sceneBytes: 8 * 1024 * 1024, elements: 5000, files: 100, fileBytes: 4 * 1024 * 1024, points: 100000 } as const;
const finite = z.number().finite().min(-1000000).max(1000000);
const colorSchema = z.string().max(100).regex(/^(?:transparent|#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i, '颜色必须是普通颜色值，不能包含 URL 或 CSS 表达式');
const idSchema = z.string().min(1).max(200);
const pointSchema = z.tuple([finite, finite]);
const bindingSchema = z.object({ elementId: idSchema, focus: finite.min(-1).max(1), gap: finite.nonnegative(), fixedPoint: pointSchema.optional() }).nullable();
const arrowheadSchema = z.enum(['arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']).nullable();
const elementSchema = z.object({
  id: idSchema,
  type: z.enum(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame']),
  x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative(),
  angle: finite.optional(), strokeColor: colorSchema.optional(), backgroundColor: colorSchema.optional(),
  fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']).optional(),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(), strokeWidth: z.number().finite().min(0).max(100).optional(),
  roughness: z.number().finite().min(0).max(10).optional(), opacity: z.number().finite().min(0).max(100).optional(),
  isDeleted: z.boolean().optional(), seed: z.number().int().optional(), version: z.number().int().nonnegative().optional(), versionNonce: z.number().int().optional(), updated: z.number().finite().nonnegative().optional(),
  index: z.string().max(200).nullable().optional(), locked: z.boolean().optional(),
  groupIds: z.array(idSchema).max(100).optional(), frameId: idSchema.nullable().optional(),
  boundElements: z.array(z.object({ id: idSchema, type: z.enum(['arrow', 'text']) })).max(5000).nullable().optional(),
  roundness: z.object({ type: z.number().int().min(1).max(3), value: z.number().finite().nonnegative().optional() }).nullable().optional(),
  link: z.string().max(2048).nullable().optional(),
  points: z.array(pointSchema).max(EXCALIDRAW_LIMITS.points).optional(),
  pressures: z.array(z.number().finite().min(0).max(1)).max(EXCALIDRAW_LIMITS.points).optional(),
  simulatePressure: z.boolean().optional(), lastCommittedPoint: pointSchema.nullable().optional(),
  startBinding: bindingSchema.optional(), endBinding: bindingSchema.optional(),
  startArrowhead: arrowheadSchema.optional(), endArrowhead: arrowheadSchema.optional(),
  elbowed: z.boolean().optional(), fixedSegments: z.array(z.object({ start: pointSchema, end: pointSchema, index: z.number().int().nonnegative().max(EXCALIDRAW_LIMITS.points) })).max(EXCALIDRAW_LIMITS.points).nullable().optional(),
  startIsSpecial: z.boolean().nullable().optional(), endIsSpecial: z.boolean().nullable().optional(),
  text: z.string().max(100000).optional(), originalText: z.string().max(100000).optional(),
  fontSize: z.number().finite().min(1).max(1000).optional(), fontFamily: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9)]).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  containerId: idSchema.nullable().optional(), autoResize: z.boolean().optional(), lineHeight: z.number().finite().min(0.1).max(10).optional(),
  fileId: idSchema.nullable().optional(), status: z.enum(['pending', 'saved', 'error']).optional(),
  scale: z.tuple([z.union([z.literal(-1), z.literal(1)]), z.union([z.literal(-1), z.literal(1)])]).optional(),
  crop: z.object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative(), naturalWidth: finite.positive(), naturalHeight: finite.positive() }).nullable().optional(),
  name: z.string().max(1000).nullable().optional(),
}).passthrough().superRefine((element, ctx) => {
  if (element.type === 'text' && (typeof element.text !== 'string' || element.fontSize == null || element.fontFamily == null)) ctx.addIssue({ code: 'custom', message: '文本元素必须提供 text、fontSize、fontFamily' });
  if (['line', 'arrow', 'freedraw'].includes(element.type) && (!element.points || element.points.length < 2)) ctx.addIssue({ code: 'custom', message: '线条元素必须包含至少两个合法 points' });
  if (element.type === 'freedraw' && element.pressures && element.pressures.length !== element.points?.length) ctx.addIssue({ code: 'custom', message: '自由线条 pressures 与 points 数量不一致' });
  if (element.link && !/^(?:https?:\/\/|mailto:|#)/i.test(element.link)) ctx.addIssue({ code: 'custom', message: '不支持的元素链接协议' });
});
const fileSchema = z.object({
  id: idSchema, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataURL: z.string().max(Math.ceil(EXCALIDRAW_LIMITS.fileBytes * 4 / 3) + 100),
  created: z.number().finite().nonnegative(), lastRetrieved: z.number().finite().nonnegative().optional(), version: z.number().finite().nonnegative().optional(),
}).strict().superRefine((file, ctx) => {
  const prefix = `data:${file.mimeType};base64,`;
  const payload = file.dataURL.slice(prefix.length);
  if (!file.dataURL.startsWith(prefix) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload) || !payload) {
    ctx.addIssue({ code: 'custom', message: '图片只允许嵌入的 base64 PNG/JPEG/WebP/GIF；拒绝远程 URL、SVG 与外部资源' });
    return;
  }
  const size = payload.length * 3 / 4 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (size > EXCALIDRAW_LIMITS.fileBytes) ctx.addIssue({ code: 'custom', message: '单张图片超过 4 MiB' });
  // Check the binary signature as well as the declared MIME type; no disguised SVG/XML payloads.
  const header = typeof atob === 'function' ? atob(payload.slice(0, 24)) : '';
  const valid = file.mimeType === 'image/png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : file.mimeType === 'image/jpeg' ? header.startsWith('\xff\xd8\xff')
    : file.mimeType === 'image/gif' ? /^GIF8[79]a/.test(header)
    : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!valid) ctx.addIssue({ code: 'custom', message: '图片内容与声明的 MIME 类型不符' });
});
const appStateSchema = z.object({
  viewBackgroundColor: colorSchema.optional(), name: z.string().max(1000).optional(),
  exportBackground: z.boolean().optional(), exportWithDarkMode: z.boolean().optional(), exportEmbedScene: z.boolean().optional(),
  gridSize: z.number().finite().min(1).max(1000).nullable().optional().transform(value => value ?? undefined), gridStep: z.number().finite().min(1).max(1000).optional(),
});
const sceneSchema = z.object({ type: z.literal('excalidraw'), version: z.literal(2), source: z.string().max(2048).optional(), elements: z.array(elementSchema).max(EXCALIDRAW_LIMITS.elements), appState: appStateSchema.nullish(), files: z.record(fileSchema).optional() }).strict();

function checkJsonTree(value: unknown, depth = 0): void {
  if (depth > 40) throw new Error('场景 JSON 嵌套过深。');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('场景不能包含非有限数值。');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('场景包含不安全的对象键。');
    checkJsonTree(child, depth + 1);
  }
}

/** Validate before restore/export/load, so imported scenes cannot initiate image or iframe requests. */
export function parseExcalidrawScene(content: string): ImportedDataState {
  if (content.length > EXCALIDRAW_LIMITS.sceneBytes || new TextEncoder().encode(content).byteLength > EXCALIDRAW_LIMITS.sceneBytes) throw new Error('Excalidraw 场景超过 8 MiB。');
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('Excalidraw 场景不是合法 JSON。'); }
  checkJsonTree(value);
  const result = sceneSchema.safeParse(value);
  if (!result.success) throw new Error(`Excalidraw 场景无效：${result.error.issues.slice(0, 8).map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  const scene = result.data;
  const files = scene.files ?? {};
  if (Object.keys(files).length > EXCALIDRAW_LIMITS.files) throw new Error('场景最多支持 100 张本地嵌入图片。');
  for (const [key, file] of Object.entries(files)) if (key !== file.id) throw new Error('图片文件键与 id 不一致。');
  const ids = new Set<string>();
  let points = 0;
  for (const element of scene.elements) {
    if (ids.has(element.id)) throw new Error('场景包含重复元素 id。');
    ids.add(element.id);
    points += (element.points?.length ?? 0) + (element.fixedSegments?.length ?? 0) * 2;
    if (points > EXCALIDRAW_LIMITS.points) throw new Error('场景线条点总数超过 100000。');
    if (!element.isDeleted && element.type === 'image' && (!element.fileId || !files[element.fileId])) throw new Error('图片元素缺少对应的嵌入 files 数据。');
  }
  // App state is allowlisted; imported dialog/library/collaboration/fileHandle state is never restored.
  return { elements: scene.elements as unknown as ExcalidrawElement[], appState: scene.appState ?? {}, files: files as BinaryFiles };
}

export function normalizeExcalidrawAssetUrl(assetUrl: string, baseUrl = typeof window === 'undefined' ? 'http://localhost/' : window.location.href): string {
  let url: URL;
  try { url = new URL(assetUrl, baseUrl); } catch { throw new Error('无效的 Excalidraw 本地资产路径。'); }
  const local = ['vscode-webview:', 'vscode-resource:'].includes(url.protocol)
    || (url.protocol === 'https:' && url.hostname.endsWith('.vscode-cdn.net'))
    || (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  if (!assetUrl.trim() || !local || url.username || url.password || url.search || url.hash) throw new Error('Excalidraw 字体必须使用 Host 提供的本地 webview 资产路径。');
  return `${url.href.replace(/\/+$/, '')}/`;
}

type ExcalidrawSDK = typeof import('@excalidraw/excalidraw');
let sdkPromise: Promise<ExcalidrawSDK> | undefined;
async function loadSDK(assetUrl: string): Promise<ExcalidrawSDK> {
  if (typeof window === 'undefined') throw new Error('Excalidraw 渲染需要浏览器 DOM。');
  (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = normalizeExcalidrawAssetUrl(assetUrl);
  // 0.18.1 also includes a CDN font fallback internally. The Host's font-src/connect-src
  // CSP must allow only local webview resources, never esm.sh/esm.run, including on failure.
  sdkPromise ??= import('@excalidraw/excalidraw');
  return sdkPromise;
}

/** Sanitized XML for export; callers should display it as an img/blob, never raw scene HTML. */
export function sanitizeExcalidrawSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'], FORBID_TAGS: ['foreignObject', 'script', 'a', 'iframe'], FORBID_ATTR: ['onload', 'onclick', 'onerror'] });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('SVG 导出结果无效。');
  for (const element of doc.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name)) element.removeAttributeNode(attr);
      if (['href', 'xlink:href', 'src'].includes(attr.name) && !attr.value.startsWith('#') && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(attr.value)) element.removeAttributeNode(attr);
      if (/url\s*\(/i.test(attr.value) && !/^url\(#[\w.-]+\)$/.test(attr.value)) element.removeAttributeNode(attr);
      if (attr.name === 'style') element.removeAttributeNode(attr);
    }
    if (element.localName === 'style') {
      // Only SDK-generated inline font faces are retained. External CSS/URLs are not.
      const css = element.textContent ?? '';
      const withoutDataFonts = css.replace(/url\(["']?data:font\/woff2;base64,[A-Za-z0-9+/=]+["']?\)/g, '');
      if (/@import|url\s*\(|expression\s*\(|[<>]/i.test(withoutDataFonts)) element.remove();
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}

async function exportSceneSvg(scene: ImportedDataState, sdk: ExcalidrawSDK): Promise<string> {
  const elements = sdk.restoreElements(scene.elements, null, { repairBindings: true });
  const svg = await sdk.exportToSvg({ elements: sdk.getNonDeletedElements(elements), appState: { ...scene.appState, exportEmbedScene: false }, files: scene.files ?? {}, renderEmbeddables: false });
  return sanitizeExcalidrawSvg(svg.outerHTML);
}

export async function previewExcalidraw(content: string, assetUrl: string): Promise<string> {
  const scene = parseExcalidrawScene(content);
  return exportSceneSvg(scene, await loadSDK(assetUrl));
}

export const excalidrawUIOptions: NonNullable<ExcalidrawProps['UIOptions']> = {
  canvasActions: { export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false },
  tools: { image: false },
};

export interface ExcalidrawEditorProps {
  content: string;
  assetUrl: string;
  onSave: (content: string, svg?: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onExport?: (svg: string) => void;
  onDraft?: (content: string) => void;
}

export default function ExcalidrawEditor({ content, assetUrl, onSave, onCancel, onExport, onDraft }: ExcalidrawEditorProps) {
  const theme = useVSCodeTheme();
  const [sdk, setSDK] = useState<ExcalidrawSDK | null>(null);
  const [initialData, setInitialData] = useState<ImportedDataState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const original = useRef(content);
  const latestContent = useRef(content);
  latestContent.current = content;
  const saving = useRef(false), initialNative = useRef('');
  const draft = useRef<{ elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles } | null>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const root = useRef<HTMLElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    // Register before the lazy SDK mounts: its command palette listens on window
    // capture, so a React-only capture handler would run too late.
    const guard = (event: KeyboardEvent) => {
      if (!root.current?.contains(event.target as Node)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (['s', 'o', '/'].includes(key) || event.shiftKey && ['p', 'e'].includes(key))) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', guard, true);
    return () => window.removeEventListener('keydown', guard, true);
  }, []);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    async function initialize() {
      try {
        const scene = parseExcalidrawScene(original.current);
        const loaded = await loadSDK(assetUrl);
        if (cancelled) return;
        const elements = loaded.restoreElements(scene.elements, null, { repairBindings: true });
        draft.current = { elements, appState: scene.appState ?? {}, files: scene.files ?? {} };
        initialNative.current = loaded.serializeAsJSON(elements, scene.appState ?? {}, scene.files ?? {}, 'local');
        setInitialData({ ...scene, elements, scrollToContent: true }); setSDK(loaded);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    }
    void initialize();
    return () => { cancelled = true; alive.current = false; };
  }, [assetUrl]);
  useEffect(() => { if (content !== original.current) setConflict(true); }, [content]);

  async function finish(exportOnly = false) {
    if (!sdk || !draft.current || saving.current || busy || conflict || latestContent.current !== original.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      // Read from the imperative API so a just-finished pointer action is included in the save.
      const current = api.current ? { elements: api.current.getSceneElements(), appState: api.current.getAppState(), files: api.current.getFiles() } : draft.current;
      const native = sdk.serializeAsJSON(current.elements, current.appState, current.files, 'local');
      const scene = parseExcalidrawScene(native);
      const svg = (scene.elements?.some(element => !element.isDeleted) || exportOnly) ? await exportSceneSvg(scene, sdk) : undefined;
      if (!alive.current || latestContent.current !== original.current) return;
      if (exportOnly && svg) onExport?.(svg); else await onSave(native, svg);
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  }
  async function cancel() {
    if (saving.current || busy) return;
    saving.current = true; setBusy(true);
    try { await onCancel(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '取消失败；草稿仍保留，可重试'); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  }
  const Editor = sdk?.Excalidraw;
  const MainMenu = sdk?.MainMenu;
  const DefaultSidebar = sdk?.DefaultSidebar;
  return <section ref={root} className="minds-diagram minds-excalidraw" role="region" aria-label="Excalidraw 本地草稿编辑器" onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onClickCapture={event => {
    if ((event.target as Element).closest('a')) { event.preventDefault(); event.stopPropagation(); }
  }} onKeyDown={event => event.stopPropagation()} onKeyDownCapture={event => {
    // SDK's saveFileToDisk is not individually configurable in 0.18.1. Block native
    // open/save shortcuts before its canvas handler; our buttons route through the Host.
    if ((event.ctrlKey || event.metaKey) && ['s', 'o'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); }
  }} onDropCapture={event => { event.preventDefault(); event.stopPropagation(); setError('请通过文档资源操作打开本地图形；编辑器不接受原厂文件拖入或远程资源。'); }}>
    <header className="diagram-toolbar"><strong>Excalidraw · 本地草稿</strong><div className="diagram-actions">
      {onExport && <button type="button" disabled={busy || !sdk || conflict} onClick={() => void finish(true)}>导出 SVG</button>}
      <button type="button" disabled={busy || !sdk || conflict} onClick={() => void finish()}>保存图形</button>
      <button type="button" disabled={busy} onClick={() => void cancel()}>取消</button>
    </div></header>
    <p className="diagram-hint">保存才会通过文档 Host 写入原生 .excalidraw 文件；取消不写入。不连接云协作或在线图形库。</p>
    {conflict && <p role="alert" className="diagram-error">原始图形已变更；请取消并重新打开，避免覆盖其他修改。</p>}
    {error && <p role="alert" className="diagram-error">{error}</p>}
    {!sdk && !error && <p role="status">正在加载本地图形编辑器…</p>}
    <div className="excalidraw-canvas">
      {Editor && initialData && MainMenu && DefaultSidebar && <Editor initialData={initialData} excalidrawAPI={value => { api.current = value; }} theme={theme} UIOptions={excalidrawUIOptions}
        isCollaborating={false} aiEnabled={false} autoFocus={false} handleKeyboardGlobally={false} validateEmbeddable={false} renderEmbeddable={() => null}
        onLinkOpen={(_element, event) => { event.preventDefault(); }}
        onPaste={data => {
          try {
            if (data.files && Object.keys(data.files).length || data.mixedContent?.some(item => item.type === 'imageUrl') || data.spreadsheet) throw new Error('不接受图片 URL、原厂图片粘贴或自动生成图表；请使用本地文档资源。');
            if (data.elements) parseExcalidrawScene(JSON.stringify({ type: 'excalidraw', version: 2, elements: data.elements, files: {} }));
            return true;
          } catch (e) { setError((e as Error).message); return false; }
        }}
        onChange={(elements, appState, files) => {
          draft.current = { elements, appState, files };
          if (sdk && onDraft) { const native = sdk.serializeAsJSON(elements, appState, files, 'local'); if (native !== initialNative.current) onDraft(native); }
          if (appState.openSidebar?.tab === 'library') api.current?.updateScene({ appState: { openSidebar: null } });
          if (appState.openDialog && ['commandPalette', 'imageExport', 'export', 'ttd'].includes(appState.openDialog.name)) api.current?.updateScene({ appState: { openDialog: null } });
        }}>
        <MainMenu><MainMenu.Item onSelect={() => void finish()}>保存到文档</MainMenu.Item><MainMenu.Item onSelect={() => void cancel()}>取消草稿</MainMenu.Item></MainMenu>
        <DefaultSidebar className="minds-disabled-library" />
        <DefaultSidebar.Trigger className="minds-disabled-library-trigger"><span>在线图形库已禁用</span></DefaultSidebar.Trigger>
      </Editor>}
    </div>
  </section>;
}
