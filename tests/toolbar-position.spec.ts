import { type Page } from '@playwright/test';
import { test, expect } from './support/review.js';

const key = 'needmark-toolbar-position';
const dock = (page: Page) => page.locator('[data-needmark] .dock');
const handle = (page: Page) => page.locator('[data-needmark] .handle');
const stored = (page: Page) => page.evaluate((name) => localStorage.getItem(name), key);
async function bounds(page: Page) { const rect = await dock(page).boundingBox(); if (!rect) throw new Error('Toolbar must be visible'); return rect; }
async function startDrag(page: Page, dx: number, dy: number) {
  const rect = await handle(page).boundingBox(); if (!rect) throw new Error('Handle must be visible');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 3 });
}
async function recordPointer(page: Page) {
  await handle(page).evaluate((element) => element.addEventListener('pointerdown', (event) => {
    if ((event as PointerEvent).isPrimary) (window as unknown as { toolbarPointer: number }).toolbarPointer = (event as PointerEvent).pointerId;
  }, { capture: true }));
}
const captured = (page: Page) => dock(page).evaluate((element) => element.hasPointerCapture((window as unknown as { toolbarPointer: number }).toolbarPointer));
async function restore(page: Page, value: { x: number; y: number }) {
  await page.evaluate(({ name, value }) => localStorage.setItem(name, JSON.stringify(value)), { name: key, value }); await page.reload();
  await expect(dock(page)).toBeVisible();
}
async function setup(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { toolbarEvents: unknown[] }; state.toolbarEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'keydown']) document.addEventListener(type, (event) => {
      const pointer = event as PointerEvent, keyboard = event as KeyboardEvent, target = event.composedPath()[0] as Element;
      state.toolbarEvents.push({ type, focus: document.hasFocus(), target: target?.getAttribute?.('aria-label') || target?.tagName,
        pointerId: pointer.pointerId, primary: pointer.isPrimary, button: pointer.button, key: keyboard.key, shift: keyboard.shiftKey });
    }, true);
  });
  await page.goto('/'); await expect(dock(page)).toBeVisible();
}
async function withinViewport(page: Page) {
  await expect.poll(async () => {
    const rect = await bounds(page), view = page.viewportSize()!;
    return { left: rect.x >= 3.9, top: rect.y >= 3.9, right: rect.x + rect.width <= view.width - 3.9, bottom: rect.y + rect.height <= view.height - 3.9 };
  }).toEqual({ left: true, top: true, right: true, bottom: true });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const events = await page.evaluate(() => ({ focus: document.hasFocus(), active: document.activeElement?.tagName, events: (window as unknown as { toolbarEvents: unknown[] }).toolbarEvents }));
  await info.attach('toolbar-events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
});

test('only a completed primary drag saves toolbar coordinates and reload restores them', async ({ page }) => {
  await setup(page); const initial = await bounds(page);
  await handle(page).click(); expect(await stored(page)).toBeNull(); expect(await bounds(page)).toEqual(initial);
  await startDrag(page, 2, 0); await page.mouse.up();
  expect(await stored(page)).toBeNull(); expect(await bounds(page)).toEqual(initial);
  await handle(page).dispatchEvent('pointerdown', { pointerId: 500, isPrimary: true, button: 2, clientX: initial.x, clientY: initial.y });
  await handle(page).dispatchEvent('pointermove', { pointerId: 500, clientX: initial.x - 100, clientY: initial.y - 100 });
  await handle(page).dispatchEvent('pointerup', { pointerId: 500 });
  expect(await stored(page)).toBeNull(); expect(await bounds(page)).toEqual(initial);
  await startDrag(page, -150, -180); await page.mouse.up();
  const moved = await bounds(page), raw = await stored(page);
  expect(moved.x).toBeCloseTo(initial.x - 150, 1); expect(moved.y).toBeCloseTo(initial.y - 180, 1);
  expect(JSON.parse(raw!)).toEqual({ x: moved.x, y: moved.y });
  await page.reload(); await expect(dock(page)).toBeVisible();
  expect(await bounds(page)).toEqual(moved); expect(await stored(page)).toBe(raw);
});

test('secondary pointers cannot replace the drag, a pointer cancellation keeps the shown spot and Escape rolls back without saving', async ({ page }) => {
  await setup(page); await restore(page, { x: 150, y: 120 }); await recordPointer(page);
  const original = await bounds(page), raw = await stored(page);
  await startDrag(page, 100, 60); const moving = await bounds(page); expect(await captured(page)).toBe(true);
  await handle(page).evaluate((element) => {
    const pointerId = (window as unknown as { toolbarPointer: number }).toolbarPointer + 100;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) element.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerId, isPrimary: false, button: 0, clientX: 900, clientY: 700 }));
  });
  expect(await bounds(page)).toEqual(moving); expect(await captured(page)).toBe(true); expect(await stored(page)).toBe(raw);
  await handle(page).evaluate((element) => element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, composed: true, pointerId: (window as unknown as { toolbarPointer: number }).toolbarPointer })));
  expect(await captured(page)).toBe(false); await page.mouse.up();
  expect(await bounds(page)).toEqual(moving); const kept = await stored(page); expect(JSON.parse(kept!)).toEqual({ x: moving.x, y: moving.y });
  await startDrag(page, 60, 40); expect(await captured(page)).toBe(true);
  await page.keyboard.press('Escape'); expect(await captured(page)).toBe(false); await page.mouse.up();
  expect(await bounds(page)).toEqual(moving); expect(await stored(page)).toBe(kept);
  await page.reload(); expect(await bounds(page)).toEqual(moving);
});

test('viewport resize cancels an unfinished drag and a completed edge drag stores its clamped position', async ({ page }) => {
  await setup(page); await restore(page, { x: 150, y: 120 }); await recordPointer(page);
  const original = await bounds(page), raw = await stored(page);
  await startDrag(page, 100, 60); expect(await captured(page)).toBe(true);
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(() => captured(page)).toBe(false); await page.mouse.up();
  expect(await bounds(page)).toEqual(original); expect(await stored(page)).toBe(raw);
  await startDrag(page, 500, 445); await page.mouse.up(); await withinViewport(page);
  const edge = await bounds(page); expect(edge.x + edge.width).toBeCloseTo(796, 1); expect(edge.y + edge.height).toBeCloseTo(596, 1);
  expect(JSON.parse((await stored(page))!)).toEqual({ x: edge.x, y: edge.y });
  await page.reload(); expect(await bounds(page)).toEqual(edge);
});

test('restored toolbar positions clamp after hide, viewport and width changes without rewriting storage', async ({ page }) => {
  await setup(page); await restore(page, { x: 100000, y: -100 }); const raw = await stored(page);
  await withinViewport(page); const first = await bounds(page);
  expect(first.y).toBe(4); expect(first.x + first.width).toBeCloseTo(1196, 1);
  await page.keyboard.press('Shift+H'); await expect(dock(page)).toBeHidden();
  await page.setViewportSize({ width: 700, height: 500 });
  expect(await stored(page)).toBe(raw);
  await page.keyboard.press('Shift+H'); await expect(dock(page)).toBeVisible(); await withinViewport(page);
  const shown = await bounds(page); expect(shown.x + shown.width).toBeCloseTo(696, 1);
  // Simulate a wider localized control while retaining the real widget and observer.
  await dock(page).locator('[data-action="list"]').evaluate((element) => { (element as HTMLElement).style.width = '200px'; });
  await expect.poll(async () => (await bounds(page)).width).toBeGreaterThan(shown.width);
  await withinViewport(page); const wider = await bounds(page);
  expect(wider.x).toBeLessThan(shown.x); expect(wider.x + wider.width).toBeCloseTo(696, 1); expect(await stored(page)).toBe(raw);
  await page.setViewportSize({ width: 600, height: 450 }); await withinViewport(page); expect(await stored(page)).toBe(raw);
  await page.reload(); await withinViewport(page); expect(await stored(page)).toBe(raw);
});

test('the toolbar drags from a button without running it, a plain click still runs it, and a clamp does not lose the chosen spot', async ({ page }) => {
  await setup(page); const list = dock(page).locator('[data-action="list"]'), panel = page.locator('[data-needmark] .panel');
  const start = await list.boundingBox(), initial = await bounds(page); if (!start) throw new Error('List button must be visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 - 200, start.y + start.height / 2 - 300, { steps: 4 }); await page.mouse.up();
  const moved = await bounds(page); expect(moved.x).toBeCloseTo(initial.x - 200, 1); expect(moved.y).toBeCloseTo(initial.y - 300, 1);
  await expect(panel).toBeHidden(); expect(JSON.parse((await stored(page))!)).toEqual({ x: moved.x, y: moved.y });
  await list.click(); await expect(panel).toBeVisible();
  await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
  const view = page.viewportSize()!; await page.setViewportSize({ width: Math.ceil(moved.x + moved.width / 2), height: view.height });
  await withinViewport(page); expect((await bounds(page)).x).toBeLessThan(moved.x);
  await page.setViewportSize(view); await expect.poll(async () => (await bounds(page)).x).toBeCloseTo(moved.x, 1);
});
