import { test, expect } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';

test('a target beneath multiple empty covers keeps its identifiers and visible pixels through save and sharing', async ({ page }, info) => {
  await rm(output, { recursive: true, force: true });
  await page.addInitScript(() => {
    localStorage.setItem('needmark-configured', 'true');
    localStorage.setItem('needmark-method', 'dom');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  });
  await page.goto('/');
  const originalStyles = await page.evaluate(() => {
    const node = document.createElement('div'); node.id = 'layered-fixture';
    node.style.cssText = 'position:fixed;left:100px;top:150px;width:280px;height:130px;z-index:100';
    node.innerHTML = '<button data-cy="layered-booking" style="position:absolute;left:30px;top:30px;width:180px;height:50px">Layered booking</button><div id="lower-cover" style="position:absolute;inset:0;z-index:2;background:rgba(90,160,230,.3)"></div><div id="upper-cover" style="position:absolute;inset:0;z-index:3;background:rgba(255,220,150,.35)"></div>';
    document.body.append(node);
    (window as unknown as { appClicks: number }).appClicks = 0;
    node.addEventListener('click', () => { (window as unknown as { appClicks: number }).appClicks++; });
    return [...node.children].map((child) => child.getAttribute('style'));
  });
  const reference = await page.screenshot();
  const button = (await page.locator('button[data-cy="layered-booking"]').boundingBox())!;
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.keyboard.down('Control'); await page.mouse.click(200, 210); await page.keyboard.up('Control');
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.getByLabel('コメント本文').fill('Review the layered booking button');
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  expect(ids).toHaveLength(1);
  const item = JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
  expect(item.target.kind).toBe('multi');
  expect(item.target.code?.elements).toHaveLength(1);
  expect(item.target.code?.elements[0]).toMatchObject({ selector: 'button[data-cy="layered-booking"]', text: 'Layered booking', attributes: { 'data-cy': 'layered-booking' }, rect: button });
  expect(item.image).toBe('screenshot.png');
  const png = await readFile(`${output}/${item.id}/screenshot.png`);
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
  await info.attach('saved-layered-target', { body: png, contentType: 'image/png' });
  await info.attach('visible-layered-reference', { body: reference, contentType: 'image/png' });
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  const prompt = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  for (const value of ['layered-booking', 'Layered booking', item.id, 'screenshot.png']) expect(prompt).toContain(value);
  expect(prompt).not.toContain('selector "#lower-cover"');
  expect(prompt).not.toContain('selector "#upper-cover"');
  expect(await page.evaluate(() => [...document.querySelector('#layered-fixture')!.children].map((child) => child.getAttribute('style')))).toEqual(originalStyles);
  expect(await page.evaluate(() => (window as unknown as { appClicks: number }).appClicks)).toBe(0);
  await page.reload(); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.getByText(item.comment, { exact: true }).click();
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  const restored = JSON.parse(await readFile(`${output}/${item.id}/context.json`, 'utf8')) as Feedback;
  expect(restored.target).toEqual(item.target);
});
