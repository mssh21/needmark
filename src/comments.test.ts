import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

const root = import.meta.dirname;
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []);

// The parser's comment list ignores `//` inside strings, templates and regular expressions, which a regex scan would misread.
// 文字列・テンプレート・正規表現内の`//`を正規表現で拾うと誤判定するため、パーサーが集めたコメントを使う。
function commentGroups(file: string): { line: number; text: string }[] {
  const text = readFileSync(file, 'utf8');
  const groups: { line: number; end: number; text: string }[] = [];
  for (const comment of parse(text, { sourceType: 'module', plugins: ['typescript'] }).comments ?? []) {
    const line = comment.loc!.start.line, raw = text.slice(comment.start!, comment.end!);
    const previous = groups.at(-1);
    // Consecutive `//` lines form one comment, so the English and Japanese lines are checked together.
    // 連続する`//`行は1つのコメントなので、英語と日本語の行をまとめて検査する。
    if (previous && comment.type === 'CommentLine' && previous.text.startsWith('//') && line === previous.end + 1) {
      previous.text += `\n${raw}`; previous.end = line;
    } else groups.push({ line, end: comment.loc!.end.line, text: raw });
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
