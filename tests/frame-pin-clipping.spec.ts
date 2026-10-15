import { type Page } from '@playwright/test';
import { test, expect, saveAndList, output, tempRoot, configureReview } from './support/review.js';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startReviewProxy, type ReviewProxy } from '../dist/proxy.js';
import type { Feedback } from '../src/shared/types.js';

const fixturePath = resolve('tests/fixtures/frame-route.jsx');
const sourceFile = 'src/frame-route.jsx';
test.setTimeout(45_000);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral loopback port');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}

/** Reuse the actual C17 React fixture and protected public proxy, with no /source or DOM identity mocks. */
async function withReview(page: Page, run: (review: { origin: string; output: string }) => Promise<void>) {
  const root = await mkdtemp(join(tempRoot, 'needmark-frame-pin-'));
  let upstream: Server | undefined, proxy: ReviewProxy | undefined;
  try {
    await mkdir(root + '/src'); await writeFile(root + '/' + sourceFile, await readFile(fixturePath, 'utf8'));
    await build({ absWorkingDir: root, entryPoints: [sourceFile], outfile: root + '/app.js', bundle: true,
      format: 'esm', jsx: 'automatic', jsxDev: true, sourcemap: 'linked', keepNames: true, minify: false,
      nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"development"' } });
    upstream = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (['/app.js', '/app.js.map'].includes(pathname)) {
        void readFile(root + pathname).then((body) => {
          response.writeHead(200, { 'Content-Type': pathname.endsWith('.map') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
        }, () => { response.writeHead(404); response.end(); });
      } else if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><head><title>NeedMark saved frame pin</title><style>body{margin:0;font:16px sans-serif}#app{padding:36px}button{width:280px;height:48px;font:16px sans-serif}h1{font-size:20px}</style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
      } else { response.writeHead(404); response.end(); }
    });
    const target = await listen(upstream);
    const reservation = createServer(), origin = await listen(reservation); await close(reservation);
    proxy = await startReviewProxy({ root, target, origin, capture: 'none' });
    await page.goto(origin + '/');
    await expect(page.frameLocator('#outer-review-frame').locator('button[data-cy="route-checkout"]')).toBeVisible();
    await run({ origin, output: root + '/.needmark/feedback' });
  } finally {
    await proxy?.close(); if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true });
  }
}

// Saved pins follow current painted bounds without changing stored target evidence.
test('a saved iframe element pin hides when its unchanged original is wholly clipped by child scrolling and recovers on scrollback', async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output }) => {
    const frameHandle = await page.locator('#outer-review-frame').elementHandle(), frame = await frameHandle?.contentFrame();
    await frameHandle?.dispose(); if (!frame) throw new Error('Child frame is unavailable');
    const target = frame.locator('button[data-cy="route-checkout"]'), original = await target.elementHandle();
    if (!original) throw new Error('Original child target is unavailable');
    try {
      // Give the existing fixture enough document height to scroll. The reviewed node/source/route stay unchanged.
      await frame.evaluate(() => { document.body.style.minHeight = '1800px'; });
      const parentUrl = page.url(), childUrl = frame.url(), before = await target.boundingBox();
      if (!before) throw new Error('Original target has no rectangle');
      await configureReview(page, { method: 'none' });
      const response = page.waitForResponse((item) => item.url() === origin + '/__needmark/source' && item.request().method() === 'POST');
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      await expect(page.locator('[data-needmark] .cover')).toBeVisible();
      await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
      await expect(page.getByLabel('コメント本文')).toBeVisible();
      expect((await response).status()).toBe(200);
      await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
      const comment = '子画面内で隠れた場所に確認済みピンを残さない';
      await page.getByLabel('コメント本文').fill(comment);
      await saveAndList(page);
      await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
      const ids = (await readdir(output, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
      const saved = (await Promise.all(ids.map(async ({ name }) => JSON.parse(await readFile(output + '/' + name + '/context.json', 'utf8')) as Feedback))).find((item) => item.comment === comment);
      if (!saved) throw new Error('The saved feedback is missing');
      expect(saved.capture.method).toBe('none'); expect(saved.image).toBeUndefined();
      expect(saved.target.code!.elements[0]).toMatchObject({ rootPath: ['iframe: #outer-review-frame'], frameUrls: [childUrl], sourceOrigin: 'runtime', sourceRelation: 'self', source: { file: sourceFile } });
      const contextPath = output + '/' + saved.id + '/context.json', contextBytes = await readFile(contextPath);
      await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
      const pin = page.getByRole('button', { name: 'コメント: ' + comment, exact: true }), tip = page.locator('[data-needmark] .tip');
      await expect(pin).toBeVisible(); await pin.focus(); await expect(tip).not.toContainText('対象未確認');
      await frame.evaluate(() => window.scrollTo(0, 100));
      await expect.poll(() => frame.evaluate(() => scrollY)).toBe(100);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const geometry = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#outer-review-frame')!, rect = frame.getBoundingClientRect();
        const target = frame.contentDocument!.querySelector('button[data-cy="route-checkout"]')!, local = target.getBoundingClientRect();
        return { frame: rect.toJSON(), contentTop: rect.top + frame.clientTop, target: { x: rect.left + frame.clientLeft + local.left, y: rect.top + frame.clientTop + local.top, width: local.width, height: local.height }, parentScroll: scrollY, parentHeight: innerHeight };
      });
      expect(geometry.parentScroll).toBe(0);
      expect(geometry.target.y + geometry.target.height).toBeLessThanOrEqual(geometry.contentTop);
      expect(geometry.target.y + geometry.target.height / 2).toBeGreaterThan(14);
      expect(geometry.target.y + geometry.target.height / 2).toBeLessThan(geometry.parentHeight - 14);
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('button[data-cy="route-checkout"]'))).toBe(true);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
      const pinVisible = await pin.isVisible();
      if (pinVisible) await pin.focus(); // Failure-only evidence; no alternate success path.
      const pinRect = pinVisible ? await pin.boundingBox() : null;
      await testInfo.attach('fully-clipped-original-and-saved-pin', { body: JSON.stringify({ saved, before, geometry, parentUrl, childUrl, pinVisible, pinRect, tooltip: await tip.textContent() }, null, 2), contentType: 'application/json' });
      await testInfo.attach('fully-clipped-saved-pin-screen', { body: await page.screenshot(), contentType: 'image/png' });
      // A fully clipped live original has no current pin.
      await expect(pin).toBeHidden({ timeout: 1500 });
      expect(await readFile(contextPath)).toEqual(contextBytes);
      await frame.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => frame.evaluate(() => scrollY)).toBe(0);
      await expect(pin).toBeVisible(); await pin.focus(); await expect(tip).not.toContainText('対象未確認');
      await expect.poll(async () => {
        const box = await target.boundingBox(), marker = await pin.boundingBox();
        return box && marker ? Math.abs(marker.y + marker.height / 2 - box.y - box.height / 2) : Infinity;
      }).toBeLessThan(1);
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('button[data-cy="route-checkout"]'))).toBe(true);
      expect(saved.target.rect).toEqual(before); expect(saved.target.code!.elements[0]!.rect).toEqual(before);
      expect(await readFile(contextPath)).toEqual(contextBytes);
    } finally { await original.dispose(); }
  });
});

async function configureNoImage(page: Page) {
  await configureReview(page, { method: 'none' });
}

async function saveReview(page: Page, frame: import('@playwright/test').Frame, origin: string, output: string, comment: string) {
  const target = frame.locator('button[data-cy="route-checkout"]'), rect = await target.boundingBox();
  if (!rect) throw new Error('Reviewed original has no rectangle');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(page.locator('[data-needmark] .cover')).toBeVisible();
  const [source] = await Promise.all([
    page.waitForResponse((response) => response.url() === origin + '/__needmark/source' && response.request().method() === 'POST'),
    page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2),
  ]);
  expect(source.status()).toBe(200);
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
  await page.getByLabel('コメント本文').fill(comment);
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const entries = (await readdir(output, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const saved = (await Promise.all(entries.map(async ({ name }) => JSON.parse(await readFile(output + '/' + name + '/context.json', 'utf8')) as Feedback))).find((item) => item.comment === comment);
  if (!saved) throw new Error('Saved review missing');
  expect(saved.capture.method).toBe('none'); expect(saved.image).toBeUndefined();
  expect(saved.target.rect).toEqual(rect);
  expect(saved.target.code!.elements[0]).toMatchObject({ rect, rootPath: ['iframe: #outer-review-frame'], frameUrls: [frame.url()], sourceOrigin: 'runtime', sourceRelation: 'self', source: { file: sourceFile, line: 4, column: 18, component: 'RouteTarget' } });
  const path = output + '/' + saved.id + '/context.json', bytes = await readFile(path);
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  const pin = page.getByRole('button', { name: 'コメント: ' + comment, exact: true });
  await expect(pin).toBeVisible(); await pin.focus();
  await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
  return { saved, path, bytes, pin };
}

async function reviewFrame(page: Page) {
  const handle = await page.locator('#outer-review-frame').elementHandle(), frame = await handle?.contentFrame();
  await handle?.dispose(); if (!frame) throw new Error('Child frame unavailable');
  const original = await frame.locator('button[data-cy="route-checkout"]').elementHandle();
  if (!original) throw new Error('Original target unavailable');
  return { frame, original };
}

// Both collision-adjusted centers must describe the remaining painted pixels, even when narrower than a marker.
test('two saved pins stay inside a narrow positive child viewport intersection and recover their full positions', async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output }) => {
    const { frame, original } = await reviewFrame(page), parentUrl = page.url(), childUrl = frame.url();
    try {
      await frame.evaluate(() => { document.body.style.minWidth = '1800px'; document.body.style.minHeight = '1800px'; });
      await configureNoImage(page);
      const first = await saveReview(page, frame, origin, output, '同じ場所のコメント一件目');
      const second = await saveReview(page, frame, origin, output, '同じ場所のコメント二件目');
      const initialPins = await Promise.all([first.pin.boundingBox(), second.pin.boundingBox()]);
      expect(initialPins[0]).not.toBeNull(); expect(initialPins[1]).not.toBeNull();
      expect(Math.abs(initialPins[0]!.x - initialPins[1]!.x)).toBeGreaterThan(20);
      await frame.evaluate(() => scrollTo(308, 76));
      await expect.poll(() => frame.evaluate(() => [scrollX, scrollY])).toEqual([308, 76]);
      const intersection = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#outer-review-frame')!, bounds = frame.getBoundingClientRect();
        const target = frame.contentDocument!.querySelector('button[data-cy="route-checkout"]')!.getBoundingClientRect();
        const x = Math.max(bounds.left, bounds.left + target.left), y = Math.max(bounds.top, bounds.top + target.top);
        return { x, y, width: Math.min(bounds.right, bounds.left + target.right) - x, height: Math.min(bounds.bottom, bounds.top + target.bottom) - y };
      });
      expect(intersection.width).toBeGreaterThan(0); expect(intersection.width).toBeLessThanOrEqual(10);
      expect(intersection.height).toBeGreaterThan(0); expect(intersection.height).toBeLessThanOrEqual(10);
      for (const review of [first, second]) {
        await expect(review.pin).toBeVisible();
        await expect.poll(async () => {
          const pin = await review.pin.boundingBox(); if (!pin) return false;
          const x = pin.x + pin.width / 2, y = pin.y + pin.height / 2;
          return x >= intersection.x && x <= intersection.x + intersection.width && y >= intersection.y && y <= intersection.y + intersection.height;
        }).toBe(true);
        await review.pin.focus(); await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
      }
      await testInfo.attach('narrow-intersection-pins', { body: JSON.stringify({ intersection, saved: [first.saved, second.saved], pins: await Promise.all([first.pin.boundingBox(), second.pin.boundingBox()]) }, null, 2), contentType: 'application/json' });
      await testInfo.attach('narrow-intersection-screen', { body: await page.screenshot(), contentType: 'image/png' });
      await frame.evaluate(() => scrollTo(308, 100));
      await expect(first.pin).toBeHidden(); await expect(second.pin).toBeHidden();
      await frame.evaluate(() => scrollTo(0, 0));
      for (const [index, review] of [first, second].entries()) {
        await expect(review.pin).toBeVisible();
        await expect.poll(async () => { const current = await review.pin.boundingBox(); return current ? Math.max(Math.abs(current.x - initialPins[index]!.x), Math.abs(current.y - initialPins[index]!.y)) : Infinity; }).toBeLessThan(1);
        expect(await readFile(review.path)).toEqual(review.bytes);
        expect(review.saved.target.rect).toEqual(first.saved.target.rect);
      }
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('button[data-cy="route-checkout"]'))).toBe(true);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
    } finally { await original.dispose(); }
  });
});

// Browser hit testing establishes that ordinary overflow can be escaped; containing blocks then clip that same original.
test('saved child pins follow painted absolute and fixed escapes but hide at real containing block clips', async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output }) => {
    const { frame, original } = await reviewFrame(page), parentUrl = page.url(), childUrl = frame.url();
    try {
      await configureNoImage(page);
      const review = await saveReview(page, frame, origin, output, '配置指定がはみ出して見える対象のピン');
      await frame.evaluate(() => {
        const target = document.querySelector<HTMLButtonElement>('button[data-cy="route-checkout"]')!;
        const wrapper = document.createElement('div'); wrapper.id = 'pin-clip-parent';
        wrapper.style.cssText = 'width:80px;height:40px;overflow:hidden;margin-left:36px;margin-top:36px';
        document.body.append(wrapper); wrapper.append(target);
        target.style.cssText = 'position:absolute;left:160px;top:180px';
        target.addEventListener('click', () => target.dataset.clicks = String(Number(target.dataset.clicks ?? 0) + 1));
      });
      const geometry = async () => frame.evaluate(() => {
        const target = document.querySelector<HTMLButtonElement>('button[data-cy="route-checkout"]')!, wrapper = document.querySelector('#pin-clip-parent')!;
        const rect = target.getBoundingClientRect(), clip = wrapper.getBoundingClientRect();
        return { rect: rect.toJSON(), clip: clip.toJSON(), nativeHit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === target };
      });
      const states: unknown[] = [];
      for (const kind of ['absolute', 'fixed'] as const) {
        await frame.evaluate((kind) => { const target = document.querySelector<HTMLElement>('button[data-cy="route-checkout"]')!, wrapper = document.querySelector<HTMLElement>('#pin-clip-parent')!; wrapper.style.position = 'static'; wrapper.style.transform = 'none'; target.style.position = kind; }, kind);
        const escape = await geometry(); expect(escape.nativeHit).toBe(true);
        expect(escape.rect.left).toBeGreaterThan(escape.clip.right); expect(escape.rect.top).toBeGreaterThan(escape.clip.bottom);
        await page.getByRole('button', { name: 'ピンの表示切り替え', exact: true }).click(); await expect(review.pin).toBeHidden();
        const bounds = await frame.locator('button[data-cy="route-checkout"]').boundingBox(); if (!bounds) throw new Error('Escaped target has no bounds');
        const clicks = await original.getAttribute('data-clicks');
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await expect(frame.locator('button[data-cy="route-checkout"]')).toHaveAttribute('data-clicks', String(Number(clicks ?? 0) + 1));
        await page.getByRole('button', { name: 'ピンの表示切り替え', exact: true }).click(); await expect(review.pin).toBeVisible();
        await review.pin.focus(); await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
        await frame.evaluate((kind) => { const wrapper = document.querySelector<HTMLElement>('#pin-clip-parent')!; if (kind === 'absolute') wrapper.style.position = 'relative'; else wrapper.style.transform = 'translateZ(0)'; }, kind);
        const constrained = await geometry(); expect(constrained.nativeHit).toBe(false);
        expect(constrained.rect.left).toBeGreaterThan(constrained.clip.right); expect(constrained.rect.top).toBeGreaterThan(constrained.clip.bottom);
        await expect(review.pin).toBeHidden();
        expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('button[data-cy="route-checkout"]'))).toBe(true);
        expect(await readFile(review.path)).toEqual(review.bytes);
        states.push({ kind, escape, constrained });
      }
      await frame.evaluate(() => { const target = document.querySelector<HTMLElement>('button[data-cy="route-checkout"]')!; document.querySelector('#app')!.append(target); target.removeAttribute('style'); document.querySelector('#pin-clip-parent')!.remove(); });
      await expect(review.pin).toBeVisible();
      expect(await frame.locator('button[data-cy="route-checkout"]').boundingBox()).toEqual(review.saved.target.rect);
      expect(await readFile(review.path)).toEqual(review.bytes);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
      await testInfo.attach('positioned-escape-and-containing-blocks', { body: JSON.stringify({ states, saved: review.saved }, null, 2), contentType: 'application/json' });
    } finally { await original.dispose(); }
  });
});

test('saved child pins respect iframe ancestor opacity and visibility while allowing an explicitly visible descendant', async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output }) => {
    // Wrap before capturing any identity: reparenting a live iframe itself creates a fresh child document.
    await page.locator('#outer-review-frame').evaluate((frame) => { const wrapper = document.createElement('div'); wrapper.id = 'saved-frame-owner'; frame.before(wrapper); wrapper.append(frame); });
    await expect(page.frameLocator('#outer-review-frame').locator('button[data-cy="route-checkout"]')).toBeVisible();
    const { frame, original } = await reviewFrame(page), parentUrl = page.url(), childUrl = frame.url();
    try {
      await configureNoImage(page);
      const review = await saveReview(page, frame, origin, output, '隠れた子画面と可視指定された対象を区別');
      await page.locator('#saved-frame-owner').evaluate((element) => (element as HTMLElement).style.opacity = '0');
      await expect(review.pin).toBeHidden();
      await page.locator('#saved-frame-owner').evaluate((element) => (element as HTMLElement).style.opacity = '1');
      await expect(review.pin).toBeVisible();
      await page.locator('#saved-frame-owner').evaluate((element) => (element as HTMLElement).style.visibility = 'hidden');
      await expect(review.pin).toBeHidden();
      await page.locator('#outer-review-frame').evaluate((element) => (element as HTMLElement).style.visibility = 'visible');
      await expect(review.pin).toBeVisible();
      await frame.evaluate(() => { document.querySelector<HTMLElement>('#app')!.style.visibility = 'hidden'; document.querySelector<HTMLElement>('button[data-cy="route-checkout"]')!.style.visibility = 'visible'; });
      await expect(review.pin).toBeVisible();
      const visibleOverride = await original.evaluate((element) => { const rect = element.getBoundingClientRect(); return { visibility: getComputedStyle(element).visibility, nativeHit: element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element }; });
      expect(visibleOverride).toEqual({ visibility: 'visible', nativeHit: true });
      await original.evaluate((element) => (element as HTMLElement).style.visibility = 'hidden');
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const ownHidden = await original.evaluate((element) => ({ computedVisibility: getComputedStyle(element).visibility,
        innerText: (element as HTMLElement).innerText, textContent: element.textContent, isConnected: element.isConnected, childUrl: location.href }));
      await testInfo.attach('own-hidden-current-identity-and-pin', { body: JSON.stringify({ ownHidden, pinVisible: await review.pin.isVisible(), tooltip: await page.locator('[data-needmark] .tip').textContent() }, null, 2), contentType: 'application/json' });
      await expect(review.pin).toBeHidden();
      await original.evaluate((element) => (element as HTMLElement).style.visibility = 'visible'); await expect(review.pin).toBeVisible();
      await review.pin.focus(); await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
      expect(await original.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('button[data-cy="route-checkout"]'))).toBe(true);
      expect(page.url()).toBe(parentUrl); expect(frame.url()).toBe(childUrl);
      expect(await readFile(review.path)).toEqual(review.bytes);
      expect(await frame.locator('button[data-cy="route-checkout"]').boundingBox()).toEqual(review.saved.target.rect);
      await testInfo.attach('visible-descendant-and-saved-source', { body: JSON.stringify({ visibleOverride, saved: review.saved }, null, 2), contentType: 'application/json' });
    } finally { await original.dispose(); }
  });
});

test('unconfirmed pins suppress only a unique invisible candidate on the recorded child route and preserve other fallbacks', async ({ page }, testInfo) => {
  await withReview(page, async ({ origin, output }) => {
    const { frame, original } = await reviewFrame(page), parentUrl = page.url(), childUrl = frame.url();
    try {
      await configureNoImage(page);
      const review = await saveReview(page, frame, origin, output, '未確認の記録位置と隠れた同一ページ候補を区別');
      expect(review.saved.target.code!.elements[0]!.frameUrls).toEqual([childUrl]);
      await original.evaluate((element) => element.textContent = 'A different visible child item');
      await expect(review.pin).toBeVisible(); await review.pin.focus();
      await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
      await original.evaluate((element) => (element as HTMLElement).style.visibility = 'hidden');
      await expect(review.pin).toBeHidden();
      await original.evaluate((element) => (element as HTMLElement).style.visibility = 'visible');
      await expect(review.pin).toBeVisible(); await review.pin.focus();
      await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
      const visibleChanged = { pin: await review.pin.boundingBox(), tooltip: await page.locator('[data-needmark] .tip').textContent() };
      await frame.evaluate(() => { history.pushState({}, '', '?frame=leaf&screen=other#route-B'); document.querySelector<HTMLElement>('button[data-cy="route-checkout"]')!.style.visibility = 'hidden'; });
      await expect.poll(() => frame.evaluate(() => location.href)).not.toBe(childUrl);
      await expect(review.pin).toBeVisible(); await review.pin.focus();
      await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
      const otherRoute = { url: frame.url(), pin: await review.pin.boundingBox(), tooltip: await page.locator('[data-needmark] .tip').textContent() };
      await original.evaluate((element) => element.remove());
      await frame.evaluate((url) => history.replaceState({}, '', url), childUrl);
      await expect.poll(() => frame.evaluate(() => location.href)).toBe(childUrl);
      await expect(review.pin).toBeVisible(); await review.pin.focus();
      await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
      expect(await original.evaluate((element) => element.isConnected)).toBe(false);
      expect(page.url()).toBe(parentUrl); expect(await readFile(review.path)).toEqual(review.bytes);
      expect(review.saved.target.rect).toEqual(review.saved.target.code!.elements[0]!.rect);
      await testInfo.attach('unconfirmed-candidate-route-and-missing-fallback', { body: JSON.stringify({ saved: review.saved, parentUrl, childUrl, visibleChanged, otherRoute, missingPin: await review.pin.boundingBox() }, null, 2), contentType: 'application/json' });
    } finally { await original.dispose(); }
  });
});
