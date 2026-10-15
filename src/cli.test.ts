import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { loadProjectConfig } from './server/config.js';
import { FeedbackStore } from './server/storage.js';
import { formatFeedbackPrompt } from './shared/prompt.js';
import { input } from '../tests/fixtures.js';

const execute = promisify(execFile), folders: string[] = [];
let bundleDirectory: string, cli: string, terminal: string;
beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(process.cwd(), '.needmark-cli-test-'));
  cli = join(bundleDirectory, 'cli.mjs');
  await build({ entryPoints: ['src/cli.ts'], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
  terminal = join(bundleDirectory, 'terminal.mjs');
  await writeFile(terminal, `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const readline = createRequire(import.meta.url)('node:readline/promises');
const answers = JSON.parse(process.env.NEEDMARK_TEST_ANSWERS), questions = [];
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
readline.createInterface = () => ({ question: async (text) => { questions.push(text); return answers.shift() ?? ''; }, close: () => writeFileSync('questions.json', JSON.stringify(questions)) });
syncBuiltinESMExports();
`);
});
afterAll(async () => { if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true }); });
afterEach(async () => { await Promise.all(folders.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), 'needmark-cli-'))); folders.push(directory); return directory; }
const run = (directory: string, args: string[], answers?: string[]) => execute(process.execPath,
  [...(answers ? ['--import', terminal] : []), cli, ...args],
  { cwd: directory, timeout: 10_000, env: { ...process.env, ...(answers ? { NEEDMARK_TEST_ANSWERS: JSON.stringify(answers) } : {}) } });

describe('CLI language configuration', () => {
  it.each([undefined, 'en', 'ja'] as const)('persists the %s initialization choice without a terminal', async (language) => {
    const directory = await temporary();
    const result = await run(directory, ['init', ...(language ? [`--language=${language}`] : [])]);
    expect(await loadProjectConfig(directory)).toEqual({ language: language ?? 'ja', capture: 'dom', outputDir: '.needmark/feedback' });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(language === 'en' ? 'Created needmark.config.ts' : 'needmark.config.tsを作成しました');
  });

  it.each(['fr', 'EN', 'en-US', ' ja'])('rejects language flag %j before writing any settings', async (language) => {
    const directory = await temporary();
    await writeFile(join(directory, '.gitignore'), 'preserved/\n');
    await expect(run(directory, ['init', `--language=${language}`])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Use en or ja') });
    await expect(readFile(join(directory, 'needmark.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('preserved/\n');
  });

  it.each(['en', 'ja'] as const)('selects %s before the other terminal questions and persists the answer', async (language) => {
    const directory = await temporary();
    await run(directory, ['init'], [language, 'git', 'none']);
    expect(await loadProjectConfig(directory)).toEqual({ language, capture: 'none', outputDir: '.needmark/feedback' });
    const questions = JSON.parse(await readFile(join(directory, 'questions.json'), 'utf8')) as string[];
    expect(questions).toHaveLength(3);
    expect(questions[0]).toContain('Language / 言語');
    expect(questions[1]).toContain(language === 'en' ? 'Feedback storage' : 'コメントの保存先');
  });

  it('uses the language flag for terminal questions without asking for it again', async () => {
    const directory = await temporary();
    await run(directory, ['init', '--language=en'], ['', '']);
    expect(await loadProjectConfig(directory)).toMatchObject({ language: 'en', capture: 'dom' });
    expect(JSON.parse(await readFile(join(directory, 'questions.json'), 'utf8'))).toHaveLength(2);
  });

  it('rejects an unsupported terminal language before asking about or writing project settings', async () => {
    const directory = await temporary();
    await expect(run(directory, ['init'], ['fr'])).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(join(directory, 'questions.json'), 'utf8'))).toHaveLength(1);
    await expect(readFile(join(directory, 'needmark.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([{ args: [] }, { args: ['help'] }, { args: ['--help'] }, { args: ['unknown'] }])('does not import trusted settings for help invocation $args', async ({ args }) => {
    const directory = await temporary();
    await writeFile(join(directory, 'needmark.config.ts'), "import { writeFileSync } from 'node:fs'; writeFileSync('executed.txt', 'unsafe'); throw new Error('Settings executed');");
    if (args[0] === 'unknown') await expect(run(directory, args)).rejects.toMatchObject({ code: 1, stderr: '' });
    else await expect(run(directory, args)).resolves.toMatchObject({ stderr: '' });
    await expect(readFile(join(directory, 'executed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['en', 'ja'] as const)('keeps %s-configured machine JSON and saved comment text unchanged while updating statuses', async (language) => {
    const directory = await temporary();
    await writeFile(join(directory, 'needmark.config.ts'), `export default { language: '${language}', outputDir: 'reviews' };`);
    const store = new FeedbackStore(join(directory, 'reviews'));
    const saved = await store.save({ ...input(), comment: 'Keep 日本語 and English as typed.' });
    const result = await run(directory, ['resolve', saved.id]);
    expect(result.stdout).toContain(language === 'en' ? 'resolved' : '解決済み');
    const listed = JSON.parse((await run(directory, ['list'])).stdout);
    expect(listed).toEqual([{ ...saved, status: 'resolved', updatedAt: expect.any(String), files: `${store.directory}/${saved.id}` }]);
    expect((await store.read(saved.id)).comment).toBe(saved.comment);
    const edited = JSON.parse((await run(directory, ['edit', saved.id, 'An unchanged 更新 comment.'])).stdout);
    expect(edited.comment).toBe('An unchanged 更新 comment.');
    expect((await store.read(saved.id)).comment).toBe(edited.comment);
  });

  it('rejects invalid config language on commands that load settings but retains config-free explicit directories', async () => {
    const directory = await temporary();
    await writeFile(join(directory, 'needmark.config.ts'), "export default { language: 'fr', outputDir: 'reviews' };");
    await expect(run(directory, ['list'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Use en or ja') });
    expect(JSON.parse((await run(directory, ['list', 'reviews'])).stdout)).toEqual([]);
  });

  it.each([undefined, 'en', 'ja'] as const)('exports the configured %s AI instruction language without changing saved feedback', async (language) => {
    const directory = await temporary();
    await writeFile(join(directory, 'needmark.config.ts'), `export default { ${language ? `language: '${language}',` : ''} outputDir: 'reviews' };`);
    const store = new FeedbackStore(join(directory, 'reviews')), saved = await store.save({ ...input(), comment: 'Keep the original 日本語 request.' });
    const file = join(store.directory, saved.id, 'context.json'), before = await readFile(file);
    const result = await run(directory, ['export', '--detail', 'compact']);
    expect(result.stdout).toBe(`${formatFeedbackPrompt([saved], 'reviews', 'compact', language)}\n`);
    expect(await readFile(file)).toEqual(before);
  });

  it.each(['en', 'ja'] as const)('lists references in %s JSON but excludes them from mixed and reference-only AI exports', async (language) => {
    const directory = await temporary();
    await writeFile(join(directory, 'needmark.config.ts'), `export default { language: '${language}', outputDir: 'reviews' };`);
    const store = new FeedbackStore(join(directory, 'reviews'));
    const reference = await store.save({ ...input(), intent: 'reference', comment: '', target: { ...input().target, selector: '#reference-only' } });
    const files = ['context.json', 'comment.md', 'screenshot.png'].map((file) => join(store.directory, reference.id, file));
    const before = await Promise.all(files.map((file) => readFile(file)));
    const listed = JSON.parse((await run(directory, ['list'])).stdout);
    expect(listed).toEqual([{ ...reference, files: `${store.directory}/${reference.id}` }]);
    for (const detail of ['compact', 'standard', 'detailed', 'forensic'] as const) {
      const exported = await run(directory, ['export', '--detail', detail]);
      expect(exported.stdout).toBe(`${language === 'ja' ? '修正依頼が選択されていません。' : 'No repair requests selected.'}\n`);
      expect(exported.stdout).not.toContain(reference.id);
    }
    await expect(run(directory, ['edit', reference.id, 'Turn this reference into a repair'])).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('Target reference comments cannot be edited'),
    });
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
    const repair = await store.save({ ...input(), comment: 'Fix the actual issue' });
    for (const detail of ['compact', 'standard', 'detailed', 'forensic'] as const) {
      expect((await run(directory, ['export', '--detail', detail])).stdout).toBe(`${formatFeedbackPrompt([repair], 'reviews', detail, language)}\n`);
    }
    await run(directory, ['resolve', reference.id]);
    expect((await store.read(reference.id)).status).toBe('resolved');
    expect(JSON.parse((await run(directory, ['list'])).stdout)).toHaveLength(2);
    expect((await store.read(reference.id)).intent).toBe('reference');
  });
});
