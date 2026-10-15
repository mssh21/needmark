import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectConfig } from './config.js';
import { initialize } from './init.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'needmark-config-')); folders.push(path); return path; }

describe('project configuration loading', () => {
  it('returns empty settings for a missing cwd file without searching an initialized parent', async () => {
    const directory = await temporary();
    expect(await loadProjectConfig(directory)).toEqual({});
    await initialize(directory, { share: 'local', capture: 'none' });
    const child = join(directory, 'child'); await mkdir(child);
    expect(await loadProjectConfig(child)).toEqual({});
  });

  it('loads the actual initializer-generated TypeScript settings', async () => {
    const directory = await temporary();
    await initialize(directory, { share: 'local', capture: 'none' });
    expect(await loadProjectConfig(directory)).toEqual({
      language: 'ja', capture: 'none', outputDir: '.needmark/feedback',
    });
  });

  it('loads the legacy cwd config when the canonical file is absent without rewriting it', async () => {
    const directory = await temporary(), source = "export default { capture: 'none', outputDir: '.needback/feedback' };";
    await writeFile(join(directory, 'needback.config.ts'), source);
    expect(await loadProjectConfig(directory)).toEqual({ capture: 'none', outputDir: '.needback/feedback' });
    expect(await readFile(join(directory, 'needback.config.ts'), 'utf8')).toBe(source);
    await expect(readFile(join(directory, 'needmark.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prefers the canonical file without executing an existing legacy config', async () => {
    const directory = await temporary(), legacy = "throw new Error('Legacy settings must not execute');";
    await writeFile(join(directory, 'needmark.config.ts'), "export default { outputDir: 'reviews/current' };");
    await writeFile(join(directory, 'needback.config.ts'), legacy);
    expect(await loadProjectConfig(directory)).toEqual({ outputDir: 'reviews/current' });
    expect(await readFile(join(directory, 'needback.config.ts'), 'utf8')).toBe(legacy);
  });

  it('rejects a canonical directory without falling back to the legacy config', async () => {
    const directory = await temporary();
    await mkdir(join(directory, 'needmark.config.ts'));
    await writeFile(join(directory, 'needback.config.ts'), "export default { capture: 'none' };");
    await expect(loadProjectConfig(directory)).rejects.toThrow('Could not load needmark.config.ts: needmark.config.ts must be a file.');
  });

  it('rejects a broken canonical symlink without falling back to the legacy config', async () => {
    const directory = await temporary();
    await symlink(join(directory, 'missing.ts'), join(directory, 'needmark.config.ts'));
    await writeFile(join(directory, 'needback.config.ts'), "export default { capture: 'none' };");
    await expect(loadProjectConfig(directory)).rejects.toThrow(/^Could not load needmark\.config\.ts:/);
  });

  it('identifies the legacy filename when its fallback export is invalid', async () => {
    const directory = await temporary();
    await writeFile(join(directory, 'needback.config.ts'), 'export default [];');
    await expect(loadProjectConfig(directory)).rejects.toThrow('Could not load needback.config.ts: The default export must be a settings object.');
  });

  it('loads relative TypeScript imports and retains callbacks without invoking them during loading', async () => {
    const directory = await temporary(), helper = join(directory, 'config'); await mkdir(helper);
    await writeFile(join(helper, 'settings.ts'), `import { writeFile } from 'node:fs/promises';
import type { FeedbackChangeEvent, FeedbackSubmission } from '@needmark/kit';
export const settings = { capture: 'none' as const, outputDir: 'reviews/team', editor: 'cursor' as const, contextAttributes: ['data-ticket'] };
export async function onFeedbackChange(event: FeedbackChangeEvent) { await writeFile(new URL('./changed.json', import.meta.url), JSON.stringify(event)); }
export async function onSubmit(submission: FeedbackSubmission) { await writeFile(new URL('./submitted.json', import.meta.url), JSON.stringify(submission)); }
`);
    await writeFile(join(directory, 'needmark.config.ts'), `import type { NeedMarkOptions } from '@needmark/kit';
import { settings, onFeedbackChange, onSubmit } from '../config/settings.ts';
export default { ...settings, onFeedbackChange, onSubmit } satisfies Partial<NeedMarkOptions>;
`);
    const config = await loadProjectConfig(directory);
    expect(config).toMatchObject({ capture: 'none', outputDir: 'reviews/team', editor: 'cursor', contextAttributes: ['data-ticket'] });
    expect(typeof config.onFeedbackChange).toBe('function'); expect(typeof config.onSubmit).toBe('function');
    for (const name of ['changed.json', 'submitted.json']) await expect(readFile(join(helper, name))).rejects.toMatchObject({ code: 'ENOENT' });
    const event = { type: 'deleted' as const, id: 'controlled-id', directory: 'reviews/team' };
    const submission = { feedback: [], prompt: 'Controlled local submission', directory: 'reviews/team', detail: 'compact' as const };
    await config.onFeedbackChange!(event); await config.onSubmit!(submission);
    expect(JSON.parse(await readFile(join(helper, 'changed.json'), 'utf8'))).toEqual(event);
    expect(JSON.parse(await readFile(join(helper, 'submitted.json'), 'utf8'))).toEqual(submission);
  });

  it.each([
    ['invalid syntax', "export default { capture: 'none' ; };"],
    ['missing relative dependency', "import settings from '../missing.ts'; export default settings;"],
  ])('does not silently default when the existing file has %s', async (_name, source) => {
    const directory = await temporary(); await writeFile(join(directory, 'needmark.config.ts'), source);
    await writeFile(join(directory, 'needback.config.ts'), "export default { capture: 'none' };");
    await expect(loadProjectConfig(directory)).rejects.toThrow(/^Could not load needmark\.config\.ts:/);
    expect(await readFile(join(directory, 'needmark.config.ts'), 'utf8')).toBe(source);
  });

  it.each([
    ['null', 'export default null;'],
    ['array', 'export default [];'],
    ['function', "export default () => ({ capture: 'none' });"],
    ['named-only export', "export const capture = 'none';"],
  ])('rejects a %s export instead of treating it as settings', async (_name, source) => {
    const directory = await temporary(); await writeFile(join(directory, 'needmark.config.ts'), source);
    await expect(loadProjectConfig(directory)).rejects.toThrow('Could not load needmark.config.ts: The default export must be a settings object.');
  });
});
