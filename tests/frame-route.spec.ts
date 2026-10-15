import { type Frame, type Locator, type Page, type TestInfo } from '@playwright/test';
import { test, expect, saveAndList, output, tempRoot, configureReview } from './support/review.js';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startReviewProxy, type ReviewProxy } from '../dist/proxy.js';
import type { ElementContext, Feedback, RuntimeSourceRequest, RuntimeSourceResult, SourceLocation } from '../src/shared/types.js';

type FrameContext = ElementContext & { frameUrls?: string[] };
type Review = { root: string; output: string; source: string; origin: string };
const fixturePath = resolve('tests/fixtures/frame-route.jsx');
const sourceFile = 'src/frame-route.jsx';
const childA = '/?frame=leaf&screen=checkout#route-A';
const childB = '/?frame=leaf&screen=other#route-B';
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

/** Real React frames, current JSX, HTTP source maps and protected public proxy; no /source response mocks. */
async function withReview(page: Page, nested: boolean, run: (review: Review) => Promise<void>) {
  const root = await mkdtemp(join(tempRoot, 'needmark-frame-route-'));
  let upstream: Server | undefined, proxy: ReviewProxy | undefined;
  try {
    const source = await readFile(fixturePath, 'utf8');
    await mkdir(root + '/src'); await writeFile(root + '/' + sourceFile, source);
    await build({ absWorkingDir: root, entryPoints: [sourceFile], outfile: root + '/app.js', bundle: true,
      format: 'esm', jsx: 'automatic', jsxDev: true, sourcemap: 'linked', keepNames: true, minify: false,
      nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"development"' } });
    await build({ stdin: { contents: [
      'export * from ' + JSON.stringify(resolve('src/client/context/code-context.ts')) + ';',
      'export * from ' + JSON.stringify(resolve('src/client/capture/identity.ts')) + ';',
      'export * from ' + JSON.stringify(resolve('src/client/page-changes.ts')) + ';',
    ].join('\n'), resolveDir: root, sourcefile: 'identity-entry.ts', loader: 'ts' },
    outfile: root + '/identity.js', bundle: true, format: 'esm' });
    upstream = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (['/app.js', '/app.js.map', '/identity.js'].includes(pathname)) {
        void readFile(root + pathname).then((body) => {
          response.writeHead(200, { 'Content-Type': pathname.endsWith('.map') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
        }, () => { response.writeHead(404); response.end(); });
      } else if (pathname === '/inert') {
        // A genuine same-origin document without a widget or application history wrapper.
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Inert child history');
      } else if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><head><title>NeedMark frame routes</title><style>body{margin:0;font:16px sans-serif}#app{padding:36px}button{width:280px;height:48px;font:16px sans-serif}h1{font-size:20px}</style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
      } else { response.writeHead(404); response.end(); }
    });
    const target = await listen(upstream);
    const reservation = createServer(); const origin = await listen(reservation); await close(reservation);
    proxy = await startReviewProxy({ root, target, origin, capture: 'dom', editor: 'vscode' });
    await page.goto(origin + '/' + (nested ? '?nested' : ''));
    await expect(leafTarget(page, nested)).toBeVisible();
    await run({ root, output: root + '/.needmark/feedback', source, origin });
  } finally {
    await proxy?.close(); if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true });
  }
}

function leafTarget(page: Page, nested = false): Locator {
  const outer = page.frameLocator('#outer-review-frame');
  return (nested ? outer.frameLocator('#nested-shadow-root #inner-review-frame') : outer).locator('button[data-cy="route-checkout"]');
}
async function leafFrame(page: Page, nested = false): Promise<Frame> {
  const handle = await (nested ? page.frameLocator('#outer-review-frame').locator('#nested-shadow-root #inner-review-frame') : page.locator('#outer-review-frame')).elementHandle();
  const frame = await handle?.contentFrame(); await handle?.dispose();
  if (!frame) throw new Error('Child frame is not available');
  return frame;
}
function sourceOf(review: Review): SourceLocation {
  const lines = review.source.split('\n'), line = lines.findIndex((value) => value.includes('data-cy="route-checkout"'));
  expect(line).toBeGreaterThanOrEqual(0);
  return { file: sourceFile, line: line + 1, column: lines[line]!.indexOf('<button') + 1, component: 'RouteTarget' };
}
async function method(page: Page, value: 'dom' | 'none') {
  await configureReview(page, { method: value });
}
async function select(page: Page, review: Review, nested = false) {
  const response = page.waitForResponse((response) => response.url() === review.origin + '/__needmark/source' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await leafTarget(page, nested).boundingBox(); if (!rect) throw new Error('Target has no rectangle');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible();
  const result = await response; expect(result.status()).toBe(200);
  const request = result.request().postDataJSON() as RuntimeSourceRequest;
  expect(request.elements[0]?.frames.some((frame) => frame.url.endsWith('/app.js') && frame.component === 'RouteTarget')).toBe(true);
  expect((await result.json() as { elements: RuntimeSourceResult[] }).elements[0]).toEqual({ source: sourceOf(review) });
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
  return rect;
}
async function save(page: Page, review: Review, comment: string): Promise<Feedback> {
  await page.getByLabel('コメント本文').fill(comment);
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const records = await Promise.all((await readdir(review.output)).filter((name) => !name.startsWith('.')).map(async (id) => JSON.parse(await readFile(review.output + '/' + id + '/context.json', 'utf8')) as Feedback));
  const item = records.find((record) => record.comment === comment);
  if (!item) throw new Error('Saved feedback is missing');
  expect(item.target.code?.elements[0]).toMatchObject({ source: sourceOf(review), sourceOrigin: 'runtime', sourceRelation: 'self', attributes: { 'data-cy': 'route-checkout' } });
  expect(JSON.stringify(item)).not.toContain('"frames"');
  return item;
}
async function closePanel(page: Page) { await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); }
async function verified(page: Page, comment: string, expected: boolean) {
  const pin = page.getByRole('button', { name: 'コメント: ' + comment, exact: true });
  await expect(pin).toBeVisible(); await pin.focus();
  const tip = page.locator('[data-needmark] .tip');
  await expect(tip).toBeVisible();
  if (expected) await expect(tip).not.toContainText('対象未確認'); else await expect(tip).toContainText('対象未確認');
}
async function attachState(page: Page, frame: Frame, saved: Feedback, name: string, testInfo: TestInfo) {
  await testInfo.attach(name, { body: JSON.stringify({
    parentUrl: page.url(), childUrl: frame.url(), saved,
    live: await frame.locator('button[data-cy]').evaluate((element) => ({
      connected: element.isConnected, text: element.textContent, attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
      rect: element.getBoundingClientRect().toJSON(), owner: Object.keys(element).filter((name) => name.startsWith('__reactFiber$')).length,
    })),
    tip: await page.locator('[data-needmark] .tip').textContent(),
  }, null, 2), contentType: 'application/json' });
  await testInfo.attach(name + '-screen', { body: await page.screenshot(), contentType: 'image/png' });
}

test('saved sourced child review refuses the identical target on another child route and recovers only the exact URL', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    await method(page, 'dom'); await select(page, review);
    const comment = '子画面Aにだけ対応するコメント', item = await save(page, review, comment);
    expect(item.image).toBe('screenshot.png'); expect(item.capture.method).toBe('dom');
    const contextPath = review.output + '/' + item.id + '/context.json', imagePath = review.output + '/' + item.id + '/screenshot.png';
    const originalContext = await readFile(contextPath), originalImage = await readFile(imagePath);
    expect(originalImage.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await closePanel(page); await page.reload(); await expect(leafTarget(page)).toBeVisible();
    await verified(page, comment, true);
    const frame = await leafFrame(page), parentUrl = page.url();
    await frame.goto(review.origin + childB); await expect(leafTarget(page)).toBeVisible();
    expect(page.url()).toBe(parentUrl);
    await page.getByRole('button', { name: 'コメント: ' + comment, exact: true }).focus();
    await attachState(page, frame, item, 'identical-child-on-other-route', testInfo);
    // Genuine baseline product failure occurs here, before checking the new optional schema.
    await verified(page, comment, false);
    await frame.goto(review.origin + childA); await expect(leafTarget(page)).toBeVisible();
    await verified(page, comment, true);
    expect((item.target.code!.elements[0] as FrameContext).frameUrls).toEqual([review.origin + childA]);
    expect(await readFile(contextPath)).toEqual(originalContext); expect(await readFile(imagePath)).toEqual(originalImage);
    await page.getByRole('button', { name: 'コメント: ' + comment, exact: true }).click();
    await expect(page.getByText(comment, { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'コメントのキャプチャ', exact: true })).toBeVisible();
  });
});

test('connected child-only push, replace, hash and back changes notify automatically without DOM mutations and legacy contexts remain readable', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    await method(page, 'none'); await select(page, review);
    const comment = 'pure child history', item = await save(page, review, comment);
    await closePanel(page); await verified(page, comment, true);
    const frame = await leafFrame(page), parentUrl = page.url();
    await page.evaluate(async ({ origin, paths }) => {
      const { installPageChanges } = await import(origin + '/identity.js');
      const state = window as unknown as { childRouteNotifications: number; detachRouteProbe: () => void };
      state.childRouteNotifications = 0;
      const observer = installPageChanges(document.querySelector<HTMLElement>('[data-needmark]')!, () => state.childRouteNotifications++);
      observer.sync(paths); state.detachRouteProbe = () => observer.dispose();
    }, { origin: review.origin, paths: [item.target.code!.elements[0]!.rootPath!] });
    await frame.evaluate(() => {
      const state = window as unknown as { routeOriginal: Element; routeMutations: number; routeObserver: MutationObserver };
      state.routeOriginal = document.querySelector('button[data-cy]')!; state.routeMutations = 0;
      state.routeObserver = new MutationObserver((records) => { state.routeMutations += records.length; });
      state.routeObserver.observe(document.querySelector('#app')!, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const notifications = () => page.evaluate(() => (window as unknown as { childRouteNotifications: number }).childRouteNotifications);
    const routeChange = async (action: 'push' | 'replace' | 'hash' | 'back', path: string, expected: boolean) => {
      const before = await notifications();
      await frame.evaluate(({ action, path }) => {
        if (action === 'push') history.pushState({}, '', path);
        else if (action === 'replace') history.replaceState({}, '', path);
        else if (action === 'hash') location.hash = path;
        else history.back();
      }, { action, path });
      await expect.poll(() => notifications()).toBeGreaterThan(before);
      await verified(page, comment, expected);
      expect(page.url()).toBe(parentUrl);
      expect(await frame.evaluate(() => {
        const state = window as unknown as { routeOriginal: Element; routeMutations: number };
        return { sameNode: state.routeOriginal === document.querySelector('button[data-cy]'), connected: state.routeOriginal.isConnected, mutations: state.routeMutations };
      })).toEqual({ sameNode: true, connected: true, mutations: 0 });
    };
    await routeChange('push', '/?frame=leaf&screen=other#route-A', false);
    await routeChange('replace', childA, true);
    await routeChange('hash', '#route-B', false);
    await routeChange('back', '', true);
    await testInfo.attach('pure-history-notifications', { body: JSON.stringify({ count: await notifications(), parentUrl, childUrl: frame.url() }), contentType: 'application/json' });
    await page.evaluate(() => (window as unknown as { detachRouteProbe: () => void }).detachRouteProbe());
    await frame.evaluate(() => (window as unknown as { routeObserver: MutationObserver }).routeObserver.disconnect());
    const legacy = structuredClone(item); delete (legacy.target.code!.elements[0] as FrameContext).frameUrls;
    await writeFile(review.output + '/' + item.id + '/context.json', JSON.stringify(legacy, null, 2) + '\n');
    await page.reload(); await expect(leafTarget(page)).toBeVisible();
    const reloaded = await leafFrame(page); await reloaded.evaluate((path) => history.replaceState({}, '', path), childB);
    await verified(page, comment, true);
    expect(JSON.parse(await readFile(review.output + '/' + item.id + '/context.json', 'utf8')).target.code.elements[0]).not.toHaveProperty('frameUrls');
  });
});

test('nested iframe, shadow and iframe evidence records only ordered frame URLs and rejects independent outer or inner route changes', { tag: '@cross-engine' }, async ({ page }) => {
  await withReview(page, true, async (review) => {
    await method(page, 'none'); await select(page, review, true);
    const comment = 'nested child identity', item = await save(page, review, comment);
    const context = item.target.code!.elements[0] as FrameContext;
    expect(context.rootPath).toEqual(['iframe: #outer-review-frame', 'shadow: #nested-shadow-root', 'iframe: #inner-review-frame']);
    expect(context.frameUrls).toEqual([review.origin + '/?frame=outer&screen=orders#outer-A', review.origin + '/?frame=leaf&screen=details#inner-A']);
    await closePanel(page); await page.reload(); await expect(leafTarget(page, true)).toBeVisible();
    await verified(page, comment, true);
    const outerHandle = await page.locator('#outer-review-frame').elementHandle(), outer = await outerHandle?.contentFrame(); await outerHandle?.dispose();
    if (!outer) throw new Error('Outer frame is not available');
    const inner = await leafFrame(page, true), parentUrl = page.url();
    const originalOuter = outer.url(), originalInner = inner.url();
    for (const [frame, original] of [[outer, originalOuter], [inner, originalInner]] as const) {
      await frame.evaluate((url) => history.pushState({}, '', url), original.replace(/#.+$/, '#changed-only'));
      await verified(page, comment, false);
      await frame.evaluate((url) => history.replaceState({}, '', url), original);
      await verified(page, comment, true);
    }
    expect(page.url()).toBe(parentUrl);
    expect((JSON.parse(await readFile(review.output + '/' + item.id + '/context.json', 'utf8')) as Feedback).target.code!.elements[0]).toEqual(context);
  });
});

test('same connected child route drift rejects original-node and range capture and preserves typed feedback for image-free saving', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    const guardResult = await page.evaluate(async (origin) => {
      const { contextForElement, contextForRange, createCaptureGuard, viewportRectOf, viewportRectForRange } = await import(origin + '/identity.js');
      const frame = document.querySelector<HTMLIFrameElement>('#outer-review-frame')!, view = frame.contentWindow!, originalUrl = view.location.href;
      const element = frame.contentDocument!.querySelector('button[data-cy]')!;
      const range = frame.contentDocument!.createRange(); range.selectNodeContents(element);
      const targets = [
        { target: { kind: 'element', text: element.textContent!, selector: 'button[data-cy="route-checkout"]', rect: viewportRectOf(element), code: contextForElement(element) }, anchors: { elements: [element] } },
        { target: { kind: 'text', text: range.toString(), selector: '', rect: viewportRectForRange(range), code: contextForRange(range) }, anchors: { range } },
      ];
      const before = targets.map(({ target, anchors }) => createCaptureGuard(target, anchors));
      const after = targets.map(({ target, anchors }) => { const guard = createCaptureGuard(target, anchors); return { guard, snapshot: guard.prepare() }; });
      view.history.pushState({}, '', originalUrl.replace('#route-A', '#route-B'));
      const error = (run: () => void) => { try { run(); return ''; } catch (failure) { return (failure as Error).message; } };
      const errors = [...before.map((guard) => error(() => guard.prepare())), ...after.map(({ guard, snapshot }) => error(() => guard.validate(snapshot)))];
      const sameNode = frame.contentDocument!.querySelector('button[data-cy]') === element && element.isConnected;
      view.history.replaceState({}, '', originalUrl);
      before.forEach((guard) => guard.validate(guard.prepare()));
      return { errors, sameNode, parentUrl: location.href };
    }, review.origin);
    expect(guardResult.sameNode).toBe(true);
    guardResult.errors.forEach((message) => expect(message).toContain('選択した対象が変わりました'));
    expect(guardResult.parentUrl).toBe(page.url());
    await method(page, 'dom');
    await page.evaluate(() => {
      const state = window as unknown as { captureGateReached: boolean; releaseCaptureGate: () => void };
      state.captureGateReached = false; const pending = new Promise<void>((resolve) => { state.releaseCaptureGate = resolve; });
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof HTMLIFrameElement) || !node.classList.contains('html2canvas-container') || !node.contentDocument) continue;
          Object.defineProperty(node.contentDocument, 'fonts', { configurable: true, value: { get ready() { state.captureGateReached = true; return pending; } } });
          observer.disconnect();
        }
      }); observer.observe(document.body, { childList: true });
    });
    await select(page, review);
    await expect.poll(() => page.evaluate(() => (window as unknown as { captureGateReached: boolean }).captureGateReached)).toBe(true);
    const comment = '子画面の移動中に入力したコメントを保持する';
    await page.getByLabel('コメント本文').fill(comment);
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    const frame = await leafFrame(page), original = await leafTarget(page).elementHandle(), parentUrl = page.url();
    await frame.evaluate((path) => history.pushState({}, '', path), childB);
    expect(await original!.evaluate((element) => element.isConnected && element === element.ownerDocument.querySelector('button[data-cy]'))).toBe(true);
    await page.evaluate(() => (window as unknown as { releaseCaptureGate: () => void }).releaseCaptureGate());
    await expect(page.getByText('画像を撮影できなかったため、画像なしで保存します。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('コメント本文')).toHaveValue(comment);
    await expect(page.getByLabel('コメント本文')).toBeFocused();
    await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    expect(page.url()).toBe(parentUrl);
    const saved = await save(page, review, comment);
    expect(saved.capture).toEqual({ method: 'none', width: 0, height: 0 }); expect(saved.image).toBeUndefined();
    expect((saved.target.code!.elements[0] as FrameContext).frameUrls).toEqual([review.origin + childA]);
    expect(await readdir(review.output + '/' + saved.id)).not.toContain('screenshot.png');
    await attachState(page, frame, saved, 'refused-child-route-capture', testInfo); await original?.dispose();
  });
});

test('child history observation preserves native behavior and reconnects without duplicate or obsolete callbacks', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, false, async (review) => {
    const result = await page.evaluate(async (origin) => {
      const { installPageChanges } = await import(origin + '/identity.js');
      const frame = document.createElement('iframe'); frame.id = 'inert-route-frame';
      const loaded = () => new Promise<void>((done) => frame.addEventListener('load', () => done(), { once: true }));
      const firstLoad = loaded(); frame.src = origin + '/inert?instance=1'; document.body.append(frame); await firstLoad;
      const host = document.querySelector<HTMLElement>('[data-needmark]')!, paths = [['iframe: #inert-route-frame']];
      let changes = 0;
      const observer = installPageChanges(host, () => changes++);
      const flush = () => new Promise<void>((done) => setTimeout(done, 0));
      const failure = (run: () => unknown) => { try { run(); return ''; } catch (error) { return (error as Error).name; } };
      try {
        const view = frame.contentWindow!, history = view.history, oldDocument = frame.contentDocument;
        const nativePush = history.pushState, nativeReplace = history.replaceState;
        const precedingAppWrapper = function(this: History, ...args: Parameters<History['pushState']>) { return nativePush.apply(this, args); };
        history.pushState = precedingAppWrapper;
        observer.sync(paths); const wrapped = history.pushState;
        observer.sync(paths); observer.sync(paths);
        const stableWrapper = wrapped === history.pushState && wrapped !== precedingAppWrapper;
        const start = changes;
        const returnValue = Reflect.apply(history.pushState, history, [{ route: 'native-argument', nested: [1, 2] }, 'title', origin + '/inert?instance=2']);
        const push = { notifications: changes - start, returnIsUndefined: returnValue === undefined, state: history.state, url: view.location.href };
        const beforeReplace = changes;
        Reflect.apply(history.replaceState, history, [{ route: 'replacement' }, 'title', origin + '/inert?instance=3']);
        const replace = { notifications: changes - beforeReplace, state: history.state, url: view.location.href };
        const beforeErrors = changes;
        const errors = {
          nativeReceiver: failure(() => Reflect.apply(nativePush, {}, [{}, '', view.location.href])),
          wrappedReceiver: failure(() => Reflect.apply(history.pushState, {}, [{}, '', view.location.href])),
          nativeOrigin: failure(() => Reflect.apply(nativeReplace, history, [{}, '', 'https://example.invalid/'])),
          wrappedOrigin: failure(() => Reflect.apply(history.replaceState, history, [{}, '', 'https://example.invalid/'])),
          nativeClone: failure(() => Reflect.apply(nativePush, history, [() => 1, '', view.location.href])),
          wrappedClone: failure(() => Reflect.apply(history.pushState, history, [() => 1, '', view.location.href])),
          notifications: changes - beforeErrors,
        };
        observer.sync([]);
        const restoredOnRemoval = history.pushState === precedingAppWrapper && history.replaceState === nativeReplace;
        const removedCount = changes; nativePush.call(history, { removed: true }, '', origin + '/inert?instance=4');
        await flush(); const removedNotifications = changes - removedCount;
        observer.sync(paths); const oldObservedDocument = frame.contentDocument;
        const nextLoad = loaded(); frame.src = origin + '/inert?instance=5'; await nextLoad; await flush();
        const replacement = frame.contentWindow!.history, replacementNative = Object.getPrototypeOf(replacement).pushState as History['pushState'];
        const replacementWrapped = replacement.pushState; observer.sync(paths); observer.sync(paths);
        const reconnectedCount = changes;
        replacement.pushState({ fresh: true }, '', origin + '/inert?instance=6');
        const reconnect = { documentChanged: frame.contentDocument !== oldObservedDocument && frame.contentDocument !== oldDocument,
          wrappedNewDocument: replacementWrapped !== replacementNative, repeatedSyncStable: replacementWrapped === replacement.pushState,
          notifications: changes - reconnectedCount };
        const kitPush = replacement.pushState;
        const laterAppWrapper = function(this: History, ...args: Parameters<History['pushState']>) { return kitPush.apply(this, args); };
        replacement.pushState = laterAppWrapper;
        observer.sync([]); const rootRemovalPreservesApp = replacement.pushState === laterAppWrapper;
        const inactiveCount = changes;
        replacement.pushState({ inactive: true }, '', origin + '/inert?instance=7');
        await flush(); const obsoleteAfterRemoval = changes - inactiveCount;
        observer.sync(paths); const reboundCount = changes;
        replacement.pushState({ rebound: true }, '', origin + '/inert?instance=8');
        const reboundNotifications = changes - reboundCount;
        const reboundKitPush = replacement.pushState;
        const finalAppWrapper = function(this: History, ...args: Parameters<History['pushState']>) { return reboundKitPush.apply(this, args); };
        replacement.pushState = finalAppWrapper;
        observer.dispose(); const disposalPreservesApp = replacement.pushState === finalAppWrapper;
        const disposedCount = changes;
        replacement.pushState({ app: true }, '', origin + '/inert?instance=9');
        await flush(); const obsoleteNotifications = changes - disposedCount;
        return { stableWrapper, push, replace, errors, restoredOnRemoval, removedNotifications, reconnect, rootRemovalPreservesApp,
          obsoleteAfterRemoval, reboundNotifications, disposalPreservesApp,
          obsoleteNotifications, appState: replacement.state, appUrl: frame.contentWindow!.location.href };
      } finally { observer.dispose(); frame.remove(); }
    }, review.origin);
    await testInfo.attach('native-child-history-lifecycle', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.stableWrapper).toBe(true);
    expect(result.push).toEqual({ notifications: 1, returnIsUndefined: true, state: { route: 'native-argument', nested: [1, 2] }, url: review.origin + '/inert?instance=2' });
    expect(result.replace).toEqual({ notifications: 1, state: { route: 'replacement' }, url: review.origin + '/inert?instance=3' });
    expect(result.errors.nativeReceiver).toBe('TypeError'); expect(result.errors.wrappedReceiver).toBe(result.errors.nativeReceiver);
    expect(result.errors.nativeOrigin).toBe('SecurityError'); expect(result.errors.wrappedOrigin).toBe(result.errors.nativeOrigin);
    expect(result.errors.nativeClone).toBe('DataCloneError'); expect(result.errors.wrappedClone).toBe(result.errors.nativeClone);
    expect(result.errors.notifications).toBe(0);
    expect(result.restoredOnRemoval).toBe(true); expect(result.removedNotifications).toBe(0);
    expect(result.reconnect).toEqual({ documentChanged: true, wrappedNewDocument: true, repeatedSyncStable: true, notifications: 1 });
    expect(result.rootRemovalPreservesApp).toBe(true); expect(result.obsoleteAfterRemoval).toBe(0); expect(result.reboundNotifications).toBe(1);
    expect(result.disposalPreservesApp).toBe(true); expect(result.obsoleteNotifications).toBe(0);
    expect(result.appState).toEqual({ app: true }); expect(result.appUrl).toBe(review.origin + '/inert?instance=9');
  });
});
