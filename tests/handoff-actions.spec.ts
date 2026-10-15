import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList, searchList } from './save.js';
const output = '/private/tmp/needmark-e2e-feedback';
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });
async function setup(page: Page, submit = false, method = 'none') {
  // The transport is controlled to exercise UI races. Server hook delivery is verified by API tests.
  if (submit) await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('data-needmark-capture=', 'data-needmark-submit="true" data-needmark-capture=') });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption(method);
  await page.getByRole('button', { name: '保存', exact: true }).click();
}
async function select(page: Page, selector = '#purchase-button') {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator(selector).boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
}
async function save(page: Page, comment: string, selector?: string) {
  await select(page, selector); await page.getByLabel('コメント本文').fill(comment);
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
}
async function stored(): Promise<Feedback[]> {
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  return Promise.all(ids.map(async id => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8'))));
}
async function clipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string }).copied);

test('a single-item copy carries the source and selector to the AI without optional send', async ({ page }) => {
  await clipboard(page); await setup(page); await select(page);
  await page.getByLabel('コメント本文').fill('ソースとセレクタをAIへ渡す');
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'AIへ送信', exact: true })).toHaveCount(0);
  await page.locator('[data-needmark] .open-item').click();
  const header = page.locator('[data-needmark] .panel > header');
  await expect(header.getByRole('link', { name: 'VS Codeで開く', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  const done = header.getByRole('button', { name: 'コピーしました', exact: true });
  await expect(done).toBeVisible(); await expect(done).toHaveText('');
  expect(await done.evaluate((button) => { const probe = document.createElement('span'); probe.style.color = 'var(--success)'; button.after(probe); const success = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(button).color === success; })).toBe(true);
  await expect.poll(() => copied(page)).toContain('ソースとセレクタをAIへ渡す');
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeVisible({ timeout: 4000 });
  expect(await copied(page)).toContain('#purchase-button'); expect(await copied(page)).toContain('demo/index.html:');
});

test('same-panel delayed clipboard failure preserves newly typed reply and focus', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>((_resolve, reject) => { (window as unknown as { rejectCopy: (error: Error) => void }).rejectCopy = reject; }) } }); });
  await setup(page); await save(page, 'コピー元の保存済みコメント');
  await page.locator('[data-needmark] .open-item').click();
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  await page.getByLabel('返信', { exact: true }).fill('コピー待ちの間に書いた返信');
  await page.evaluate(() => (window as unknown as { rejectCopy: (error: Error) => void }).rejectCopy(new Error('Denied')));
  await expect(page.getByLabel('返信', { exact: true })).toHaveValue('コピー待ちの間に書いた返信');
  await expect(page.getByLabel('返信', { exact: true })).toBeFocused();
  await expect(page.getByLabel('AIへの指示', { exact: true })).toHaveValue(/コピー元の保存済みコメント/);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.locator('[data-needmark] .reply p')).toHaveText('コピー待ちの間に書いた返信');
  expect((await stored())[0]!.replies?.[0]?.comment).toBe('コピー待ちの間に書いた返信');
});

test('copy and send use the same visible open scope; failure and retry preserve local screenshot and status', async ({ page }) => {
  await clipboard(page); await setup(page, true, 'dom');
  await save(page, '送信対象：ボタン'); await save(page, '送信対象：タイトル', '#product-title');
  await save(page, '対応済みのコメント');
  await page.getByRole('button', { name: '解決にする', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toHaveCount(1);
  const original = await stored(), chosen = original.find(item => item.comment === '送信対象：ボタン')!;
  const image = await readFile(`${output}/${chosen.id}/screenshot.png`);
  await searchList(page, '送信対象：ボタン');
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toHaveAttribute('title', 'AIへ渡す対象：表示中の未対応 1件');
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  expect(await copied(page)).toContain(chosen.comment); expect(await copied(page)).not.toContain('送信対象：タイトル');
  const requests: unknown[] = [];
  await page.route('**/__needmark/submit', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.fulfill({ status: 502, json: { error: 'Unable to send feedback' } });
    else await route.fulfill({ json: { submitted: [chosen.id], skipped: [] } });
  });
  await page.getByRole('button', { name: 'AIへ送信', exact: true }).click();
  await expect(page.getByText('Unable to send feedback', { exact: true })).toBeVisible();
  expect(await stored()).toEqual(original); expect(await readFile(`${output}/${chosen.id}/screenshot.png`)).toEqual(image);
  await page.getByRole('button', { name: 'AIへ送信', exact: true }).click();
  await expect(page.getByText('1件を送信しました。コメントと画像は手元に残っています。', { exact: true })).toBeVisible();
  expect(requests).toEqual([{ ids: [chosen.id], detail: 'standard', language: 'ja' }, { ids: [chosen.id], detail: 'standard', language: 'ja' }]);
  expect(await stored()).toEqual(original); expect(await readFile(`${output}/${chosen.id}/screenshot.png`)).toEqual(image);
});

test('pending send prevents duplicate delivery and cannot replace a new composer', async ({ page }) => {
  await setup(page, true); await save(page, '保存済みの送信対象');
  const original = (await stored())[0]!;
  let release: () => void = () => {}; const pending = new Promise<void>(done => { release = done; });
  const requests: unknown[] = [];
  await page.route('**/__needmark/submit', async route => { requests.push(route.request().postDataJSON()); await pending; await route.fulfill({ json: { submitted: [original.id], skipped: [] } }); });
  const delivered = page.waitForResponse(response => response.url().endsWith('/__needmark/submit'));
  await page.getByRole('button', { name: 'AIへ送信', exact: true }).click();
  await expect(page.getByRole('button', { name: '送信中…', exact: true })).toBeDisabled();
  const bounds = await page.getByRole('button', { name: '送信中…', exact: true }).boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await select(page, '#product-title'); await page.getByLabel('コメント本文').fill('送信中に入力した新しいコメント');
  release(); await delivered; await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByLabel('コメント本文')).toHaveValue('送信中に入力した新しいコメント');
  await saveAndList(page);
  await expect(page.getByText('送信中に入力した新しいコメント', { exact: true })).toBeVisible();
  expect(requests).toEqual([{ ids: [original.id], detail: 'standard', language: 'ja' }]);
  expect((await stored()).find(item => item.id === original.id)).toEqual(original);
});

test('manual clipboard selection survives polling after a CLI update', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }); });
  await setup(page); await save(page, '手動コピー中にCLIが更新するコメント');
  const original = (await stored())[0]!;
  await page.locator('[data-needmark] .open-item').click();
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  const field = page.getByLabel('AIへの指示', { exact: true });
  await expect(field).toBeFocused(); const prompt = await field.inputValue();
  const selection = await field.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }));
  await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'reply', original.id, 'CLIからの補足', '--directory', output]);
  await page.waitForTimeout(2400); // Exercise the two-second idle file polling while text is selected.
  await expect(field).toHaveValue(prompt); await expect(field).toBeFocused();
  expect(await field.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual(selection);
  await page.getByRole('button', { name: '一覧へ', exact: true }).click();
  await page.locator('[data-needmark] .open-item', { hasText: original.comment }).click();
  await expect(page.getByText('CLIからの補足', { exact: true })).toBeVisible();
});
