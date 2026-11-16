import { XMLParser, XMLValidator } from 'fast-xml-parser';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_TAGS = new Set('svg g defs title desc metadata symbol use switch path rect circle ellipse line polyline polygon text tspan textPath image a clipPath mask pattern marker linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence foreignObject style'.split(' '));
const CSS_ATTRIBUTES = new Set('style fill stroke filter clip-path mask marker marker-start marker-mid marker-end cursor color stop-color flood-color lighting-color font font-family'.split(' '));
const HTML_TAGS = new Set('div span p br b i u s strong em sub sup small big font a img ul ol li table tbody thead tfoot tr td th pre code blockquote hr h1 h2 h3 h4 h5 h6'.split(' '));
type XmlNode = Record<string, unknown>;
function css(value: string): void {
  if (/[\\@]|\/\*|expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:/i.test(value.replace(/@font-face\s*\{/gi, '{'))) throw new Error('SVG 不允许活动样式');
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const url = match[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!/^#[\w.:-]+$/.test(url) && !/^data:(?:font\/(?:ttf|otf|woff2?)|application\/(?:x-font-(?:ttf|opentype)|font-(?:woff2?|sfnt)|vnd.ms-fontobject))(?:;charset=utf-8)?;base64,[a-z\d+/=\s]+$/i.test(url)) throw new Error('SVG 不允许外部样式资源');
  }
}
export function validateSvg(svg: string, nesting = 0): string {
  if (nesting > 3 || svg.length > 20_000_000 || /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(svg)) throw new Error('SVG 包含不允许的声明或超过限制');
  if (XMLValidator.validate(svg) !== true) throw new Error('SVG 格式无效');
  const xml = new XMLParser({ ignoreAttributes: false, preserveOrder: true, processEntities: true, htmlEntities: true, ignoreDeclaration: true, commentPropName: '#comment', cdataPropName: '#cdata' }).parse(svg) as XmlNode[];
  if (xml.filter(node => Object.keys(node).some(name => name !== ':@' && !name.startsWith('#'))).length !== 1) throw new Error('SVG 必须只有一个根元素');
  let elements = 0;
  const resource = (value: string): void => {
    if (!value || /^#[\w.:-]+$/.test(value) || /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return;
    if (/^data:image\/svg\+xml(?:;charset=utf-8)?(?:;base64)?,/i.test(value)) {
      const comma = value.indexOf(',');
      const nested = /;base64$/i.test(value.slice(0, comma)) ? Buffer.from(value.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(value.slice(comma + 1));
      validateSvg(nested, nesting + 1); return;
    }
    throw new Error('SVG 不允许外部或活动资源');
  };
  const text = (nodes: XmlNode[]): string => nodes.map(node => typeof node['#text'] === 'string' ? node['#text'] : typeof node['#cdata'] === 'string' ? node['#cdata'] : Array.isArray(node['#cdata']) ? text(node['#cdata'] as XmlNode[]) : '').join('');
  const walk = (nodes: XmlNode[], namespaces: Record<string, string>, depth: number, metadata = false): void => {
    if (depth > 256) throw new Error('SVG 嵌套超过限制');
    for (const node of nodes) for (const [name, children] of Object.entries(node)) {
      if (name === ':@' || name.startsWith('#')) continue;
      if (++elements > 50000 || !Array.isArray(children)) throw new Error('SVG 元素超过限制');
      const attrs = (node[':@'] ?? {}) as Record<string, string>;
      const ns = { ...namespaces };
      for (const [key, value] of Object.entries(attrs)) if (key === '@_xmlns') ns[''] = value; else if (key.startsWith('@_xmlns:')) ns[key.slice(8)] = value;
      const colon = name.indexOf(':'), local = colon < 0 ? name : name.slice(colon + 1), namespace = ns[colon < 0 ? '' : name.slice(0, colon)];
      if (depth === 0 && (local !== 'svg' || namespace !== SVG_NS)) throw new Error('导出内容不是 SVG');
      const inert = metadata && ['http://purl.org/dc/elements/1.1/', 'http://creativecommons.org/ns#', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'].includes(namespace);
      const viewMetadata = (namespace === 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd' && local === 'namedview') || (namespace === 'http://www.inkscape.org/namespaces/inkscape' && local === 'grid');
      if (!inert && !viewMetadata && !(namespace === SVG_NS && SVG_TAGS.has(local)) && !(namespace === HTML_NS && HTML_TAGS.has(local))) throw new Error('SVG 含不允许的元素');
      for (const [key, raw] of Object.entries(attrs)) {
        const attr = key.replace(/^@_/, '').split(':').at(-1)!.toLowerCase(), value = String(raw);
        if (attr.startsWith('on') || ['srcdoc', 'base', 'formaction', 'action', 'srcset', 'ping', 'dynsrc', 'lowsrc'].includes(attr)) throw new Error('SVG 不允许活动属性');
        if (['href', 'src', 'poster', 'background'].includes(attr)) resource(value);
        if (CSS_ATTRIBUTES.has(attr) || /url\s*\(/i.test(value)) css(value);
        if (depth === 0 && ['width', 'height'].includes(attr) && (!/^\d+(?:\.\d+)?(?:px)?$/.test(value) || Number(value.replace(/px$/, '')) <= 0 || Number(value.replace(/px$/, '')) > 16384)) throw new Error('SVG 尺寸超过限制');
        if (depth === 0 && attr === 'viewbox') {
          const box = value.trim().split(/[\s,]+/).map(Number);
          if (box.length !== 4 || box.some(n => !Number.isFinite(n)) || box[2] <= 0 || box[3] <= 0 || box[2] > 16384 || box[3] > 16384) throw new Error('SVG viewBox 无效');
        }
      }
      if (local === 'style') css(text(children as XmlNode[]));
      walk(children as XmlNode[], ns, depth + 1, metadata || local === 'metadata');
    }
  };
  walk(xml, {}, 0); if (!elements) throw new Error('SVG 为空'); return svg;
}
