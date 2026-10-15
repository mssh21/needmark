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
