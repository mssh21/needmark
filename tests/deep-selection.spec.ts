import { type Page } from '@playwright/test';
import { test, expect, saveAndList, output } from './support/review.js';
import { readFile, readdir } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';

const cover = (page: Page) => page.locator('[data-needmark] .cover');
const field = (page: Page) => page.getByLabel('コメント本文');

async function fixture(page: Page, capture: 'none' | 'dom' = 'none') {
  await page.addInitScript((method) => {
    localStorage.setItem('needmark-configured', 'true'); localStorage.setItem('needmark-method', method);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  }, capture);
  await page.goto('/');
  await page.evaluate(() => {
    const node = document.createElement('div'); node.id = 'deep-fixture';
    node.style.cssText = 'position:fixed;left:100px;top:150px;width:280px;height:130px;z-index:100';
    node.innerHTML = '<button id="underlay-button" style="position:absolute;left:30px;top:30px;width:180px;height:50px">Covered booking</button><div id="veil" style="position:absolute;inset:0;z-index:2;background:rgba(255,220,150,.35)"><span id="veil-label" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">Overlay label</span></div>';
    document.body.append(node);
    (window as unknown as { appClicks: number }).appClicks = 0;
    node.addEventListener('click', () => { (window as unknown as { appClicks: number }).appClicks++; });
  });
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(cover(page)).toBeVisible();
}

async function saved(): Promise<Feedback> {
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  expect(ids).toHaveLength(1);
  return JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
}


test('ordinary clicks still select the frontmost overlay and do not activate the application', { tag: '@cross-engine' }, async ({ page }) => {
  await fixture(page); await page.mouse.click(200, 210); await field(page).fill('Review the overlay');
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const item = await saved();
  expect(item.target.kind).toBe('element'); expect(item.target.selector).toBe('#veil-label');
  expect(await page.evaluate(() => (window as unknown as { appClicks: number }).appClicks)).toBe(0);
});

for (const modifier of ['Control', 'Meta'] as const) {
  test(`${modifier} at gesture onset selects the covered target, saves pixels and shares its actual context`, { tag: '@cross-engine' }, async ({ page }, info) => {
    // caret: 'hide' writes and removes inline styles on the page's inputs, and NeedMark clears the hover a frame after any page change.
    await fixture(page, 'dom'); const reference = await page.screenshot({ caret: 'initial' });
    await page.keyboard.down(modifier); await page.mouse.move(200, 210);
    const button = (await page.locator('#underlay-button').boundingBox())!;
    await expect.poll(() => page.locator('[data-needmark] .outline').evaluate((node) => {
      const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    })).toEqual(button);
    await page.mouse.down(); await page.keyboard.up(modifier); await page.mouse.up();
    await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(1);
    await expect(field(page)).toHaveCount(0); await page.keyboard.press('Enter');
    await field(page).fill(`Fix the covered button with ${modifier}`);
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await saveAndList(page);
    await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
    const item = await saved();
    expect(item.target.kind).toBe('multi'); expect(item.target.code?.elements).toHaveLength(1);
    expect(item.target.code?.elements[0]).toMatchObject({ selector: '#underlay-button', text: 'Covered booking', rect: button });
    expect(item.capture.method).toBe('dom'); expect(item.capture.width).toBeGreaterThan(0); expect(item.image).toBe('screenshot.png');
    const png = await readFile(`${output}/${item.id}/screenshot.png`);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const pixels = await page.evaluate(async ({ saved, original }) => {
      const pixel = async (bytes: number[]) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
        return [...context.getImageData(Math.floor(110 * canvas.width / innerWidth), Math.floor(160 * canvas.height / innerHeight), 1, 1).data];
      };
      return { saved: await pixel(saved), original: await pixel(original) };
    }, { saved: [...png], original: [...reference] });
    for (let channel = 0; channel < 4; channel++) expect(Math.abs(pixels.saved[channel]! - pixels.original[channel]!)).toBeLessThanOrEqual(3);
    await info.attach('saved-covered-target', { body: png, contentType: 'image/png' });
    await info.attach('visible-overlay-reference', { body: reference, contentType: 'image/png' });
    await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
    const prompt = await page.evaluate(() => (window as unknown as { copied: string }).copied);
    for (const value of ['#underlay-button', 'Covered booking', item.id, 'screenshot.png']) expect(prompt).toContain(value);
    expect(prompt).not.toContain('selector "#veil-label"');
    expect(await page.evaluate(() => (window as unknown as { appClicks: number }).appClicks)).toBe(0);
    await page.reload(); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
    await page.getByText(item.comment, { exact: true }).click();
    await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
    expect((await saved()).target).toEqual(item.target);
  });
}

test('a modifier pressed only after pointerdown cannot retarget the gesture', { tag: '@cross-engine' }, async ({ page }) => {
  await fixture(page); await page.mouse.move(200, 210); await page.mouse.down();
  await page.keyboard.down('Meta'); await page.mouse.up(); await page.keyboard.up('Meta');
  await field(page).fill('Keep the initially selected overlay');
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  expect((await saved()).target.selector).toBe('#veil-label');
});
