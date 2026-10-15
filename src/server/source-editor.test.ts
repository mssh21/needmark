import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceEditorUrl, type SourceEditorOptions } from './source-editor.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function project() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'needmark-editor-'))); folders.push(base);
  const root = join(base, 'project'); await mkdir(root);
  return { base, root, options: { root, editor: 'vscode' } satisfies SourceEditorOptions };
}
const location = (file: string) => ({ file, line: 1, column: 1 });

it.each(['vscode', 'cursor'] as const)('encodes a %s file URL without letting path characters become URI query, fragment or coordinate delimiters', async (editor) => {
  const { root, options } = await project();
  const file = "Panel #?日本語: special!'().tsx"; await writeFile(join(root, file), 'const a = 1;\n<button />');
  const url = new URL(await sourceEditorUrl({ ...options, editor }, { file, line: 2, column: 4 }));
  expect(url.protocol).toBe(`${editor}:`); expect(url.host).toBe('file'); expect(url.search).toBe(''); expect(url.hash).toBe('');
  expect(url.pathname).toContain('%20'); expect(url.pathname).toContain('%23'); expect(url.pathname).toContain('%3F'); expect(url.pathname).toContain('%3A');
  expect(url.pathname).toContain('%27'); expect(url.pathname).toContain('%28'); expect(url.pathname).toContain('%29');
  expect(decodeURIComponent(url.pathname.replace(/:2:4$/, ''))).toBe(join(root, file));
});

it('resolves Vite working-directory-relative annotations while constraining them to the project, and supports proxy-root-relative paths', async () => {
  const { base, root, options } = await project(); await mkdir(join(root, 'src')); await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'src', 'Panel.tsx'), '<button />');
  const direct = await sourceEditorUrl(options, location('src/Panel.tsx'));
  expect(await sourceEditorUrl({ ...options, sourceRoot: base }, location('project/src/Panel.tsx'))).toBe(direct);
  expect(await sourceEditorUrl({ ...options, sourceRoot: join(root, 'scripts') }, location('../src/Panel.tsx'))).toBe(direct);
  await writeFile(join(base, 'outside.tsx'), '<button />');
  await expect(sourceEditorUrl({ ...options, sourceRoot: base }, location('outside.tsx'))).rejects.toThrow('not allowed');
  await expect(sourceEditorUrl(options, location('../outside.tsx'))).rejects.toThrow('not allowed');
});

it('keeps a project root symlink compatible and returns the canonical in-project file for a safe internal symlink', async () => {
  const { base, root, options } = await project();
  await writeFile(join(root, 'Card.tsx'), '<button />');
  await symlink(root, join(base, 'linked-project')); await symlink(join(root, 'Card.tsx'), join(root, 'alias.tsx'));
  expect(await sourceEditorUrl({ ...options, root: join(base, 'linked-project') }, location('Card.tsx'))).toBe(await sourceEditorUrl(options, location('alias.tsx')));
});

it('rejects outside, hidden and feedback aliases after resolving their real paths', async () => {
  const { base, root, options } = await project();
  await writeFile(join(base, 'outside.tsx'), '<button />');
  await mkdir(join(root, '.hidden')); await writeFile(join(root, '.hidden', 'Secret.tsx'), '<button />');
  await mkdir(join(root, 'review-store')); await writeFile(join(root, 'review-store', 'Feedback.tsx'), '<button />');
  const outputs = { ...options, outputDir: 'review-store' };
  for (const [name, target] of [['outside.tsx', join(base, 'outside.tsx')], ['hidden.tsx', join(root, '.hidden', 'Secret.tsx')], ['feedback.tsx', join(root, 'review-store', 'Feedback.tsx')]]) {
    await symlink(target!, join(root, name!));
    await expect(sourceEditorUrl(outputs, location(name!))).rejects.toThrow('not allowed');
  }
  await symlink(join(root, 'review-store'), join(root, 'aliased-store'));
  await expect(sourceEditorUrl({ ...options, outputDir: 'aliased-store' }, location('review-store/Feedback.tsx'))).rejects.toThrow('not allowed');
});

it.each(['.env.ts', '.git/config.ts', 'node_modules/Card.tsx', 'dist/Card.tsx', 'build/Card.tsx', 'out/Card.tsx', 'coverage/Card.tsx', 'secrets/Card.tsx', 'src/private/Card.tsx', '.needmark/feedback/Card.tsx'])('rejects excluded source paths before reading %s', async (file) => {
  const { options } = await project();
  await expect(sourceEditorUrl(options, location(file))).rejects.toThrow('not allowed');
});

it('rejects directories, non-source files, missing files and oversized source', async () => {
  const { root, options } = await project();
  await mkdir(join(root, 'directory.tsx')); await writeFile(join(root, 'credentials.json'), '{}'); await writeFile(join(root, 'large.tsx'), 'x'.repeat(1024 * 1024 + 1));
  for (const file of ['directory.tsx', 'credentials.json', 'large.tsx']) await expect(sourceEditorUrl(options, location(file))).rejects.toThrow('not allowed');
  await expect(sourceEditorUrl(options, location('missing.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('rejects a FIFO source without waiting for a writer', async () => {
  const { root, options } = await project();
  execFileSync('mkfifo', [join(root, 'pipe.tsx')]);
  await expect(sourceEditorUrl(options, location('pipe.tsx'))).rejects.toThrow('not allowed');
});

it('checks current one-based line/UTF-16 column bounds, including CRLF and end-of-line positions', async () => {
  const { root, options } = await project(); await writeFile(join(root, 'Card.tsx'), 'ab\r\n😄c\r\n');
  expect(await sourceEditorUrl(options, { file: 'Card.tsx', line: 2, column: 4 })).toMatch(/:2:4$/);
  expect(await sourceEditorUrl(options, { file: 'Card.tsx', line: 3, column: 1 })).toMatch(/:3:1$/);
  for (const coords of [{ line: 4, column: 1 }, { line: 2, column: 5 }]) await expect(sourceEditorUrl(options, { file: 'Card.tsx', ...coords })).rejects.toThrow('outside the current file');
});

it.each([null, [], {}, { file: '', line: 1, column: 1 }, { file: ' ', line: 1, column: 1 }, { file: 'x'.repeat(1025), line: 1, column: 1 },
  { file: 'Card\u0000.tsx', line: 1, column: 1 }, { file: 'Card\n.tsx', line: 1, column: 1 }, { file: 'src\\Card.tsx', line: 1, column: 1 },
  { file: 'Card.tsx', line: 0, column: 1 }, { file: 'Card.tsx', line: 1.5, column: 1 }, { file: 'Card.tsx', line: 1000001, column: 1 },
  { file: 'Card.tsx', line: 1, column: -1 }, { file: 'Card.tsx', line: '1', column: 1 }, { file: 'Card.tsx', line: 1, column: NaN },
  { file: 'Card.tsx', line: 1, column: 1, command: 'open-editor' }])('rejects invalid editor request %j', async (input) => {
  const { options } = await project(); await expect(sourceEditorUrl(options, input)).rejects.toThrow('Invalid editor location');
});
