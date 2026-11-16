import { describe, expect, it } from 'vitest';
import { XMLValidator } from 'fast-xml-parser';
import { validateSvg } from '../src/utils/security';
import { exportChartSvg } from '../src/webview/components/ChartBlock';
import { chartSchema, findEmbedBlocks, sampleChart } from '../src/shared/embeds';
import { readFile } from 'node:fs/promises';
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420">${body}</svg>`;
describe('Host SVG export boundary', () => {
  it('accepts actual light/dark ECharts geometry and texture', () => {
    for (const theme of ['light', 'dark'] as const) for (const type of ['bar', 'line', 'pie'] as const) {
      const output = exportChartSvg({ ...sampleChart, type }, theme, 800, 420, undefined, true);
      expect(XMLValidator.validate(output)).toBe(true);
      expect(validateSvg(output)).toBe(output);
    }
  });
  it('renders the shipped example Charts through the real schema and ECharts', async () => {
    const text = await readFile(new URL('../examples/welcome.md', import.meta.url), 'utf8');
    const charts = findEmbedBlocks(text).filter(block => block.kind === 'charts');
    expect(charts).toHaveLength(2);
    for (const block of charts) {
      const spec = chartSchema.parse(JSON.parse(block.content));
      const output = exportChartSvg(spec, 'light', 800, 420);
      expect(validateSvg(output)).toBe(output);
      expect(output).toContain('<svg');
    }
  });
  it('accepts local marker URLs and embedded font CSS including CDATA', () => {
    for (const body of ['<path style="marker-end:url(&quot;#arrow&quot;)"/>', '<style><![CDATA[@font-face {font-family:Test;src:url("data:font/woff2;base64,AAAA")}]]></style>']) expect(validateSvg(svg(body))).toContain('<svg');
  });
  it('accepts inert native draw.io HTML labels, not active HTML', () => {
    expect(validateSvg(svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><b>安全文字</b><span style="color:#333">标签</span></div></foreignObject>'))).toContain('安全文字');
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'input', 'video']) expect(() => validateSvg(svg(`<foreignObject><${tag} xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>`))).toThrow();
  });
  it.each([
    '<image href="https://evil.example/a.png"/>', '<g onload="alert(1)"/>', '<animate attributeName="href" to="https://evil.example"/>',
    '<style><![CDATA[@import "https://evil.example";]]></style>', '<style type="text/css">rect{fill:url(https://evil.example)}</style>',
    '<path fill="u\\72l(https://evil.example)"/>', '<path style="fill:u&#114;l(https://evil.example)"/>', '<path style="fill:u\\72l(https://evil.example)"/>', '<path style="fill:u/**/rl(https://evil.example)"/>',
    '<foreignObject><a xmlns="http://www.w3.org/1999/xhtml" href="javascript:alert(1)">x</a></foreignObject>',
    '<image href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQvPjwvc3ZnPg=="/>',
  ])('rejects active resources: %s', body => expect(() => validateSvg(svg(body))).toThrow());
  it('rejects multiple SVG roots', () => {
    expect(() => validateSvg(svg('') + svg(''))).toThrow();
  });
  it('rejects excessive dimensions, declarations and deep trees', () => {
    expect(() => validateSvg('<svg xmlns="http://www.w3.org/2000/svg" width="20000"/>')).toThrow();
    expect(() => validateSvg('<!DOCTYPE svg [<!ENTITY x "evil">]>' + svg('&x;'))).toThrow();
    expect(() => validateSvg(svg('<g>'.repeat(258) + '</g>'.repeat(258)))).toThrow();
  });
});
