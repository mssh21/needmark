import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needmarkCommand } from './package-manager.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function project(lockfiles: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'needmark-pm-')), feedback = join(root, 'apps/web/.needmark/feedback');
  folders.push(root);
  await mkdir(feedback, { recursive: true });
  for (const lockfile of lockfiles) await writeFile(join(root, lockfile), '');
  return feedback;
}

it.each([
  [['pnpm-lock.yaml'], 'pnpm exec needmark'],
  [['yarn.lock'], 'yarn needmark'],
  [['package-lock.json'], 'npx needmark'],
  [[], 'npx needmark'],
])('the nearest lockfile %j above the feedback folder selects %s', async (lockfiles, command) => {
  expect(needmarkCommand(await project(lockfiles))).toBe(command);
});

it('a workspace lockfile closer to the project wins over one further up', async () => {
  const feedback = await project(['pnpm-lock.yaml']);
  await writeFile(join(feedback, '../../yarn.lock'), '');
  expect(needmarkCommand(feedback)).toBe('yarn needmark');
});
