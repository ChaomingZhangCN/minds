// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { validateSvg } from '../src/utils/security';
import { EXCALIDRAW_LIMITS, excalidrawUIOptions, normalizeExcalidrawAssetUrl, parseExcalidrawScene, previewExcalidraw, sanitizeExcalidrawSvg } from '../src/webview/components/ExcalidrawEditor';

const shape = { id: 'rectangle-1', type: 'rectangle', x: 10, y: 20, width: 180, height: 90, strokeColor: '#1b1b1f', backgroundColor: '#ffffff' };
const scene = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'excalidraw', version: 2, elements: [shape], appState: { viewBackgroundColor: '#ffffff' }, files: {}, ...extra });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=';
const imageFile = (dataURL = png, mimeType = 'image/png') => ({ id: 'file-1', dataURL, mimeType, created: 1 });

beforeAll(() => {
  // These DOM shims allow the library's pure SVG API to run in jsdom. They do not
  // emulate the interactive canvas/editor, and no browser UI claim is made.
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, media: '', onchange: null })) as typeof window.matchMedia;
  vi.stubGlobal('FontFace', class {
    family: string;
    unicodeRange = 'U+0-10FFFF';
    status = 'loaded';
    constructor(family: string, _source: string, descriptors: FontFaceDescriptors = {}) { this.family = family; Object.assign(this, descriptors); }
    load() { return Promise.resolve(this); }
    get loaded() { return Promise.resolve(this); }
  });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add() {}, has() { return true; }, check() { return true; }, load() { return Promise.resolve([]); }, ready: Promise.resolve(), [Symbol.iterator]() { return [][Symbol.iterator](); } } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    measureText: (text: string) => ({ width: text.length * 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 }),
    canvas: document.createElement('canvas'), font: '',
  }) as unknown as CanvasRenderingContext2D);
});

describe('Excalidraw scene and local resource guards', () => {
  it('accepts native version-two scenes and strips imported runtime/library/dialog state', () => {
    const parsed = parseExcalidrawScene(scene({ appState: { viewBackgroundColor: '#fff', openDialog: { name: 'export' }, openSidebar: { name: 'default', tab: 'library' }, fileHandle: { anything: true }, collaborators: [] } }));
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.appState).toEqual({ viewBackgroundColor: '#fff' });
    expect(() => parseExcalidrawScene('{')).toThrow('合法 JSON');
    expect(() => parseExcalidrawScene(scene({ type: 'other' }))).toThrow('场景无效');
    expect(() => parseExcalidrawScene(scene({ version: 1 }))).toThrow('场景无效');
  });

  it('rejects iframe/embeddable/AI HTML and unsafe styles before importing the SDK', async () => {
    for (const type of ['iframe', 'embeddable', 'magicframe']) expect(() => parseExcalidrawScene(scene({ elements: [{ ...shape, type, link: 'https://evil.example', customData: { generationData: { html: '<script>alert(1)</script>' } } }] }))).toThrow();
    expect(() => parseExcalidrawScene(scene({ elements: [{ ...shape, strokeColor: 'url(https://evil.example/pixel)' }] }))).toThrow('颜色');
    expect(() => parseExcalidrawScene(scene({ elements: [{ ...shape, link: 'javascript:alert(1)' }] }))).toThrow('链接协议');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(previewExcalidraw(scene({ elements: [{ ...shape, type: 'embeddable' }] }), '/assets/')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('validates IDs, geometry, point arrays, and total scene size', () => {
    expect(() => parseExcalidrawScene(scene({ elements: [shape, shape] }))).toThrow('重复元素');
    expect(() => parseExcalidrawScene(scene({ elements: [{ ...shape, x: 1e308 }] }))).toThrow();
    expect(() => parseExcalidrawScene(scene({ elements: [{ ...shape, type: 'arrow', points: [[0, 0], ['bad', 12]] }] }))).toThrow();
    expect(() => parseExcalidrawScene(scene({ elements: [{ ...shape, type: 'freedraw', points: [[0, 0], [12, 12]], pressures: [0.5] }] }))).toThrow('数量不一致');
    expect(() => parseExcalidrawScene(' '.repeat(EXCALIDRAW_LIMITS.sceneBytes + 1))).toThrow('8 MiB');
    expect(() => parseExcalidrawScene('{"type":"excalidraw","version":2,"elements":[],"__proto__":{"polluted":true}}')).toThrow('对象键');
    expect(() => parseExcalidrawScene(scene({ elements: Array.from({ length: EXCALIDRAW_LIMITS.elements + 1 }, (_, index) => ({ ...shape, id: `id-${index}` })) }))).toThrow();
  });

  it('accepts embedded raster images and rejects URLs, SVG, disguised payloads, and missing files', () => {
    const image = { ...shape, type: 'image', fileId: 'file-1', status: 'saved', scale: [1, 1] };
    expect(parseExcalidrawScene(scene({ elements: [image], files: { 'file-1': imageFile() } })).files).toHaveProperty('file-1');
    for (const url of ['https://evil.example/image.png', '//evil.example/image.png', 'file:///tmp/image.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,PHN2Zz48L3N2Zz4=']) {
      expect(() => parseExcalidrawScene(scene({ elements: [image], files: { 'file-1': imageFile(url) } }))).toThrow();
    }
    expect(() => parseExcalidrawScene(scene({ elements: [image] }))).toThrow('缺少对应');
    expect(() => parseExcalidrawScene(scene({ files: { wrong: imageFile() } }))).toThrow('键与 id');
    expect(() => parseExcalidrawScene(scene({ files: { 'file-1': imageFile('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'image/svg+xml') } }))).toThrow();
  });

  it('requires a Host-local asset root and exposes verified 0.18.1 UIOptions flags', () => {
    expect(normalizeExcalidrawAssetUrl('https://file+.vscode-resource.vscode-cdn.net/workspace/dist/excalidraw')).toMatch(/excalidraw\/$/);
    expect(normalizeExcalidrawAssetUrl('http://localhost:5173/assets/excalidraw/')).toBe('http://localhost:5173/assets/excalidraw/');
    for (const url of ['', 'https://esm.sh/assets/', 'https://evil.example/fonts/', 'javascript:alert(1)', 'https://user:password@file+.vscode-resource.vscode-cdn.net/fonts/']) expect(() => normalizeExcalidrawAssetUrl(url)).toThrow();
    expect(excalidrawUIOptions.canvasActions).toMatchObject({ export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false });
  });

  it('sanitizes exported XML, dropping scripts, HTML, remote images, links and external CSS', () => {
    const clean = sanitizeExcalidrawSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><image href="https://evil.example/img" onload="alert(1)"/><a href="javascript:alert(1)"><text>x</text></a><style>@import "https://evil.example/css";</style><rect width="10" height="10" fill="url(https://evil.example/x)"/><text>&lt;script&gt;literal&lt;/script&gt;</text></svg>');
    expect(clean).not.toMatch(/<script|foreignObject|onload|javascript:|https:\/\/evil/);
    expect(clean).toContain('&lt;script&gt;literal&lt;/script&gt;');
    expect(clean).toContain('<rect');
  });
});

describe('real Excalidraw 0.18.1 native/SVG API (DOM test, not interactive browser)', () => {
  it('serializes a native file that restores and reopens with the real library', async () => {
    const sdk = await import('@excalidraw/excalidraw');
    const elements = sdk.convertToExcalidrawElements([{ type: 'rectangle', id: 'real-shape', x: 10, y: 20, width: 180, height: 90 }], { regenerateIds: false });
    const native = sdk.serializeAsJSON(elements, { viewBackgroundColor: '#ffffff' }, {}, 'local');
    expect(JSON.parse(native)).toMatchObject({ type: 'excalidraw', version: 2 });
    const validated = parseExcalidrawScene(native);
    const reopened = sdk.restore(validated, null, null);
    expect(reopened.elements[0]).toMatchObject({ id: 'real-shape', type: 'rectangle', width: 180, height: 90 });
  });

  it('restores and exports the shipped native example through the real SDK', async () => {
    const source = await readFile(new NodeURL('../examples/diagrams/sketch.excalidraw', import.meta.url), 'utf8');
    const sdk = await import('@excalidraw/excalidraw');
    const reopened = sdk.restore(parseExcalidrawScene(source), null, null);
    expect(reopened.elements).toHaveLength(4);
    const output = await previewExcalidraw(source, 'http://localhost/assets/excalidraw/');
    expect(validateSvg(output)).toBe(output);
    expect(output).toContain('Markdown');
    expect(output).toContain('Snapshot');
  });

  it('exports hostile scene text as literal SVG text, not HTML', async () => {
    const sdk = await import('@excalidraw/excalidraw');
    const text = '<script>alert(1)</script><img src=https://evil.example>';
    const elements = sdk.convertToExcalidrawElements([{ type: 'text', id: 'text-safe', x: 10, y: 20, text, fontFamily: 2, fontSize: 20 }], { regenerateIds: false });
    const native = sdk.serializeAsJSON(elements, { viewBackgroundColor: '#ffffff' }, {}, 'local');
    const svg = await previewExcalidraw(native, 'http://localhost/assets/excalidraw/');
    expect(validateSvg(svg)).toBe(svg);
    expect(svg).toContain('<text');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toMatch(/<script|<img|foreignObject/);
  });

  it('previewExcalidraw returns actual exportToSvg geometry with only local assets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const svg = await previewExcalidraw(scene(), 'http://localhost/assets/excalidraw/');
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(svg).toContain('viewBox="0 0 200 110"');
    expect(svg).not.toContain('foreignObject');
    expect((window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH).toBe('http://localhost/assets/excalidraw/');
    expect(fetchSpy).not.toHaveBeenCalled(); // No text/font or image fetch in this fixture.
    fetchSpy.mockRestore();
  });
});
