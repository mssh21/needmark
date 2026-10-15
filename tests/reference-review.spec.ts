import { test, expect, type Page } from '@playwright/test';
import { readdir, readFile, rm } from 'node:fs/promises';
import type { Feedback, FeedbackInput } from '../src/shared/types.js';
import { input } from './fixtures.js';
import { saveAndList, searchList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });
async function setup(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { referenceCopied: string }).referenceCopied = value; } } });
  });
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('data-needmark-capture=', 'data-needmark-submit="true" data-needmark-capture=') });
  });
  await page.goto('/'); await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('none'); await page.getByRole('button', { name: '設定を保存', exact: true }).click();
}
async function headers(page: Page) { return { 'x-needmark-token': (await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token'))! }; }
// References can no longer be created in the widget, so earlier files are reproduced through the local API.
async function seedReference(page: Page): Promise<Feedback> {
  const rect = (await page.locator('#purchase-button').boundingBox())!, base = input(); delete base.screenshot;
  const target: FeedbackInput['target'] = { kind: 'element', text: 'Start free trial', selector: '#purchase-button', rect, code: { truncated: false, elements: [{ tag: 'button', selector: '#purchase-button', text: 'Start free trial', rect,
    attributes: { id: 'purchase-button' }, styles: {}, headings: [], components: [], source: { file: 'demo/index.html', line: 1, column: 1 }, sourceRelation: 'self' }] } };
  const response = await page.request.post('/__needmark/feedback', { headers: await headers(page), data: { ...base, intent: 'reference', comment: '', url: page.url(), target, capture: { method: 'none', width: 0, height: 0 } } });
  expect(response.status()).toBe(201); return await response.json() as Feedback;
}
async function records(): Promise<Feedback[]> {
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  return Promise.all(ids.map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback));
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { referenceCopied: string }).referenceCopied);
async function list(page: Page) { await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible(); }

test('the composer offers no reference saving, and an existing reference keeps status, replies and locate without repair controls', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); const rect = (await page.locator('#purchase-button').boundingBox())!; await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible(); await expect(page.getByRole('button', { name: '対象情報だけを保存' })).toHaveCount(0);
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  const saved = await seedReference(page); await list(page);
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'AIへ送信', exact: true })).toBeDisabled();
  await expect(page.locator('[data-needmark] .card')).toContainText('対象情報のみ');
  await page.locator('[data-needmark] .open-item').click(); await expect(page.getByRole('heading', { name: '対象情報の詳細' })).toBeVisible();
  for (const name of ['編集', 'プロンプトをコピー', 'AIへ送信']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.locator('[data-needmark] > .outline')).toBeVisible();
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  await page.getByLabel('返信', { exact: true }).fill('対象情報に補足を追加'); await page.getByRole('button', { name: '送信', exact: true }).click(); await expect(page.locator('[data-needmark] .reply p')).toHaveText('対象情報に補足を追加');
  await page.getByRole('button', { name: '一覧へ', exact: true }).click(); await page.getByRole('button', { name: '解決にする', exact: true }).click(); await expect.poll(async () => (await records())[0]!.status).toBe('resolved');
  await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toBeVisible();
  const [updated] = await records(); expect(updated!.id).toBe(saved.id); expect(updated!.intent).toBe('reference'); expect(updated!.replies![0]!.comment).toBe('対象情報に補足を追加');
});

test('mixed repair Copy/Send exclude references and their replies', async ({ page }) => {
  await setup(page); const reference = await seedReference(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); const rect = (await page.locator('#product-title').boundingBox())!; await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.getByLabel('コメント本文').fill('タイトルを大きくする'); await saveAndList(page); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); await list(page);
  const repair = (await records()).find((item) => item.intent !== 'reference')!; const delivered: unknown[] = [];
  await page.route('**/__needmark/submit', async (route) => { delivered.push(route.request().postDataJSON()); await route.fulfill({ json: { submitted: [repair.id], skipped: [] } }); });
  await searchList(page, 'Start free trial'); await expect(page.locator('[data-needmark] .card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'AIへ送信', exact: true })).toBeDisabled();
  // Disabled controls are not the dispatch boundary: even a synthetic click cannot send a reference.
  await page.locator('[data-needmark] [data-action="send"]').dispatchEvent('click'); expect(delivered).toEqual([]);
  await searchList(page, ''); await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  expect(await copied(page)).toContain(repair.id); expect(await copied(page)).not.toContain(reference.id); expect(await copied(page)).toContain('タイトルを大きくする');
  await page.getByRole('button', { name: 'AIへ送信', exact: true }).click(); await expect(page.getByText('1件を送信しました。コメントと画像は手元に残っています。', { exact: true })).toBeVisible(); expect(delivered).toEqual([{ ids: [repair.id], detail: 'standard', language: 'ja' }]);
  await page.locator(`[data-needmark] .card[data-id="${repair.id}"]`).getByRole('button', { name: '解決にする', exact: true }).click(); await expect.poll(async () => (await records()).find((item) => item.id === repair.id)!.status).toBe('resolved');
  const before = await copied(page);
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeDisabled(); await page.locator('[data-needmark] [data-action="copy"]').dispatchEvent('click'); expect(await copied(page)).toBe(before);
  await searchList(page, 'タイトルを大きくする'); await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'AIへ送信', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click(); const empty = await copied(page); expect(empty).not.toContain(repair.id); expect(empty).not.toContain(reference.id);
});
