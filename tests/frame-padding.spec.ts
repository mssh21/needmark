import { type Page } from '@playwright/test';
import { test, expect, saveAndList, output, tempRoot, configureReview, tabColorTolerance } from './support/review.js';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startReviewProxy, type ReviewProxy } from '../dist/proxy.js';
import type { Feedback, Rectangle, RuntimeSourceRequest, RuntimeSourceResult, SourceLocation } from '../src/shared/types.js';

const fixturePath = resolve('tests/fixtures/frame-capture.jsx'), sourceFile = 'src/frame-capture.jsx';
const currentColor = [217, 91, 36, 255], outlineColor = [25, 101, 227, 255];
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

/** Real unmodified CaptureTarget, live React state, source maps and protected public proxy. */
async function withReview(page: Page, run: (review: { origin: string; output: string; source: string }) => Promise<void>) {
  const root = await mkdtemp(join(tempRoot, 'needmark-frame-padding-'));
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
      } else if (url.pathname === '/') {
        const child = url.searchParams.get('frame') === 'leaf';
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end(`<!doctype html><html><head><title>NeedMark frame padding</title><style>
          html,body{margin:0;font:16px sans-serif;background:${child ? '#d3e8ef' : '#dbe9ce'}}body{min-height:${child ? 1400 : 1800}px}*{box-sizing:border-box}
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
    proxy = await startReviewProxy({ root, target, origin, capture: 'dom' });
    await page.goto(origin + '/');
    await expect(page.frameLocator('#outer-capture-frame').locator('[data-cy="frame-live-button"]')).toBeVisible();
    await run({ origin, output: root + '/.needmark/feedback', source });
  } finally { await proxy?.close(); if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true }); }
}

function expectedSource(source: string): SourceLocation {
  const lines = source.split('\n'), line = lines.findIndex((value) => value.includes('data-cy="frame-live-button"'));
  if (line < 0) throw new Error('The actual CaptureTarget opening node is missing');
  return { file: sourceFile, line: line + 1, column: lines[line]!.indexOf('<button') + 1, component: 'CaptureTarget' };
}
async function pixels(page: Page, png: Buffer, rect: Rectangle, privateRects: Record<string, Rectangle> = {}) {
  return page.evaluate(async ({ png, rect, privateRects }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const sx = image.width / innerWidth, sy = image.height / innerHeight;
    const sample = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * sx), Math.round(y * sy), 1, 1).data);
    return { width: image.width, height: image.height,
      inside: sample(rect.x + 15, rect.y + 15),
      topEdge: sample(rect.x + rect.width / 2, rect.y), leftEdge: sample(rect.x, rect.y + rect.height / 2),
      privacy: Object.fromEntries(Object.entries(privateRects).map(([name, box]) => [name, [
        sample(box.x + 1, box.y + 1), sample(box.x + box.width - 1, box.y + 1),
        sample(box.x + 1, box.y + box.height - 1), sample(box.x + box.width - 1, box.y + box.height - 1),
      ]])) };
  }, { png: png.toString('base64'), rect, privateRects });
}

// One actual saved review: native rendered geometry is the independent oracle, not NeedMark's mapping.
test('a padded bordered iframe saves its original target geometry and DOM PNG outline at the native rendered position', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output, source }) => {
    const frameLocator = page.locator('#outer-capture-frame');
    await frameLocator.evaluate((element) => {
      const frame = element as HTMLIFrameElement;
      frame.style.boxSizing = 'content-box'; frame.style.padding = '24px 20px 16px 32px';
      frame.style.borderStyle = 'solid'; frame.style.borderWidth = '7px 5px'; frame.style.borderColor = '#202020';
    });
    const frameHandle = await frameLocator.elementHandle(), frame = await frameHandle?.contentFrame();
    await frameHandle?.dispose(); if (!frame) throw new Error('The live child document is missing');
    const target = frame.locator('[data-cy="frame-live-button"]'); await target.click(); await expect(target).toHaveText('Current child 1');
    await page.evaluate(() => scrollTo(0, 0)); await frame.evaluate(() => scrollTo(0, 0));
    const original = await target.elementHandle(), originalDocument = await frame.evaluateHandle(() => document);
    if (!original) throw new Error('The original child button is missing');
    try {
      const parentUrl = page.url(), childUrl = frame.url(), rect = await target.boundingBox();
      if (!rect) throw new Error('The native browser target has no rectangle');
      const frameBefore = await frameLocator.evaluate((element) => {
        const frame = element as HTMLIFrameElement, style = getComputedStyle(frame);
        return { html: frame.outerHTML, rect: frame.getBoundingClientRect().toJSON(), paddingLeft: style.paddingLeft, paddingTop: style.paddingTop,
          borderLeft: style.borderLeftWidth, borderTop: style.borderTopWidth, viewport: { width: frame.contentWindow!.innerWidth, height: frame.contentWindow!.innerHeight } };
      });
      const childBefore = await frame.evaluate(() => ({ html: document.body.innerHTML, url: location.href, scrollX, scrollY, password: (document.querySelector('#child-password') as HTMLInputElement).value }));
      expect(frameBefore).toMatchObject({ paddingLeft: '32px', paddingTop: '24px', borderLeft: '5px', borderTop: '7px' });
      const privateRects = await privacyRects(frame);
      const native = await page.screenshot({ caret: 'initial' }), nativePixels = await pixels(page, native, rect, privateRects);
      await testInfo.attach('padded-frame-native.png', { body: native, contentType: 'image/png' });
      expect(nativePixels.inside).toEqual(currentColor); expectPrivacy(nativePixels.privacy, [153, 34, 169, 255]);
      await configureReview(page, { method: 'dom' });
      const response = page.waitForResponse((item) => item.url() === origin + '/__needmark/source' && item.request().method() === 'POST');
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      await expect(page.locator('[data-needmark] .cover')).toBeVisible();
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await expect(page.getByLabel('コメント本文')).toBeVisible();
      const sourceResponse = await response; expect(sourceResponse.status()).toBe(200);
      expect((sourceResponse.request().postDataJSON() as RuntimeSourceRequest).elements[0]?.frames.some((entry) => entry.url.endsWith('/app.js') && entry.component === 'CaptureTarget')).toBe(true);
      expect((await sourceResponse.json() as { elements: RuntimeSourceResult[] }).elements[0]).toEqual({ source: expectedSource(source) });
      await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeVisible();
      const comment = 'iframeの余白と枠があっても画面上の場所に画像の注目枠を合わせる';
      await page.getByLabel('コメント本文').fill(comment); await saveAndList(page);
      await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
      const ids = (await readdir(output, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
      const saved = (await Promise.all(ids.map(async ({ name }) => JSON.parse(await readFile(output + '/' + name + '/context.json', 'utf8')) as Feedback))).find((item) => item.comment === comment);
      if (!saved || !saved.target.code?.elements[0]) throw new Error('The real saved element context is missing');
      const context = saved.target.code.elements[0], png = await readFile(output + '/' + saved.id + '/screenshot.png'), actualPixels = await pixels(page, png, rect, privateRects);
      const frameAfter = await frameLocator.evaluate((element) => element.outerHTML);
      const childAfter = await frame.evaluate(() => ({ html: document.body.innerHTML, url: location.href, scrollX, scrollY, password: (document.querySelector('#child-password') as HTMLInputElement).value }));
      const identity = { sameDocument: await frame.evaluate((original) => original === document, originalDocument),
        sameNode: await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('[data-cy="frame-live-button"]')) };
      await testInfo.attach('padded-frame-saved.png', { body: png, contentType: 'image/png' });
      await testInfo.attach('padded-frame-native-saved-geometry.json', { body: JSON.stringify({ rect, nativePixels, actualPixels, privateRects, saved, frameBefore, frameAfter, childBefore, childAfter, identity, source: expectedSource(source) }, null, 2), contentType: 'application/json' });
      expect(saved.target.kind).toBe('element'); expect(context).toMatchObject({ tag: 'button', text: 'Current child 1', attributes: { 'data-cy': 'frame-live-button' },
        rootPath: ['iframe: #outer-capture-frame'], frameUrls: [childUrl], sourceOrigin: 'runtime', sourceRelation: 'self', source: expectedSource(source) });
      expect(identity).toEqual({ sameDocument: true, sameNode: true }); expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
      expect(frameAfter).toBe(frameBefore.html); expect(childAfter).toEqual(childBefore); expect(await target.boundingBox()).toEqual(rect);
      expect(saved.capture.method).toBe('dom'); expect(saved.viewport.devicePixelRatio).toBe(2);
      expect(actualPixels.width).toBe(saved.capture.width); expect(actualPixels.height).toBe(saved.capture.height);
      // Stored geometry and the image outline must agree with independent native browser bounds.
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(saved.target.rect[key] - rect[key]), 'saved target.' + key).toBeLessThanOrEqual(0.5);
        expect(Math.abs(context.rect[key] - rect[key]), 'saved code.' + key).toBeLessThanOrEqual(0.5);
      }
      expect(actualPixels.inside).toEqual(nativePixels.inside);
      expect(actualPixels.topEdge, 'orange outline at the actual native top edge').toEqual(outlineColor);
      expect(actualPixels.leftEdge, 'orange outline at the actual native left edge').toEqual(outlineColor);
      expectPrivacy(actualPixels.privacy, [46, 49, 52, 255]);
    } finally { await original.dispose(); await originalDocument.dispose(); }
  });
});

async function paddedFrame(page: Page, scaled = false) {
  await page.locator('#outer-capture-frame').evaluate((element, scaled) => {
    const frame = element as HTMLIFrameElement;
    Object.assign(frame.style, { boxSizing: 'content-box', padding: '24px 20px 16px 32px', borderStyle: 'solid', borderWidth: '7px 5px', borderColor: '#202020',
      transform: scaled ? 'scale(1.25,.8)' : 'none', transformOrigin: '0 0' });
  }, scaled);
  const handle = await page.locator('#outer-capture-frame').elementHandle(), frame = await handle?.contentFrame();
  await handle?.dispose(); if (!frame) throw new Error('Child frame unavailable');
  return frame;
}
async function privacyRects(frame: import('@playwright/test').Frame): Promise<Record<string, Rectangle>> {
  const entries = await Promise.all(['child-password', 'child-redact'].map(async (id) => {
    const rect = await frame.locator('#' + id).boundingBox(); if (!rect) throw new Error('Missing private native geometry: ' + id);
    return [id, rect] as const;
  }));
  return Object.fromEntries(entries);
}
async function configureMethod(page: Page, method: 'none' | 'tab') {
  await configureReview(page, { method });
}
async function storedComment(output: string, comment: string) {
  const ids = (await readdir(output, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const saved = (await Promise.all(ids.map(async ({ name }) => JSON.parse(await readFile(output + '/' + name + '/context.json', 'utf8')) as Feedback))).find((item) => item.comment === comment);
  if (!saved) throw new Error('Missing real saved comment'); return saved;
}
async function saveComposer(page: Page, output: string, comment: string) {
  await page.getByLabel('コメント本文').fill(comment); await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  return storedComment(output, comment);
}
async function selectVerified(page: Page, origin: string, source: string, rect: Rectangle) {
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await expect(page.locator('[data-needmark] .cover')).toBeVisible();
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url() === origin + '/__needmark/source' && response.request().method() === 'POST'),
    page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2),
  ]);
  expect(response.status()).toBe(200);
  expect((response.request().postDataJSON() as RuntimeSourceRequest).elements[0]?.frames.some((frame) => frame.url.endsWith('/app.js') && frame.component === 'CaptureTarget')).toBe(true);
  expect((await response.json() as { elements: RuntimeSourceResult[] }).elements[0]).toEqual({ source: expectedSource(source) });
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
}
function expectGeometry(actual: Rectangle, native: Rectangle) {
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual[key] - native[key]), key).toBeLessThanOrEqual(.5);
}
function expectPrivacy(actual: Record<string, number[][]>, color: number[]) {
  for (const corners of Object.values(actual)) for (const corner of corners) expect(corner).toEqual(color);
}

test('padded scaled frames select a thin original at its native center and retain exact native text-range geometry', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output, source }) => {
    const frame = await paddedFrame(page, true), target = frame.locator('[data-cy="frame-live-button"]');
    await target.click(); await expect(target).toHaveText('Current child 1');
    await target.evaluate((element) => Object.assign((element as HTMLElement).style, { width: '12px', height: '12px', padding: '0', overflow: 'hidden', whiteSpace: 'nowrap' }));
    const original = await target.elementHandle(), originalDocument = await frame.evaluateHandle(() => document);
    if (!original) throw new Error('Thin original missing');
    try {
      const parentUrl = page.url(), childUrl = frame.url(), rect = await target.boundingBox(); if (!rect) throw new Error('Thin native rectangle missing');
      expect(rect.width).toBeCloseTo(15); expect(rect.height).toBeCloseTo(9.6, 1);
      expect(await original.evaluate((element) => { const rect = element.getBoundingClientRect(); return element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element; })).toBe(true);
      await configureMethod(page, 'none'); await selectVerified(page, origin, source, rect);
      const saved = await saveComposer(page, output, '余白と拡大縮小がある子画面の細いボタンをそのままコメント');
      expect(saved.target.kind).toBe('element'); expect(saved.target.code!.elements[0]).toMatchObject({ tag: 'button', text: 'Current child 1', sourceOrigin: 'runtime', sourceRelation: 'self', source: expectedSource(source), rootPath: ['iframe: #outer-capture-frame'], frameUrls: [childUrl] });
      expectGeometry(saved.target.rect, rect); expectGeometry(saved.target.code!.elements[0]!.rect, rect); expect(saved.capture).toEqual({ method: 'none', width: 0, height: 0 });
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
      const note = frame.getByRole('textbox', { name: 'Live child note', exact: true }); await note.fill('Frame caret words');
      const noteRect = await note.boundingBox(); if (!noteRect) throw new Error('Native note rectangle missing');
      const nativeRanges = await note.evaluate((element) => {
        const node = element.firstChild!, range = element.ownerDocument.createRange();
        const rect = (start: number, end: number) => { range.setStart(node, start); range.setEnd(node, end); return range.getBoundingClientRect().toJSON(); };
        return { owner: element.getBoundingClientRect().toJSON(), first: rect(0, 1), last: rect(10, 11), selected: rect(0, 11), text: node.textContent!.slice(0, 11) };
      });
      const sx = noteRect.width / nativeRanges.owner.width, sy = noteRect.height / nativeRanges.owner.height;
      const nativeSelected = { x: noteRect.x + (nativeRanges.selected.x - nativeRanges.owner.x) * sx,
        y: noteRect.y + (nativeRanges.selected.y - nativeRanges.owner.y) * sy, width: nativeRanges.selected.width * sx, height: nativeRanges.selected.height * sy };
      const start = { x: noteRect.x + (nativeRanges.first.left - nativeRanges.owner.left + .1) * sx, y: nativeSelected.y + nativeSelected.height / 2 };
      const end = { x: noteRect.x + (nativeRanges.last.right - nativeRanges.owner.left - .1) * sx, y: start.y };
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      await expect(page.locator('[data-needmark] .cover')).toBeVisible();
      await page.keyboard.down('Alt'); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Alt');
      await expect(page.getByLabel('コメント本文')).toBeVisible();
      const text = await saveComposer(page, output, '余白がある子画面の文字範囲を正しい場所に保存');
      expect(text.target.kind).toBe('text'); expect(text.target.text).toBe(nativeRanges.text); expectGeometry(text.target.rect, nativeSelected);
      expect(text.target.code!.elements[0]).toMatchObject({ attributes: { id: 'live-note' }, rootPath: ['iframe: #outer-capture-frame'], frameUrls: [childUrl] });
      expectGeometry(text.target.code!.elements[0]!.rect, noteRect); expect(text.target.code!.elements[0]!.source).toBeUndefined();
      expect(await frame.evaluate((original) => original === document, originalDocument)).toBe(true);
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('[data-cy="frame-live-button"]'))).toBe(true);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
      await testInfo.attach('padded-scaled-thin-and-native-range.json', { body: JSON.stringify({ rect, saved, nativeRanges, nativeSelected, start, end, text }, null, 2), contentType: 'application/json' });
    } finally { await original.dispose(); await originalDocument.dispose(); }
  });
});

test('native tab capture masks every padded scaled child corner at its actual rendered position', async ({ page, browserName }, testInfo) => {
  await withReview(page, async ({ origin, output, source }) => {
    const frame = await paddedFrame(page, true), target = frame.locator('[data-cy="frame-live-button"]');
    await target.click(); await expect(target).toHaveText('Current child 1');
    const rect = await target.boundingBox(); if (!rect) throw new Error('Native reviewed target missing');
    const privateRects = await privacyRects(frame), originalDocument = await frame.evaluateHandle(() => document), original = await target.elementHandle();
    if (!original) throw new Error('Native original missing');
    try {
      const frameBefore = await page.locator('#outer-capture-frame').evaluate((element) => element.outerHTML), childBefore = await frame.evaluate(() => document.body.innerHTML);
      const native = await page.screenshot({ caret: 'initial' }), nativePixels = await pixels(page, native, rect, privateRects);
      await testInfo.attach('padded-scaled-tab-native.png', { body: native, contentType: 'image/png' });
      expectPrivacy(nativePixels.privacy, [153, 34, 169, 255]);
      await configureMethod(page, 'tab'); await selectVerified(page, origin, source, rect);
      await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeVisible();
      const saved = await saveComposer(page, output, 'タブ撮影でも余白と縮尺がある子画面の秘密情報を全周伏せる');
      const png = await readFile(output + '/' + saved.id + '/screenshot.png'), actual = await pixels(page, png, rect, privateRects);
      await testInfo.attach('padded-scaled-tab-saved.png', { body: png, contentType: 'image/png' });
      await testInfo.attach('padded-scaled-tab-privacy.json', { body: JSON.stringify({ nativePixels, actual, privateRects, rect, saved }, null, 2), contentType: 'application/json' });
      expectPrivacy(actual.privacy, [46, 49, 52, 255]);
      actual.inside.forEach((value, index) => expect(Math.abs(value - currentColor[index]!)).toBeLessThanOrEqual(tabColorTolerance));
      expect(saved.capture.method).toBe('tab'); expect(actual.width).toBe(saved.capture.width); expect(actual.height).toBe(saved.capture.height); expect(saved.capture.width).toBeGreaterThan(500);
      expect(saved.viewport.devicePixelRatio).toBe(2); expectGeometry(saved.target.rect, rect); expectGeometry(saved.target.code!.elements[0]!.rect, rect);
      expect(saved.target.code!.elements[0]).toMatchObject({ source: expectedSource(source), sourceRelation: 'self', sourceOrigin: 'runtime', frameUrls: [frame.url()] });
      expect(await frame.evaluate((original) => original === document, originalDocument)).toBe(true);
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('[data-cy="frame-live-button"]'))).toBe(true);
      expect(await page.locator('#outer-capture-frame').evaluate((element) => element.outerHTML)).toBe(frameBefore); expect(await frame.evaluate(() => document.body.innerHTML)).toBe(childBefore);
    } finally { await original.dispose(); await originalDocument.dispose(); }
  });
});

test('multi marquee excludes an unpainted child control whose geometry falls entirely in padded iframe space', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, async () => {
    const frame = await paddedFrame(page, true), target = frame.locator('[data-cy="frame-live-button"]');
    await target.click(); await expect(target).toHaveText('Current child 1');
    await target.evaluate((element) => Object.assign((element as HTMLElement).style, { left: '-20px', top: '260px', width: '12px', height: '12px', padding: '0', overflow: 'hidden' }));
    const original = await target.elementHandle(); if (!original) throw new Error('Clipped original missing');
    try {
      const parentUrl = page.url(), childUrl = frame.url(), rect = await target.boundingBox(); if (!rect) throw new Error('Clipped native rectangle missing');
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const parentHit = await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.id, point);
      const childGeometry = await original.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { rect: rect.toJSON(), connected: element.isConnected,
          nativeHit: element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element };
      });
      const frameBounds = await page.locator('#outer-capture-frame').evaluate((element) => {
        const frame = element as HTMLIFrameElement, bounds = frame.getBoundingClientRect(), style = getComputedStyle(frame), scale = bounds.width / frame.offsetWidth;
        return { innerBorder: bounds.left + frame.clientLeft * scale, contentLeft: bounds.left + (frame.clientLeft + parseFloat(style.paddingLeft)) * scale };
      });
      expect(childGeometry.connected).toBe(true); expect(childGeometry.nativeHit).toBe(false); expect(childGeometry.rect.right).toBeLessThan(0);
      expect(parentHit).toBe('outer-capture-frame'); expect(rect.x).toBeGreaterThan(frameBounds.innerBorder); expect(rect.x + rect.width).toBeLessThan(frameBounds.contentLeft);
      await configureMethod(page, 'none');
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      const cover = page.locator('[data-needmark] .cover'); await expect(cover).toBeVisible();
      await page.mouse.move(rect.x - 1, rect.y - 1); await page.keyboard.down('Shift'); await page.mouse.down(); await page.keyboard.up('Shift'); await page.mouse.move(rect.x + rect.width + 1, rect.y + rect.height + 1, { steps: 4 }); await page.mouse.up();
      await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(0);
      await expect(page.locator('[data-needmark] [data-hint]')).toContainText('0件を選択');
      await page.getByRole('button', { name: '選択を完了', exact: true }).click();
      await expect(page.getByLabel('コメント本文')).toBeHidden(); await expect(cover).toBeVisible();
      await expect(page.locator('[data-needmark] [data-hint]')).toContainText('0件を選択');
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('[data-cy="frame-live-button"]'))).toBe(true);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
      await testInfo.attach('padded-space-unpainted-control.json', { body: JSON.stringify({ rect, point, parentHit, childGeometry, frameBounds }, null, 2), contentType: 'application/json' });
      await testInfo.attach('padded-space-unpainted-control.png', { body: await page.screenshot({ caret: 'initial' }), contentType: 'image/png' });
      await page.keyboard.press('Escape'); await expect(cover).toBeHidden();
    } finally { await original.dispose(); }
  });
});


// Normal Area sampling must describe painted evidence, independently of exact JSX verification.
test('a normal area review over iframe padding never attributes a wholly unpainted child target to its image or AI prompt', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
    (window as unknown as { copied: string }).copied = value;
  } } }));
  await withReview(page, async ({ origin, output, source }) => {
    const frame = await paddedFrame(page, true), target = frame.locator('[data-cy="frame-live-button"]');
    await target.click(); await expect(target).toHaveText('Current child 1');
    const original = await target.elementHandle(), originalDocument = await frame.evaluateHandle(() => document);
    if (!original) throw new Error('The live original child target is missing');
    const sourceCalls: Promise<{ status: number; input: RuntimeSourceRequest; result: { elements?: RuntimeSourceResult[] } }>[] = [];
    const observeSource = (response: import('@playwright/test').Response) => {
      if (response.url() === origin + '/__needmark/source' && response.request().method() === 'POST') sourceCalls.push(response.json().then((result) => ({
        status: response.status(), input: response.request().postDataJSON() as RuntimeSourceRequest, result,
      })));
    };
    try {
      const parentUrl = page.url(), childUrl = frame.url(), visible = await target.boundingBox();
      if (!visible) throw new Error('The initially painted native target is missing');
      expect(expectedSource(source)).toEqual({ file: 'src/frame-capture.jsx', line: 6, column: 18, component: 'CaptureTarget' });
      await configureMethod(page, 'none'); await selectVerified(page, origin, source, visible);
      await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
      await target.evaluate((element) => Object.assign((element as HTMLElement).style, { left: '-20px', top: '260px', width: '12px', height: '12px', padding: '0', overflow: 'hidden', whiteSpace: 'nowrap' }));
      await page.evaluate(() => scrollTo(0, 0)); await frame.evaluate(() => scrollTo(0, 0));
      const rect = await target.boundingBox(); if (!rect) throw new Error('The projected native child rectangle is missing');
      const local = await original.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { rect: rect.toJSON(), centerHit: element.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element };
      });
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const nativeHit = await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.id, point);
      const area = { x: Math.floor(rect.x) - 1, y: Math.floor(rect.y) - 1,
        width: Math.ceil(rect.x + rect.width) + 1 - (Math.floor(rect.x) - 1), height: Math.ceil(rect.y + rect.height) + 1 - (Math.floor(rect.y) - 1) };
      const frameBounds = await page.locator('#outer-capture-frame').evaluate((element) => {
        const frame = element as HTMLIFrameElement, bounds = frame.getBoundingClientRect(), style = getComputedStyle(frame), scale = bounds.width / frame.offsetWidth;
        return { innerBorder: bounds.left + frame.clientLeft * scale, contentLeft: bounds.left + (frame.clientLeft + parseFloat(style.paddingLeft)) * scale };
      });
      const originalIdentity = { sameDocument: await frame.evaluate((original) => original === document, originalDocument),
        sameNode: await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('[data-cy="frame-live-button"]')) };
      expect(local.rect.right).toBeLessThan(0); expect(local.centerHit).toBe(false); expect(nativeHit).toBe('outer-capture-frame');
      expect(area.x).toBeGreaterThan(frameBounds.innerBorder); expect(area.x + area.width).toBeLessThan(frameBounds.contentLeft);
      expect(originalIdentity).toEqual({ sameDocument: true, sameNode: true });
      expect(rect.width).toBeCloseTo(15); expect(rect.height).toBeCloseTo(9.6, 1); expect(area.width).toBeGreaterThan(5); expect(area.height).toBeGreaterThan(5);
      await configureReview(page, { method: 'dom' });
      const frameBefore = await page.locator('#outer-capture-frame').evaluate((element) => element.outerHTML);
      const childBefore = await frame.evaluate(() => ({ html: document.body.innerHTML, url: location.href, scrollX, scrollY }));
      const native = await page.screenshot({ caret: 'initial' });
      const centerPixel = (png: Buffer) => page.evaluate(async ({ png, point }) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, rgba: Array.from(context.getImageData(Math.round(point.x * image.width / innerWidth), Math.round(point.y * image.height / innerHeight), 1, 1).data) };
      }, { png: png.toString('base64'), point });
      const nativePixel = await centerPixel(native); expect(nativePixel.rgba).not.toEqual(currentColor);
      await testInfo.attach('normal-area-padding-native.png', { body: native, contentType: 'image/png' });
      await testInfo.attach('normal-area-padding-preconditions.json', { body: JSON.stringify({ rect, local, point, nativeHit, nativePixel, area, frameBounds, originalIdentity, parentUrl, childUrl, source: expectedSource(source) }, null, 2), contentType: 'application/json' });
      page.on('response', observeSource);
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      await expect(page.locator('[data-needmark] .cover')).toBeVisible();
      await page.mouse.move(area.x, area.y); await page.mouse.down(); await page.mouse.move(area.x + area.width, area.y + area.height, { steps: 4 }); await page.mouse.up();
      const comment = 'iframeの余白だけを囲んだコメントに、画面へ描画されていない子要素を含めない';
      await page.getByLabel('コメント本文').fill(comment);
      await expect.poll(async () => ({ image: await page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true }).isVisible(), failed: await page.getByText('画像を撮影できなかったため、画像なしで保存します。', { exact: true }).isVisible() })).not.toEqual({ image: false, failed: false });
      const captureState = await page.locator('[data-capture-state]').textContent();
      await expect(page.locator('[data-source-state]')).not.toHaveText('対象のコードを確認中…');
      const calls = await Promise.all(sourceCalls);
      await testInfo.attach('normal-area-padding-acquisition.json', { body: JSON.stringify({ captureState, imageVisible: await page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true }).isVisible(), sourceCalls: calls }, null, 2), contentType: 'application/json' });
      // A capture rejection is a product signal, not an excuse to silently switch to image-free evidence.
      await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
      const saved = await saveComposer(page, output, comment), png = await readFile(output + '/' + saved.id + '/screenshot.png'), actualPixel = await centerPixel(png);
      await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
      const prompt = await page.evaluate(() => (window as unknown as { copied: string }).copied);
      const identity = { sameDocument: await frame.evaluate((original) => original === document, originalDocument),
        sameNode: await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('[data-cy="frame-live-button"]')) };
      const frameAfter = await page.locator('#outer-capture-frame').evaluate((element) => element.outerHTML), childAfter = await frame.evaluate(() => ({ html: document.body.innerHTML, url: location.href, scrollX, scrollY }));
      await testInfo.attach('normal-area-padding-saved.png', { body: png, contentType: 'image/png' });
      await testInfo.attach('normal-area-padding-saved-evidence.json', { body: JSON.stringify({ saved, prompt, rect, area, nativePixel, actualPixel, sourceCalls: calls, identity, frameBefore, frameAfter, childBefore, childAfter }, null, 2), contentType: 'application/json' });
      expect(saved.target.kind).toBe('area'); expectGeometry(saved.target.rect, area); expect(saved.capture).toEqual({ method: 'dom', width: actualPixel.width, height: actualPixel.height });
      expect(actualPixel.rgba).toEqual(nativePixel.rgba); expect([actualPixel.width, actualPixel.height]).toEqual([2400, 1700]);
      expect(identity).toEqual({ sameDocument: true, sameNode: true }); expect(frameAfter).toBe(frameBefore); expect(childAfter).toEqual(childBefore);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl); expect(await target.boundingBox()).toEqual(rect);
      // Honest iframe-host fallback or no sampled context is permissible; the hidden original is not.
      expect(JSON.stringify(saved.target.code ?? {})).not.toContain('frame-live-button');
      expect(saved.target.code?.elements.some((element) => element.source?.file === sourceFile && element.source.line === 6 && element.source.column === 18)).toBeFalsy();
      expect(prompt).toContain(saved.id); expect(prompt).toContain(comment); expect(prompt).toContain('screenshot.png');
      expect(prompt).not.toContain('frame-live-button'); expect(prompt).not.toContain(sourceFile + ':6:18');
    } finally { page.off('response', observeSource); await original.dispose(); await originalDocument.dispose(); }
  });
});
