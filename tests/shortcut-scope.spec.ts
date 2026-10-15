import { type Page } from '@playwright/test';
import { test, expect, output } from './support/review.js';
import { readFile, readdir } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';

async function configure(page: Page, shortcuts = true) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('キーボードショートカット')).toHaveValue('true');
  await page.getByLabel('キャプチャ方式').selectOption('none');
  await page.getByLabel('キーボードショートカット').selectOption(String(shortcuts));
  await page.getByRole('button', { name: '保存', exact: true }).click();
}
async function chooseTarget(page: Page) {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator('#purchase-button').boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
}
async function stored(): Promise<Feedback> {
  const [id] = (await readdir(output)).filter((id) => !id.startsWith('.'));
  return JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback;
}
async function hostEvents(page: Page) {
  await page.evaluate(() => {
    const state = { submitted: 0, keys: [] as { key: string; prevented: boolean }[] };
    (window as unknown as { shortcutHost: typeof state }).shortcutHost = state;
    const form = document.createElement('form'); form.id = 'shortcut-host-form';
    form.style.cssText = 'position:fixed;left:12px;top:160px;width:240px';
    form.innerHTML = '<label>Host input<input aria-label="Host input"></label><label>Host textarea<textarea aria-label="Host textarea"></textarea></label><div role="textbox" aria-label="Host editable" contenteditable><span>Host content</span></div>';
    form.addEventListener('submit', (event) => { event.preventDefault(); state.submitted++; });
    const shadowHost = document.createElement('div'); shadowHost.attachShadow({ mode: 'open' }).innerHTML = '<label>Host shadow textarea<textarea aria-label="Host shadow textarea"></textarea></label>'; form.append(shadowHost);
    document.body.append(form);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) || event.shiftKey && ['c', 'p', 'h'].includes(event.key.toLowerCase())) state.keys.push({ key: event.key.toLowerCase(), prevented: event.defaultPrevented });
    });
  });
}
async function hostState(page: Page) {
  return page.evaluate(() => (window as unknown as { shortcutHost: { submitted: number; keys: { key: string; prevented: boolean }[] } }).shortcutHost);
}

test('enabled shortcuts never submit or intercept a host input, textarea or inherited editable region', async ({ page }) => {
  await page.goto('/'); await configure(page); await hostEvents(page);
  for (const name of ['Host input', 'Host textarea', 'Host editable', 'Host shadow textarea']) {
    await page.getByRole('textbox', { name, exact: true }).focus();
    await page.keyboard.press('Control+Enter'); await page.keyboard.press('Meta+Enter');
    await page.keyboard.press('Shift+C'); await page.keyboard.press('Shift+P'); await page.keyboard.press('Shift+H');
  }
  expect((await hostState(page)).submitted).toBe(0);
  expect((await hostState(page)).keys).toHaveLength(20);
  expect((await hostState(page)).keys.every((key) => !key.prevented)).toBe(true);
  await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'アニメーションを停止', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // A host control remains isolated even while a NeedMark composer contains unsaved text.
  await chooseTarget(page); await page.getByLabel('コメント本文').fill('Keep this unsaved NeedMark comment');
  await page.getByRole('textbox', { name: 'Host textarea', exact: true }).focus(); await page.keyboard.press('Control+Enter');
  expect((await hostState(page)).submitted).toBe(0);
  expect((await hostState(page)).keys.at(-1)?.prevented).toBe(false);
  await expect(page.getByLabel('コメント本文')).toHaveValue('Keep this unsaved NeedMark comment');
  expect((await readdir(output).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).filter((id) => !id.startsWith('.'))).toHaveLength(0);
});

test('disabled global shortcuts pass through to the host and stay disabled after reload', async ({ page }) => {
  await page.goto('/'); await configure(page, false); await hostEvents(page);
  await page.locator('#purchase-button').focus();
  for (const key of ['Shift+C', 'Shift+P', 'Shift+H']) await page.keyboard.press(key);
  expect((await hostState(page)).keys.map((key) => key.prevented)).toEqual([false, false, false]);
  await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
  await expect(page.locator('[data-needmark] .cover')).toBeHidden();
  await expect(page.getByRole('button', { name: 'アニメーションを停止', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('needmark-shortcuts'))).toBe('false');
  await page.reload(); await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('キーボードショートカット')).toHaveValue('false');
  await page.getByLabel('キーボードショートカット').selectOption('true'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('#purchase-button').focus(); await page.keyboard.press('Shift+C');
  await expect(page.locator('[data-needmark] .cover')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-needmark] .cover')).toBeHidden();
});

test('disabled global shortcuts retain local NeedMark comment and reply submission plus Escape', async ({ page }) => {
  await page.goto('/'); await configure(page, false); await chooseTarget(page);
  await page.getByLabel('コメント本文').fill('Submit this NeedMark comment with Control Enter'); await page.keyboard.press('Control+Enter');
  // Saving returns to selection; Escape still ends it with page-wide shortcuts disabled, then the list shows the saved comment.
  await expect(page.locator('[data-needmark] .cover')).toBeVisible(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await expect(page.getByText('Submit this NeedMark comment with Control Enter', { exact: true })).toBeVisible();
  const original = await stored(); expect(original.comment).toBe('Submit this NeedMark comment with Control Enter');
  await page.locator('[data-needmark] .open-item').click();
  await page.getByLabel('返信', { exact: true }).fill('Submit this NeedMark reply with Meta Enter'); await page.keyboard.press('Meta+Enter');
  await expect(page.getByText('Submit this NeedMark reply with Meta Enter', { exact: true })).toBeVisible();
  expect((await stored()).replies?.map((reply) => reply.comment)).toEqual(['Submit this NeedMark reply with Meta Enter']);
  await page.keyboard.press('Escape'); await expect(page.getByRole('region', { name: 'NeedMark', exact: true })).toBeHidden();
  expect((await stored()).id).toBe(original.id);
});
