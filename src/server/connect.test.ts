import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planConnection, planDisconnection } from './connect.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function project(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'needmark-connect-')); folders.push(directory);
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  return directory;
}
async function roundTrip(files: Record<string, string>, file: string) {
  const directory = await project(files), plan = await planConnection(directory);
  if (plan.kind !== 'edit') throw new Error(`Expected an edit, got ${plan.kind}`);
  await writeFile(join(directory, file), plan.content);
  const [removal] = await planDisconnection(directory);
  return { connected: plan.content, lines: plan.lines, disconnected: removal?.content };
}

describe('connecting the development server', () => {
  it('adds the plugin first in an existing Vite plugins array and removes it again', async () => {
    const original = "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n";
    const result = await roundTrip({ 'vite.config.ts': original }, 'vite.config.ts');
    expect(result.connected).toBe("import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport { needmark } from 'needmark';\n\nexport default defineConfig({\n  plugins: [needmark(), react()],\n});\n");
    expect(result.lines).toEqual(["import { needmark } from 'needmark';", '  plugins: [needmark(), react()],']);
    expect(result.disconnected).toBe(original);
  });

  it.each([
    ['a plain object without plugins', "export default {\n  server: { port: 3000 },\n};\n", "import { needmark } from 'needmark';\nexport default {\n  plugins: [needmark()],\n  server: { port: 3000 },\n};\n"],
    ['a named constant with satisfies', "import type { UserConfig } from 'vite';\nconst config = { plugins: [] } satisfies UserConfig;\nexport default config;\n", "import type { UserConfig } from 'vite';\nimport { needmark } from 'needmark';\nconst config = { plugins: [needmark()] } satisfies UserConfig;\nexport default config;\n"],
    ['an arrow function', "import { defineConfig } from 'vite';\nexport default defineConfig(() => ({}));\n", "import { defineConfig } from 'vite';\nimport { needmark } from 'needmark';\nexport default defineConfig(() => ({ plugins: [needmark()] }));\n"],
  ])('connects %s', async (_name, original, expected) => {
    const result = await roundTrip({ 'vite.config.ts': original }, 'vite.config.ts');
    expect(result.connected).toBe(expected);
  });

  it('adds a vite option to an Astro config and removes all of it again', async () => {
    const original = "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  site: 'https://example.com',\n});\n";
    const result = await roundTrip({ 'astro.config.mjs': original, 'package.json': '{"scripts":{"dev":"astro dev"}}' }, 'astro.config.mjs');
    expect(result.connected).toContain("  vite: { plugins: [needmark()] },\n  site: 'https://example.com',");
    expect(result.disconnected).toBe(original);
  });

  it('wraps a Next.js dev script without reformatting package.json and unwraps it again', async () => {
    const original = '{\n    "name": "app",\n    "scripts": { "dev": "next dev --turbopack", "build": "next build" }\n}\n';
    const result = await roundTrip({ 'package.json': original }, 'package.json');
    expect(result.connected).toBe(original.replace('"next dev --turbopack"', '"needmark dev -- next dev --turbopack"'));
    expect(result.disconnected).toBe(original);
  });

  it('reports a connected project and leaves unknown shapes to the person', async () => {
    expect(await planConnection(await project({ 'vite.config.ts': "import { needmark } from 'needmark';\nexport default { plugins: [needmark()] };\n" }))).toMatchObject({ kind: 'connected', framework: 'Vite' });
    expect(await planConnection(await project({ 'vite.config.ts': "import base from './base';\nexport default { ...base, plugins: base.plugins };\n" }))).toEqual({ kind: 'manual', file: 'vite.config.ts' });
    expect(await planConnection(await project({ 'package.json': '{"scripts":{"dev":"webpack serve"}}' }))).toEqual({ kind: 'manual' });
  });
});
