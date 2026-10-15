import { type Frame, type Locator, type Page, type TestInfo } from '@playwright/test';
import { test, expect, output, tempRoot, configureReview, tabColorTolerance } from './support/review.js';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startReviewProxy, type ReviewProxy } from '../dist/proxy.js';
import type { Feedback, Rectangle, RuntimeSourceRequest, RuntimeSourceResult, SourceLocation } from '../src/shared/types.js';

type Review = { root: string; output: string; source: string; origin: string };
type Sample = { name: string; x: number; y: number; color: number[] };
const fixturePath = resolve('tests/fixtures/frame-capture.jsx'), sourceFile = 'src/frame-capture.jsx';
const parentColor = [219, 233, 206, 255], childColor = [211, 232, 239, 255], currentColor = [217, 91, 36, 255], mask = [46, 49, 52, 255];
test.use({ deviceScaleFactor: 2 });
test.setTimeout(45_000);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected an ephemeral loopback port');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}

/** Actual React dev allocation frames, current local JSX, source maps and public protected proxy. */
async function withReview(page: Page, nested: boolean, run: (review: Review) => Promise<void>, inline = false) {
  const root = await mkdtemp(join(tempRoot, 'needmark-frame-capture-'));
  let upstream: Server | undefined, proxy: ReviewProxy | undefined;
  try {
    const source = await readFile(fixturePath, 'utf8'); await mkdir(root + '/src'); await writeFile(root + '/' + sourceFile, source);
    await build({ absWorkingDir: root, entryPoints: [sourceFile], outfile: root + '/app.js', bundle: true,
      format: 'esm', jsx: 'automatic', jsxDev: true, sourcemap: 'linked', keepNames: true, minify: false,
      nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"development"' } });
    upstream = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (['/app.js', '/app.js.map'].includes(url.pathname)) {
        void readFile(root + url.pathname).then((body) => {
          response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.map') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
        }, () => { response.writeHead(404); response.end(); });
      } else if (url.pathname === '/clone-resource.svg') {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#39b58a"/></svg>');
      } else if (url.pathname === '/inert-frame') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><body style="margin:0;background:#397baa"><div id="inert-marker">Unrelated child</div></body></html>');
      } else if (url.pathname === '/') {
        const kind = url.searchParams.get('frame');
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end(`<!doctype html><html><head><title>NeedMark frame capture</title><style>
          html,body{margin:0;font:16px sans-serif;background:${kind === 'leaf' ? '#d3e8ef' : kind === 'outer' ? '#e8def1' : '#dbe9ce'}}body{min-height:${kind ? 1400 : 1800}px}*{box-sizing:border-box}
          h1{margin:0;position:absolute;left:30px;top:30px;font-size:22px}iframe{display:block}
          [data-cy="frame-live-button"]{position:absolute;left:40px;top:260px;width:280px;height:70px;border:0;border-radius:0;color:#fff;font:20px sans-serif}
          #live-note{position:absolute;left:40px;top:355px;width:300px;height:36px;padding:0;background:#fff;color:#000;white-space:nowrap;font:24px/36px monospace}
          #child-password,#child-redact{position:absolute;left:370px;width:160px;height:40px;border:0;border-radius:0;background:#9922a9;color:#fff}#child-password{top:275px}#child-redact{top:335px}
          #child-marker{position:absolute;left:370px;top:220px;width:120px;height:30px;background:#31c7ad}
          #root-password,#root-redact,#root-marker{position:absolute;left:940px;width:180px;height:40px;border:0;border-radius:0;background:#9922a9;color:#fff}#root-password{top:200px}#root-redact{top:260px}#root-marker{top:140px;background:#5b42bd}
        </style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>`);
      } else { response.writeHead(404); response.end(); }
    });
    const target = await listen(upstream), reservation = createServer(), origin = await listen(reservation); await close(reservation);
    proxy = await startReviewProxy({ root, target, origin, capture: 'dom', editor: 'vscode' });
    await page.goto(origin + '/' + (nested ? '?nested' : inline ? '?inline' : ''));
    await expect(leafTarget(page, nested)).toBeVisible(); await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
    await run({ root, output: root + '/.needmark/feedback', source, origin });
  } finally { await proxy?.close(); if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true }); }
}
function leafTarget(page: Page, nested = false): Locator {
  const frame = page.frameLocator('#outer-capture-frame');
  return (nested ? frame.frameLocator('#inner-capture-frame') : frame).locator('[data-cy="frame-live-button"]');
}
async function frames(page: Page, nested = false): Promise<{ outer: Frame; leaf: Frame }> {
  const outerHandle = await page.locator('#outer-capture-frame').elementHandle(), outer = await outerHandle?.contentFrame(); await outerHandle?.dispose();
  if (!outer) throw new Error('Missing outer frame');
  if (!nested) return { outer, leaf: outer };
  const leafHandle = await outer.locator('#inner-capture-frame').elementHandle(), leaf = await leafHandle?.contentFrame(); await leafHandle?.dispose();
  if (!leaf) throw new Error('Missing inner frame'); return { outer, leaf };
}
function sourceOf(review: Review): SourceLocation {
  const lines = review.source.split('\n'), line = lines.findIndex((value) => value.includes('data-cy="frame-live-button"'));
  expect(line).toBeGreaterThanOrEqual(0);
  return { file: sourceFile, line: line + 1, column: lines[line]!.indexOf('<button') + 1, component: 'CaptureTarget' };
}
async function method(page: Page, value: 'dom' | 'none' | 'tab') {
  await configureReview(page, { method: value });
}
async function select(page: Page, review: Review, nested = false) {
  const response = page.waitForResponse((response) => response.url() === review.origin + '/__needmark/source' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(page.locator('[data-needmark] .cover')).toBeVisible();
  const rect = await leafTarget(page, nested).boundingBox(); if (!rect) throw new Error('Missing target geometry');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible();
  const result = await response; expect(result.status()).toBe(200);
  expect((result.request().postDataJSON() as RuntimeSourceRequest).elements[0]?.frames.some((frame) => frame.url.endsWith('/app.js') && frame.component === 'CaptureTarget')).toBe(true);
  expect((await result.json() as { elements: RuntimeSourceResult[] }).elements[0]).toEqual({ source: sourceOf(review) });
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible(); return rect;
}
async function save(page: Page, review: Review, comment: string): Promise<Feedback> {
  await page.getByLabel('コメント本文').fill(comment);
  // Save is enabled as the preview appears, while the panel is still growing to fit it; on a slow runner a click then lands above the moving button.
  await expect(page.locator('[data-needmark] .morphing')).toHaveCount(0); await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const records = await Promise.all((await readdir(review.output)).filter((name) => !name.startsWith('.')).map(async (id) => JSON.parse(await readFile(`${review.output}/${id}/context.json`, 'utf8')) as Feedback));
  const item = records.find((record) => record.comment === comment); if (!item) throw new Error('Missing saved feedback');
  expect(item.target.code?.elements[0]).toMatchObject({ source: sourceOf(review), sourceOrigin: 'runtime', sourceRelation: 'self', attributes: { 'data-cy': 'frame-live-button' } });
  expect(JSON.stringify(item)).not.toContain('"frames"'); return item;
}
async function currentChild(page: Page, nested = false) {
  const target = leafTarget(page, nested); await target.click(); await expect(target).toHaveText('Current child 1');
  const { leaf } = await frames(page, nested); const note = leaf.getByRole('textbox', { name: 'Live child note', exact: true }); await note.fill('MMMMMMMMMMMM');
  // Chromium on Linux draws a near-black focus ring that the ink measurement would count as text, and DOM capture never draws focus rings.
  await note.blur();
  expect(await target.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(217, 91, 36)'); return leaf;
}
async function point(locator: Locator, name: string, color: number[], inset = 12): Promise<Sample> {
  const rect = await locator.boundingBox(); if (!rect) throw new Error('Missing ' + name);
  return { name, x: rect.x + inset, y: rect.y + inset, color };
}
async function evidence(page: Page, png: Buffer, samples: Sample[], note?: Rectangle) {
  return page.evaluate(async ({ png, samples, note }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const sx = image.width / innerWidth, sy = image.height / innerHeight;
    let inkWidth = 0;
    if (note) {
      const left = Math.round(note.x * sx), top = Math.round(note.y * sy), width = Math.round(note.width * sx), height = Math.round(note.height * sy);
      const pixels = context.getImageData(left, top, width, height).data;
      let first = width, last = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        if (pixels[index]! < 50 && pixels[index + 1]! < 50 && pixels[index + 2]! < 50 && pixels[index + 3]! === 255) { first = Math.min(first, x); last = Math.max(last, x); }
      }
      inkWidth = last >= first ? (last - first + 1) / sx : 0;
    }
    return { width: image.width, height: image.height, inkWidth, samples: samples.map(({ name, x, y }) => ({ name, color: Array.from(context.getImageData(Math.round(x * sx), Math.round(y * sy), 1, 1).data) })) };
  }, { png: png.toString('base64'), samples, note });
}
async function captureSamples(page: Page, nested = false) {
  const { leaf } = await frames(page, nested);
  const samples = [await point(leafTarget(page, nested), 'live-child-button', currentColor, 15),
    await point(leaf.locator('#child-marker'), 'live-child-marker', [49, 199, 173, 255]),
    await point(leaf.locator('#child-password'), 'child-password', mask), await point(leaf.locator('#child-redact'), 'child-redact', mask),
    await point(page.locator('#root-password'), 'root-password', mask), await point(page.locator('#root-redact'), 'root-redact', mask),
    await point(page.locator('#root-marker'), 'root-marker', [91, 66, 189, 255])];
  const dock = await page.locator('[data-needmark] .dock').boundingBox(); if (!dock) throw new Error('Missing main toolbar geometry');
  samples.push({ name: 'excluded-main-toolbar', x: dock.x + dock.width - 15, y: dock.y + 12, color: parentColor });
  const frame = await page.locator('#outer-capture-frame').boundingBox(); if (!frame) throw new Error('Missing frame');
  if (!nested) samples.push({ name: 'child-background', x: frame.x + 20, y: frame.y + 20, color: childColor });
  const leafFrame = nested ? await page.frameLocator('#outer-capture-frame').locator('#inner-capture-frame').boundingBox() : frame;
  if (!leafFrame) throw new Error('Missing leaf viewport');
  // Actual frame viewport coordinates, including scroll: the default child dock occupies this corner.
  samples.push({ name: 'excluded-child-toolbar', x: leafFrame.x + leafFrame.width - 24, y: leafFrame.y + leafFrame.height - 24, color: childColor });
  const note = await leaf.locator('#live-note').boundingBox(); if (!note) throw new Error('Missing note'); return { samples, note };
}
async function originalChildState(page: Page, nested = false) {
  const { outer, leaf } = await frames(page, nested);
  const frameAttributes = [await page.locator('#outer-capture-frame').evaluate((element) => Object.fromEntries(Array.from(element.attributes).map(({ name, value }) => [name, value])))];
  if (nested) frameAttributes.push(await outer.locator('#inner-capture-frame').evaluate((element) => Object.fromEntries(Array.from(element.attributes).map(({ name, value }) => [name, value]))));
  return { frameAttributes, child: await leaf.evaluate(() => ({
    html: ['#app', '#live-note', '#child-password', '#child-redact', '#child-marker'].map((selector) => document.querySelector(selector)!.outerHTML),
    password: (document.querySelector('#child-password') as HTMLInputElement).value,
    note: document.querySelector('#live-note')!.textContent,
    color: getComputedStyle(document.querySelector('[data-cy="frame-live-button"]')!).backgroundColor,
    scroll: { x: scrollX, y: scrollY }, viewport: { width: innerWidth, height: innerHeight },
  })) };
}
async function attach(testInfo: TestInfo, name: string, png: Buffer, state: unknown) {
  await testInfo.attach(name + '.png', { body: png, contentType: 'image/png' });
  await testInfo.attach(name + '.json', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
}
function expectPixels(actual: Awaited<ReturnType<typeof evidence>>, samples: Sample[], tolerance = 0) {
  for (const sample of samples) {
    const value = actual.samples.find((entry) => entry.name === sample.name)!.color;
    sample.color.forEach((channel, index) => expect(Math.abs(value[index]! - channel), sample.name).toBeLessThanOrEqual(tolerance));
  }
}

test('only the top document owns the review toolbar while a child opened directly remains reviewable', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, true, async (review) => {
    const { outer, leaf } = await frames(page, true);
    const state = { topUrl: page.url(), outerUrl: outer.url(), leafUrl: leaf.url(), top: await page.locator('[data-needmark] .dock').count(), outer: await outer.locator('[data-needmark] .dock').count(), leaf: await leaf.locator('[data-needmark] .dock').count() };
    await attach(testInfo, 'toolbar-ownership', await page.screenshot(), state);
    expect(state.top).toBe(1); expect(state.outer).toBe(0); expect(state.leaf).toBe(0);
    const direct = await page.context().newPage();
    try { await direct.goto(leaf.url()); await expect(direct.getByRole('button', { name: 'コメント', exact: true })).toBeVisible(); await expect(direct.locator('[data-needmark] .dock')).toHaveCount(1); }
    finally { await direct.close(); }
    await outer.evaluate(() => scrollTo(0, 340)); await leaf.evaluate(() => scrollTo(0, 160));
    await method(page, 'none'); const rect = await select(page, review, true), item = await save(page, review, '親のレビュー操作だけで入れ子の子画面をコメントする');
    expect(item.target.rect).toEqual(rect); expect(item.target.code!.elements[0]!.frameUrls).toEqual([outer.url(), leaf.url()]);
    expect(item.capture).toEqual({ method: 'none', width: 0, height: 0 });
  });
});

test('CSS-sized iframe DOM PNG records current React pixels and edited text with source, DPR and private regions', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    const leaf = await currentChild(page), { samples, note } = await captureSamples(page);
    const dimensions = await page.locator('#outer-capture-frame').evaluate((frame) => ({ width: frame.getAttribute('width'), height: frame.getAttribute('height'), rect: frame.getBoundingClientRect().toJSON() }));
    expect(dimensions.width).toBeNull(); expect(dimensions.height).toBeNull(); expect(dimensions.rect.height).toBe(520);
    const native = await page.screenshot(), nativeState = await evidence(page, native, samples, note);
    await attach(testInfo, 'css-frame-native', native, { nativeState, dimensions, childUrl: leaf.url() });
    expectPixels(nativeState, samples.filter((sample) => !sample.name.includes('password') && !sample.name.includes('redact') && !sample.name.includes('toolbar')));
    expect(nativeState.inkWidth).toBeGreaterThan(100);
    const original = await originalChildState(page);
    await method(page, 'dom'); const rect = await select(page, review), item = await save(page, review, '子画面で変更した色と文章を画像にも残す');
    const png = await readFile(`${review.output}/${item.id}/screenshot.png`), actual = await evidence(page, png, samples, note);
    await attach(testInfo, 'css-frame-saved', png, { actual, saved: item, dimensions, original, after: await originalChildState(page) });
    // The independent baseline image failure occurs after genuine source lookup and local saving.
    expectPixels(actual, samples); expect(actual.inkWidth).toBeGreaterThan(nativeState.inkWidth * 0.85);
    expect(item.capture).toEqual({ method: 'dom', width: 2400, height: 1700 });
    expect(actual.width).toBe(item.capture.width); expect(actual.height).toBe(item.capture.height);
    expect(item.viewport.devicePixelRatio).toBe(2); expect(item.target.rect).toEqual(rect); expect(item.target.code!.elements[0]!.rect).toEqual(rect);
    expect(await originalChildState(page)).toEqual(original);
    expect(item.target.code!.elements[0]!.text).toBe('Current child 1'); expect(item.target.code!.elements[0]!.frameUrls).toEqual([leaf.url()]);
    await expect(leaf.getByRole('textbox', { name: 'Live child note', exact: true })).toHaveText('MMMMMMMMMMMM');
  });
});

test('nested iframe DOM capture preserves live pixels and private rectangles after child and root scrolling', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, true, async (review) => {
    const { outer, leaf } = await frames(page, true); await currentChild(page, true);
    await page.evaluate(() => scrollTo(0, 80)); await outer.evaluate(() => scrollTo(0, 340)); await leaf.evaluate(() => scrollTo(0, 160));
    const { samples, note } = await captureSamples(page, true), native = await page.screenshot(), nativeState = await evidence(page, native, samples, note);
    const scroll = { root: await page.evaluate(() => scrollY), outer: await outer.evaluate(() => scrollY), leaf: await leaf.evaluate(() => scrollY) };
    await attach(testInfo, 'nested-frame-native', native, { scroll, nativeState });
    expectPixels(nativeState, samples.filter((sample) => !sample.name.includes('password') && !sample.name.includes('redact') && !sample.name.includes('toolbar'))); expect(nativeState.inkWidth).toBeGreaterThan(100);
    expect(scroll).toEqual({ root: 80, outer: 340, leaf: 160 });
    const original = await originalChildState(page, true);
    await method(page, 'dom'); const rect = await select(page, review, true), item = await save(page, review, 'スクロール後の入れ子画面をそのまま残す');
    const png = await readFile(`${review.output}/${item.id}/screenshot.png`), actual = await evidence(page, png, samples, note);
    await attach(testInfo, 'nested-frame-saved', png, { actual, scroll, saved: item, original, after: await originalChildState(page, true) });
    expectPixels(actual, samples); expect(actual.inkWidth).toBeGreaterThan(nativeState.inkWidth * 0.85);
    expect(item.target.rect).toEqual(rect); expect(item.target.code!.elements[0]!.rect).toEqual(rect); expect(item.viewport.scrollY).toBe(80);
    expect(item.target.code!.elements[0]!.frameUrls).toEqual([outer.url(), leaf.url()]); expect(item.capture).toEqual({ method: 'dom', width: 2400, height: 1700 });
    expect(await originalChildState(page, true)).toEqual(original);
    await expect(leafTarget(page, true)).toHaveText('Current child 1'); expect(await leaf.evaluate(() => scrollY)).toBe(160);
  });
});

test('a scrolled page with smooth scrolling still captures its iframe with DOM capture', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    await currentChild(page);
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'smooth'; scrollTo({ top: 80, behavior: 'instant' }); });
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(80);
    await method(page, 'dom'); await select(page, review); const item = await save(page, review, 'なめらかなスクロールのページでも子画面を撮る');
    await attach(testInfo, 'smooth-scroll-frame-saved', await readFile(`${review.output}/${item.id}/screenshot.png`), { saved: item });
    expect(item.capture.method).toBe('dom'); expect(item.viewport.scrollY).toBe(80);
  });
});

test('native tab PNG excludes review controls while preserving current child pixels and privacy masks', async ({ page, browserName }, testInfo) => {
  await withReview(page, false, async (review) => {
    await currentChild(page); const { samples } = await captureSamples(page); await method(page, 'tab');
    const rect = await select(page, review), item = await save(page, review, '高精度の子画面画像にレビューツールを混ぜない');
    const png = await readFile(`${review.output}/${item.id}/screenshot.png`), actual = await evidence(page, png, samples);
    await attach(testInfo, 'native-frame-saved', png, { actual, saved: item }); expectPixels(actual, samples, tabColorTolerance);
    expect(item.capture.method).toBe('tab'); expect(item.capture.width).toBe(actual.width); expect(item.capture.height).toBe(actual.height);
    expect(item.target.rect).toEqual(rect); expect(item.target.code!.elements[0]!.rect).toEqual(rect); expect(item.capture.width).toBeGreaterThan(500);
  });
});


test('an inline frame keeps its current pixels between interleaved direct text and style siblings without changing original order', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    await currentChild(page); const { samples } = await captureSamples(page);
    const originalLine = await page.locator('#inline-frame-line').evaluate((element) => ({
      html: element.outerHTML, nodes: Array.from(element.childNodes).map((node) => node.nodeType === Node.TEXT_NODE ? { type: 'text', value: node.textContent } : { type: (node as Element).localName }),
    }));
    expect(originalLine.nodes).toEqual([{ type: 'text', value: 'BEFORE ' }, { type: 'style' }, { type: 'iframe' }, { type: 'text', value: ' AFTER' }]);
    const textRectangles = await page.locator('#inline-frame-line').evaluate((element) => [element.firstChild!, element.lastChild!].map((node) => {
      const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON();
    }));
    const originalChild = await originalChildState(page), native = await page.screenshot({ caret: 'initial' });
    const nativeBefore = await evidence(page, native, samples, textRectangles[0]), nativeAfter = await evidence(page, native, samples, textRectangles[1]);
    await attach(testInfo, 'inline-frame-native', native, { nativeBefore, nativeAfter, textRectangles, originalLine, originalChild });
    expectPixels(nativeBefore, samples.filter((sample) => !sample.name.includes('password') && !sample.name.includes('redact') && !sample.name.includes('toolbar')));
    expect(nativeBefore.inkWidth).toBeGreaterThan(40); expect(nativeAfter.inkWidth).toBeGreaterThan(40);
    await method(page, 'dom'); const rect = await select(page, review), item = await save(page, review, '文章とiframeの並びを崩さず現在の子画面を残す');
    const png = await readFile(`${review.output}/${item.id}/screenshot.png`);
    const actualBefore = await evidence(page, png, samples, textRectangles[0]), actualAfter = await evidence(page, png, samples, textRectangles[1]);
    await attach(testInfo, 'inline-frame-saved', png, { actualBefore, actualAfter, saved: item, originalLine });
    expectPixels(actualBefore, samples); expect(actualBefore.inkWidth).toBeGreaterThan(nativeBefore.inkWidth * 0.85); expect(actualAfter.inkWidth).toBeGreaterThan(nativeAfter.inkWidth * 0.85);
    expect(await page.locator('#inline-frame-line').evaluate((element) => ({
      html: element.outerHTML, nodes: Array.from(element.childNodes).map((node) => node.nodeType === Node.TEXT_NODE ? { type: 'text', value: node.textContent } : { type: (node as Element).localName }),
    }))).toEqual(originalLine);
    expect(await originalChildState(page)).toEqual(originalChild); expect(item.target.rect).toEqual(rect); expect(item.target.code!.elements[0]!.rect).toEqual(rect);
    expect(item.capture).toEqual({ method: 'dom', width: 2400, height: 1700 });
  }, true);
});


test('an unrelated iframe added during real image acquisition rejects stale pixels and retains the typed comment for image-free saving', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    const leaf = await currentChild(page); await method(page, 'dom');
    let release = () => {}, entered = () => {};
    const resourceRequested = new Promise<void>((done) => { entered = done; });
    const resourceGate = new Promise<void>((done) => { release = done; });
    const pattern = review.origin + '/clone-resource.svg?*';
    const handler = async (route: import('@playwright/test').Route) => { entered(); await resourceGate; await route.continue(); };
    await page.route(pattern, handler);
    try {
      await leaf.evaluate((origin) => {
        const image = document.createElement('img'); image.id = 'held-real-resource';
        image.style.cssText = 'position:absolute;left:20px;top:420px;width:40px;height:40px';
        image.src = origin + '/clone-resource.svg?capture=' + crypto.randomUUID(); document.body.append(image);
      }, review.origin);
      await resourceRequested;
      const original = await originalChildState(page), rect = await select(page, review), comment = '撮影中に別のiframeが増えても入力を失わない';
      const input = page.getByLabel('コメント本文'); await input.fill(comment);
      await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
      await expect(page.getByText('画像を撮影できなかったため、画像なしで保存します。', { exact: true })).toHaveCount(0);
      expect(await leaf.locator('#held-real-resource').evaluate((image) => (image as HTMLImageElement).complete)).toBe(false);
      await page.evaluate((origin) => {
        const frame = document.createElement('iframe'); frame.id = 'unrelated-late-frame';
        frame.style.cssText = 'position:absolute;left:950px;top:650px;width:150px;height:120px;border:0';
        frame.src = origin + '/inert-frame'; document.body.append(frame);
      }, review.origin);
      await expect(page.frameLocator('#unrelated-late-frame').locator('#inert-marker')).toBeVisible();
      const newFrameState = await page.evaluate(() => ({ parentUrl: location.href, frames: Array.from(document.querySelectorAll('iframe')).map((frame) => ({ id: frame.id, url: frame.contentWindow!.location.href, privateNodes: frame.contentDocument!.querySelectorAll('input[type="password"],[data-needmark-redact]').length })) }));
      expect(newFrameState.frames.find((frame) => frame.id === 'unrelated-late-frame')?.privateNodes).toBe(0);
      release();
      await expect(page.getByText('画像を撮影できなかったため、画像なしで保存します。', { exact: true })).toBeVisible();
      await expect(input).toHaveValue(comment); await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
      await testInfo.attach('new-frame-during-capture', { body: JSON.stringify({ original, after: await originalChildState(page), newFrameState, rect, typedComment: await input.inputValue() }, null, 2), contentType: 'application/json' });
      const item = await save(page, review, comment);
      expect(item.capture).toEqual({ method: 'none', width: 0, height: 0 }); expect(item.image).toBeUndefined();
      expect(await readdir(`${review.output}/${item.id}`)).not.toContain('screenshot.png');
      expect(item.target.rect).toEqual(rect); expect(item.target.code!.elements[0]!.rect).toEqual(rect); expect(item.target.code!.elements[0]!.frameUrls).toEqual([leaf.url()]);
      expect(await originalChildState(page)).toEqual(original);
    } finally { release(); await page.unroute(pattern, handler); }
  });
});
