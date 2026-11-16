import { useEffect, useRef, useState } from 'react';

export const DRAWIO_MAX_XML = 16 * 1024 * 1024;
export const DRAWIO_MAX_SVG = 8 * 1024 * 1024;
const MAX_MESSAGE = 24 * 1024 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const MAX_DIMENSION = 16384;
const TIMEOUT_MS = 60000;

export type DrawioMessage =
  | { event: 'init' }
  | { event: 'load' }
  | { event: 'save' | 'autosave'; xml: string }
  | { event: 'exit' }
  | { event: 'export'; data: string }
  | { event: 'error'; message: string };
export type DrawioSessionState = 'initializing' | 'loading' | 'ready' | 'saving' | 'exporting' | 'closed';

/** The official proto=json transport sends JSON strings, not trusted objects. */
export function parseDrawioMessage(data: unknown): DrawioMessage | null {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch { return null; }
  switch (value.event) {
    case 'init': return { event: 'init' };
    case 'load': return typeof value.error === 'string'
      ? { event: 'error', message: value.error.slice(0, 1000) } : { event: 'load' };
    case 'exit': return { event: 'exit' };
    case 'autosave':
    case 'save': return typeof value.xml === 'string' && value.xml.length <= DRAWIO_MAX_XML
      ? { event: value.event, xml: value.xml } : null;
    case 'export': return value.format === 'svg' && typeof value.data === 'string' && value.data.length <= MAX_MESSAGE
      ? { event: 'export', data: value.data } : null;
    case 'error': return { event: 'error', message: typeof value.message === 'string' ? value.message.slice(0, 1000) : 'draw.io runtime error' };
    default: return null;
  }
}

/** Source, exact URL origin and protocol phase must all match; no invented token. */
export function acceptDrawioMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frameWindow: Window | null,
  origin: string,
  state: DrawioSessionState,
): DrawioMessage | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== origin || state === 'closed') return null;
  const message = parseDrawioMessage(event.data);
  if (!message) return null;
  if (message.event === 'init') return state === 'initializing' ? message : null;
  if (message.event === 'load') return state === 'loading' ? message : null;
  if (message.event === 'export') return state === 'exporting' ? message : null;
  if (message.event === 'save' || message.event === 'autosave' || message.event === 'exit') return state === 'ready' ? message : null;
  return message;
}

function parseXml(text: string, limit: number): XMLDocument {
  if (!text.trim() || text.length > limit || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML is empty, too large, or contains a DTD/entity declaration');
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length || !document.documentElement) throw new Error('Invalid XML');
  return document;
}

/** Return the original editor XML, not an SVG or a lossy reserialization. */
export function validateDrawioXml(xml: string): string {
  const document = parseXml(xml, DRAWIO_MAX_XML);
  if (!['mxfile', 'mxGraphModel'].includes(document.documentElement.localName)) throw new Error('Expected draw.io mxfile or mxGraphModel XML');
  return xml;
}

export function decodeDrawioSvg(data: string): string {
  if (data.length > MAX_MESSAGE) throw new Error('SVG export exceeds the size limit');
  if (data.trimStart().startsWith('<')) return data;
  const match = /^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,([\s\S]*)$/i.exec(data);
  if (!match) throw new Error('Expected an SVG export');
  try {
    if (!match[1]) return decodeURIComponent(match[2]);
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new Error('Invalid SVG export encoding'); }
}

const SVG_TAGS = new Set(('svg g defs title desc metadata symbol use switch path rect circle ellipse line polyline polygon text tspan textPath image a clipPath mask pattern marker linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence foreignObject style').split(' '));
const CSS_ATTRIBUTES = new Set('style fill stroke filter clip-path mask marker marker-start marker-mid marker-end cursor color stop-color flood-color lighting-color font font-family'.split(' '));
const HTML_TAGS = new Set(('div span p br b i u s strong em sub sup small big font a img ul ol li table tbody thead tfoot tr td th pre code blockquote hr h1 h2 h3 h4 h5 h6').split(' '));

function validateCss(css: string): void {
  // Escapes/comments cannot smuggle a network URL, @import, expression or binding.
  const withoutFontFace = css.replace(/@font-face\s*\{/gi, '{');
  if (/[\\@]|\/\*|expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:/i.test(withoutFontFace)) throw new Error('Unsafe SVG CSS');
  for (const match of css.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const value = match[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    const embeddedFont = /^data:(?:font\/(?:ttf|otf|woff2?)|application\/(?:x-font-(?:ttf|opentype)|font-(?:woff2?|sfnt)|vnd.ms-fontobject))(?:;charset=utf-8)?;base64,[a-z\d+/=\s]+$/i.test(value);
    if (!/^#[\w.:-]+$/.test(value) && !embeddedFont) throw new Error('External SVG CSS resource');
  }
}

/** Validate before handing SVG to the parent; allow native HTML labels, never active content. */
export function validateDrawioSvg(svg: string, depth = 0): string {
  if (depth > 3) throw new Error('Nested SVG resource limit exceeded');
  const document = parseXml(svg, DRAWIO_MAX_SVG);
  const root = document.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) throw new Error('Expected SVG namespace/root');
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && (viewBox.length !== 4 || viewBox.some(n => !Number.isFinite(n)) || Math.abs(viewBox[0]) > 1e7 || Math.abs(viewBox[1]) > 1e7 || viewBox[2] <= 0 || viewBox[3] <= 0 || viewBox[2] > MAX_DIMENSION || viewBox[3] > MAX_DIMENSION)) throw new Error('SVG viewBox exceeds safe bounds');
  const dimension = (name: string, fallback: number | undefined) => {
    const raw = root.getAttribute(name);
    const value = raw === null ? fallback : /^\d+(?:\.\d+)?(?:px)?$/.test(raw) ? Number(raw.replace(/px$/, '')) : NaN;
    if (!Number.isFinite(value) || value! <= 0 || value! > MAX_DIMENSION) throw new Error(`SVG ${name} exceeds safe bounds`);
  };
  dimension('width', viewBox?.[2]);
  dimension('height', viewBox?.[3]);
  const elements = Array.from(document.getElementsByTagName('*'));
  if (elements.length > 50000) throw new Error('SVG element limit exceeded');
  const resource = (value: string) => {
    if (/^#[\w.:-]+$/.test(value)) return;
    if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return;
    if (/^data:image\/svg\+xml[;,]/i.test(value)) { validateDrawioSvg(decodeDrawioSvg(value), depth + 1); return; }
    throw new Error('External or active SVG resource');
  };
  const metadataNamespaces = new Set(['http://purl.org/dc/elements/1.1/', 'http://creativecommons.org/ns#', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#']);
  for (const element of elements) {
    // Official local Azure/etc icons carry copyright/RDF metadata and Inkscape
    // namedviews. These non-rendering namespaces are retained, not stripped.
    let inMetadata = false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.namespaceURI === SVG_NS && parent.localName === 'metadata') { inMetadata = true; break; }
    }
    const inertMetadata = inMetadata && metadataNamespaces.has(element.namespaceURI ?? '');
    const inertNamedview = element.namespaceURI === 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd' && element.localName === 'namedview';
    const inertGrid = element.namespaceURI === 'http://www.inkscape.org/namespaces/inkscape' && element.localName === 'grid';
    if (!inertMetadata && !inertNamedview && !inertGrid && (element.namespaceURI === SVG_NS ? !SVG_TAGS.has(element.localName) : element.namespaceURI !== HTML_NS || !HTML_TAGS.has(element.localName))) throw new Error(`Unsupported/active SVG element: ${element.localName}`);
    if (element.localName === 'style') validateCss(element.textContent ?? '');
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith('on') || ['srcdoc', 'base', 'formaction', 'action'].includes(name)) throw new Error('Active SVG attribute');
      if (['srcset', 'ping', 'dynsrc', 'lowsrc'].includes(name)) throw new Error('Active/multiple SVG resource attribute');
      if (name === 'href' || name === 'src' || name === 'poster' || name === 'background') resource(attribute.value);
      if (CSS_ATTRIBUTES.has(name) || /url\s*\(/i.test(attribute.value)) validateCss(attribute.value);
    }
  }
  // Processing instructions can refer to external XML stylesheets.
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  if (walker.nextNode()) throw new Error('SVG processing instruction is not allowed');
  return svg;
}

export function drawioFrameUrl(url: string, readOnly = false): { href: string; origin: string } {
  const target = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  const vscodeResource = target.hostname.endsWith('.vscode-resource.vscode-cdn.net');
  if (target.username || target.password || (!loopback && !vscodeResource) || (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback))) throw new Error('draw.io must use a local webview resource URL');
  // Only the approved local index is an entry point; no hosted/online editor.
  if (!target.pathname.endsWith('/dist/drawio/index.html') && !target.pathname.endsWith('/drawio/index.html')) throw new Error('Expected the bundled draw.io index.html');
  // Do not inherit upstream url/config/plugin parameters from the supplied URI.
  target.search = '';
  target.searchParams.set('embed', '1');
  target.searchParams.set('proto', 'json');
  target.searchParams.set('offline', '1');
  target.searchParams.set('local', '1');
  target.searchParams.set('pwa', '0');
  target.searchParams.set('stealth', '1');
  target.searchParams.set('plugins', '0');
  target.searchParams.set('spin', '1');
  target.searchParams.set('libraries', '1');
  target.searchParams.set('saveAndExit', '1');
  if (readOnly) target.searchParams.set('chrome', '0');
  target.hash = '';
  return { href: target.href, origin: target.origin };
}

export function DrawioFrame({ url, xml, onSave, onCancel, onExport, onDraft, readOnly = false }: {
  url: string; xml: string; onSave: (xml: string) => void | Promise<void>; onCancel: () => void | Promise<void>;
  onExport?: (svg: string) => void; onDraft?: (xml: string) => void; readOnly?: boolean;
}) {
  return <RuntimeFrame key={`${url}\0${xml}\0${readOnly}`} url={url} xml={xml} readOnly={readOnly} onSave={onSave} onCancel={onCancel} onSvg={onExport} onDraft={onDraft} />;
}

export function DrawioPreview({ url, xml, onSvg, onError }: {
  url: string; xml: string; onSvg: (svg: string) => void; onError?: (message: string) => void;
}) {
  return <RuntimeFrame key={`${url}\0${xml}`} url={url} xml={xml} readOnly preview onSvg={onSvg} onError={onError} />;
}

function RuntimeFrame({ url, xml, readOnly, preview = false, onSave, onCancel, onSvg, onError, onDraft }: {
  url: string; xml: string; readOnly: boolean; preview?: boolean;
  onSave?: (xml: string) => void | Promise<void>; onCancel?: () => void | Promise<void>; onSvg?: (svg: string) => void; onError?: (message: string) => void; onDraft?: (xml: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onSave, onCancel, onSvg, onError, onDraft });
  callbacks.current = { onSave, onCancel, onSvg, onError, onDraft };
  const exportAction = useRef<() => void>(() => {});
  const cancelAction = useRef<() => void>(() => {});
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  let target: ReturnType<typeof drawioFrameUrl> | undefined;
  let setupError = '';
  try {
    target = drawioFrameUrl(url, readOnly);
    if (target.origin === window.location.origin) throw new Error('draw.io iframe must have a different origin from its parent');
    validateDrawioXml(xml);
  }
  catch (cause) { setupError = cause instanceof Error ? cause.message : String(cause); }
  const href = target?.href;
  const origin = target?.origin;

  useEffect(() => {
    if (!href || !origin || setupError) {
      setError(setupError || 'Invalid draw.io URL');
      callbacks.current.onError?.(setupError || 'Invalid draw.io URL');
      return;
    }
    const iframe = frame.current;
    if (!iframe) return;
    let state: DrawioSessionState = 'initializing';
    let finished = false, disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const fail = (message: string) => {
      if (state === 'closed') return;
      state = 'closed'; clearTimer(); setReady(false); setError(message);
      callbacks.current.onError?.(message);
    };
    const deadline = () => { clearTimer(); timer = setTimeout(() => fail('draw.io runtime timed out'), TIMEOUT_MS); };
    const send = (message: object) => iframe.contentWindow?.postMessage(JSON.stringify(message), origin);
    const requestExport = () => {
      if (state !== 'ready') return;
      state = 'exporting'; setReady(false); deadline();
      send({ action: 'export', format: 'svg', asText: true, embedImages: true, embedFonts: true });
    };
    exportAction.current = requestExport;
    cancelAction.current = () => {
      if (finished || state === 'saving') return;
      const previous = state;
      state = 'saving'; clearTimer(); setReady(false);
      void (async () => {
        try { await callbacks.current.onCancel?.(); if (!disposed) { finished = true; state = 'closed'; } }
        catch (cause) { if (!disposed) { state = previous; setReady(previous === 'ready'); setError(cause instanceof Error ? cause.message : '取消失败；画布草稿仍保留，可重试'); if (previous !== 'ready' && previous !== 'closed') deadline(); } }
      })();
    };
    const receive = async (event: MessageEvent) => {
      const message = acceptDrawioMessage(event, iframe.contentWindow, origin, state);
      if (!message) return;
      try {
        switch (message.event) {
          case 'init':
            state = 'loading'; deadline();
            send({ action: 'load', xml, title: 'minds', autosave: !readOnly && onDraft ? 1 : 0 });
            break;
          case 'load':
            state = 'ready'; clearTimer(); setReady(true);
            if (preview) requestExport();
            break;
          case 'autosave':
            if (!readOnly) callbacks.current.onDraft?.(validateDrawioXml(message.xml));
            break;
          case 'save':
            if (readOnly) return;
            validateDrawioXml(message.xml);
            callbacks.current.onDraft?.(message.xml);
            state = 'saving'; clearTimer(); setReady(false);
            try {
              await callbacks.current.onSave?.(message.xml);
              if (disposed) return;
              finished = true; state = 'closed'; setReady(false);
            } catch (cause) {
              if (disposed) return;
              state = 'ready'; setReady(true); setError(cause instanceof Error ? cause.message : '保存失败；画布草稿仍保留，可重试');
            }
            break;
          case 'exit': cancelAction.current(); break;
          case 'export': {
            const svg = validateDrawioSvg(decodeDrawioSvg(message.data));
            clearTimer(); state = preview ? 'closed' : 'ready'; setReady(!preview);
            callbacks.current.onSvg?.(svg);
            break;
          }
          case 'error': fail(message.message); break;
        }
      } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
    };
    window.addEventListener('message', receive);
    // Register first so an immediately cached init event cannot be lost.
    iframe.src = href;
    deadline();
    return () => {
      disposed = true; state = 'closed'; clearTimer(); window.removeEventListener('message', receive);
      exportAction.current = () => {}; cancelAction.current = () => {};
    };
  }, [href, origin, setupError, xml, readOnly, preview]);

  return <div className={preview ? 'minds-drawio-preview-runtime' : 'minds-drawio-frame'}>
    {!preview && <div className="minds-drawio-controls">
      {onSvg && <button type="button" disabled={!ready} onClick={() => exportAction.current()}>导出 SVG</button>}
      <button type="button" onClick={() => { if (setupError) void Promise.resolve().then(() => callbacks.current.onCancel?.()).catch(cause => setError(cause instanceof Error ? cause.message : '取消失败')); else cancelAction.current(); }}>取消</button>
      {error && <span role="alert">{error}</span>}
    </div>}
    {href && !setupError && <iframe ref={frame} title={preview ? 'draw.io preview runtime' : 'draw.io editor'}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" tabIndex={preview ? -1 : 0} aria-hidden={preview || undefined}
      style={preview ? { position: 'absolute', left: '-10000px', width: 1000, height: 700, visibility: 'hidden', border: 0 } : { width: '100%', height: '70vh', minHeight: 500, border: 0 }} />}
  </div>;
}
