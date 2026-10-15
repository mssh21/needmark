import { build } from 'esbuild';
import { mkdir, chmod, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts', 'src/cli.ts', 'src/proxy.ts'], outdir: 'dist',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
});
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022', minify: true, inject: ['src/client/browser-timers.ts'],
});
await chmod('dist/cli.js', 0o755);
