// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import {
  acceptDrawioMessage, decodeDrawioSvg, drawioFrameUrl, parseDrawioMessage,
  validateDrawioSvg, validateDrawioXml,
} from '../src/webview/components/DrawioFrame';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px" viewBox="0 0 100 50"><rect width="100" height="50" fill="#fff"/></svg>';
const xml = '<mxfile><diagram id="a"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

describe('official draw.io JSON messages and session boundary', () => {
  it('accepts bounded official JSON events, not arbitrary objects or malformed values', () => {
    expect(parseDrawioMessage('{"event":"init"}')).toEqual({ event: 'init' });
    expect(parseDrawioMessage(JSON.stringify({ event: 'save', xml }))).toEqual({ event: 'save', xml });
    expect(parseDrawioMessage({ event: 'init' })).toBeNull();
    expect(parseDrawioMessage('null')).toBeNull();
    expect(parseDrawioMessage('[]')).toBeNull();
    expect(parseDrawioMessage('{"event":"save","xml":42}')).toBeNull();
    expect(parseDrawioMessage('{"event":"export","data":null}')).toBeNull();
    expect(parseDrawioMessage(JSON.stringify({ event: 'autosave', xml }))).toEqual({ event: 'autosave', xml });
    expect(parseDrawioMessage('{"event":"autosave","xml":42}')).toBeNull();
  });

  it('requires exact iframe source and URL origin', () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const origin = 'https://file+.vscode-resource.vscode-cdn.net';
    const event = { source: frame.contentWindow, origin, data: '{"event":"init"}' };
    expect(acceptDrawioMessage(event, frame.contentWindow, origin, 'initializing')).toEqual({ event: 'init' });
    expect(acceptDrawioMessage({ ...event, source: window }, frame.contentWindow, origin, 'initializing')).toBeNull();
    expect(acceptDrawioMessage({ ...event, origin: `${origin}.evil.invalid` }, frame.contentWindow, origin, 'initializing')).toBeNull();
    expect(acceptDrawioMessage({ ...event, origin: 'null' }, frame.contentWindow, origin, 'initializing')).toBeNull();
    expect(acceptDrawioMessage(event, null, origin, 'initializing')).toBeNull();
    frame.remove();
  });

  it('rejects out-of-phase, canceled and late messages without fake token fields', () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const origin = 'https://file+.vscode-resource.vscode-cdn.net';
    const accept = (event: string, state: Parameters<typeof acceptDrawioMessage>[3]) => acceptDrawioMessage({ source: frame.contentWindow, origin, data: JSON.stringify({ event, xml, data: svg, format: 'svg' }) }, frame.contentWindow, origin, state);
    expect(accept('init', 'ready')).toBeNull();
    expect(accept('load', 'initializing')).toBeNull();
    expect(accept('load', 'loading')).toEqual({ event: 'load' });
    expect(accept('save', 'loading')).toBeNull();
    expect(accept('save', 'ready')).toEqual({ event: 'save', xml });
    expect(accept('save', 'saving')).toBeNull(); expect(accept('exit', 'saving')).toBeNull();
    expect(accept('autosave', 'ready')).toEqual({ event: 'autosave', xml });
    for (const phase of ['initializing', 'loading', 'saving', 'exporting', 'closed'] as const) expect(accept('autosave', phase)).toBeNull();
    expect(accept('export', 'ready')).toBeNull();
    expect(accept('export', 'exporting')).toEqual({ event: 'export', data: svg });
    for (const type of ['init', 'load', 'save', 'exit', 'export', 'error']) expect(accept(type, 'closed')).toBeNull();
    frame.remove();
  });
});

describe('draw.io source and export validation', () => {
  it('preserves original source XML including compressed diagram payloads', () => {
    expect(validateDrawioXml(xml)).toBe(xml);
    const compressed = '<mxfile><diagram id="a">compressed-base64-source</diagram></mxfile>';
    expect(validateDrawioXml(compressed)).toBe(compressed);
    expect(() => validateDrawioXml(svg)).toThrow();
    expect(() => validateDrawioXml('<mxfile>')).toThrow();
    expect(() => validateDrawioXml('<!DOCTYPE mxfile SYSTEM "https://evil.invalid/a"><mxfile/>')).toThrow();
  });

  it('accepts the shipped native XML example without rewriting it', async () => {
    const source = await readFile(new NodeURL('../examples/diagrams/architecture.drawio', import.meta.url), 'utf8');
    expect(validateDrawioXml(source)).toBe(source);
    expect(source).toContain('mxGraphModel');
    expect(source).toContain('html=1');
  });

  it('decodes UTF-8 base64 and URI exports', () => {
    const utf8 = svg.replace('<rect', '<title>图形 é</title><rect');
    const data = 'data:image/svg+xml;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(utf8)));
    expect(decodeDrawioSvg(data)).toBe(utf8);
    expect(decodeDrawioSvg('data:image/svg+xml,' + encodeURIComponent(utf8))).toBe(utf8);
    expect(decodeDrawioSvg(svg)).toBe(svg);
    expect(() => decodeDrawioSvg('data:text/html;base64,WA==')).toThrow();
    expect(() => decodeDrawioSvg('data:image/svg+xml;base64,%%%')).toThrow();
  });

  it('accepts native SVG and safe foreignObject HTML labels', () => {
    expect(validateDrawioSvg(svg)).toBe(svg);
    const labels = svg.replace('<rect', '<foreignObject width="90" height="40"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;color:#123"><b>label</b></div></foreignObject><rect');
    expect(validateDrawioSvg(labels)).toBe(labels);
    const fragment = svg.replace('<rect', '<defs><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></defs><rect style="fill:url(#g)"');
    expect(validateDrawioSvg(fragment)).toBe(fragment);
  });

  it.each([
    svg.replace('100px', '999999px'),
    svg.replace('0 0 100 50', '0 0 Infinity 50'),
    svg.replace('0 0 100 50', '0 0 0 50'),
    svg.replace('<rect', '<script>alert(1)</script><rect'),
    svg.replace('<rect', '<rect onload="alert(1)"'),
    svg.replace('<rect', '<image href="https://evil.invalid/a.svg"/><rect'),
    svg.replace('<rect', '<a href="javascript:alert(1)"><rect').replace('</svg>', '</a></svg>'),
    svg.replace('<rect', '<style>@import "https://evil.invalid/a.css";</style><rect'),
    svg.replace('<rect', '<rect style="fill:url(https://evil.invalid/a)"'),
    svg.replace('<rect', '<rect style="fill:u\\72l(https://evil.invalid/a)"'),
    svg.replace('<rect', '<foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml"/></foreignObject><rect'),
    '<?xml-stylesheet href="https://evil.invalid/a.css"?>' + svg,
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "https://evil.invalid/a">]>' + svg,
  ])('rejects unsafe/oversized SVG %#', unsafe => expect(() => validateDrawioSvg(unsafe)).toThrow());
});

describe('local runtime entry URL', () => {
  it('uses the bundled index and forces offline JSON embed flags', () => {
    const value = drawioFrameUrl('https://file+.vscode-resource.vscode-cdn.net/home/minds/dist/drawio/index.html?embed=0&proto=xml&offline=0');
    const target = new URL(value.href);
    expect(value.origin).toBe('https://file+.vscode-resource.vscode-cdn.net');
    expect(target.searchParams.get('embed')).toBe('1');
    expect(target.searchParams.get('proto')).toBe('json');
    expect(target.searchParams.get('offline')).toBe('1');
    expect(target.searchParams.get('local')).toBe('1');
    expect(drawioFrameUrl('http://127.0.0.1:5137/dist/drawio/index.html').origin).toBe('http://127.0.0.1:5137');
  });
  it.each(['https://app.diagrams.net/dist/drawio/index.html', 'https://evil.invalid/drawio/index.html', 'javascript:alert(1)', 'file:///tmp/dist/drawio/index.html', 'https://file+.vscode-resource.vscode-cdn.net/index.html'])('rejects online/foreign entry URLs %s', value => expect(() => drawioFrameUrl(value)).toThrow());
});
