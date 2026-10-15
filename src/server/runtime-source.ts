import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { open, realpath, stat } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultFeedbackDirectory, InputError } from './storage.js';
import { identifyingContextAttributes } from '../shared/context-attributes.js';
import type { RuntimeSourceRequest, RuntimeSourceResult, SourceLocation } from '../shared/types.js';

const maxAsset = 4 * 1024 * 1024, maxMap = 8 * 1024 * 1024, maxFile = 1024 * 1024;
const within = (root: string, file: string) => { const path = relative(root, file); return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;

function validateRequest(value: unknown): RuntimeSourceRequest {
  if (!record(value) || !Array.isArray(value.elements) || value.elements.length > 12) throw new InputError('Invalid runtime source request');
  for (const element of value.elements) {
    if (!record(element) || !text(element.tag, 100) || !/^[a-z][a-z\d-]*$/.test(element.tag) || !record(element.attributes)
      || Object.keys(element.attributes).length > 20 || Object.entries(element.attributes).some(([key, value]) => !text(key, 100) || typeof value !== 'string' || value.length > 500)
      || !Array.isArray(element.frames) || element.frames.length > 5) throw new InputError('Invalid runtime source element');
    for (const frame of element.frames) {
      if (!record(frame) || !text(frame.url, 2048) || !Number.isSafeInteger(frame.line) || Number(frame.line) < 1 || Number(frame.line) > 1_000_000
        || !Number.isSafeInteger(frame.column) || Number(frame.column) < 1 || Number(frame.column) > 1_000_000
        || frame.component !== undefined && !text(frame.component, 100)) throw new InputError('Invalid runtime source frame');
    }
  }
  return value as unknown as RuntimeSourceRequest;
}

// A source map line can be stale after edits, so the current file is re-parsed and a location is trusted only when
// literal identifiers match exactly one JSX opening; any spread or dynamic value makes it a file hint instead.
// 編集後はソースマップの行がずれ得るため、現在のファイルを解析し直し、リテラルの識別子が1つのJSX開始タグだけに一致したときに限り位置を信頼する。
// スプレッドや動的な値があればファイルの手掛かりにとどめる。
function exactJsx(code: string, file: string, element: RuntimeSourceRequest['elements'][number], identifiers: readonly string[]): SourceLocation | undefined {
  const wanted = identifiers.filter((key) => Object.hasOwn(element.attributes, key) && typeof element.attributes[key] === 'string' && element.attributes[key] !== '');
  if (!wanted.length) return;
  const ast = parse(code, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript', 'decorators-legacy'] });
  const matches: SourceLocation[] = []; let uncertain = false;
  function visit(node: Node, component?: string) {
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id && /^[A-Z]/.test(node.id.name)) component = node.id.name;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /^[A-Z]/.test(node.id.name)) component = node.id.name;
    if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXIdentifier' && node.name.name === element.tag && node.loc) {
      const literals: Record<string, string | undefined> = {};
      for (const attribute of node.attributes) {
        if (attribute.type === 'JSXSpreadAttribute') { for (const key of identifiers) literals[key] = undefined; continue; }
        if (attribute.name.type !== 'JSXIdentifier' || !identifiers.includes(attribute.name.name)) continue;
        const value = attribute.value?.type === 'StringLiteral' ? attribute.value
          : attribute.value?.type === 'JSXExpressionContainer' && attribute.value.expression.type === 'StringLiteral' ? attribute.value.expression : undefined;
        literals[attribute.name.name] = value?.value;
      }
      const known = wanted.filter((key) => Object.hasOwn(literals, key) && literals[key] !== undefined);
      const unknown = wanted.some((key) => Object.hasOwn(literals, key) && literals[key] === undefined);
      if (known.every((key) => element.attributes[key] === literals[key])) {
        if (unknown) uncertain = true;
        if (known.length && !unknown) matches.push({ file, line: node.loc.start.line, column: node.loc.start.column + 1, ...(component ? { component } : {}) });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child: unknown) => { if (isNode(child)) visit(child, component); });
      else if (isNode(value)) visit(value, component);
    }
  }
  visit(ast);
  return !uncertain && matches.length === 1 ? matches[0] : undefined;
}
function isNode(value: unknown): value is Node { return record(value) && typeof value.type === 'string'; }

export interface RuntimeSourceOptions { root: string; target: string; origins: string[]; outputDir?: string; contextAttributes?: string[] }

/** Assets are fetched only from the fixed loopback target, never from URLs supplied by the page, so a request cannot make the server fetch elsewhere. / ページから渡されたURLではなく固定のループバック先からだけ取得し、要求によってサーバーに任意の場所を取得させない。 */
export function createRuntimeSourceResolver(options: RuntimeSourceOptions) {
  const identifiers = identifyingContextAttributes(options.contextAttributes);
  const target = new URL(options.target);
  if (options.target !== target.origin || target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Runtime source target must be an exact loopback HTTP origin.');
  const origins = new Set([target.origin, ...options.origins]);
  const root = realpath(resolve(options.root)).catch(() => undefined);
  const output = resolve(options.root, options.outputDir ?? defaultFeedbackDirectory(options.root));
  const privateOutput = realpath(output).catch(() => output);

  function assetUrl(value: string, base: URL, extension: RegExp, frame = false): URL | undefined {
    if (frame && !/^https?:\/\//.test(value)) return;
    if (value.length > 2048 || /[\\\u0000-\u001f]/.test(value)) return;
    let decoded: string; try { decoded = decodeURIComponent(value); } catch { return; }
    if (/[\\\u0000-\u001f]/.test(decoded) || frame && /\/(?:\.|\.\.)(?:\/|$|\?)/.test(decoded)) return;
    let url: URL; try { url = new URL(value, base); } catch { return; }
    if (!origins.has(url.origin) || url.username || url.password || url.hash || !extension.test(url.pathname)) return;
    const path = decodeURIComponent(url.pathname), parts = path.split('/');
    if (parts.some((part) => part.startsWith('.') || part === '__needmark') || path.includes(output.replaceAll('\\', '/'))) return;
    const privatePath = relative(resolve(options.root), output).replaceAll('\\', '/');
    if (privatePath && path.startsWith(`/${privatePath}/`)) return;
    return new URL(url.pathname + url.search, target);
  }

  async function sourceFile(source: string): Promise<{ absolute: string; file: string } | undefined> {
    const projectRoot = await root; if (!projectRoot) return;
    let file: string;
    if (source.startsWith('file:')) {
      const url = new URL(source); if (url.search || url.hash) return; file = fileURLToPath(url);
    } else if (/^(?:webpack|turbopack):/.test(source)) {
      const url = new URL(source); if (url.search || url.hash) return;
      file = resolve(projectRoot, decodeURIComponent(url.pathname).replace(/^\/(?:\[project\]\/|\.\/)?/, ''));
    } else if (!/^[a-z][\w+.-]*:/i.test(source)) {
      file = resolve(projectRoot, source.replace(/^\[project\]\//, ''));
    } else return;
    const absolute = await realpath(file), name = relative(projectRoot, absolute).replaceAll('\\', '/');
    const parts = name.split('/');
    if (!(await stat(absolute)).isFile()) return;
    if (!within(projectRoot, absolute) || !/\.[cm]?[jt]sx?$/i.test(name) || parts.some((part) => part.startsWith('.') || ['node_modules', 'dist', 'build', 'out'].includes(part))
      || absolute === await privateOutput || within(await privateOutput, absolute)) return;
    return { absolute, file: name };
  }

  return async (input: unknown): Promise<{ elements: RuntimeSourceResult[] }> => {
    const request = validateRequest(input);
    const controller = new AbortController(), results: RuntimeSourceResult[] = request.elements.map(() => ({}));
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<{ elements: RuntimeSourceResult[] }>((done) => {
      timeout = setTimeout(() => { controller.abort(); done({ elements: results.slice() }); }, 5_000);
    });
    const maps = new Map<string, Promise<SourceMap | undefined>>(), files = new Map<string, Promise<string>>();
    async function fetchText(url: URL, maximum: number): Promise<string> {
      if (controller.signal.aborted) throw new Error('Source request timed out');
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'accept-encoding': 'identity' } });
      if (response.status !== 200 || Number(response.headers.get('content-length')) > maximum || !response.body) { await response.body?.cancel(); throw new Error('Source asset unavailable'); }
      const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > maximum) throw new Error('Source asset exceeds limit'); chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks).toString('utf8');
    }
    async function sourceMap(url: URL): Promise<SourceMap | undefined> {
      const code = await fetchText(url, maxAsset);
      const references = [...code.matchAll(/\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)|\/\*[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)\s*\*\//g)];
      const reference = references.at(-1)?.[1] ?? references.at(-1)?.[2]; if (!reference) return;
      let payload: string;
      if (reference.startsWith('data:')) {
        const match = reference.match(/^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/i); if (!match) return;
        if (match[1] && !/^[\w+/]*={0,2}$/.test(match[2]!)) return;
        payload = match[1] ? Buffer.from(match[2]!, 'base64').toString('utf8') : decodeURIComponent(match[2]!);
        if (Buffer.byteLength(payload) > maxMap) return;
      } else {
        const mapUrl = assetUrl(reference, url, /\.map$/i); if (!mapUrl) return; payload = await fetchText(mapUrl, maxMap);
      }
      return new SourceMap(JSON.parse(payload));
    }
    function mapFor(url: URL) {
      let pending = maps.get(url.href); if (!pending) { pending = sourceMap(url).catch(() => undefined); maps.set(url.href, pending); } return pending;
    }
    function codeFor(path: string) {
      let pending = files.get(path);
      if (!pending) {
        pending = (async () => {
          const handle = await open(path, 'r');
          try {
            const info = await handle.stat(); if (!info.isFile() || info.size > maxFile) throw new Error('Source file exceeds limit');
            const chunks: Buffer[] = []; let size = 0;
            while (true) { const buffer = Buffer.alloc(64 * 1024), result = await handle.read(buffer); if (!result.bytesRead) break; size += result.bytesRead; if (size > maxFile) throw new Error('Source file exceeds limit'); chunks.push(buffer.subarray(0, result.bytesRead)); }
            return Buffer.concat(chunks).toString('utf8');
          } finally { await handle.close(); }
        })(); files.set(path, pending);
      }
      return pending;
    }
    async function locate(element: RuntimeSourceRequest['elements'][number]): Promise<RuntimeSourceResult> {
      for (const frame of element.frames) {
        if (controller.signal.aborted) return {};
        try {
          const url = assetUrl(frame.url, target, /\.[cm]?js$/i, true); if (!url) continue;
          const map = await mapFor(url); if (!map || controller.signal.aborted) continue;
          // findOrigin interpolates across long generated segments and can land on a neighbouring line; findEntry returns the exact mapped JSX opening.
          // findOriginは長い生成区間を補間して隣の行を返すことがあるため、対応付けられたJSX開始位置そのものを返すfindEntryを使う。
          const entry = map.findEntry(frame.line - 1, frame.column - 1);
          if (!('originalSource' in entry) || !text(entry.originalSource, 4096) || !Number.isSafeInteger(entry.originalLine) || entry.originalLine < 0 || !Number.isSafeInteger(entry.originalColumn) || entry.originalColumn < 0) continue;
          const file = await sourceFile(entry.originalSource); if (!file) continue;
          const hint = { file: file.file, ...(frame.component ? { component: frame.component } : {}) };
          try {
            const source = exactJsx(await codeFor(file.absolute), file.file, element, identifiers);
            if (!controller.signal.aborted && source && (!frame.component || !source.component || frame.component === source.component)) return { source };
          } catch { /* A parse failure still leaves a useful file candidate, so fall through to the hint. / 解析に失敗してもファイル候補は役に立つため、手掛かりとして返す。 */ }
          return controller.signal.aborted ? {} : { sourceHint: hint };
        } catch { /* Source lookup is optional; a missing map or file must not fail the review request. / ソース検索は任意のため、マップやファイルが無くてもレビューの要求を失敗させない。 */ }
      }
      return {};
    }
    try {
      return await Promise.race([Promise.all(request.elements.map(async (element, index) => results[index] = await locate(element))).then((elements) => ({ elements })), deadline]);
    } finally { clearTimeout(timeout!); controller.abort(); }
  };
}
