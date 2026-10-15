import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = import.meta.dirname;
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []);

// The compiler's comment ranges ignore `//` inside strings, templates and regular expressions, which a regex scan would misread.
// 文字列・テンプレート・正規表現内の`//`を正規表現で拾うと誤判定するため、コンパイラーのコメント範囲を使う。
function commentGroups(file: string): { line: number; text: string }[] {
  const text = readFileSync(file, 'utf8'), source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node) => {
    for (const range of [...ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [], ...ts.getTrailingCommentRanges(text, node.getEnd()) ?? []]) ranges.set(range.pos, range);
    // getChildren() includes tokens such as `}`, whose leading trivia holds comments inside empty blocks that forEachChild never reaches.
    // getChildren()は`}`などのトークンも含み、空のブロック内のコメントはその前置トリビアにあるため、forEachChildでは届かない。
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  const groups: { line: number; end: number; text: string }[] = [];
  for (const range of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    const line = source.getLineAndCharacterOfPosition(range.pos).line, comment = text.slice(range.pos, range.end);
    const previous = groups.at(-1);
    // Consecutive `//` lines form one comment, so the English and Japanese lines are checked together.
    // 連続する`//`行は1つのコメントなので、英語と日本語の行をまとめて検査する。
    if (previous && range.kind === ts.SyntaxKind.SingleLineCommentTrivia && previous.text.startsWith('//') && line === previous.end + 1) {
      previous.text += `\n${comment}`; previous.end = line;
    } else groups.push({ line: line + 1, end: line, text: comment });
  }
  return groups;
}

describe('code comments', () => {
  it('write every source comment in English and Japanese', () => {
    const japanese = /[぀-ヿ㐀-鿿]/, english = /[A-Za-z]{3,}/;
    const missing = sources(root).flatMap((file) => commentGroups(file)
      .filter((group) => !japanese.test(group.text) || !english.test(group.text.replace(/`[^`]*`/g, '')))
      .map((group) => `${relative(root, file)}:${group.line} ${group.text.split('\n')[0]!.slice(0, 80)}`));
    expect(missing).toEqual([]);
  });
});
