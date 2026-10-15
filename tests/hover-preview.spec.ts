import { type Page } from '@playwright/test';
import { test, expect, output } from './support/review.js';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Feedback } from '../src/shared/types.js';

const moduleUrl = `/@fs/${resolve('src/client/context/code-context.ts')}`;
const preview = (page: Page) => page.locator('[data-needmark] .target-preview');
const outline = (page: Page) => page.locator('[data-needmark] .outline');

async function start(page: Page, shortcuts = true) {
  await rm(output, { recursive: true, force: true });
  await page.addInitScript((enabled) => {
    localStorage.setItem('needmark-configured', 'true'); localStorage.setItem('needmark-method', 'dom');
    localStorage.setItem('needmark-shortcuts', String(enabled));
  }, shortcuts);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
}

// The composer marks the chosen target with a dashed outline three pixels outside its box.
async function expectDraftOutline(page: Page, rect: { x: number; y: number; width: number; height: number }) {
  const bounds = (await page.locator('[data-needmark] .draft-outline').boundingBox())!;
  for (const [key, delta] of [['x', -3], ['y', -3], ['width', 6], ['height', 6]] as const) expect(bounds[key]).toBeCloseTo(rect[key] + delta, 0);
}
async function expectOutline(page: Page, rect: { x: number; y: number; width: number; height: number }) {
  await expect(outline(page)).toBeVisible();
  const bounds = (await outline(page).boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(bounds[key]).toBeCloseTo(rect[key], 0);
}

test('preview, outline and saved target agree without requesting source while hovering or leaking into capture', async ({ page }, info) => {
  await start(page);
  const sourceRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/source')) sourceRequests.push(request.url()); });
  await page.evaluate(() => {
    const target = document.createElement('button'); target.dataset.cy = 'hover-booking';
    target.textContent = '予約を確定'; target.setAttribute('aria-label', '予約 <img src=x onerror=alert(1)>');
    target.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Booking.tsx', line: 8, column: 5, component: 'Booking' }));
    target.style.cssText = 'position:fixed;left:100px;top:190px;width:260px;height:60px;z-index:100'; document.body.append(target);
  });
  const original = await page.screenshot();
  const rect = (await page.locator('[data-cy="hover-booking"]').boundingBox())!;
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.mouse.move(200, 220);
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator('[data-hover-tag]')).toHaveText('button');
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('予約 <img src=x onerror=alert(1)>');
  await expect(preview(page).locator('[data-hover-component]')).toHaveText('<Booking>');
  await expect(preview(page).locator('img')).toHaveCount(0);
  await expectOutline(page, rect);
  const label = (await preview(page).boundingBox())!;
  await info.attach('selection-preview', { body: await page.screenshot(), contentType: 'image/png' });
  await page.mouse.move(201, 220); await page.mouse.move(202, 220);
  expect(sourceRequests).toEqual([]);
  await page.mouse.click(200, 220);
  await expect(preview(page)).toBeHidden();
  await page.getByLabel('コメント本文').fill('Adjust the booking button');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.')); expect(ids).toHaveLength(1);
  const item = JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
  expect(item.target.kind).toBe('element');
  expect(item.target.code?.elements[0]).toMatchObject({ selector: 'button[data-cy="hover-booking"]', accessibleName: '予約 <img src=x onerror=alert(1)>', rect });
  const png = await readFile(`${output}/${item.id}/screenshot.png`);
  const pixels = await page.evaluate(async ({ saved, original, x, y }) => {
    const pixel = async (bytes: number[]) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return [...context.getImageData(Math.floor(x * canvas.width / innerWidth), Math.floor(y * canvas.height / innerHeight), 1, 1).data];
    };
    return { saved: await pixel(saved), original: await pixel(original) };
  }, { saved: [...png], original: [...original], x: label.x + 10, y: label.y + 10 });
  for (let channel = 0; channel < 4; channel++) expect(Math.abs(pixels.saved[channel]! - pixels.original[channel]!)).toBeLessThanOrEqual(3);
  await info.attach('capture-without-preview', { body: png, contentType: 'image/png' });
});

test('stationary Ctrl and Cmd update the same hit and keep gesture depth latched when shortcuts are disabled', async ({ page }) => {
  await start(page, false);
  await page.evaluate(() => {
    const node = document.createElement('div'); node.id = 'hover-layered';
    node.style.cssText = 'position:fixed;left:100px;top:180px;width:280px;height:130px;z-index:100';
    node.innerHTML = '<button data-cy="deep-preview" style="position:absolute;left:30px;top:30px;width:180px;height:50px">Deep booking</button><div id="front-cover" style="position:absolute;inset:0;z-index:3;background:#ddc8"></div>';
    document.body.append(node);
  });
  const front = (await page.locator('#front-cover').boundingBox())!, deep = (await page.locator('[data-cy="deep-preview"]').boundingBox())!;
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await page.mouse.move(200, 235);
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('front-cover'); await expectOutline(page, front);
  for (const key of ['Control', 'Meta']) {
    await page.keyboard.down(key); await expect(preview(page).locator('[data-hover-name]')).toHaveText('Deep booking'); await expectOutline(page, deep);
    await page.keyboard.up(key); await expect(preview(page).locator('[data-hover-name]')).toHaveText('front-cover'); await expectOutline(page, front);
  }
  await page.keyboard.down('Control'); await page.mouse.down(); await expect(preview(page)).toBeHidden();
  await page.keyboard.up('Control'); await page.mouse.up();
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(1);
  await page.getByRole('button', { name: '選択を完了', exact: true }).click();
  await expect(page.locator('[data-needmark] .draft-outline')).toHaveCount(1);
  await expectDraftOutline(page, deep);
  await expect(preview(page)).toBeHidden();
});

test('new frame and shadow targets clear their preview on local mutations and scrolling before any feedback is saved', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    const host = document.createElement('div'); host.id = 'preview-shadow'; host.style.cssText = 'position:fixed;left:70px;top:150px;width:180px;height:80px;z-index:100';
    host.attachShadow({ mode: 'open' }).innerHTML = '<button style="width:180px;height:70px" aria-label="Shadow booking">Book</button>'; document.body.append(host);
    const frame = document.createElement('iframe'); frame.id = 'preview-frame';
    frame.style.cssText = 'position:fixed;left:400px;top:150px;width:260px;height:170px;border:4px solid;padding:9px;transform:scale(1.2);transform-origin:0 0;z-index:100';
    frame.srcdoc = '<body style="margin:0;height:600px"><button style="position:absolute;left:20px;top:25px;width:170px;height:55px" aria-label="Frame booking">Book</button></body>';
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true })); document.body.append(frame); await ready;
  });
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await page.mouse.move(120, 190);
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('Shadow booking');
  await page.evaluate(() => document.querySelector('#preview-shadow')!.shadowRoot!.querySelector('button')!.setAttribute('aria-label', 'Updated shadow'));
  await expect(preview(page)).toBeHidden(); await expect(outline(page)).toBeHidden();
  await page.keyboard.down('Control'); await page.keyboard.up('Control'); await expect(preview(page)).toBeHidden();
  await page.mouse.move(121, 190); await expect(preview(page).locator('[data-hover-name]')).toHaveText('Updated shadow');
  const rect = await page.evaluate(async (url) => {
    const { viewportRectOf } = await import(url); return viewportRectOf((document.querySelector('#preview-frame') as HTMLIFrameElement).contentDocument!.querySelector('button')!);
  }, moduleUrl);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('Frame booking'); await expectOutline(page, rect);
  await page.evaluate(() => (document.querySelector('#preview-frame') as HTMLIFrameElement).contentDocument!.querySelector('button')!.setAttribute('aria-label', 'Updated frame'));
  await expect(preview(page)).toBeHidden(); await expect(outline(page)).toBeHidden();
  await page.mouse.move(rect.x + rect.width / 2 + 1, rect.y + rect.height / 2);
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('Updated frame');
  await page.evaluate(() => (document.querySelector('#preview-frame') as HTMLIFrameElement).contentWindow!.scrollTo(0, 30));
  await expect(preview(page)).toBeHidden(); await expect(outline(page)).toBeHidden();
});

test('hint, page changes and cancellation clear the preview without losing selected targets', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    document.body.style.minHeight = '2000px';
    const button = document.createElement('button'); button.id = 'cleanup-booking'; button.textContent = 'Cleanup booking';
    button.style.cssText = 'position:fixed;left:100px;top:160px;width:200px;height:70px;z-index:100'; document.body.append(button);
  });
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await page.mouse.move(170, 195); await expect(preview(page)).toBeVisible();
  const hint = (await page.locator('[data-needmark] .hint').boundingBox())!;
  await page.mouse.move(hint.x + 5, hint.y + 5); await expect(preview(page)).toBeHidden();
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('resize'));
    document.querySelector('[data-needmark]')!.shadowRoot!.querySelector('.cover')!.dispatchEvent(new PointerEvent('pointermove', { clientX: 170, clientY: 195, isPrimary: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(preview(page)).toBeHidden(); await expect(outline(page)).toBeHidden();
  for (const change of ['resize', 'scroll', 'blur'] as const) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.move(170 + ['resize', 'scroll', 'blur'].indexOf(change), 195); await expect(preview(page)).toBeVisible();
    await page.evaluate((name) => { if (name === 'scroll') window.scrollTo(0, 30); else window.dispatchEvent(new Event(name)); }, change);
    await expect(preview(page)).toBeHidden();
    await page.keyboard.down('Meta'); await page.keyboard.up('Meta'); await expect(preview(page)).toBeHidden();
  }
  await page.mouse.move(175, 195); await expect(preview(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(preview(page)).toBeHidden();
  await page.keyboard.down('Control'); await page.keyboard.up('Control'); await expect(preview(page)).toBeHidden();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.mouse.move(170, 195); await expect(preview(page)).toBeVisible();
  await page.keyboard.down('Shift'); await page.mouse.click(170, 195); await page.keyboard.up('Shift'); await expect(preview(page)).toBeHidden();
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(1);
  await page.mouse.move(171, 195); await expect(preview(page)).toBeVisible();
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(1);
  await page.getByRole('button', { name: '選択を完了', exact: true }).click();
  await expect(page.locator('[data-needmark] .draft-outline')).toHaveCount(1);
  await expectDraftOutline(page, (await page.locator('#cleanup-booking').boundingBox())!);
});

test('a slotted leaf observes rendered shadow scrolling and mutations through its slotted ancestor', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'slotted-preview';
    host.style.cssText = 'position:fixed;left:100px;top:150px;width:250px;height:100px;z-index:100';
    host.innerHTML = '<div><button style="width:200px;height:60px"><span aria-label="Slotted booking" style="display:block;width:100%;height:100%">Book</span></button></div>';
    host.attachShadow({ mode: 'open' }).innerHTML = '<div id="scroller" style="height:100px;overflow:auto"><div style="height:500px"><slot></slot></div></div>';
    document.body.append(host);
  });
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await page.mouse.move(170, 180);
  await expect(preview(page).locator('[data-hover-tag]')).toHaveText('span');
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('Slotted booking');
  await page.evaluate(() => { document.querySelector('#slotted-preview')!.shadowRoot!.querySelector('#scroller')!.scrollTop = 15; });
  await expect(preview(page)).toBeHidden(); await expect(outline(page)).toBeHidden();
  await page.keyboard.down('Control'); await page.keyboard.up('Control'); await expect(preview(page)).toBeHidden();
  await page.mouse.move(171, 180); await expect(preview(page).locator('[data-hover-name]')).toHaveText('Slotted booking');
  await page.evaluate(() => { (document.querySelector('#slotted-preview')!.shadowRoot!.querySelector('#scroller') as HTMLElement).style.paddingLeft = '15px'; });
  await expect(preview(page)).toBeHidden(); await expect(outline(page)).toBeHidden();
});

test('long plain labels fit near viewport edges and a native modal remains selectable', async ({ page }, info) => {
  await start(page);
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'edge-booking'; button.textContent = 'Edge booking'; button.setAttribute('aria-label', '長い予約ボタン '.repeat(100));
    button.style.cssText = 'position:fixed;right:1px;top:1px;width:75px;height:45px;z-index:100'; document.body.append(button);
  });
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await page.mouse.move(1180, 10);
  await expect(preview(page)).toBeVisible();
  expect((await preview(page).locator('[data-hover-name]').textContent())?.length).toBe(160);
  expect(await preview(page).locator('[data-hover-tag]').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const bounds = (await preview(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1192); expect(bounds.y + bounds.height).toBeLessThanOrEqual(842);
  await info.attach('selection-preview-at-edge', { body: await page.screenshot(), contentType: 'image/png' });
  await page.evaluate(() => {
    const dialog = document.createElement('dialog'); dialog.id = 'hover-dialog'; dialog.innerHTML = '<button style="width:220px;height:80px" aria-label="Modal booking">Modal booking</button>';
    document.body.append(dialog); dialog.showModal();
  });
  await expect(preview(page)).toBeHidden();
  // Opening the dialog moves the review host and schedules one batched page refresh that clears hover state; move after it settles.
  await page.waitForFunction(() => document.querySelector('[data-needmark]')?.parentElement?.id === 'hover-dialog');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const button = (await page.locator('#hover-dialog > button').boundingBox())!;
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await expect(preview(page).locator('[data-hover-name]')).toHaveText('Modal booking'); await expectOutline(page, button);
  await info.attach('selection-preview-in-dialog', { body: await page.screenshot(), contentType: 'image/png' });
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await expect(preview(page)).toBeHidden(); await expect(page.getByLabel('コメント本文')).toBeVisible();
});
