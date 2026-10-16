import { type Locator, type Page } from '@playwright/test';
import { test, expect } from './support/review.js';

const dock = (page: Page) => page.locator('[data-needmark] .dock');
async function bounds(locator: Locator) { const rect = await locator.boundingBox(); expect(rect).not.toBeNull(); return rect!; }

test('legacy browser preferences restore review behavior and canonical preferences take precedence without changing legacy values', async ({ page }) => {
  const legacy = {
    'needback-kit-configured': 'true', 'needback-kit-method': 'none', 'needback-kit-author': 'Legacy reviewer',
    'needback-kit-detail': 'compact', 'needback-kit-shortcuts': 'false', 'needback-kit-theme': 'dark',
    'needback-kit-toolbar-position': JSON.stringify({ x: 150, y: 120 }),
  };
  await page.addInitScript((values) => {
    if (sessionStorage.getItem('rename-preferences-seeded')) return;
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    sessionStorage.setItem('rename-preferences-seeded', 'true');
  }, legacy);
  await page.goto('/'); await expect(dock(page)).toBeVisible();
  expect(await bounds(dock(page))).toMatchObject({ x: 150, y: 120 });
  await expect(page.locator('[data-needmark]')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#purchase-button').focus(); await page.keyboard.press('Shift+H');
  await expect(dock(page)).toBeVisible();
  // A previously configured reviewer can select a target without first saving settings again.
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(page.getByRole('button', { name: '終了', exact: true })).toBeVisible();
  await expect(page.getByLabel('キャプチャ方式')).toHaveCount(0);
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('キャプチャ方式')).toHaveValue('none');
  await expect(page.getByLabel('投稿者名')).toHaveValue('Legacy reviewer');
  await expect(page.getByLabel('AIへの情報量')).toHaveValue('compact');
  await expect(page.getByLabel('キーボードショートカット')).toHaveValue('false');
  await expect(page.getByLabel('表示テーマ')).toHaveValue('dark');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  const canonical = {
    'needmark-author': 'Current reviewer', 'needmark-detail': 'standard', 'needmark-shortcuts': 'true',
    'needmark-theme': 'light', 'needmark-toolbar-position': JSON.stringify({ x: 220, y: 180 }),
  };
  await page.evaluate((values) => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, canonical);
  await page.reload(); await expect(dock(page)).toBeVisible();
  expect(await bounds(dock(page))).toMatchObject({ x: 220, y: 180 });
  await expect(page.locator('[data-needmark]')).toHaveAttribute('data-theme', 'light');
  await page.locator('#purchase-button').focus(); await page.keyboard.press('Shift+H');
  await expect(dock(page)).toBeHidden();
  await page.keyboard.press('Shift+H'); await expect(dock(page)).toBeVisible();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('キャプチャ方式')).toHaveValue('none');
  await expect(page.getByLabel('投稿者名')).toHaveValue('Current reviewer');
  await expect(page.getByLabel('AIへの情報量')).toHaveValue('standard');
  await expect(page.getByLabel('キーボードショートカット')).toHaveValue('true');
  await expect(page.getByLabel('表示テーマ')).toHaveValue('light');
  expect(await page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), Object.keys(legacy))).toEqual(legacy);
});
