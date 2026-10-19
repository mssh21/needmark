import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import MagicString from 'magic-string';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import type { SourceLocation } from '../shared/types.js';
import { LOOPBACK_HOSTNAMES } from '../shared/origin.js';

const attribute = 'data-needmark-source';

// Only native tags are annotated because custom components may drop unknown props; MagicString edits in place so the
// original source map and formatting survive, which regenerating code with Babel would not guarantee.
// 独自コンポーネントは未知のpropsを捨てることがあるため、ネイティブタグだけに付与する。MagicStringでその場に追記し、
// Babelでコードを再生成する方法では保証できない元のソースマップと書式を保つ。
export function instrumentJsx(code: string, file: string, origins: string[] | undefined, mapFilename = file) {
  const ast = parse(code, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript', 'decorators-legacy'] });
  const output = new MagicString(code);
  function visit(node: Node, component?: string) {
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id && /^[A-Z]/.test(node.id.name)) component = node.id.name;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /^[A-Z]/.test(node.id.name)) component = node.id.name;
    if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name)
      && node.loc && node.name.end !== null && node.name.end !== undefined
      && !node.attributes.some((item) => item.type === 'JSXAttribute' && item.name.type === 'JSXIdentifier' && item.name.name === attribute)) {
      const source: SourceLocation = { file, line: node.loc.start.line, column: node.loc.start.column + 1, ...(component ? { component } : {}) };
      // The origin check runs in the browser because one dev module is served to every origin that reaches the server.
      // 同じ開発用モジュールがサーバーに届くすべてのオリジンへ配信されるため、オリジンの確認はブラウザ側で行う。
      const value = JSON.stringify(JSON.stringify(source));
      const allowed = origins ? `${JSON.stringify(origins)}.includes(window.location.origin)` : `${JSON.stringify(LOOPBACK_HOSTNAMES)}.includes(window.location.hostname)`;
      output.appendLeft(node.end! - (node.selfClosing ? 2 : 1), ` ${attribute}={typeof window !== "undefined" && ${allowed} ? ${value} : undefined}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child: unknown) => { if (isNode(child)) visit(child, component); });
      else if (isNode(value)) visit(value, component);
    }
  }
  visit(ast);
  return output.hasChanged() ? { code: output.toString(), map: output.generateMap({ hires: true, source: mapFilename, includeContent: true }).toString() } : undefined;
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'type' in value && typeof value.type === 'string';
}

export function instrumentHtml(html: string, file: string) {
  const document = parseHtml(html, { sourceCodeLocationInfo: true });
  const output = new MagicString(html);
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node && !['html', 'head', 'meta', 'link', 'script', 'style', 'title', 'base'].includes(node.tagName)) {
      const location = node.sourceCodeLocation?.startTag;
      if (location && !node.attrs.some((item) => item.name === attribute)) {
        const source: SourceLocation = { file, line: location.startLine, column: location.startCol };
        const value = JSON.stringify(source).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        output.appendLeft(location.startOffset + node.tagName.length + 1, ` ${attribute}="${value}"`);
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if ('content' in node) visit(node.content);
  }
  visit(document);
  return output.toString();
}

const nativeTag = /^[a-z][a-z0-9-]*$/;
// Elements that never render a visible box or are rewritten by Astro itself, so a source attribute on them is noise or breaks slots.
// 表示される箱を持たない、またはAstro自身が書き換える要素。ソース属性を付けてもノイズになるかスロットを壊す。
const astroSkipped = new Set(['html', 'head', 'meta', 'link', 'script', 'style', 'title', 'base', 'slot']);
const jsxPosition = /(?:[(=?:&|,[{>]|\breturn)\s*$/;

// Astro compiles templates itself, so the template is read as HTML and every start tag found in plain markup is annotated. Tags that
// only look like markup inside a JS string or a comparison would corrupt the expression, so a scan of the `{}` expressions
// rejects them instead of guessing from the HTML parser alone.
// Astroはテンプレートを独自にコンパイルするため、テンプレートをHTMLとして読み、通常のマークアップにある開始タグだけに付与する。
// JSの文字列や比較演算子の中にあるタグらしき文字列へ付けると式が壊れるため、HTMLパーサーの結果だけに頼らず、`{}`式の走査で除外する。
export function instrumentAstro(code: string, file: string, origins: string[] | undefined, mapFilename = file) {
  const frontmatter = code.match(/^\s*---[^\n]*\n[\s\S]*?\n---[ \t]*(?=\r?\n|$)/);
  // Blanking keeps every offset, line and column of the original while hiding code the HTML parser must not read.
  // 空白に置き換えれば、HTMLパーサーに読ませたくない部分を隠しても元のオフセット・行・列が変わらない。
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  const template = (frontmatter ? blank(frontmatter[0]) + code.slice(frontmatter[0].length) : code)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (_all, open: string, _name: string, body: string, close: string) => open + blank(body) + close);
  const guard = origins ? `${JSON.stringify(origins)}.includes(Astro.url.origin)` : `${JSON.stringify(LOOPBACK_HOSTNAMES)}.includes(Astro.url.hostname)`;
  const quoted = new Uint8Array(template.length), expressionStart = new Int32Array(template.length).fill(-1);
  for (let index = 0, depth = 0, start = -1; index < template.length; index++) {
    const char = template[index]!;
    if (depth > 0) expressionStart[index] = start;
    if (depth === 0) { if (char === '{') { depth = 1; start = index; expressionStart[index] = index; } continue; }
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '"' || char === "'" || char === '`') {
      // A quote in JSX text such as "don't" must not hide the rest of the template, so only a template literal may span lines.
      // JSX本文の"don't"のような引用符でテンプレートの残りを隠さないよう、複数行にまたがれるのはテンプレートリテラルだけにする。
      let end = index + 1;
      while (end < template.length && template[end] !== char && (char === '`' || template[end] !== '\n')) end += template[end] === '\\' ? 2 : 1;
      quoted.fill(1, index, Math.min(end + 1, template.length)); index = end;
    } else if (char === '/' && (template[index + 1] === '/' || template[index + 1] === '*')) {
      const end = template[index + 1] === '/' ? template.indexOf('\n', index) : template.indexOf('*/', index + 2) + 1;
      const stop = end > 0 ? end : template.length;
      quoted.fill(1, index, stop); index = stop - 1;
    }
  }
  const output = new MagicString(code);
  const document = parseHtml(template, { sourceCodeLocationInfo: true });
  function visit(node: DefaultTreeAdapterMap['node'], parentStart = -1) {
    let start = parentStart;
    if ('tagName' in node && node.sourceCodeLocation?.startTag) {
      const location = node.sourceCodeLocation.startTag, at = location.startOffset;
      const insideExpression = expressionStart[at]! >= 0;
      const valid = !quoted[at] && template.slice(at + 1, at + 1 + node.tagName.length) === node.tagName && nativeTag.test(node.tagName)
        && (!insideExpression || jsxPosition.test(template.slice(0, at)) || parentStart > expressionStart[at]!);
      if (valid) {
        start = at;
        if (!astroSkipped.has(node.tagName) && !node.attrs.some((item) => item.name === attribute)) {
          const source: SourceLocation = { file, line: location.startLine, column: location.startCol };
          output.appendLeft(at + node.tagName.length + 1, ` ${attribute}={${guard} ? ${JSON.stringify(JSON.stringify(source))} : undefined}`);
        }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach((child) => visit(child, start));
    if ('content' in node) visit(node.content, start);
  }
  visit(document);
  return output.hasChanged() ? { code: output.toString(), map: output.generateMap({ hires: true, source: mapFilename, includeContent: true }).toString() } : undefined;
}
