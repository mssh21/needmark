// Installs the packed package (or a published spec) into a fresh project per package manager and checks
// the CLI, MCP, Vite plugin and review proxy there. Usage: docs/testing.md#package-managers.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
const repo = resolve(import.meta.dirname, '..');
// Each runner except npm is fetched at a pinned major through npx, so the result does not depend on global installs or Corepack.
const pnpm = ['npx', '-y', `pnpm@${args.pnpm ?? 11}`], yarn = ['npx', '-y', `@yarnpkg/cli-dist@${args.yarn ?? 4}`], yarn1 = ['npx', '-y', 'yarn@1'];
const runners = {
  npm: { bin: ['npm'], install: (spec) => ['npm', 'install', '--save-dev', '--no-audit', '--no-fund', spec, 'vite@7'], exec: ['npx', 'needmark'], node: ['node'], hint: 'npx needmark' },
  pnpm: { bin: pnpm, install: (spec) => [...pnpm, 'add', '--save-dev', spec, 'vite@7'], exec: [...pnpm, 'exec', 'needmark'], node: ['node'], hint: 'pnpm exec needmark',
    files: { 'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n' } },
  yarn: { bin: yarn, install: (spec) => [...yarn, 'add', '--dev', spec.endsWith('.tgz') ? `needmark@file:${spec}` : spec, 'vite@7'], exec: [...yarn, 'needmark'], node: [...yarn, 'node'], hint: 'yarn needmark',
    files: { 'yarn.lock': '' } },
  yarn1: { bin: yarn1, install: (spec) => [...yarn1, 'add', '--dev', spec, 'vite@7'], exec: [...yarn1, '--silent', 'needmark'], node: ['node'], hint: 'yarn needmark',
    files: { 'yarn.lock': '' } },
};
// Yarn 4 quarantines recently published versions, which would block checking a release right after publishing it.
process.env.YARN_NPM_MINIMAL_AGE_GATE ??= '0';
const selected = (args.only ?? Object.keys(runners).join(',')).split(',');

function run(command, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; options.onStdout?.(stdout, child); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (options.input) child.stdin.end(options.input);
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 || options.allowExit ? resolvePromise({ stdout, stderr, code, signal })
      : reject(new Error(`${command.join(' ')} exited with ${code ?? signal}\n${stdout}\n${stderr}`.trim())));
  });
}

const check = `
import { createServer as createHttpServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, build } from 'vite';
import { startReviewProxy } from 'needmark/proxy';
const port = Number(process.argv[2]);
const scriptOf = (html) => html.match(/<script[^>]*src="([^"]*needmark[^"]*)"/i)?.[1] ?? html.match(/<script[^>]*data-needmark[^>]*src="([^"]+)"/i)?.[1];
async function clientServed(origin, html, label) {
  const src = scriptOf(html);
  if (!src) throw new Error(label + ': no NeedMark script in HTML');
  const response = await fetch(new URL(src, origin));
  const body = await response.text();
  if (!response.ok || body.length < 10000) throw new Error(label + ': client script ' + src + ' returned ' + response.status);
  console.log('ok ' + label + ' injects and serves the review client');
}
const server = await createServer({ server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'silent' });
await server.listen();
try { await clientServed('http://127.0.0.1:' + port, await (await fetch('http://127.0.0.1:' + port + '/')).text(), 'vite dev'); } finally { await server.close(); }
const target = createHttpServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><h1>target</h1></body></html>'); });
await new Promise((done) => target.listen(port + 1, '127.0.0.1', done));
const proxy = await startReviewProxy({ target: 'http://127.0.0.1:' + (port + 1), origin: 'http://127.0.0.1:' + (port + 2) });
try { await clientServed(proxy.origin, await (await fetch(proxy.origin + '/')).text(), 'review proxy'); } finally { await proxy.close(); target.close(); }
await build({ logLevel: 'silent' });
for (const file of await readdir('dist', { recursive: true, withFileTypes: true }))
  if (file.isFile() && /needmark/i.test(await readFile(file.parentPath + '/' + file.name, 'utf8'))) throw new Error('production build contains NeedMark: ' + file.name);
console.log('ok production build excludes NeedMark');
`;

async function mcpHandshake(runner, cwd) {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } });
  const { stdout } = await run([...runner.exec, 'mcp'], { cwd, input: `${request}\n`, allowExit: true, onStdout: (text, child) => { if (text.includes('\n')) child.kill(); } });
  const reply = JSON.parse(stdout.split('\n').find((line) => line.trim()) ?? '{}');
  if (!reply.result?.serverInfo) throw new Error(`MCP initialize returned ${stdout}`);
}

async function verify(name, runner, spec, port) {
  const cwd = join(root, name);
  await mkdir(cwd);
  const files = { 'package.json': JSON.stringify({ name: `verify-${name}`, private: true, type: 'module' }), ...runner.files,
    'index.html': '<!doctype html><html><body><h1>verify</h1><script type="module" src="/main.js"></script></body></html>', 'main.js': 'document.title = "verify";',
    'vite.config.ts': "import { defineConfig } from 'vite';\nimport { needmark } from 'needmark';\nexport default defineConfig({ plugins: [needmark()] });\n", 'check.mjs': check };
  for (const [file, content] of Object.entries(files)) await writeFile(join(cwd, file), content);
  await run(['git', 'init', '-q'], { cwd });
  const step = async (label, action) => { await action(); console.log(`  ok ${label}`); };
  await step('install', () => run(runner.install(spec), { cwd }));
  await step('--help', async () => { if (!(await run([...runner.exec, '--help'], { cwd })).stdout.includes('needmark init')) throw new Error('help text missing'); });
  await step('init', async () => {
    const { stdout } = await run([...runner.exec, 'init', '--share=local', '--capture=dom', '--language=en'], { cwd });
    if (!(await readFile(join(cwd, 'needmark.config.ts'), 'utf8')).includes('outputDir')) throw new Error('needmark.config.ts not written');
    if (!(await readFile(join(cwd, '.gitignore'), 'utf8')).includes('/.needmark/')) throw new Error('.gitignore rule not written');
    if (!stdout.includes(`${runner.hint} dev`)) throw new Error(`init guidance does not use "${runner.hint}":\n${stdout}`);
  });
  await step('list', async () => { if (!Array.isArray(JSON.parse((await run([...runner.exec, 'list'], { cwd })).stdout))) throw new Error('list did not print an array'); });
  await step('mcp initialize', () => mcpHandshake(runner, cwd));
  const { stdout } = await run([...runner.node, 'check.mjs', String(port)], { cwd });
  for (const line of stdout.trim().split('\n')) console.log(`  ${line}`);
}

const root = await mkdtemp(join(tmpdir(), 'needmark-pm-'));
let spec = args.spec;
if (!spec) {
  await run(['pnpm', 'pack', '--pack-destination', root], { cwd: repo });
  spec = join(root, (await readdir(root)).find((file) => file.endsWith('.tgz')));
}
console.log(`Package: ${spec}\nWork directory: ${root}\nNode: ${process.version}`);
const failures = [];
for (const [index, name] of selected.entries()) {
  const runner = runners[name];
  if (!runner) throw new Error(`Unknown runner ${name}; choose from ${Object.keys(runners).join(', ')}`);
  const version = (await run([...runner.bin, '--version'], { cwd: root, allowExit: true })).stdout.trim();
  console.log(`\n${name} ${version}`);
  try { await verify(name, runner, spec, 4590 + index * 10); } catch (error) { failures.push(name); console.log(`  FAIL ${error.message.split('\n').slice(0, 12).join('\n       ')}`); }
}
if (failures.length) { console.log(`\nFailed: ${failures.join(', ')} (projects kept in ${root})`); process.exit(1); }
if (!('keep' in args)) await rm(root, { recursive: true, force: true });
console.log('\nAll package managers passed.');
