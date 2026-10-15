import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '.');
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []);
const layer = (file: string) => relative(root, file).split('/')[0]!;
const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]!);

describe('source layout', () => {
  it('keeps only the public entries at the src root', () => {
    expect(sources(root).filter((file) => !relative(root, file).includes('/')).map((file) => relative(root, file)).sort()).toEqual(['cli.ts', 'index.ts', 'proxy.ts']);
  });

  it('respects runtime boundaries between shared, client and server code', () => {
    const forbidden: Record<string, string[]> = { shared: ['client', 'server', 'node:'], client: ['server', 'node:'], server: ['client'] };
    const violations = sources(root).flatMap((file) => {
      const rules = forbidden[layer(file)] ?? [];
      return imports(file).filter((specifier) => rules.some((rule) => rule === 'node:'
        ? specifier.startsWith('node:') : specifier.startsWith('.') && layer(join(file, '..', specifier)) === rule))
        .map((specifier) => `${relative(root, file)} -> ${specifier}`);
    });
    expect(violations).toEqual([]);
  });
});
