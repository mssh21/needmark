import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import type { CaptureGuard } from '../src/client/capture/identity.js';
import type { ScreenshotCapture } from '../src/client/capture/screenshot.js';
import type { Feedback, FeedbackInput, Rectangle } from '../src/shared/types.js';

const output = '/private/tmp/needmark-e2e-feedback';
const urls = { capture: `/@fs/${resolve('src/client/capture/screenshot.ts')}`, identity: `/@fs/${resolve('src/client/capture/identity.ts')}`, context: `/@fs/${resolve('src/client/context/code-context.ts')}` };
interface NativeHarness {
  capture: ScreenshotCapture; canvas: HTMLCanvasElement; host: HTMLElement; requested: Promise<void>; closed: number;
  begin(guard?: CaptureGuard, rect?: Rectangle): ReturnType<ScreenshotCapture['capture']>;
  release(): Promise<void>; dispose(): void;
}
async function modulePage(page: Page) {
  await page.route('**/__needmark/client.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' })); await page.goto('/');
}
async function nativeFixture(page: Page) {
  await modulePage(page);
  await page.evaluate(async (captureUrl) => {
    const { ScreenshotCapture } = await import(captureUrl);
    const devices = navigator.mediaDevices, display = Object.getOwnPropertyDescriptor(devices, 'getDisplayMedia');
    const imageCapture = Object.getOwnPropertyDescriptor(window, 'ImageCapture'), play = HTMLMediaElement.prototype.play;
    const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#dc1e3c'; context.fillRect(70, 70, 30, 30);
    const stream = canvas.captureStream(); Object.defineProperty(stream.getVideoTracks()[0]!, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
    Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: async () => stream }); HTMLMediaElement.prototype.play = () => Promise.resolve();
    const capture = new ScreenshotCapture(), host = document.createElement('div'); document.body.append(host);
    let requested!: () => void, deliver!: (frame: ImageBitmap) => void;
    const fixture: NativeHarness = {
      capture, canvas, host, requested: Promise.resolve(), closed: 0,
      begin(guard, rect = { x: 400, y: 300, width: 100, height: 40 }) {
        fixture.requested = new Promise<void>((resolve) => { requested = resolve; });
        return capture.capture('tab', rect, host, guard);
      },
      async release() {
        const bitmap = await createImageBitmap(canvas), close = bitmap.close.bind(bitmap);
        Object.defineProperty(bitmap, 'close', { value: () => { fixture.closed++; close(); } }); deliver(bitmap);
      },
      dispose() {
        capture.stop(); host.remove(); HTMLMediaElement.prototype.play = play;
        if (display) Object.defineProperty(devices, 'getDisplayMedia', display); else Reflect.deleteProperty(devices, 'getDisplayMedia');
        if (imageCapture) Object.defineProperty(window, 'ImageCapture', imageCapture); else Reflect.deleteProperty(window, 'ImageCapture');
      },
    };
    Object.defineProperty(window, 'ImageCapture', { configurable: true, value: class {
      grabFrame() { requested(); return new Promise<ImageBitmap>((resolve) => { deliver = resolve; }); }
    } });
    (window as unknown as { nativeHarness: NativeHarness }).nativeHarness = fixture; await capture.start();
  }, urls.capture);
}

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('DOM pixels, selection outline and committed code geometry agree after the same original element moves before prepare', async ({ page }) => {
  await modulePage(page);
  const result = await page.evaluate(async (urls) => {
    const { ScreenshotCapture } = await import(urls.capture), { createCaptureGuard, applyCaptureSnapshot } = await import(urls.identity);
    const { contextForElement, viewportRectOf } = await import(urls.context);
    const original = document.createElement('div'); original.id = 'capture-pixel-original'; original.textContent = 'Original pixel target';
    original.style.cssText = 'position:fixed;left:100px;top:200px;width:120px;height:60px;background:rgb(12,174,93);color:transparent;z-index:100000'; document.body.append(original);
    const host = document.createElement('div'); document.body.append(host);
    const target: FeedbackInput['target'] = { kind: 'element', text: original.textContent, selector: '#capture-pixel-original', rect: viewportRectOf(original), code: contextForElement(original) };
    const before = structuredClone(target), guard = createCaptureGuard(target, { elements: [original] }, host);
    original.style.left = '300px'; original.style.top = '260px'; const actual = viewportRectOf(original);
    const capture = new ScreenshotCapture();
    try {
      const captured = await capture.capture('dom', target.rect, host, guard), uncommitted = structuredClone(target);
      applyCaptureSnapshot(target, captured.snapshot);
      const image = new Image(); image.src = captured.screenshot; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const color = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * image.width / innerWidth), Math.round(y * image.height / innerHeight), 1, 1).data);
      return { before, uncommitted, committed: structuredClone(target), actual, outline: color(actual.x, actual.y + actual.height / 2), center: color(actual.x + actual.width / 2, actual.y + actual.height / 2),
        oldOutline: color(before.rect.x, before.rect.y + before.rect.height / 2), capture: captured.capture, image: { width: image.width, height: image.height }, snapshotRect: captured.snapshot.rect };
    } finally { capture.stop(); original.remove(); host.remove(); }
  }, urls);
  expect(result.uncommitted).toEqual(result.before); expect(result.snapshotRect).toEqual(result.actual);
  expect(result.committed.rect).toEqual(result.actual); expect(result.committed.code?.elements[0]?.rect).toEqual(result.actual);
  expect(result.outline).toEqual([25, 101, 227, 255]); expect(result.center).toEqual([12, 174, 93, 255]); expect(result.oldOutline).not.toEqual(result.outline);
  expect(result.capture).toEqual({ method: 'dom', ...result.image });
});

test('native frames prepare after the hide delay, rebase before acquisition and reject later original movement without committing', async ({ page }) => {
  await nativeFixture(page);
  const result = await page.evaluate(async (urls) => {
    const fixture = (window as unknown as { nativeHarness: NativeHarness }).nativeHarness;
    const { createCaptureGuard, applyCaptureSnapshot } = await import(urls.identity), { contextForElement, viewportRectOf } = await import(urls.context);
    const original = document.createElement('button'); original.id = 'capture-native-original'; original.textContent = 'Native original';
    original.style.cssText = 'position:fixed;left:100px;top:200px;width:100px;height:40px'; document.body.append(original);
    const target: FeedbackInput['target'] = { kind: 'element', text: original.textContent, selector: '#capture-native-original', rect: viewportRectOf(original), code: contextForElement(original) };
    const guard = createCaptureGuard(target, { elements: [original] }, fixture.host), order: string[] = [];
    const observed: CaptureGuard = { prepare() { order.push('prepare'); return guard.prepare(); }, validate: (snapshot) => guard.validate(snapshot) };
    try {
      const pending = fixture.begin(observed, target.rect);
      original.style.left = '300px'; order.push('moved-before-frame');
      await fixture.requested; order.push('frame-requested'); await fixture.release(); const captured = await pending;
      const beforeCommit = structuredClone(target); applyCaptureSnapshot(target, captured.snapshot); const accepted = structuredClone(target);
      const nextGuard = createCaptureGuard(target, { elements: [original] }, fixture.host);
      const rejectedCapture = fixture.begin(nextGuard, target.rect).then(() => '', (error: Error) => error.message);
      await fixture.requested; original.style.left = '320px'; await fixture.release(); const error = await rejectedCapture;
      return { order, preparedRect: captured.snapshot.rect, beforeCommit: beforeCommit.rect, accepted: accepted.rect, codeRect: accepted.code!.elements[0]!.rect,
        retainedRect: target.rect, error, closed: fixture.closed, capture: captured.capture };
    } finally { original.remove(); fixture.dispose(); }
  }, urls);
  expect(result.order).toEqual(['moved-before-frame', 'prepare', 'frame-requested']);
  expect(result.beforeCommit.x).toBe(100); expect(result.preparedRect.x).toBe(300); expect(result.accepted).toEqual(result.preparedRect); expect(result.codeRect).toEqual(result.preparedRect);
  expect(result.retainedRect).toEqual(result.accepted); expect(result.error).toContain('選択した対象が変わりました'); expect(result.closed).toBe(2);
  expect(result.capture).toEqual({ method: 'tab', width: 1200, height: 850 });
});

test('native pixel acquisition rejects privacy identity, geometry, URL and DPR drift and masks tolerated subpixel movement at the original edges', async ({ page }) => {
  await nativeFixture(page);
  const result = await page.evaluate(async () => {
    const fixture = (window as unknown as { nativeHarness: NativeHarness }).nativeHarness;
    let sensitive = document.createElement('div'); sensitive.dataset.needmarkRedact = ''; sensitive.style.cssText = 'position:fixed;left:70px;top:70px;width:30px;height:30px;background:#dc1e3c'; document.body.append(sensitive);
    const originalUrl = location.href, dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio'), originalDpr = devicePixelRatio;
    const errors: Record<string, string> = {};
    try {
      for (const action of ['move', 'replace', 'remove', 'add', 'url', 'dpr']) {
        const pending = fixture.begin().then(() => '', (error: Error) => error.message); await fixture.requested;
        let extra: HTMLElement | undefined;
        if (action === 'move') sensitive.style.left = '90px';
        if (action === 'replace') { const clone = sensitive.cloneNode(true) as HTMLDivElement; sensitive.replaceWith(clone); sensitive = clone; }
        if (action === 'remove') sensitive.remove();
        if (action === 'add') { extra = sensitive.cloneNode(true) as HTMLElement; extra.style.left = '150px'; document.body.append(extra); }
        if (action === 'url') history.pushState({}, '', '/?capture-frame-drift');
        if (action === 'dpr') Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: originalDpr + 1 });
        await fixture.release(); errors[action] = await pending;
        sensitive.style.left = '70px'; if (!sensitive.isConnected) document.body.append(sensitive); extra?.remove(); history.replaceState({}, '', originalUrl);
        if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr); else Reflect.deleteProperty(window, 'devicePixelRatio');
      }
      const stable = fixture.begin(); await fixture.requested; sensitive.style.left = '70.25px'; await fixture.release(); const captured = await stable;
      const image = new Image(); image.src = captured.screenshot; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const edges = [69, 70, 99, 100].map((x) => Array.from(context.getImageData(x, 80, 1, 1).data));
      return { errors, closed: fixture.closed, edges, snapshotDpr: captured.snapshot.viewport.devicePixelRatio, currentDpr: devicePixelRatio };
    } finally {
      sensitive.remove(); history.replaceState({}, '', originalUrl);
      if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr); else Reflect.deleteProperty(window, 'devicePixelRatio'); fixture.dispose();
    }
  });
  for (const action of ['move', 'replace', 'remove', 'add']) expect(result.errors[action]).toContain('伏せる領域が変わりました');
  for (const action of ['url', 'dpr']) expect(result.errors[action]).toContain('画面の位置が変わりました');
  expect(result.closed).toBe(7); expect(result.edges).toEqual(Array.from({ length: 4 }, () => [46, 49, 52, 255])); expect(result.snapshotDpr).toBe(result.currentDpr);
});

for (const change of ['move', 'replace'] as const) {
  test(`widget preserves typed feedback after original ${change} during DOM rendering and falls back to image-free saving`, async ({ page }) => {
    await page.goto('/'); await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByLabel('キャプチャ方式').selectOption('dom'); await page.getByRole('button', { name: '設定を保存', exact: true }).click();
    await page.evaluate(() => {
      const state = window as unknown as { captureGateReached: boolean; releaseCaptureGate: () => void; captureGateObserver: MutationObserver };
      state.captureGateReached = false; const pending = new Promise<void>((resolve) => { state.releaseCaptureGate = resolve; });
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof HTMLIFrameElement) || !node.classList.contains('html2canvas-container') || !node.contentDocument) continue;
          Object.defineProperty(node.contentDocument, 'fonts', { configurable: true, value: { get ready() { state.captureGateReached = true; return pending; } } });
          observer.disconnect();
        }
      }); observer.observe(document.body, { childList: true }); state.captureGateObserver = observer;
    });
    await page.getByRole('button', { name: 'コメント', exact: true }).click(); const original = await page.locator('#purchase-button').boundingBox();
    await page.mouse.click(original!.x + original!.width / 2, original!.y + original!.height / 2);
    await expect.poll(() => page.evaluate(() => (window as unknown as { captureGateReached: boolean }).captureGateReached)).toBe(true);
    await page.getByLabel('コメント本文').fill(`撮影待ちに入力した ${change} のコメント`);
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await page.evaluate((change) => {
      const original = document.querySelector<HTMLElement>('#purchase-button')!;
      if (change === 'move') original.style.transform = 'translateX(30px)'; else original.replaceWith(original.cloneNode(true));
      (window as unknown as { releaseCaptureGate: () => void }).releaseCaptureGate();
    }, change);
    await expect(page.getByText('画像を撮影できなかったため、画像なしで保存します。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('コメント本文')).toHaveValue(`撮影待ちに入力した ${change} のコメント`);
    await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeHidden();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
    const ids = (await readdir(output)).filter((id) => !id.startsWith('.')); expect(ids).toHaveLength(1);
    const saved = JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
    expect(saved.comment).toBe(`撮影待ちに入力した ${change} のコメント`); expect(saved.capture).toEqual({ method: 'none', width: 0, height: 0 }); expect(saved.image).toBeUndefined();
    expect(await readdir(`${output}/${saved.id}`)).not.toContain('screenshot.png'); expect(saved.target.rect).toEqual(original);
    expect(saved.target.code?.elements[0]?.rect).toEqual(original); expect(saved.target.code?.elements[0]?.attributes.id).toBe('purchase-button');
    expect(Object.keys(saved)).not.toContain('snapshot'); expect(Object.keys(saved.target)).not.toContain('anchors');
  });
}
