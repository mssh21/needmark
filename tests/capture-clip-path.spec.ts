import { type Page } from '@playwright/test';
import { test, expect, output, configureReview } from './support/review.js';
import { resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import type { CaptureSnapshot } from '../src/client/capture/identity.js';

const urls = { capture: `/@fs/${resolve('src/client/capture/screenshot.ts')}`, identity: `/@fs/${resolve('src/client/capture/identity.ts')}`, context: `/@fs/${resolve('src/client/context/code-context.ts')}` };
const background = [217, 223, 199, 255], shade = [250, 244, 221, 255], mask = [46, 49, 52, 255];
const shapes = [
  { name: 'lamp-outside', x: 65, y: 145, color: background }, { name: 'lamp-inside', x: 145, y: 170, color: shade },
  { name: 'inset-outside', x: 285, y: 190, color: background }, { name: 'inset-inside', x: 350, y: 190, color: shade },
  { name: 'circle-outside', x: 485, y: 145, color: background }, { name: 'circle-inside', x: 530, y: 190, color: shade },
  { name: 'ellipse-outside', x: 655, y: 190, color: background }, { name: 'ellipse-inside', x: 730, y: 190, color: shade },
  { name: 'descendant-outside', x: 65, y: 345, color: background }, { name: 'descendant-inside', x: 130, y: 390, color: [25, 132, 209, 255] },
];
const nested = [
  { name: 'pseudo-outside', x: 325, y: 365, color: background }, { name: 'pseudo-inside', x: 390, y: 410, color: [181, 66, 43, 255] },
  { name: 'pseudo-after', x: 390, y: 480, color: [101, 90, 68, 255] },
  { name: 'shadow-outside', x: 675, y: 365, color: background }, { name: 'shadow-inside', x: 720, y: 410, color: [181, 66, 43, 255] },
  { name: 'iframe-outside', x: 925, y: 365, color: background }, { name: 'iframe-inside', x: 980, y: 400, color: [181, 66, 43, 255] },
];
const privatePoints = [
  { name: 'password', x: 140, y: 618, color: mask }, { name: 'explicit-redact', x: 350, y: 618, color: mask },
  { name: 'shadow-password', x: 750, y: 482, color: mask }, { name: 'iframe-password', x: 1000, y: 482, color: mask },
];
async function fixture(page: Page, widget = false) {
  const html = await readFile(resolve('tests/fixtures/capture-clip-path.html'), 'utf8');
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    const script = (await response.text()).match(/<script\b[^>]*data-needmark-token=[^>]*>[\s\S]*?<\/script>/)?.[0];
    if (!script) throw new Error('The fixture needs the protected widget script');
    await route.fulfill({ response, body: html.replace('</body>', `${widget ? script : ''}</body>`) });
  });
  await page.goto('/'); await expect(page.frameLocator('#same-origin-frame').locator('#frame-shape')).toBeVisible();
}
async function pixels(page: Page, png: string, samples: readonly { name: string; x: number; y: number }[]) {
  return page.evaluate(async ({ png, samples }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return samples.map((sample) => ({ name: sample.name, color: Array.from(context.getImageData(
      Math.round(sample.x * image.width / innerWidth), Math.round(sample.y * image.height / innerHeight), 1, 1).data) }));
  }, { png, samples });
}
function expected(samples: readonly { name: string; color: number[] }[]) { return samples.map(({ name, color }) => ({ name, color })); }
async function domCapture(page: Page) {
  return page.evaluate(async (urls) => {
    const { ScreenshotCapture } = await import(urls.capture), { createCaptureGuard } = await import(urls.identity);
    const { contextForElement, viewportRectOf } = await import(urls.context);
    const element = document.querySelector('#review-target')!, host = document.createElement('div'); host.id = 'capture-kit-host';
    host.style.cssText = 'position:fixed;left:1050px;top:20px;width:100px;height:40px;background:#ff00ff'; document.body.append(host);
    const target = { kind: 'element' as const, selector: '#review-target', text: element.textContent ?? '', rect: viewportRectOf(element), code: contextForElement(element) };
    const original = document.querySelector('#lamp')!, before = { html: original.outerHTML, rect: viewportRectOf(original), clip: getComputedStyle(original).clipPath };
    const capture = new ScreenshotCapture(), guard = createCaptureGuard(target, { elements: [element] }, host);
    try {
      const result = await capture.capture('dom', target.rect, host, guard);
      return { png: result.screenshot.split(',')[1]!, capture: result.capture, before, after: { html: original.outerHTML, rect: viewportRectOf(original), clip: getComputedStyle(original).clipPath },
        snapshotRect: result.snapshot.rect, targetRect: target.rect, contexts: result.snapshot.geometry.map((entry: CaptureSnapshot['geometry'][number]) => entry.context.attributes.id) };
    } finally { capture.stop(); host.remove(); }
  }, urls);
}

test('full viewport DOM PNG preserves the consumer trapezoid, inset, circle, ellipse and clipped descendants outside the selected target', { tag: '@cross-engine' }, async ({ page }) => {
  await fixture(page); const native = await page.screenshot();
  expect(await pixels(page, native.toString('base64'), shapes)).toEqual(expected(shapes));
  const captured = await domCapture(page);
  await test.info().attach('clip-native.png', { body: native, contentType: 'image/png' });
  await test.info().attach('clip-dom.png', { body: Buffer.from(captured.png, 'base64'), contentType: 'image/png' });
  expect(await pixels(page, captured.png, shapes)).toEqual(expected(shapes));
  expect(captured.capture).toEqual({ method: 'dom', width: 1200, height: 850 });
  expect(captured.snapshotRect).toEqual(captured.targetRect); expect(captured.contexts).toEqual(['review-target']); expect(captured.after).toEqual(captured.before);
  expect(await pixels(page, captured.png, [{ name: 'excluded-kit', x: 1090, y: 40 }])).toEqual([{ name: 'excluded-kit', color: background }]);
});

test('DOM shape rendering handles pseudo-elements, open shadow and same-origin frame content while keeping all privacy masks', { tag: '@cross-engine' }, async ({ page }) => {
  await fixture(page); expect(await pixels(page, (await page.screenshot()).toString('base64'), nested)).toEqual(expected(nested));
  const before = await page.evaluate(() => ({
    password: (document.querySelector('#private-password') as HTMLInputElement).value,
    shadow: (document.querySelector('capture-shadow')!.shadowRoot!.querySelector('input') as HTMLInputElement).value,
    frame: (document.querySelector<HTMLIFrameElement>('#same-origin-frame')!.contentDocument!.querySelector('input') as HTMLInputElement).value,
  }));
  const captured = await domCapture(page);
  expect(await pixels(page, captured.png, [...nested, ...privatePoints])).toEqual(expected([...nested, ...privatePoints]));
  expect(await page.evaluate(() => ({
    password: (document.querySelector('#private-password') as HTMLInputElement).value,
    shadow: (document.querySelector('capture-shadow')!.shadowRoot!.querySelector('input') as HTMLInputElement).value,
    frame: (document.querySelector<HTMLIFrameElement>('#same-origin-frame')!.contentDocument!.querySelector('input') as HTMLInputElement).value,
  }))).toEqual(before);
  expect(before).toEqual({ password: 'private-password', shadow: 'shadow-private', frame: 'frame-private' });
});

test('the real widget saves a full viewport shape-correct PNG and selected code geometry without requesting tab permission', { tag: '@cross-engine' }, async ({ page }) => {
  let sharingRequests = 0; await page.exposeFunction('recordUnexpectedSharing', () => { sharingRequests++; });
  await page.addInitScript(() => {
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => {
      void (window as unknown as { recordUnexpectedSharing(): Promise<void> }).recordUnexpectedSharing(); return Promise.reject(new Error('DOM capture must not request tab permission'));
    } });
  });
  await fixture(page, true); await configureReview(page, { method: 'dom' });
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); const bounds = (await page.locator('#review-target').boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.getByLabel('コメント本文').fill('台形と丸の形を維持して余白を調整する');
  await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.')); expect(ids).toHaveLength(1);
  const feedback = JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback, png = await readFile(`${output}/${ids[0]}/screenshot.png`);
  await test.info().attach('widget-saved.png', { body: png, contentType: 'image/png' });
  expect(await pixels(page, png.toString('base64'), [...shapes, ...nested, ...privatePoints])).toEqual(expected([...shapes, ...nested, ...privatePoints]));
  expect(feedback.target.kind).toBe('element'); expect(feedback.target.rect).toEqual(bounds); expect(feedback.target.code?.elements[0]?.rect).toEqual(bounds);
  expect(feedback.target.code?.elements[0]?.attributes.id).toBe('review-target'); expect(feedback.capture).toEqual({ method: 'dom', width: 1200, height: 850 }); expect(sharingRequests).toBe(0);
  expect(await page.locator('#lamp').evaluate((element) => getComputedStyle(element).clipPath)).toContain('polygon(');
});
