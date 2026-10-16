import { test, expect, saveAndList, output, tempRoot } from './support/review.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Feedback } from '../src/shared/types.js';

const cli = resolve('dist/cli.js'), execute = promisify(execFile);
test.setTimeout(45_000);

async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected an ephemeral loopback address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
async function exists(path: string) {
  try { await readFile(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

// Intentional onboarding contract: init's shared settings also govern CLI proxy and local-agent commands.
test('fresh CLI init settings govern proxy capture and one shared review directory through UI and agent commands', async ({ page }, info) => {
  const root = await mkdtemp(join(tempRoot, 'needmark-cli-onboarding-'));
  let upstream: Server | undefined, dev: ChildProcess | undefined, exited: Promise<void> | undefined;
  let stdout = '', stderr = '';
  const commands: { args: string[]; stdout: string; stderr: string }[] = [];
  const run = async (...args: string[]) => {
    const result = await execute(process.execPath, [cli, ...args], { cwd: root, timeout: 10_000 });
    commands.push({ args, stdout: result.stdout, stderr: result.stderr }); return result;
  };
  try {
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><title>NeedMark CLI onboarding</title><style>html,body{margin:0;font:16px sans-serif;background:#fff}#onboarding-target{position:absolute;left:120px;top:180px;width:220px;height:60px}output{position:absolute;left:120px;top:270px}</style></head><body><button id="onboarding-target">Review this real control</button><output aria-label="Native click count">0</output><script>document.querySelector("#onboarding-target").onclick=()=>{const count=document.querySelector("output");count.textContent=String(Number(count.textContent)+1)}</script></body></html>');
    });
    const target = await listen(upstream), reservation = createServer(), origin = await listen(reservation); await close(reservation);
    expect(origin).not.toBe(target);
    const initialized = await run('init', '--capture=none', '--share=git');
    const configPath = root + '/needmark.config.ts', generated = await readFile(configPath, 'utf8');
    expect(generated).not.toContain('origins'); expect(generated).toContain('capture: "none"');
    expect(generated.match(/outputDir: '\.needmark\/feedback'/g)).toHaveLength(1);
    const config = generated.replace("outputDir: '.needmark/feedback'", "outputDir: 'reviews'"); await writeFile(configPath, config);
    const gitignore = await readFile(root + '/.gitignore', 'utf8'); expect(gitignore).toContain('!/.needmark/feedback/**');
    dev = spawn(process.execPath, [cli, 'dev', `--target=${target}`, `--origin=${origin}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise<void>((done) => { dev!.once('close', () => done()); dev!.once('error', () => done()); });
    dev.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    dev.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    await new Promise<void>((done, reject) => {
      const child = dev!;
      const cleanup = () => { clearTimeout(timer); child.stdout!.removeListener('data', ready); child.removeListener('error', failed); child.removeListener('close', stopped); };
      const ready = () => { if (stdout.includes(`NeedMark review: ${origin}`)) { cleanup(); done(); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const stopped = (code: number | null) => { cleanup(); reject(new Error(`CLI dev exited before readiness (${code}): ${stderr}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CLI dev did not announce readiness: ${stdout}\n${stderr}`)); }, 8_000);
      child.stdout!.on('data', ready); child.once('error', failed); child.once('close', stopped); ready();
    });
    await page.goto(origin);
    const setup = await page.evaluate(async () => {
      const script = document.querySelector<HTMLScriptElement>('script[data-needmark-token]')!;
      const response = await fetch(script.dataset.needmarkEndpoint + '/feedback', { headers: { 'x-needmark-token': script.dataset.needmarkToken! } });
      return { script: { capture: script.dataset.needmarkCapture, origins: JSON.parse(script.dataset.needmarkOrigins!), endpoint: script.dataset.needmarkEndpoint },
        preference: localStorage.getItem('needmark-method'), status: response.status, feedback: await response.json() };
    });
    expect(setup.status).toBe(200); expect(setup.preference).toBeNull(); expect(setup.script.origins).toEqual([origin]);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const method = await page.getByLabel('キャプチャ方式').inputValue();
    await info.attach('fresh-cli-shared-config-preconditions.json', { body: JSON.stringify({ target, origin, generated, config, gitignore, initialized, setup, method, stdout, stderr }, null, 2), contentType: 'application/json' });
    await info.attach('fresh-cli-first-settings.png', { body: await page.screenshot({ caret: 'initial' }), contentType: 'image/png' });
    // C23 flags-only behavior ignores this generated config and initializes the fresh browser to DOM.
    await expect(page.getByLabel('キャプチャ方式')).toHaveValue('none');
    expect(setup.script.capture).toBe('none'); expect(setup.feedback).toEqual({ directory: 'reviews', command: 'npx needmark', feedback: [] });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const targetButton = page.locator('#onboarding-target'); await targetButton.click(); await expect(page.getByLabel('Native click count')).toHaveText('1');
    const original = await targetButton.elementHandle(), originalDocument = await page.evaluateHandle(() => document);
    if (!original) throw new Error('The original reviewed control is missing');
    try {
      const targetBefore = await targetButton.evaluate((element) => element.outerHTML), rect = await targetButton.boundingBox();
      if (!rect) throw new Error('The native reviewed control has no rectangle');
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      await expect(page.locator('[data-needmark] .cover')).toBeVisible(); await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const comment = '初回設定どおり画像なしで同じフォルダへ保存し、いつものAIから更新する';
      await page.getByLabel('コメント本文').fill(comment);
      const pending = page.waitForResponse((response) => response.url() === origin + '/__needmark/feedback' && response.request().method() === 'POST');
      await saveAndList(page); const response = await pending;
      expect(response.status()).toBe(201); const saved = await response.json() as Feedback;
      const directory = `${root}/reviews/${saved.id}`, context = await readFile(directory + '/context.json', 'utf8'), markdown = await readFile(directory + '/comment.md', 'utf8');
      expect(JSON.parse(context)).toEqual(saved); expect(markdown).toContain(comment);
      expect(saved.target.kind).toBe('element'); expect(saved.target.selector).toBe('#onboarding-target'); expect(saved.target.rect).toEqual(rect);
      expect(saved.capture).toEqual({ method: 'none', width: 0, height: 0 }); expect(saved.image).toBeUndefined();
      expect((await readdir(directory)).sort()).toEqual(['comment.md', 'context.json']); expect(await exists(`${root}/.needmark/feedback/${saved.id}/context.json`)).toBe(false);
      const listed = JSON.parse((await run('list')).stdout) as (Feedback & { files: string })[];
      expect(listed).toEqual([{ ...saved, files: directory }]);
      const exported = (await run('export', '--detail', 'compact')).stdout;
      expect(exported).toContain(saved.id); expect(exported).toContain(comment); expect(exported).toContain(`reviews/${saved.id}/context.json`); expect(exported).not.toContain('screenshot.png');
      const reply = '同じ共有設定を使ってAIが修正と検証を行った';
      await run('reply', saved.id, reply, '--author', 'Codex');
      const updated = JSON.parse(await readFile(directory + '/context.json', 'utf8')) as Feedback;
      expect(updated.status).toBe('open'); expect(updated.replies).toMatchObject([{ author: 'Codex', comment: reply }]);
      expect(updated.capture).toEqual(saved.capture); expect(updated.target).toEqual(saved.target);
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
      await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
      await page.locator('[data-needmark] .open-item', { hasText: comment }).click(); await expect(page.getByText(reply, { exact: true })).toBeVisible();
      const current = await page.evaluate(async () => {
        const script = document.querySelector<HTMLScriptElement>('script[data-needmark-token]')!;
        const response = await fetch(script.dataset.needmarkEndpoint + '/feedback', { headers: { 'x-needmark-token': script.dataset.needmarkToken! } });
        return { status: response.status, value: await response.json() };
      });
      expect(current).toEqual({ status: 200, value: { directory: 'reviews', command: 'npx needmark', feedback: [updated] } });
      expect(await original.evaluate((element) => element.isConnected && element === document.querySelector('#onboarding-target'))).toBe(true);
      expect(await page.evaluate((original) => original === document, originalDocument)).toBe(true);
      expect(await targetButton.evaluate((element) => element.outerHTML)).toBe(targetBefore); expect(await targetButton.boundingBox()).toEqual(rect); expect(page.url()).toBe(origin + '/');
      expect(await readFile(configPath, 'utf8')).toBe(config);
      await info.attach('cli-shared-directory-save-and-agent-handoff.json', { body: JSON.stringify({ saved, updated, context, markdown, exported, current, commands, targetBefore, rect }, null, 2), contentType: 'application/json' });
    } finally { await original.dispose(); await originalDocument.dispose(); }
  } finally {
    try { await info.attach('actual-cli-server-output.json', { body: JSON.stringify({ stdout, stderr, commands }, null, 2), contentType: 'application/json' }); }
    finally {
      if (dev && dev.exitCode === null && dev.signalCode === null) {
        dev.kill('SIGTERM'); const forced = setTimeout(() => dev!.kill('SIGKILL'), 5_000);
        try { await exited; } finally { clearTimeout(forced); }
      } else await exited;
      if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true });
    }
  }
});

type CliReview = { root: string; origin: string; run: (...args: string[]) => Promise<{ stdout: string; stderr: string }> };
async function withConfiguredCli(page: import('@playwright/test').Page, info: import('@playwright/test').TestInfo,
  options: { flags?: string[]; serverSettings?: string }, work: (review: CliReview) => Promise<void>) {
  const root = await mkdtemp(join(tempRoot, 'needmark-configured-cli-'));
  let upstream: Server | undefined, dev: ChildProcess | undefined, exited: Promise<void> | undefined;
  let stdout = '', stderr = '';
  const commands: { args: string[]; stdout: string; stderr: string }[] = [];
  const run = async (...args: string[]) => {
    const result = await execute(process.execPath, [cli, ...args], { cwd: root, timeout: 10_000 });
    commands.push({ args, stdout: result.stdout, stderr: result.stderr }); return result;
  };
  try {
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><title>NeedMark configured CLI</title><style>html,body{margin:0;font:16px sans-serif;background:#fff}#configured-target{position:absolute;left:120px;top:180px;width:220px;height:60px}</style></head><body><button id="configured-target" data-review-key="main-call-to-action">Review the configured target</button></body></html>');
    });
    const target = await listen(upstream), reservation = createServer(), origin = await listen(reservation); await close(reservation);
    await run('init', '--capture=none', '--share=local');
    const generated = await readFile(root + '/needmark.config.ts', 'utf8');
    expect(generated.match(/outputDir: '\.needmark\/feedback'/g)).toHaveLength(1);
    const config = generated.replace("outputDir: '.needmark/feedback',", "outputDir: 'reviews',\n" + (options.serverSettings ?? ''));
    await writeFile(root + '/needmark.config.ts', config);
    dev = spawn(process.execPath, [cli, 'dev', `--target=${target}`, `--origin=${origin}`, ...(options.flags ?? [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise<void>((done) => { dev!.once('close', () => done()); dev!.once('error', () => done()); });
    dev.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); }); dev.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    await new Promise<void>((done, reject) => {
      const child = dev!;
      const cleanup = () => { clearTimeout(timer); child.stdout!.removeListener('data', ready); child.removeListener('error', failed); child.removeListener('close', stopped); };
      const ready = () => { if (stdout.includes(`NeedMark review: ${origin}`)) { cleanup(); done(); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const stopped = (code: number | null) => { cleanup(); reject(new Error(`Configured CLI stopped before readiness (${code}): ${stderr}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Configured CLI did not announce readiness: ${stdout}\n${stderr}`)); }, 8_000);
      child.stdout!.on('data', ready); child.once('error', failed); child.once('close', stopped); ready();
    });
    await page.goto(origin); await work({ root, origin, run });
    expect(await readFile(root + '/needmark.config.ts', 'utf8')).toBe(config);
  } finally {
    try { await info.attach('configured-cli-server-and-command-output.json', { body: JSON.stringify({ stdout, stderr, commands }, null, 2), contentType: 'application/json' }); }
    finally {
      if (dev && dev.exitCode === null && dev.signalCode === null) {
        dev.kill('SIGTERM'); const forced = setTimeout(() => dev!.kill('SIGKILL'), 5_000);
        try { await exited; } finally { clearTimeout(forced); }
      } else await exited;
      if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true });
    }
  }
}
async function configuredEvidence(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const script = document.querySelector<HTMLScriptElement>('script[data-needmark-token]')!;
    const response = await fetch(script.dataset.needmarkEndpoint + '/feedback', { headers: { 'x-needmark-token': script.dataset.needmarkToken! } });
    return { capture: script.dataset.needmarkCapture, editor: script.dataset.needmarkEditor, submit: script.dataset.needmarkSubmit,
      contextAttributes: JSON.parse(script.dataset.needmarkContextAttributes ?? '[]'), preference: localStorage.getItem('needmark-method'),
      status: response.status, feedback: await response.json() };
  });
}
async function saveConfiguredTarget(page: import('@playwright/test').Page, origin: string, comment: string) {
  const rect = await page.locator('#configured-target').boundingBox(); if (!rect) throw new Error('The configured native target has no rectangle');
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await expect(page.locator('[data-needmark] .cover')).toBeVisible();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.getByLabel('コメント本文').fill(comment);
  const pending = page.waitForResponse((response) => response.url() === origin + '/__needmark/feedback' && response.request().method() === 'POST');
  await saveAndList(page); const response = await pending;
  expect(response.status()).toBe(201); const saved = await response.json() as Feedback;
  expect(saved.target.rect).toEqual(rect); expect(saved.capture).toEqual({ method: 'none', width: 0, height: 0 }); expect(saved.image).toBeUndefined(); return saved;
}

test('explicit CLI flags override shared defaults while a saved browser capture preference survives reload', async ({ page }, info) => {
  await withConfiguredCli(page, info, { flags: ['--capture=dom', '--directory=overrides'] }, async ({ root, origin, run }) => {
    const initial = await configuredEvidence(page);
    expect(initial).toMatchObject({ capture: 'dom', preference: null, status: 200, feedback: { directory: 'overrides', feedback: [] } });
    await page.getByRole('button', { name: '設定', exact: true }).click(); await expect(page.getByLabel('キャプチャ方式')).toHaveValue('dom');
    await page.getByLabel('キャプチャ方式').selectOption('none'); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.reload(); const afterReload = await configuredEvidence(page);
    expect(afterReload).toMatchObject({ capture: 'dom', preference: 'none', feedback: { directory: 'overrides', feedback: [] } });
    await page.getByRole('button', { name: '設定', exact: true }).click(); await expect(page.getByLabel('キャプチャ方式')).toHaveValue('none');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const saved = await saveConfiguredTarget(page, origin, 'CLIの明示した保存先と、ブラウザで選んだ画像なし設定を優先する');
    const directory = root + '/overrides/' + saved.id;
    expect(JSON.parse(await readFile(directory + '/context.json', 'utf8'))).toEqual(saved);
    expect((await readdir(directory)).sort()).toEqual(['comment.md', 'context.json']);
    expect(JSON.parse((await run('list')).stdout)).toEqual([]);
    expect(JSON.parse((await run('list', 'overrides')).stdout)).toEqual([{ ...saved, files: directory }]);
    const exported = (await run('export', 'overrides', '--detail', 'compact')).stdout;
    expect(exported).toContain(`overrides/${saved.id}/context.json`); expect(exported).toContain(saved.comment);
    expect(await exists(root + '/reviews/' + saved.id + '/context.json')).toBe(false);
    await info.attach('cli-flags-browser-preference-and-directory.json', { body: JSON.stringify({ initial, afterReload, saved, exported }, null, 2), contentType: 'application/json' });
  });
});

test('shared CLI configuration enables custom target evidence, a validated local editor URL and a real Node submission hook', async ({ page }, info) => {
  const serverSettings = "  editor: 'cursor',\n  contextAttributes: ['data-review-key'],\n  onSubmit: async (submission) => { const { writeFile } = await import('node:fs/promises'); await writeFile('submitted.json', JSON.stringify(submission)); },\n";
  await withConfiguredCli(page, info, { serverSettings }, async ({ root, origin }) => {
    const initial = await configuredEvidence(page);
    expect(initial).toMatchObject({ capture: 'none', editor: 'cursor', submit: 'true', contextAttributes: ['data-review-key'], status: 200, feedback: { directory: 'reviews', feedback: [] } });
    await page.getByRole('button', { name: '設定', exact: true }).click(); await expect(page.getByLabel('キャプチャ方式')).toHaveValue('none');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const original = await page.locator('#configured-target').elementHandle(); if (!original) throw new Error('The original configured control is missing');
    try {
      const saved = await saveConfiguredTarget(page, origin, '開発者が指定した識別子を保存し、設定したローカル処理へコメントを渡す');
      expect(saved.target.code?.elements[0]?.attributes).toMatchObject({ id: 'configured-target', 'data-review-key': 'main-call-to-action' });
      expect(saved.target.code?.elements[0]?.source).toBeUndefined();
      const { mkdir } = await import('node:fs/promises'); await mkdir(root + '/src'); await writeFile(root + '/src/editor-target.ts', 'export const reviewed = true;\n');
      // The real protected editor API validates this local file; no fabricated browser source position or protocol navigation.
      const editor = await page.evaluate(async () => {
        const script = document.querySelector<HTMLScriptElement>('script[data-needmark-token]')!;
        const response = await fetch(script.dataset.needmarkEndpoint + '/editor', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-needmark-token': script.dataset.needmarkToken! }, body: JSON.stringify({ file: 'src/editor-target.ts', line: 1, column: 1 }) });
        return { status: response.status, body: await response.json() };
      });
      expect(editor).toEqual({ status: 200, body: { url: `cursor://file${root}/src/editor-target.ts:1:1` } });
      const diskBefore = await readFile(root + '/reviews/' + saved.id + '/context.json', 'utf8');
      const sent = page.waitForResponse((response) => response.url() === origin + '/__needmark/submit' && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'AIへ送信', exact: true }).click(); const response = await sent;
      expect(response.status()).toBe(200); expect(await response.json()).toEqual({ submitted: [saved.id], skipped: [] });
      const submission = JSON.parse(await readFile(root + '/submitted.json', 'utf8')) as { feedback: Feedback[]; prompt: string; directory: string; detail: string };
      expect(submission.feedback).toEqual([saved]); expect(submission.directory).toBe('reviews'); expect(submission.detail).toBe('standard');
      expect(submission.prompt).toContain(saved.comment); expect(submission.prompt).toContain(`reviews/${saved.id}/context.json`);
      expect(await readFile(root + '/reviews/' + saved.id + '/context.json', 'utf8')).toBe(diskBefore);
      expect(await original.evaluate((element) => element.isConnected && element === document.querySelector('#configured-target'))).toBe(true);
      await info.attach('configured-node-hook-editor-and-target-evidence.json', { body: JSON.stringify({ initial, saved, editor, submission }, null, 2), contentType: 'application/json' });
    } finally { await original.dispose(); }
  });
});
