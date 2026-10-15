import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import { input } from './fixtures.js';
import { saveAndList, searchList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
const positionKey = 'needmark-toolbar-position';
const panel = (page: Page) => page.getByRole('region', { name: 'NeedMark', exact: true });
const dock = (page: Page) => page.locator('[data-needmark] .dock');
const handle = (page: Page) => page.locator('[data-needmark] .handle');
const storedPosition = (page: Page) => page.evaluate((key) => localStorage.getItem(key), positionKey);

async function setup(page: Page, options: { width?: number; height?: number; method?: 'none' | 'dom'; denied?: boolean } = {}) {
  await page.setViewportSize({ width: options.width ?? 410, height: options.height ?? 814 });
  await page.addInitScript(({ key, method, denied }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ x: 4, y: 90 }));
    localStorage.setItem('needmark-configured', 'true');
    if (!localStorage.getItem('needmark-method')) localStorage.setItem('needmark-method', method);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      (window as unknown as { copied: string }).copied = value;
      if (denied) throw new Error('Clipboard denied');
    } } });
  }, { key: positionKey, method: options.method ?? 'none', denied: !!options.denied });
  await page.goto('/'); await expect(dock(page)).toBeVisible();
  await expect.poll(async () => (await dock(page).boundingBox())?.y).toBeCloseTo(90, 1);
}
async function accessiblePanel(page: Page) {
  await expect(panel(page)).toBeVisible();
  await expect.poll(async () => {
    const current = await panel(page).boundingBox(), toolbar = await dock(page).isVisible() ? await dock(page).boundingBox() : null, viewport = page.viewportSize()!;
    if (!current) return false;
    const inside = current.x >= -0.5 && current.y >= -0.5 && current.x + current.width <= viewport.width + 0.5 && current.y + current.height <= viewport.height + 0.5;
    const overlaps = !!toolbar && Math.min(current.x + current.width, toolbar.x + toolbar.width) - Math.max(current.x, toolbar.x) > 0.5
      && Math.min(current.y + current.height, toolbar.y + toolbar.height) - Math.max(current.y, toolbar.y) > 0.5;
    return inside && !overlaps;
  }).toBe(true);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}
async function seed(page: Page, comment: string): Promise<Feedback> {
  const base = input(); delete base.screenshot;
  const token = (await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token'))!;
  const response = await page.request.post('/__needmark/feedback', {
    headers: { 'x-needmark-token': token }, data: { ...base, comment, url: page.url(),
      target: { kind: 'area', text: '', selector: '', rect: { x: 20, y: 300, width: 60, height: 40 } },
      capture: { method: 'none', width: 0, height: 0 } },
  });
  expect(response.status()).toBe(201); return response.json();
}
async function selectPurchase(page: Page) {
  const target = page.locator('#purchase-button'); await target.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const bounds = await target.boundingBox(); if (!bounds) throw new Error('Purchase target has no visible rectangle');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible();
}
async function saved(comment: string): Promise<Feedback> {
  const items = await Promise.all((await readdir(output)).filter((name) => !name.startsWith('.')).map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback));
  const item = items.find((value) => value.comment === comment); if (!item) throw new Error('Saved review is missing'); return item;
}
async function drag(page: Page, dy: number) {
  const bounds = await handle(page).boundingBox(); if (!bounds) throw new Error('Toolbar handle is missing');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + dy, { steps: 4 });
}
async function selection(field: ReturnType<Page['getByLabel']>) {
  return field.evaluate((element) => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd, scroll: (element as HTMLTextAreaElement).scrollTop }));
}

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await screenshot(page, info, 'actual-panel-failure');
  const state = await page.evaluate(() => {
    const root = document.querySelector('[data-needmark]')?.shadowRoot;
    const active = root?.activeElement;
    return { viewport: { width: innerWidth, height: innerHeight }, panel: root?.querySelector('.panel')?.getBoundingClientRect().toJSON(),
      dock: root?.querySelector('.dock')?.getBoundingClientRect().toJSON(), active: active?.getAttribute('aria-label') ?? active?.id,
      storage: localStorage.getItem('needmark-toolbar-position') };
  });
  await info.attach('panel-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
});

test('stored toolbar at y90 leaves mobile settings and a tall searchable review list usable by pointer', async ({ page }, info) => {
  await setup(page); const raw = await storedPosition(page);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await screenshot(page, info, 'settings-at-restored-toolbar');
  await page.getByLabel('投稿者名', { exact: true }).click({ timeout: 2500 });
  await page.getByLabel('投稿者名', { exact: true }).fill('狭い画面のレビュアー');
  await accessiblePanel(page);
  await page.getByLabel('AIへの情報量').selectOption('compact');
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(panel(page)).toBeHidden();
  for (let index = 0; index < 12; index++) await seed(page, `一覧のコメント ${index}: ${'レビュー内容と修正理由。'.repeat(12)}`);
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await searchList(page, '一覧のコメント 9:');
  await expect(panel(page).getByRole('article')).toHaveCount(1); await accessiblePanel(page);
  await page.locator('[data-needmark] .open-item').click();
  await page.getByLabel('返信', { exact: true }).click(); await page.getByLabel('返信', { exact: true }).fill('パネルが重ならず操作できた');
  await accessiblePanel(page); await screenshot(page, info, 'mobile-detail-with-restored-toolbar');
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await expect(panel(page)).toBeHidden(); await expect(dock(page)).toBeVisible(); expect(await storedPosition(page)).toBe(raw);
});

test('a mobile real-target composer retains typed feedback through image and source expansion and saves its evidence', async ({ page }, info) => {
  await setup(page, { method: 'dom' }); await selectPurchase(page);
  const comment = '画像とソースを確認しても、このコメントを保持する';
  const field = page.getByLabel('コメント本文'); await field.fill(comment);
  await expect(page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true })).toBeVisible();
  await accessiblePanel(page);
  await expect(field).toHaveValue(comment); await accessiblePanel(page);
  await page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '画像プレビュー' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(field).toHaveValue(comment);
  await page.setViewportSize({ width: 410, height: 650 }); await accessiblePanel(page); await expect(field).toHaveValue(comment);
  await screenshot(page, info, 'expanded-composer-after-resize');
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const item = await saved(comment); expect(item.target.selector).toBe('#purchase-button');
  expect(item.target.code?.elements[0]?.source?.file).toBe('demo/index.html'); expect(item.capture.method).toBe('dom');
  expect((await readFile(`${output}/${item.id}/screenshot.png`)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('toolbar drag cancellation and viewport reflow preserve a typed reply, caret and valid panel scroll', async ({ page }) => {
  await setup(page, { width: 800, height: 700 }); const raw = await storedPosition(page);
  await seed(page, '長いコメントの本文。\n'.repeat(45));
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await page.locator('[data-needmark] .open-item').click();
  const reply = page.getByLabel('返信', { exact: true }); await reply.fill('未保存の返信をドラッグやサイズ変更でも保持する');
  await reply.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(4, 13));
  const before = await selection(reply);
  await drag(page, 160); await accessiblePanel(page);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(reply).toBeFocused(); expect(await selection(reply)).toEqual(before); expect(await storedPosition(page)).toBe(raw);
  await expect(reply).toHaveValue('未保存の返信をドラッグやサイズ変更でも保持する');
  const scroll = await panel(page).evaluate((element) => element.scrollTop);
  await page.setViewportSize({ width: 600, height: 500 }); await accessiblePanel(page);
  await expect(reply).toBeFocused(); expect(await selection(reply)).toEqual(before);
  expect(await panel(page).evaluate((element) => element.scrollTop)).toBeCloseTo(await panel(page).evaluate((element, previous) => Math.min(previous, element.scrollHeight - element.clientHeight), scroll), 1);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByText('未保存の返信をドラッグやサイズ変更でも保持する', { exact: true })).toBeVisible();
});

test('manual copy value, focus and selected range survive completed toolbar movement and viewport resizing', async ({ page }, info) => {
  await setup(page, { width: 800, height: 700, denied: true });
  const item = await seed(page, '手動コピーする長いレビュー。\n'.repeat(35));
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  const field = page.getByLabel('AIへの指示', { exact: true }); await expect(field).toBeFocused();
  const prompt = await field.inputValue(); expect(prompt).toContain(item.id);
  await field.evaluate((element) => { const field = element as HTMLTextAreaElement; field.setSelectionRange(5, 35); field.scrollTop = 20; });
  const before = await selection(field); const raw = await storedPosition(page);
  await drag(page, 180); await page.mouse.up();
  await expect(field).toBeFocused(); await expect(field).toHaveValue(prompt); expect(await selection(field)).toEqual(before);
  expect(await storedPosition(page)).not.toBe(raw); const moved = await storedPosition(page);
  await page.setViewportSize({ width: 500, height: 550 }); await accessiblePanel(page);
  await expect(field).toBeFocused(); await expect(field).toHaveValue(prompt); expect(await selection(field)).toEqual(before);
  await screenshot(page, info, 'manual-copy-preserved-after-toolbar-reflow');
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await page.reload(); await expect(dock(page)).toBeVisible(); expect(await storedPosition(page)).toBe(moved);
});

test('a moved toolbar and review panels remain usable inside a native modal focus boundary', async ({ page }, info) => {
  await setup(page);
  await page.evaluate(() => {
    const modal = document.createElement('dialog'); modal.id = 'panel-modal'; modal.style.cssText = 'padding:24px;width:300px';
    modal.innerHTML = '<button id="panel-modal-target" style="padding:16px">Modal review action</button>';
    modal.querySelector('button')!.addEventListener('click', () => { modal.dataset.clicks = String(Number(modal.dataset.clicks ?? 0) + 1); });
    document.body.append(modal); modal.showModal();
  });
  await expect(page.locator('#panel-modal > [data-needmark]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Modal review action', exact: true }).click();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const target = await page.locator('#panel-modal-target').boundingBox(); await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
  const comment = 'モーダル内でもコメントを完了できる'; const field = page.getByLabel('コメント本文'); await field.fill(comment);
  await accessiblePanel(page); await expect(field).toBeFocused();
  expect(await page.locator('#panel-modal').evaluate((modal) => modal.contains(document.activeElement))).toBe(true);
  await screenshot(page, info, 'modal-composer-with-restored-toolbar');
  await saveAndList(page);
  await searchList(page, comment);
  await expect(panel(page).getByRole('article')).toHaveCount(1); await accessiblePanel(page);
  await page.getByRole('button', { name: '検索を閉じる', exact: true }).click(); await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await expect(page.locator('#panel-modal')).toHaveJSProperty('open', true);
  await page.getByRole('button', { name: 'ピンの表示切り替え', exact: true }).click();
  await page.getByRole('button', { name: 'Modal review action', exact: true }).click();
  await expect(page.locator('#panel-modal')).toHaveAttribute('data-clicks', '2'); expect((await saved(comment)).target.selector).toBe('#panel-modal-target');
});

test('an extremely short viewport temporarily hides the toolbar while settings stay usable and restores its saved position on exit', async ({ page }) => {
  await setup(page); const raw = await storedPosition(page);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('投稿者名', { exact: true }).fill('高さが足りなくても保存できる');
  await page.setViewportSize({ width: 410, height: 220 });
  await expect(dock(page)).toBeHidden(); await accessiblePanel(page);
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(panel(page)).toBeHidden(); await expect(dock(page)).toBeVisible(); expect(await storedPosition(page)).toBe(raw);
  await page.setViewportSize({ width: 410, height: 814 });
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('投稿者名', { exact: true })).toHaveValue('高さが足りなくても保存できる');
  await accessiblePanel(page); await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await expect(dock(page)).toBeVisible(); expect(await storedPosition(page)).toBe(raw);
});

test('a closing panel fades out as itself, yields to the next panel and settles when motion is reduced mid-fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await setup(page);
  const panels = page.locator('[data-needmark] .panel'), list = dock(page).locator('[data-action="list"]'), settings = dock(page).locator('[data-action="settings"]');
  await list.click(); await expect(panels).toBeVisible();
  await list.click(); expect(await panels.count()).toBe(1);
  await settings.click(); expect(await panels.count()).toBe(1); await expect(panels.getByLabel('キャプチャ方式')).toBeEditable();
  await settings.click(); await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(panels).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.waitForTimeout(200); await expect(panels).toBeHidden();
  await list.click(); await expect(panel(page)).toBeVisible(); expect(await panels.count()).toBe(1);
});

test('the panel header drags the panel, keeps its spot across screens and Escape or closing puts it back', async ({ page }) => {
  await setup(page, { width: 1000, height: 800 }); await seed(page, '動かせるパネル');
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.locator('[data-needmark] .open-item')).toBeVisible();
  await panel(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const header = panel(page).locator('header'), start = (await panel(page).boundingBox())!, grip = (await header.locator('h2').boundingBox())!;
  const holdX = grip.x + grip.width / 2, holdY = grip.y + grip.height / 2;
  await page.mouse.move(holdX, holdY); await page.mouse.down(); await page.mouse.move(holdX + 300, holdY + 120, { steps: 5 }); await page.mouse.up();
  const moved = (await panel(page).boundingBox())!;
  expect(moved.x).toBeCloseTo(start.x + 300, 0); expect(moved.y).toBeCloseTo(start.y + 120, 0);
  await page.locator('[data-needmark] .open-item').click(); await expect(panel(page).getByText('動かせるパネル')).toBeVisible();
  const details = (await panel(page).boundingBox())!; expect(details.x).toBeCloseTo(moved.x, 0); expect(details.y).toBeCloseTo(moved.y, 0);
  const dragged = (await header.boundingBox())!;
  await page.mouse.move(dragged.x + dragged.width / 2, dragged.y + 10); await page.mouse.down(); await page.mouse.move(dragged.x + dragged.width / 2 + 2000, dragged.y - 2000, { steps: 5 }); await page.mouse.up();
  const clamped = (await panel(page).boundingBox())!; expect(clamped.x + clamped.width).toBeLessThanOrEqual(1000); expect(clamped.y).toBeGreaterThanOrEqual(0);
  await page.mouse.move(clamped.x + clamped.width / 2, clamped.y + 20); await page.mouse.down(); await page.mouse.move(clamped.x + clamped.width / 2 - 100, clamped.y + 120, { steps: 3 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  // Escape puts the panel back on the next animation frame, so the restored spot is polled rather than read once.
  await expect(panel(page)).toBeVisible();
  await expect.poll(async () => { const restored = (await panel(page).boundingBox())!; return [Math.round(restored.x), Math.round(restored.y)]; }).toEqual([Math.round(clamped.x), Math.round(clamped.y)]);
  await page.getByRole('button', { name: '一覧へ', exact: true }).click(); await expect(page.locator('[data-needmark] .open-item')).toBeVisible();
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); await expect(panel(page)).toBeHidden();
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await panel(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const reopened = (await panel(page).boundingBox())!;
  expect(reopened.x).toBeCloseTo(start.x, 0); expect(reopened.y).toBeCloseTo(start.y, 0);
});

test('a page that swallows pointerup leaves a dragged panel and toolbar where they were dropped', async ({ page }) => {
  // Gesture and outside-click libraries stop pointerup before NeedMark sees it; only the end of the pointer capture still arrives.
  await page.addInitScript(() => addEventListener('pointerup', (event) => event.stopImmediatePropagation(), true));
  await setup(page, { width: 1000, height: 800 });
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(panel(page)).toBeVisible();
  await panel(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const start = (await panel(page).boundingBox())!, grip = (await panel(page).locator('header h2').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 200, grip.y + grip.height / 2 + 100, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(100);
  const dropped = (await panel(page).boundingBox())!; expect(dropped.x).toBeCloseTo(start.x + 200, 0); expect(dropped.y).toBeCloseTo(start.y + 100, 0);
  await page.keyboard.press('Escape'); await expect(panel(page)).toBeHidden();
  const before = (await dock(page).boundingBox())!;
  await drag(page, 300); await page.mouse.up(); await page.waitForTimeout(100);
  const after = (await dock(page).boundingBox())!; expect(after.y).toBeCloseTo(before.y + 300, 0);
  expect(JSON.parse((await storedPosition(page))!).y).toBeCloseTo(before.y + 300, 0);
});

test('details open beside the pin after the target is scrolled into view, not at the recorded rectangle', async ({ page }) => {
  await setup(page, { width: 1000, height: 800 });
  const base = input(); delete base.screenshot;
  const token = (await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token'))!;
  // The recorded rectangle is at the top-left of an unscrolled page, far from where the button is shown once it is located.
  const response = await page.request.post('/__needmark/feedback', { headers: { 'x-needmark-token': token }, data: { ...base, comment: 'ピンの横に開く', url: page.url(),
    viewport: { ...base.viewport, scrollX: 0, scrollY: 0 }, target: { kind: 'element', text: 'Start free trial', selector: '#purchase-button', rect: { x: 20, y: 20, width: 60, height: 40 } },
    capture: { method: 'none', width: 0, height: 0 } } });
  expect(response.status()).toBe(201);
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await page.locator('[data-needmark] .open-item').click();
  await expect(panel(page).getByText('ピンの横に開く')).toBeVisible();
  await panel(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const pin = (await page.locator('[data-needmark] .pin').boundingBox())!, details = (await panel(page).boundingBox())!;
  const gap = details.x >= pin.x + pin.width ? details.x - pin.x - pin.width : pin.x - details.x - details.width;
  expect(gap).toBeCloseTo(12, 0); expect(details.y).toBeLessThanOrEqual(pin.y + 0.5); expect(details.y + details.height).toBeGreaterThanOrEqual(pin.y + pin.height - 0.5);
});

test('delete confirmations replace the content of the open panel without moving it', async ({ page }) => {
  await setup(page, { width: 1000, height: 800 }); await seed(page, 'その場で確認する');
  const settle = () => panel(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.locator('[data-needmark] .open-item')).toBeVisible(); await settle();
  const list = (await panel(page).boundingBox())!;
  await page.getByRole('button', { name: '一覧の操作', exact: true }).click(); await page.getByRole('menuitem', { name: 'すべて削除', exact: true }).click();
  await expect(page.getByRole('button', { name: '1件を削除する', exact: true })).toBeVisible();
  // The toolbar sits near the top here, so the list opens below its button and the confirmation keeps that top-left corner.
  await expect.poll(async () => { const box = (await panel(page).boundingBox())!; return [Math.round(box.x), Math.round(box.y)]; }).toEqual([Math.round(list.x), Math.round(list.y)]);
  await page.getByRole('button', { name: '戻る', exact: true }).click(); await page.locator('[data-needmark] .open-item').click();
  await expect(panel(page).getByText('その場で確認する')).toBeVisible(); await settle();
  const details = (await panel(page).boundingBox())!;
  await page.getByRole('button', { name: 'コメントの操作', exact: true }).click(); await page.getByRole('menuitem', { name: '削除', exact: true }).click();
  await expect(page.getByRole('button', { name: '削除する', exact: true })).toBeVisible();
  await expect.poll(async () => { const box = (await panel(page).boundingBox())!; return [Math.round(box.x), Math.round(box.y)]; }).toEqual([Math.round(details.x), Math.round(details.y)]);
});

test('the panel header stays at the top while the panel body scrolls', async ({ page }) => {
  await setup(page, { width: 800, height: 600 }); await seed(page, '長いコメントの本文。\n'.repeat(60));
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await page.locator('[data-needmark] .open-item').click();
  await expect(page.getByLabel('返信', { exact: true })).toBeVisible();
  await panel(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const header = await panel(page).locator('header').evaluate((element) => { const box = element.getBoundingClientRect(), outer = element.parentElement!.getBoundingClientRect(); return { top: box.top - outer.top, scrolled: element.parentElement!.scrollTop }; });
  expect(header.scrolled).toBeGreaterThan(200); expect(header.top).toBeCloseTo(0, 0);
  await expect(page.getByRole('button', { name: 'パネルを閉じる', exact: true })).toBeVisible();
});
