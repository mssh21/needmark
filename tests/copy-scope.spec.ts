import { test, expect, type Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import type { Feedback, FeedbackInput, FeedbackStatus } from '../src/shared/types.js';
import { input } from './fixtures.js';
import { searchList, toggleFilter } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
const copied = (page: Page) => page.evaluate(() => (window as unknown as { scopeCopied: string }).scopeCopied);
function target(selector: string): FeedbackInput['target'] {
  return { kind: 'element', text: 'Review target', selector, rect: { x: 100, y: 100, width: 120, height: 40 } };
}
async function setup(page: Page, send = false, denied = false) {
  await page.addInitScript(({ denied }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      const state = window as unknown as { scopeCopied: string; scopePending?: boolean; rejectScopeCopy?: (error: Error) => void };
      state.scopeCopied = value;
      if (state.scopePending) return new Promise<void>((_resolve, reject) => { state.rejectScopeCopy = reject; });
      if (denied) throw new Error('Clipboard denied');
    } } });
  }, { denied });
  if (send) await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('data-needmark-capture=', 'data-needmark-submit="true" data-needmark-capture=') });
  });
  await page.goto('/'); await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('none'); await page.getByRole('button', { name: '設定を保存', exact: true }).click();
}
async function headers(page: Page) { return { 'x-needmark-token': (await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token'))! }; }
async function seed(page: Page, comment: string, selected: FeedbackInput['target'], status: FeedbackStatus = 'open', url = page.url()): Promise<Feedback> {
  const base = input(); delete base.screenshot;
  const response = await page.request.post('/__needmark/feedback', { headers: await headers(page), data: { ...base, comment, url, target: selected, capture: { method: 'none', width: 0, height: 0 } } });
  expect(response.status()).toBe(201); let item = await response.json() as Feedback;
  if (status !== 'open') {
    const updated = await page.request.patch(`/__needmark/feedback/${item.id}`, { headers: await headers(page), data: { status } });
    expect(updated.ok()).toBe(true); item = await updated.json() as Feedback;
  }
  return item;
}
async function list(page: Page) { await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible(); }
const copyPrompt = (page: Page) => page.getByRole('button', { name: 'プロンプトをコピー', exact: true });
async function promptIds(page: Page, seeded: Feedback[]) { await copyPrompt(page).click(); const prompt = await copied(page); return seeded.filter((item) => prompt.includes(item.id)).map((item) => item.id).sort(); }

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('prompt copies and send share the searched, resolved-filtered and exact-page open scope', async ({ page }) => {
  await setup(page, true);
  const a = await seed(page, '集約の対象A', target('#aggregate-a'));
  const b = await seed(page, '集約の対象B', target('#aggregate-b'));
  const closed = await seed(page, '集約の対象C', target('#closed-c'), 'resolved');
  const other = await seed(page, '別ページの対象E', target('#other-e'), 'open', `${page.url()}?variant=other`);
  const all = [a, b, closed, other];
  await list(page); expect(await promptIds(page, all)).toEqual([a.id, b.id, other.id].sort());
  await expect(page.getByText(closed.comment, { exact: true })).toHaveCount(0);
  await searchList(page, '集約の対象B'); expect(await promptIds(page, all)).toEqual([b.id]);
  const delivered: unknown[] = [];
  await page.route('**/__needmark/submit', async (route) => { delivered.push(route.request().postDataJSON()); await route.fulfill({ json: { submitted: [b.id], skipped: [] } }); });
  await page.getByRole('button', { name: 'AIへ送信', exact: true }).click();
  await expect(page.getByText('1件を送信しました。コメントと画像は手元に残っています。', { exact: true })).toBeVisible();
  expect(delivered).toEqual([{ ids: [b.id], detail: 'standard', language: 'ja' }]);
  await page.getByRole('button', { name: '検索を閉じる', exact: true }).click(); await toggleFilter(page, 'このページのみ');
  expect(await promptIds(page, all)).toEqual([a.id, b.id].sort());
  await page.evaluate(() => history.pushState({}, '', '/?variant=other'));
  await expect.poll(() => promptIds(page, all)).toEqual([other.id]);
  await toggleFilter(page, 'このページのみ'); await toggleFilter(page, '解決済みも表示'); await expect(page.getByText(closed.comment, { exact: true })).toBeVisible();
  await searchList(page, closed.comment); expect(await promptIds(page, all)).toEqual([]);
});

test('denied prompt copying keeps manual selection through polling and a delayed failure cannot replace a new draft', async ({ page }) => {
  await setup(page, false, true); const item = await seed(page, '手動コピー対象', target('#manual-target')); await list(page);
  await copyPrompt(page).click(); const field = page.getByRole('textbox', { name: 'AIへの指示', exact: true });
  await expect(field).toBeVisible(); await expect(field).toHaveAttribute('readonly', ''); await expect(field).toBeFocused();
  const value = await field.inputValue(), selection = await field.evaluate((element) => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }));
  expect(selection).toEqual({ start: 0, end: value.length });
  const added = await seed(page, 'コピー後に追加されたコメント', target('#later-target'));
  await page.waitForTimeout(2400); // Exercise the two-second local feedback poll with a manually selected fallback.
  await expect(field).toHaveValue(value); await expect(field).toBeFocused();
  expect(await field.evaluate((element) => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual(selection);
  expect(value).toContain(item.id); expect(value).not.toContain(added.id);
  await page.evaluate(() => { (window as unknown as { scopePending: boolean }).scopePending = true; });
  await copyPrompt(page).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { rejectScopeCopy?: unknown }).rejectScopeCopy)).toBe('function');
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator('#purchase-button').boundingBox(); await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.getByLabel('コメント本文').fill('待機中に入力した新しいコメント');
  await page.evaluate(() => (window as unknown as { rejectScopeCopy: (error: Error) => void }).rejectScopeCopy(new Error('Late denied')));
  await expect(page.getByLabel('コメント本文')).toHaveValue('待機中に入力した新しいコメント');
  await expect(page.getByLabel('コメント本文')).toBeFocused(); await expect(field).toHaveCount(0);
});
