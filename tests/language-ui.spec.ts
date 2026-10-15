import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import { localizeClientError, resolveClientLanguage } from '../src/client/messages.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
const widget = (page: Page) => page.locator('[data-needmark]');
const comment = 'コメントを保存しました。という表示を変えてください。';
const author = '投稿者名：日本語';
const reason = '削除せず、この文言を維持するため';

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

async function saved(): Promise<Feedback> {
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  expect(ids).toHaveLength(1);
  return JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
}

async function configurePageLanguage(page: Page, configured: string, preference?: string) {
  if (preference !== undefined) await page.addInitScript((value) => localStorage.setItem('needmark-language', value), preference);
  await page.route('**/', async (route) => {
    const response = await route.fetch(), html = await response.text();
    expect(html).toMatch(/data-needmark-language="[^"]*"/);
    await route.fulfill({ response, body: html.replace(/data-needmark-language="[^"]*"/, `data-needmark-language="${configured}"`) });
  });
  await page.goto('/');
}

test('first setup switches all feedback operations to English while saved Japanese content survives a switch back', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedLocalePrompt: string }).copiedLocalePrompt = text; },
    } });
  });
  // The first-run panel has no author field, so a stored author must survive saving it.
  await page.addInitScript((value) => { if (!localStorage.getItem('needmark-author')) localStorage.setItem('needmark-author', value); }, author);
  await page.goto('/');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'レビューを始める' })).toBeVisible();
  await page.getByLabel('表示言語').selectOption('en');
  await expect(page.getByLabel('投稿者名')).toHaveCount(0);
  await page.getByLabel('キャプチャ方式').selectOption('none');
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(widget(page)).toHaveAttribute('lang', 'en');
  await expect(widget(page).locator('.cover')).toBeVisible();
  await expect(widget(page).locator('[data-hint]')).toHaveText('Click or drag to select');
  const bounds = (await page.locator('#purchase-button').boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.getByLabel('Comment text').fill(comment);
  await saveAndList(page, 'en');
  await expect(widget(page).getByRole('status')).toHaveText('Feedback saved.');
  await expect(page.getByRole('button', { name: 'Mark resolved', exact: true })).toBeVisible();
  const original = await saved();
  expect(original.comment).toBe(comment); expect(original.author).toBe(author);
  expect(original.target.text).toBe('Start free trial'); expect(original.target.selector).toBe('#purchase-button');

  await page.reload();
  await expect(widget(page)).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  const englishPrompt = await page.evaluate(() => (window as unknown as { copiedLocalePrompt: string }).copiedLocalePrompt);
  expect(englishPrompt).toMatch(/^Review and fix the following UI feedback in this project\./);
  for (const value of [`> ${comment}`, author, original.target.text, original.target.selector, original.id]) expect(englishPrompt).toContain(value);
  await page.getByRole('button', { name: 'Filter', exact: true }).click(); await page.getByRole('menuitemcheckbox', { name: 'This page only', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'This page only', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Search by keyword', exact: true }).click(); await page.getByLabel('Search by keyword').fill('表示を変えて');
  await page.getByText(comment, { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comment', exact: true })).toBeVisible();
  await page.getByLabel('Reply', { exact: true }).fill(reason); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to list', exact: true }).click(); await page.getByRole('button', { name: 'Mark resolved', exact: true }).click();
  await page.getByRole('button', { name: 'Mark unresolved', exact: true }).click(); await expect(page.getByRole('button', { name: 'Mark resolved', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Language')).toHaveValue('en');
  await page.getByLabel('Language').selectOption('ja');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('needmark-language'))).toBe('ja');
  await page.reload();
  await expect(widget(page)).toHaveAttribute('lang', 'ja');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('表示言語')).toHaveValue('ja');
  await expect(page.getByLabel('投稿者名')).toHaveValue(author);
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.getByText(comment, { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'コメント', exact: true })).toBeVisible();
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  await expect(page.getByRole('button', { name: 'コピーしました', exact: true })).toBeVisible();
  const japanesePrompt = await page.evaluate(() => (window as unknown as { copiedLocalePrompt: string }).copiedLocalePrompt);
  expect(japanesePrompt).toMatch(/^このプロジェクトの次のUIフィードバックを確認し、修正してください。/);
  for (const value of [`> ${comment}`, `> ${reason}`, author, original.target.text, original.target.selector, original.id]) expect(japanesePrompt).toContain(value);
  const final = await saved();
  expect(final.comment).toBe(original.comment); expect(final.author).toBe(original.author);
  expect(final.target).toEqual(original.target); expect(final.status).toBe('open');
  expect(final.replies?.[0]?.comment).toBe(reason);
});

for (const { configured, preference, language } of [
  { configured: 'en', preference: 'invalid', language: 'en' },
  { configured: 'ja', preference: 'en', language: 'en' },
  { configured: 'en', preference: 'ja', language: 'ja' },
  { configured: 'invalid', preference: 'invalid', language: 'ja' },
] as const) {
  test(`language precedence: configuration ${configured}, preference ${preference} uses ${language}`, async ({ page }) => {
    await configurePageLanguage(page, configured, preference);
    await expect(widget(page)).toHaveAttribute('lang', language);
    await page.getByRole('button', { name: language === 'en' ? 'Comment' : 'コメント', exact: true }).click();
    await expect(page.getByRole('heading', { name: language === 'en' ? 'Start review' : 'レビューを始める', exact: true })).toBeVisible();
    await expect(widget(page).locator('#nm-language')).toHaveValue(language);
  });
}

test('language defaults and error localization retain unknown source messages verbatim', () => {
  expect(resolveClientLanguage(undefined, undefined)).toBe('ja');
  expect(resolveClientLanguage('en', null)).toBe('en');
  expect(resolveClientLanguage(null, 'ja')).toBe('ja');
  expect(resolveClientLanguage('EN', 'JA')).toBe('ja');
  const captureError = new Error('選択した対象が変わりました。画像なしで保存するか、場所を選び直してください。');
  expect(localizeClientError('en', captureError)).toBe('The selected target changed. Save without an image or select the location again.');
  expect(localizeClientError('ja', captureError)).toBe(captureError.message);
  const sourceError = new Error('Client custom error: コメントを保存');
  expect(localizeClientError('en', sourceError)).toBe(sourceError.message);
  expect(localizeClientError('en', 'コメントを保存')).toBe('コメントを保存');
});
