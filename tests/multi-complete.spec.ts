import { type ElementHandle, type Page, type TestInfo } from '@playwright/test';
import { test, expect, saveAndList, output, tempRoot, configureReview } from './support/review.js';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startReviewProxy, type ReviewProxy } from '../dist/proxy.js';
import type { Feedback, Rectangle, RuntimeSourceRequest, RuntimeSourceResult, SourceLocation } from '../src/shared/types.js';

const ids = Array.from({ length: 20 }, (_, index) => `multi-${String(index + 1).padStart(2, '0')}`);
const sourceFile = 'src/multi-complete.jsx', fixturePath = resolve('tests/fixtures/multi-complete.jsx');
const cover = (page: Page) => page.locator('[data-needmark] .cover');
const outlines = (page: Page) => page.locator('[data-needmark] .selected-outline');
const field = (page: Page) => page.getByLabel('コメント本文');
const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string }).copied);
const execute = promisify(execFile);
type SourceCall = { status: number; input: RuntimeSourceRequest; elements: RuntimeSourceResult[]; token: string };
type Review = { origin: string; output: string; source: string; calls: Promise<SourceCall>[] };
test.use({ deviceScaleFactor: 2 });
test.setTimeout(60_000);

async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
/** Real current JSX, React dev allocation frames, source maps and the protected public proxy. */
async function withReview(page: Page, method: 'dom' | 'none', run: (review: Review) => Promise<void>) {
  const root = await mkdtemp(join(tempRoot, 'needmark-multi-complete-'));
  let upstream: Server | undefined, proxy: ReviewProxy | undefined;
  const calls: Promise<SourceCall>[] = [];
  const observe = (response: import('@playwright/test').Response) => {
    if (response.url().endsWith('/__needmark/source') && response.request().method() === 'POST') {
      calls.push(response.json().then((value: { elements: RuntimeSourceResult[] }) => ({ status: response.status(),
        input: response.request().postDataJSON() as RuntimeSourceRequest, elements: value.elements,
        token: response.request().headers()['x-needmark-token']! })));
    }
  };
  try {
    const source = await readFile(fixturePath, 'utf8'); await mkdir(`${root}/src`); await writeFile(`${root}/${sourceFile}`, source);
    await build({ absWorkingDir: root, entryPoints: [sourceFile], outfile: `${root}/app.js`, bundle: true, format: 'esm',
      jsx: 'automatic', jsxDev: true, sourcemap: 'linked', keepNames: true, minify: false,
      nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"development"' } });
    upstream = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (['/app.js', '/app.js.map'].includes(pathname)) {
        void readFile(root + pathname).then((body) => {
          response.writeHead(200, { 'Content-Type': pathname.endsWith('.map') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
        }, () => { response.writeHead(404); response.end(); });
      } else if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><head><title>NeedMark complete multi review</title><style>html,body{margin:0;background:#fff;font:16px sans-serif}*{box-sizing:border-box}#host-controls{position:absolute;left:80px;top:40px;display:flex;align-items:center;gap:20px}#host-controls button{height:36px}#target-grid{position:absolute;left:80px;top:120px;display:grid;grid-template-columns:repeat(4,160px);gap:16px}#target-grid button{width:160px;height:52px;border:0;border-radius:0;background:#13866f;color:#fff;font:16px sans-serif}#multi-13{background:#bf5e19!important}#multi-20{background:#784ad1!important}</style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
      } else { response.writeHead(404); response.end(); }
    });
    const target = await listen(upstream), reservation = createServer(), origin = await listen(reservation); await close(reservation);
    proxy = await startReviewProxy({ root, target, origin, capture: method });
    // Clipboard observation only; source, selection, image acquisition and persistence are real.
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      (window as unknown as { copied: string }).copied = value;
    } } }));
    page.on('response', observe); await page.goto(origin);
    await expect(page.locator('#target-grid button')).toHaveCount(20);
    await configureReview(page, { method });
    await run({ origin, output: `${root}/.needmark/feedback`, source, calls });
  } finally {
    page.off('response', observe); await proxy?.close(); if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true });
  }
}
function expectedSource(source: string, id: string): SourceLocation {
  const lines = source.split('\n'), line = lines.findIndex((value) => value.includes(`id="${id}"`));
  if (line < 0) throw new Error('The actual literal target is missing');
  return { file: sourceFile, line: line + 1, column: lines[line]!.indexOf('<button') + 1, component: 'SelectionTargets' };
}
async function rectangles(page: Page, selected = ids) {
  return Promise.all(selected.map(async (id) => { const rect = await page.locator(`#${id}`).boundingBox(); if (!rect) throw new Error(`Missing native target ${id}`); return rect; }));
}
function union(rects: Rectangle[]): Rectangle {
  const x = Math.min(...rects.map((rect) => rect.x)), y = Math.min(...rects.map((rect) => rect.y));
  return { x, y, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x, height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y };
}
// Multiple selection starts with a Shift gesture, so the first gesture after begin() holds Shift and later ones add plainly.
let shiftNext = false;
async function firstShift(page: Page, gesture: () => Promise<void>) { if (!shiftNext) return gesture(); shiftNext = false; await page.keyboard.down('Shift'); await gesture(); await page.keyboard.up('Shift'); }
async function begin(page: Page, mode: '複数要素' | '要素・範囲' = '複数要素') {
  // The comment button toggles selection off, so a running selection is ended first to start a fresh one.
  if (await cover(page).isVisible()) { await page.keyboard.press('Escape'); await expect(cover(page)).toBeHidden(); }
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await expect(cover(page)).toBeVisible();
  shiftNext = mode === '複数要素';
}
async function dragGrid(page: Page, rect: Rectangle, reverse = false) {
  const first: [number, number] = [rect.x - 2, rect.y - 2], last: [number, number] = [rect.x + rect.width + 2, rect.y + rect.height + 2];
  await page.mouse.move(...(reverse ? last : first)); await firstShift(page, () => page.mouse.down()); await page.mouse.move(...(reverse ? first : last), { steps: 5 }); await page.mouse.up();
}
async function clickTarget(page: Page, id: string) {
  const rect = (await rectangles(page, [id]))[0]!; await firstShift(page, () => page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2));
}
async function selection(page: Page, selected = ids) {
  await expect(outlines(page)).toHaveCount(selected.length);
  await expect(page.locator('[data-needmark] [data-hint]')).toContainText(`${selected.length}件を選択`);
  await expect.poll(() => outlines(page).evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }))).toEqual(await rectangles(page, selected));
}
async function originalsRemain(originals: ElementHandle<Node>[]) {
  expect(await Promise.all(originals.map((element) => element.evaluate((node) => node instanceof Element && node.isConnected && node === document.getElementById(node.id))))).toEqual(Array(20).fill(true));
}
async function complete(page: Page, comment: string) {
  await page.getByRole('button', { name: '選択を完了', exact: true }).click(); await expect(field(page)).toBeVisible(); await field(page).fill(comment);
  await expect(page.locator('[data-source-state]')).toHaveText('修正対象のファイルを確認しました。');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(field(page)).toHaveValue(comment);
}
async function save(page: Page, review: Review): Promise<Feedback> {
  const pending = page.waitForResponse((response) => response.url().endsWith('/__needmark/feedback') && response.request().method() === 'POST');
  await saveAndList(page); const response = await pending;
  expect(response.status()).toBe(201); const item = await response.json() as Feedback;
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  expect(JSON.parse(await readFile(`${review.output}/${item.id}/context.json`, 'utf8'))).toEqual(item); return item;
}
function assertComplete(item: Feedback, source: string, rects: Rectangle[], truncated = false) {
  expect(item.target.kind).toBe('multi'); expect(item.target.rect).toEqual(union(rects));
  expect(item.target.code?.truncated).toBe(truncated); expect(item.target.code?.elements).toHaveLength(20);
  expect(item.target.code?.elements.map((element) => element.selector)).toEqual(ids.map((id) => `#${id}`));
  expect(item.target.code?.elements.map((element) => element.rect)).toEqual(rects);
  for (const [index, element] of item.target.code!.elements.entries()) {
    expect(element).toMatchObject({ attributes: { id: ids[index] }, source: expectedSource(source, ids[index]!), sourceOrigin: 'runtime', sourceRelation: 'self' });
  }
  for (const forbidden of ['"frames"', '"stack"', '__reactFiber', '_debugStack', '/app.js']) expect(JSON.stringify(item)).not.toContain(forbidden);
}
async function assertSourceCalls(review: Review) {
  const calls = await Promise.all(review.calls); expect(calls.length).toBeGreaterThan(0);
  const requested: string[] = [];
  for (const call of calls) {
    expect(call.status).toBe(200); expect(call.input.elements.length).toBeGreaterThan(0); expect(call.input.elements.length).toBeLessThanOrEqual(12);
    expect(call.elements).toHaveLength(call.input.elements.length);
    call.input.elements.forEach((input, index) => {
      requested.push(input.attributes.id!); expect(input.frames.length).toBeGreaterThan(0);
      expect(call.elements[index]).toEqual({ source: expectedSource(review.source, input.attributes.id!) });
    });
  }
  expect(requested).toEqual(ids); return calls;
}
function assertPrompt(prompt: string, item: Feedback) {
  for (const value of [item.id, item.comment, 'context.json', ...ids.map((id) => `#${id}`)]) expect(prompt).toContain(value);
  for (const element of item.target.code!.elements) expect(prompt).toContain(`${element.source!.file}:${element.source!.line}:${element.source!.column}`);
  expect(prompt).toContain('Source (runtime; current JSX verified by identifiers)');
}

test('forward marquee retains all twenty original targets through real DOM capture, source verification, disk reload and AI exports', async ({ page }, info) => {
  await withReview(page, 'dom', async (review) => {
    await page.locator('#multi-20').click(); await expect(page.getByLabel('Native click count')).toHaveText('1');
    const originals = await page.locator('#target-grid button').elementHandles(), nativeRects = await rectangles(page), bounds = union(nativeRects);
    await info.attach('native-twenty-targets', { body: await page.screenshot({ caret: 'initial' }), contentType: 'image/png' });
    await begin(page); await dragGrid(page, bounds);
    await info.attach('actual-forward-twenty-attempt', { body: await page.screenshot({ caret: 'initial' }), contentType: 'image/png' });
    await info.attach('actual-forward-target-scope', { body: JSON.stringify({ nativeRects, selectedRects: await outlines(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON())), hint: await page.locator('[data-needmark] [data-hint]').textContent() }), contentType: 'application/json' });
    // This is the public baseline gate: all twenty physically visible targets must remain selected.
    await selection(page); await originalsRemain(originals);
    const comment = '20箇所すべての余白と配色を画像・個別ソースに基づいて修正する'; await complete(page, comment);
    await expect(field(page)).toHaveValue(comment);
    const calls = await assertSourceCalls(review), item = await save(page, review); assertComplete(item, review.source, nativeRects); await originalsRemain(originals);
    const png = await readFile(`${review.output}/${item.id}/screenshot.png`);
    const actual = await page.evaluate(async ({ png, rects, bounds }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const color = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * image.width / innerWidth), Math.round(y * image.height / innerHeight), 1, 1).data);
      return { width: image.width, height: image.height, targets: rects.map((rect) => color(rect.x + 8, rect.y + 8)), outline: color(bounds.x, bounds.y + 20) };
    }, { png: png.toString('base64'), rects: nativeRects, bounds });
    expect(actual.targets).toEqual(ids.map((_, index) => index === 12 ? [191, 94, 25, 255] : index === 19 ? [120, 74, 209, 255] : [19, 134, 111, 255]));
    expect(actual.outline).toEqual([25, 101, 227, 255]); expect(item.capture).toEqual({ method: 'dom', width: actual.width, height: actual.height });
    expect([actual.width, actual.height]).toEqual([2400, 1700]);
    await info.attach('saved-twenty-targets.png', { body: png, contentType: 'image/png' });
    await info.attach('twenty-current-source-and-geometry.json', { body: JSON.stringify({ item, nativeRects, sourceCalls: calls.map(({ token: _, ...value }) => value), pixels: actual }), contentType: 'application/json' });
    const diskBefore = await readFile(`${review.output}/${item.id}/context.json`, 'utf8');
    const reloaded = page.waitForResponse((response) => response.url().endsWith('/__needmark/feedback') && response.request().method() === 'GET');
    await page.reload(); expect((await (await reloaded).json()).feedback).toEqual([item]);
    await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await page.locator('[data-needmark] .open-item').click();
    await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click(); assertPrompt(await copied(page), item);
    for (const detail of ['compact', 'standard', 'detailed', 'forensic']) {
      await page.getByRole('button', { name: '設定', exact: true }).click(); await page.getByLabel('AIへの情報量').selectOption(detail);
      await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
      await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click(); assertPrompt(await copied(page), item); expect(await copied(page)).toContain('screenshot.png');
    }
    const cli = await execute(process.execPath, [resolve('dist/cli.js'), 'export', review.output, '--detail', 'forensic']); assertPrompt(cli.stdout, item); expect(cli.stdout).toContain('screenshot.png');
    expect(await readFile(`${review.output}/${item.id}/context.json`, 'utf8')).toBe(diskBefore); expect(await readdir(review.output)).toEqual([item.id]);
  });
});

test('twenty Shift-click targets survive toggles, Backspace, additive reverse marquee and native reflow without losing originals', async ({ page }, info) => {
  await withReview(page, 'none', async (review) => {
    const originals = await page.locator('#target-grid button').elementHandles(); await begin(page, '要素・範囲'); await page.keyboard.down('Shift');
    for (const id of ids) await clickTarget(page, id); await page.keyboard.up('Shift'); await selection(page);
    await clickTarget(page, ids[19]!); await selection(page, ids.slice(0, 19)); await page.keyboard.press('Backspace'); await selection(page, ids.slice(0, 18));
    await clickTarget(page, ids[18]!); await clickTarget(page, ids[19]!); await selection(page); await dragGrid(page, union(await rectangles(page)), true); await selection(page);
    const before = await rectangles(page);
    await page.locator('#reflow').evaluate((button) => (button as HTMLButtonElement).click()); await expect.poll(async () => (await rectangles(page))[0]!.y).toBe(before[0]!.y + 36); await originalsRemain(originals);
    await selection(page); const current = await rectangles(page);
    await complete(page, '明示した20要素を解除・追加・再配置後も欠けずに修正する'); const calls = await assertSourceCalls(review), item = await save(page, review);
    assertComplete(item, review.source, current); expect(item.capture).toEqual({ method: 'none', width: 0, height: 0 }); expect(item.image).toBeUndefined(); await originalsRemain(originals);
    await info.attach('explicit-twenty-originals-after-reflow.json', { body: JSON.stringify({ item, before, current, sourceCalls: calls.map(({ token: _, ...value }) => value) }), contentType: 'application/json' });
  });
});


test('a genuine traversal limit retains the twenty discovered targets and persists incomplete discovery through local AI handoff', async ({ page }, info) => {
  await withReview(page, 'none', async (review) => {
    await page.evaluate(() => {
      const fragment = document.createDocumentFragment(), budget = document.createElement('div');
      for (let index = 0; index < 5005; index++) budget.append(document.createElement('div'));
      fragment.append(budget);
      const late = document.createElement('button'); late.id = 'late-eligible'; late.textContent = 'Late visible target';
      late.style.cssText = 'position:absolute;left:940px;top:120px;width:160px;height:52px;background:#417dcc;color:#fff;border:0';
      late.onclick = () => { late.dataset.clicks = '1'; }; fragment.append(late); document.body.append(fragment);
    });
    await page.locator('#late-eligible').click(); await expect(page.locator('#late-eligible')).toHaveAttribute('data-clicks', '1');
    const rects = await rectangles(page), late = (await page.locator('#late-eligible').boundingBox())!;
    expect(await page.locator('#late-eligible').evaluate((element) => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element; })).toBe(true);
    await begin(page); await dragGrid(page, union([...rects, late])); await selection(page);
    await expect(page.locator('[data-needmark]').getByRole('status')).toContainText('上限');
    await complete(page, '探索できた20箇所を残し、未探索の対象があることもAIへ伝える');
    const calls = await assertSourceCalls(review), item = await save(page, review); assertComplete(item, review.source, rects, true);
    expect(item.target.code?.elements.some((element) => element.selector === '#late-eligible')).toBe(false);
    await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click(); const prompt = await copied(page);
    assertPrompt(prompt, item); expect(prompt).toContain('対象の探索が完了していない');
    const cli = await execute(process.execPath, [resolve('dist/cli.js'), 'export', review.output, '--detail', 'compact']);
    assertPrompt(cli.stdout, item); expect(cli.stdout).toContain('Target discovery is incomplete');
    await info.attach('incomplete-discovery-with-known-twenty.json', { body: JSON.stringify({ item, nativeRects: rects, lateNativeRect: late, prompt, sourceCalls: calls.map(({ token: _, ...value }) => value) }), contentType: 'application/json' });
  });
});


test('a saved twenty-target review locates its complete current group after native reflow without changing originals or saved evidence', async ({ page }, info) => {
  await withReview(page, 'none', async (review) => {
    const originals = await page.locator('#target-grid button').elementHandles(), originalDocument = await page.evaluateHandle(() => document);
    const originalUrl = page.url(), before = await rectangles(page);
    try {
      await begin(page); await dragGrid(page, union(before)); await selection(page);
      const comment = 'AIの修正後に保存した20対象の全体を画面上で確認する';
      await complete(page, comment); const calls = await assertSourceCalls(review), saved = await save(page, review);
      assertComplete(saved, review.source, before); await originalsRemain(originals);
      const diskBefore = await readFile(`${review.output}/${saved.id}/context.json`, 'utf8');
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
      // The real host control applies a CSS-only React reflow, retaining the exact twenty DOM nodes.
      await page.locator('#reflow').click(); await expect.poll(async () => (await rectangles(page))[0]!.y).toBe(before[0]!.y + 36);
      const afterReflow = await rectangles(page);
      expect(afterReflow).toEqual(before.map((rect) => ({ ...rect, y: rect.y + 36 }))); await originalsRemain(originals);
      await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
      await page.locator('[data-needmark] .open-item').click();
      const markers = page.locator('[data-needmark] .outline:visible');
      await expect(markers.first()).toBeVisible();
      const actual = await markers.evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      // Native current boxes are the oracle; saved boxes deliberately predate the reflow.
      const current = await rectangles(page), currentUnion = union(current);
      const identity = { sameDocument: await page.evaluate((original) => original === document, originalDocument), sameUrl: page.url() === originalUrl };
      await info.attach('saved-twenty-locate-after-native-reflow.png', { body: await page.screenshot({ caret: 'initial' }), contentType: 'image/png' });
      await info.attach('saved-twenty-locate-current-scope.json', { body: JSON.stringify({ saved, before, afterReflow, current, currentUnion, actual, identity,
        sourceCalls: calls.map(({ token: _, ...value }) => value) }, null, 2), contentType: 'application/json' });
      await originalsRemain(originals); expect(identity).toEqual({ sameDocument: true, sameUrl: true });
      expect(await readFile(`${review.output}/${saved.id}/context.json`, 'utf8')).toBe(diskBefore);
      await expect(page.locator('[data-needmark]').getByText('記録した場所を表示しています。現在の要素は特定できませんでした。', { exact: true })).toBeHidden();
      const sameRect = (actual: Rectangle, expected: Rectangle) => (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(actual[key] - expected[key]) <= .5);
      const everyTarget = actual.length === current.length && current.every((rect) => actual.some((marker) => sameRect(marker, rect)));
      const completeUnion = actual.length === 1 && sameRect(actual[0]!, currentUnion);
      // A complete current union or all twenty exact boxes both show the user's complete recheck scope.
      expect(everyTarget || completeUnion, 'Locate must show the complete current20-target scope, rather than only its first successfully matched target').toBe(true);
    } finally { await originalDocument.dispose(); await Promise.all(originals.map((element) => element.dispose())); }
  });
});

async function openSavedGroup(page: Page) {
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.locator('[data-needmark] .open-item').click();
}
async function savedGroupMarkers(page: Page) {
  const markers = page.locator('[data-needmark] .located-outline');
  await expect(markers).toHaveCount(20);
  const actual = await markers.evaluateAll((nodes) => nodes.map((node) => {
    const element = node as HTMLElement, rect = element.getBoundingClientRect();
    return { index: Number(element.dataset.targetIndex), state: element.dataset.targetState,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }).sort((a, b) => a.index - b.index));
  expect(actual.map((marker) => marker.index)).toEqual(ids.map((_, index) => index + 1));
  return actual;
}
function expectGroupGeometry(actual: Awaited<ReturnType<typeof savedGroupMarkers>>, rects: Rectangle[], states: string[]) {
  expect(actual.map((marker) => marker.state)).toEqual(states);
  for (const [index, marker] of actual.entries()) for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(marker.rect[key] - rects[index]![key]), `target ${index + 1} ${key}`).toBeLessThanOrEqual(.5);
  }
}

test('saved multi Locate measures a later target independently and distinguishes first and later identity failures', async ({ page }, info) => {
  await withReview(page, 'none', async (review) => {
    const originals = await page.locator('#target-grid button').elementHandles(), originalUrl = page.url(), before = await rectangles(page);
    try {
      await begin(page); await dragGrid(page, union(before)); await selection(page);
      await complete(page, '先頭だけを基準にせず20対象を確認し、変わった対象は記録と区別する');
      await assertSourceCalls(review); const saved = await save(page, review); assertComplete(saved, review.source, before);
      const diskBefore = await readFile(`${review.output}/${saved.id}/context.json`, 'utf8');
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
      await originals[19]!.evaluate((node) => (node as HTMLElement).style.transform = 'translate(24px,16px)');
      const moved = await rectangles(page);
      expect(moved[0]).toEqual(before[0]); expect(moved.slice(0, 19)).toEqual(before.slice(0, 19));
      expect(moved[19]).toEqual({ ...before[19]!, x: before[19]!.x + 24, y: before[19]!.y + 16 });
      expect(await originals[19]!.evaluate((node) => { const rect = (node as Element).getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node; })).toBe(true);
      await openSavedGroup(page);
      const confirmed = await savedGroupMarkers(page); expectGroupGeometry(confirmed, await rectangles(page), Array(20).fill('confirmed'));
      await expect(page.locator('[data-needmark] .toast')).not.toContainText('対象未確認');
      // Repeating the action replaces the previous group rather than appending twenty more markers.
      await openSavedGroup(page); await savedGroupMarkers(page);
      await originals[0]!.evaluate((node) => node.textContent = 'A different first action');
      await openSavedGroup(page);
      const firstMismatch = await savedGroupMarkers(page);
      await expect(page.locator('[data-needmark] .toast')).toHaveText('19件を確認、1件は対象未確認（記録位置）です。');
      const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
      const recorded = saved.target.code!.elements.map((context) => ({ ...context.rect,
        x: context.rect.x + saved.viewport.scrollX - scroll.x, y: context.rect.y + saved.viewport.scrollY - scroll.y }));
      const firstExpected = await rectangles(page); firstExpected[0] = recorded[0]!;
      expectGroupGeometry(firstMismatch, firstExpected, ids.map((_, index) => index ? 'confirmed' : 'recorded'));
      await originals[19]!.evaluate((node) => (node as Element).setAttribute('data-testid', 'different-later-action'));
      await openSavedGroup(page);
      const laterMismatch = await savedGroupMarkers(page), laterExpected = await rectangles(page);
      laterExpected[0] = recorded[0]!; laterExpected[19] = recorded[19]!;
      expectGroupGeometry(laterMismatch, laterExpected, ids.map((_, index) => index === 0 || index === 19 ? 'recorded' : 'confirmed'));
      await expect(page.locator('[data-needmark] .toast')).toHaveText('18件を確認、2件は対象未確認（記録位置）です。');
      await info.attach('saved-group-confirmed-and-recorded.png', { body: await page.screenshot({ caret: 'initial' }), contentType: 'image/png' });
      await originalsRemain(originals); expect(page.url()).toBe(originalUrl);
      expect(await readFile(`${review.output}/${saved.id}/context.json`, 'utf8')).toBe(diskBefore);
      await info.attach('saved-group-independent-motion-and-mismatches.json', { body: JSON.stringify({ saved, before, moved, confirmed, firstMismatch, laterMismatch }, null, 2), contentType: 'application/json' });
    } finally { await Promise.all(originals.map((element) => element.dispose())); }
  });
});

test('all unmatched saved multi targets retain document positions when the old saved scroll cannot be restored', async ({ page }, info) => {
  await withReview(page, 'none', async (review) => {
    const originals = await page.locator('#target-grid button').elementHandles(), originalDocument = await page.evaluateHandle(() => document), originalUrl = page.url();
    try {
      await page.evaluate(() => { document.body.style.minHeight = '2000px'; document.querySelector<HTMLElement>('#target-grid')!.style.top = '800px'; window.scrollTo({ top: 600, behavior: 'instant' }); });
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(600);
      const before = await rectangles(page); expect(before.every((rect) => rect.y >= 0 && rect.y + rect.height <= 850)).toBe(true);
      expect(await originals[0]!.evaluate((node) => { const rect = (node as Element).getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node; })).toBe(true);
      await begin(page); await dragGrid(page, union(before)); await selection(page);
      await complete(page, '全対象が未確認なら復元できなかったスクロール量も考慮して記録位置を示す');
      await assertSourceCalls(review); const saved = await save(page, review); assertComplete(saved, review.source, before); expect(saved.viewport.scrollY).toBe(600);
      const diskBefore = await readFile(`${review.output}/${saved.id}/context.json`, 'utf8');
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
      await page.evaluate(() => {
        for (const element of document.querySelectorAll('#target-grid button')) element.setAttribute('data-testid', `changed-${element.id}`);
        document.querySelector<HTMLElement>('#target-grid')!.style.top = '120px'; document.body.style.minHeight = '0';
      });
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await openSavedGroup(page);
      const actualScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY })), actual = await savedGroupMarkers(page);
      expect(actualScroll.y).toBe(0);
      const recorded = saved.target.code!.elements.map((context) => ({ ...context.rect,
        x: context.rect.x + saved.viewport.scrollX - actualScroll.x, y: context.rect.y + saved.viewport.scrollY - actualScroll.y }));
      expectGroupGeometry(actual, recorded, Array(20).fill('recorded'));
      expect(actual[0]!.rect.y).not.toBe((await rectangles(page))[0]!.y);
      await expect(page.locator('[data-needmark] .toast')).toHaveText('0件を確認、20件は対象未確認（記録位置）です。');
      await originalsRemain(originals); expect(page.url()).toBe(originalUrl);
      expect(await page.evaluate((original) => original === document, originalDocument)).toBe(true);
      expect(await readFile(`${review.output}/${saved.id}/context.json`, 'utf8')).toBe(diskBefore);
      await info.attach('saved-group-clamped-scroll-recorded-fallback.json', { body: JSON.stringify({ saved, before, actualScroll, recorded, actual }, null, 2), contentType: 'application/json' });
    } finally { await originalDocument.dispose(); await Promise.all(originals.map((element) => element.dispose())); }
  });
});

test('saved multi Locate clears on close, hide, route and new selection without reviving an old group', async ({ page }) => {
  await withReview(page, 'none', async (review) => {
    const originals = await page.locator('#target-grid button').elementHandles(), originalUrl = page.url(), before = await rectangles(page);
    try {
      await begin(page); await dragGrid(page, union(before)); await selection(page);
      await complete(page, '確認用の枠を閉じた画面や次の選択へ残さない');
      await assertSourceCalls(review); const saved = await save(page, review); assertComplete(saved, review.source, before);
      const diskBefore = await readFile(`${review.output}/${saved.id}/context.json`, 'utf8'), markers = page.locator('[data-needmark] .located-outline');
      await page.locator('[data-needmark] .open-item').click(); await savedGroupMarkers(page);
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); await expect(markers).toHaveCount(0);
      await openSavedGroup(page); await savedGroupMarkers(page);
      await page.keyboard.press('Shift+H'); await expect(page.locator('[data-needmark] .dock')).toBeHidden(); await expect(markers).toHaveCount(0);
      await page.keyboard.press('Shift+H'); await expect(page.locator('[data-needmark] .dock')).toBeVisible();
      await openSavedGroup(page); await savedGroupMarkers(page);
      await page.evaluate(() => history.replaceState({ reviewState: 1 }, '', location.href));
      expect(page.url()).toBe(originalUrl); expectGroupGeometry(await savedGroupMarkers(page), await rectangles(page), Array(20).fill('confirmed'));
      await page.evaluate(() => history.pushState({ reviewState: 2 }, '', location.href));
      expect(page.url()).toBe(originalUrl); expectGroupGeometry(await savedGroupMarkers(page), await rectangles(page), Array(20).fill('confirmed'));
      expect(await readFile(`${review.output}/${saved.id}/context.json`, 'utf8')).toBe(diskBefore);
      await page.evaluate(() => history.pushState({}, '', '?locate=other'));
      await expect(markers).toHaveCount(0);
      await page.evaluate((url) => history.replaceState({}, '', url), originalUrl);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      await expect(markers).toHaveCount(0);
      await openSavedGroup(page); await savedGroupMarkers(page);
      await page.getByRole('button', { name: 'コメント', exact: true }).click(); await expect(cover(page)).toBeVisible();
      await expect(markers).toHaveCount(0); await expect(outlines(page)).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(cover(page)).toBeHidden(); await expect(markers).toHaveCount(0);
      await originalsRemain(originals); expect(page.url()).toBe(originalUrl);
      expect(await readFile(`${review.output}/${saved.id}/context.json`, 'utf8')).toBe(diskBefore);
    } finally { await Promise.all(originals.map((element) => element.dispose())); }
  });
});
