import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { ArrayExpression, Node, ObjectExpression, ObjectProperty } from '@babel/types';
import MagicString from 'magic-string';

/** See docs/architecture.md#connecting-the-development-server. / 仕様は docs/architecture.md#connecting-the-development-server を参照。 */
export type Connection =
  | { kind: 'edit'; framework: 'Vite' | 'Astro' | 'Next.js'; file: string; content: string; lines: string[] }
  | { kind: 'connected'; framework: 'Vite' | 'Astro' | 'Next.js'; file: string }
  | { kind: 'manual'; file?: string };
export interface Change { file: string; content: string; lines: string[] }

const importLine = "import { needmark } from 'needmark';";
const wrapper = 'needmark dev -- ';
const configFile = (directory: string, base: string) => ['ts', 'mts', 'js', 'mjs'].map((extension) => `${base}.config.${extension}`).find((name) => existsSync(join(directory, name)));

// Lines are compared as a multiset rather than with a full diff, because an edit here only adds or removes a few whole lines or one fragment of a line.
// ここでの編集は数行の追加・削除か1行の一部だけなので、本格的な差分ではなく行の多重集合で比べる。
function changedLines(before: string, after: string): string[] {
  const remaining = new Map<string, number>();
  for (const line of before.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  return after.split('\n').filter((line) => { const count = remaining.get(line) ?? 0; remaining.set(line, count - 1); return count <= 0; });
}

const parseModule = (code: string) => parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program;
function unwrap(node: Node | null | undefined): Node | undefined {
  while (node && (node.type === 'TSSatisfiesExpression' || node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')) node = node.expression;
  return node ?? undefined;
}

// Configs are written as `defineConfig({...})`, a plain object, a named constant or an arrow function returning the object; anything else is left for the person to edit, because guessing would risk breaking their config.
// 設定は`defineConfig({...})`、素のオブジェクト、名前付きの定数、オブジェクトを返すアロー関数のいずれかで書かれる。それ以外は推測で壊さないよう、本人に編集を任せる。
function configObject(code: string): ObjectExpression | undefined {
  const program = parseModule(code);
  const exported = program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  let node = exported ? unwrap(exported.declaration) : undefined;
  if (node?.type === 'Identifier') {
    const name = node.name;
    for (const statement of program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'VariableDeclaration') continue;
      const found = declaration.declarations.find((item) => item.id.type === 'Identifier' && item.id.name === name);
      if (found) node = unwrap(found.init);
    }
  }
  if (node?.type === 'CallExpression' && node.arguments.length === 1) node = unwrap(node.arguments[0]);
  if (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') {
    const body = node.body;
    if (body.type === 'BlockStatement') {
      const returned = body.body.filter((statement) => statement.type === 'ReturnStatement');
      node = returned.length === 1 ? unwrap(returned[0]!.argument) : undefined;
    } else node = unwrap(body);
  }
  return node?.type === 'ObjectExpression' ? node : undefined;
}
function property(object: ObjectExpression, name: string): ObjectProperty | undefined {
  return object.properties.find((item): item is ObjectProperty => item.type === 'ObjectProperty' && !item.computed
    && ((item.key.type === 'Identifier' && item.key.name === name) || (item.key.type === 'StringLiteral' && item.key.value === name)));
}
function addProperty(output: MagicString, code: string, object: ObjectExpression, text: string) {
  const first = object.properties[0];
  if (!first) { output.overwrite(object.start!, object.end!, `{ ${text} }`); return; }
  const gap = code.slice(object.start! + 1, first.start!);
  output.prependLeft(first.start!, gap.includes('\n') ? `${text},\n${gap.slice(gap.lastIndexOf('\n') + 1)}` : `${text}, `);
}
function addPlugin(output: MagicString, array: ArrayExpression) {
  const first = array.elements[0];
  if (first) output.prependLeft(first.start!, 'needmark(), ');
  else output.overwrite(array.start!, array.end!, '[needmark()]');
}

function connectConfig(code: string, framework: 'Vite' | 'Astro'): string | undefined {
  const object = configObject(code);
  if (!object) return;
  const output = new MagicString(code);
  let target = object;
  if (framework === 'Astro') {
    const vite = property(object, 'vite');
    if (!vite) addProperty(output, code, object, 'vite: { plugins: [needmark()] }');
    else if (vite.value.type === 'ObjectExpression') target = vite.value;
    else return;
  }
  if (framework === 'Vite' || target !== object) {
    const plugins = property(target, 'plugins');
    if (!plugins) addProperty(output, code, target, 'plugins: [needmark()]');
    else if (plugins.value.type === 'ArrayExpression') addPlugin(output, plugins.value);
    else return;
  }
  const imports = parseModule(code).body.filter((node) => node.type === 'ImportDeclaration');
  if (imports.length) output.appendRight(imports.at(-1)!.end!, `\n${importLine}`);
  else output.prepend(`${importLine}\n`);
  return output.toString();
}
const importsNeedMark = (code: string) => parseModule(code).body.some((node) => node.type === 'ImportDeclaration' && node.source.value === 'needmark');

async function packageScript(directory: string): Promise<{ raw: string; dev: string; pattern: RegExp } | undefined> {
  const path = join(directory, 'package.json');
  if (!existsSync(path)) return;
  const raw = await readFile(path, 'utf8');
  const dev = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts?.dev;
  if (typeof dev !== 'string') return;
  // Replacing the encoded string in the file keeps the person's formatting, which re-serializing package.json would not.
  // ファイル中のエンコード済み文字列を置き換えれば、package.jsonを再シリアライズする場合と違い本人の書式を保てる。
  return { raw, dev, pattern: new RegExp(`("dev"\\s*:\\s*)${JSON.stringify(dev).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) };
}

export async function planConnection(directory: string): Promise<Connection> {
  for (const [base, framework] of [['astro', 'Astro'], ['vite', 'Vite']] as const) {
    const file = configFile(directory, base);
    if (!file) continue;
    const code = await readFile(join(directory, file), 'utf8');
    try {
      if (importsNeedMark(code)) return { kind: 'connected', framework, file };
      const content = connectConfig(code, framework);
      return content ? { kind: 'edit', framework, file, content, lines: changedLines(code, content) } : { kind: 'manual', file };
    } catch { return { kind: 'manual', file }; } /* A config the parser cannot read is left untouched. / パーサーが読めない設定には手を付けない。 */
  }
  const script = await packageScript(directory);
  if (!script || !/(^|[\s;&|])next\s+dev\b/.test(script.dev)) return { kind: 'manual' };
  if (script.dev.startsWith(wrapper)) return { kind: 'connected', framework: 'Next.js', file: 'package.json' };
  const content = script.raw.replace(script.pattern, (_match, key: string) => key + JSON.stringify(wrapper + script.dev));
  return content === script.raw ? { kind: 'manual', file: 'package.json' } : { kind: 'edit', framework: 'Next.js', file: 'package.json', content, lines: changedLines(script.raw, content) };
}

// Removal widens a range to whole lines only when the node had its line to itself, so code sharing that line is never deleted.
// 削除範囲を行全体へ広げるのはノードが単独で行を占めていた場合だけにし、同じ行のほかのコードを消さないようにする。
function wholeLines(code: string, start: number, end: number): [number, number] {
  const lineStart = code.lastIndexOf('\n', start - 1) + 1, lineEnd = code.indexOf('\n', end);
  const after = lineEnd === -1 ? code.length : lineEnd;
  return code.slice(lineStart, start).trim() === '' && code.slice(end, after).trim() === '' ? [lineStart, lineEnd === -1 ? after : lineEnd + 1] : [start, end];
}
function removeProperty(output: MagicString, code: string, node: ObjectProperty) {
  const comma = code.slice(node.end!).match(/^\s*,/);
  output.remove(...wholeLines(code, node.start!, node.end! + (comma ? comma[0].length : 0)));
}

function disconnectConfig(code: string): string {
  const program = parseModule(code), output = new MagicString(code);
  for (const node of program.body) if (node.type === 'ImportDeclaration' && node.source.value === 'needmark') output.remove(...wholeLines(code, node.start!, node.end!));
  const isCall = (node: Node | null) => node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'needmark';
  const visit = (node: Node, parents: Node[]) => {
    if (node.type === 'ArrayExpression' && node.elements.some(isCall)) {
      const kept = node.elements.filter((element) => !isCall(element));
      const owner = parents.at(-1), object = parents.at(-2), outer = parents.at(-3);
      if (!kept.length && owner?.type === 'ObjectProperty' && object?.type === 'ObjectExpression') {
        // An emptied `vite: { plugins: [] }` is what connecting added to an Astro config without a vite option, so it goes as a whole.
        // 空になった`vite: { plugins: [] }`は、viteオプションのないAstroの設定に接続時に足したものなので、まとめて消す。
        if (object.properties.length === 1 && outer?.type === 'ObjectProperty') removeProperty(output, code, outer);
        else if (object.properties.length === 1) output.overwrite(object.start!, object.end!, '{}');
        else removeProperty(output, code, owner);
        return;
      }
      node.elements.forEach((element, index) => {
        if (!isCall(element)) return;
        const next = node.elements[index + 1], previous = node.elements[index - 1];
        if (next) output.remove(element!.start!, next.start!);
        else if (previous) output.remove(previous.end!, element!.end!);
        else output.remove(element!.start!, element!.end!);
      });
      return;
    }
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child as Node, [...parents, node]);
    }
  };
  visit(program, []);
  return output.toString();
}

export async function planDisconnection(directory: string): Promise<Change[]> {
  const changes: Change[] = [];
  for (const base of ['astro', 'vite']) {
    const file = configFile(directory, base);
    if (!file) continue;
    const code = await readFile(join(directory, file), 'utf8');
    try {
      if (!importsNeedMark(code)) continue;
      const content = disconnectConfig(code);
      if (content !== code) changes.push({ file, content, lines: changedLines(content, code) });
    } catch { /* A config the parser cannot read is left untouched. / パーサーが読めない設定には手を付けない。 */ }
  }
  const script = await packageScript(directory);
  if (script?.dev.startsWith(wrapper)) {
    const content = script.raw.replace(script.pattern, (_match, key: string) => key + JSON.stringify(script.dev.slice(wrapper.length)));
    if (content !== script.raw) changes.push({ file: 'package.json', content, lines: changedLines(content, script.raw) });
  }
  return changes;
}

