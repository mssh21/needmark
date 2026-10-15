import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, type InitOptions } from './init.js';
import { loadProjectConfig } from './config.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'needmark-init-')); folders.push(path); return path; }

describe('project initialization', () => {
  it.each(['en', 'ja'] as const)('persists %s in the typed config and reloads it with the shared project settings', async (language) => {
    const directory = await temporary();
    await initialize(directory, { share: 'local', capture: 'none', language });
    const settings = await loadProjectConfig(directory);
    expect(settings).toEqual({ language, capture: 'none', outputDir: '.needmark/feedback' });
    expect(await readFile(join(directory, 'needmark.config.ts'), 'utf8')).toContain('satisfies NeedMarkOptions');
  });

  it.each(['fr', 'EN', ' ja', '', null, ['en']] as const)('rejects invalid language %j before creating config or editing ignore rules', async (language) => {
    const directory = await temporary();
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    await expect(initialize(directory, { share: 'local', capture: 'dom', language } as unknown as InitOptions)).rejects.toThrow('Invalid NeedMark language');
    await expect(readFile(join(directory, 'needmark.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('keeps existing legacy feedback private and selects its folder without moving the files', async () => {
    const directory = await temporary(), legacy = join(directory, '.needback/feedback');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'preserved.png'), 'image bytes');
    await initialize(directory, { share: 'local', capture: 'dom' });
    expect(await readFile(join(directory, 'needmark.config.ts'), 'utf8')).toContain("outputDir: '.needback/feedback'");
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toContain('/.needback/');
    expect(await readFile(join(legacy, 'preserved.png'), 'utf8')).toBe('image bytes');
    await expect(readFile(join(directory, '.needmark/feedback/preserved.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not create conflicting settings or change ignore rules when a legacy config exists', async () => {
    const directory = await temporary();
    const config = "export default { origins: ['http://localhost:5173'], capture: 'none' };\n";
    await writeFile(join(directory, 'needback.config.ts'), config);
    await writeFile(join(directory, '.gitignore'), '.needback/\n');
    await expect(initialize(directory, { share: 'git', capture: 'dom' })).rejects.toThrow('Existing needback.config.ts');
    expect(await readFile(join(directory, 'needback.config.ts'), 'utf8')).toBe(config);
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('.needback/\n');
    await expect(readFile(join(directory, 'needmark.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('creates settings without an origin allowlist, keeps local feedback ignored and preserves existing rules', async () => {
    const directory = await temporary();
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n.env');
    await initialize(directory, { share: 'local', capture: 'none' });
    const config = await readFile(join(directory, 'needmark.config.ts'), 'utf8');
    expect(config).not.toContain('origins');
    expect(config).toContain('capture: "none"');
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toContain('node_modules/\n.env\n');
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toContain('/.needmark/');
    await expect(initialize(directory, { share: 'git', capture: 'tab' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(directory, 'needmark.config.ts'), 'utf8')).toBe(config);
  });

  it('adds narrow Git sharing overrides', async () => {
    const directory = await temporary();
    await initialize(directory, { share: 'git', capture: 'dom' });
    const ignore = await readFile(join(directory, '.gitignore'), 'utf8');
    expect(ignore).toContain('!/.needmark/feedback/**');
    expect(ignore).toContain('/.needmark/*');
  });
});
