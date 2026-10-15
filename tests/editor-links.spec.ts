import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('none');
  await page.getByRole('button', { name: '保存', exact: true }).click();
}
async function select(page: Page) {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator('#purchase-button').boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible();
}
async function saveAndOpen(page: Page, comment = '購入ボタンを修正する') {
  await select(page); await page.getByLabel('コメント本文').fill(comment);
  await saveAndList(page); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  await page.locator('[data-needmark] .open-item').click(); await expect(page.getByLabel('返信', { exact: true })).toBeVisible();
}

test('configured identifiers survive widget saving and details prepare the local editor link for the saved source', async ({ page }) => {
  await setup(page);
  await page.locator('#purchase-button').evaluate((button) => {
    button.setAttribute('data-feature', 'checkout'); button.setAttribute('data-ticket', 'NB-42');
    button.setAttribute('data-unconfigured', 'excluded');
  });
  await saveAndOpen(page, '独自属性も手掛かりにして購入ボタンを修正する');
  const link = page.getByRole('link', { name: 'VS Codeで開く', exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^vscode:\/\/file\//);
  expect(decodeURIComponent(href!)).toContain(resolve('demo/index.html'));
  const source = (await readFile('demo/index.html', 'utf8')).split('\n');
  expect(href).toMatch(new RegExp(`:${source.findIndex((line) => line.includes('id="purchase-button"')) + 1}:\\d+$`));
  const id = (await readdir(output)).find((id) => !id.startsWith('.'))!;
  const saved = JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback;
  expect(saved.target.code?.elements[0]?.attributes).toMatchObject({ 'data-feature': 'checkout', 'data-ticket': 'NB-42' });
  expect(saved.target.code?.elements[0]?.attributes).not.toHaveProperty('data-unconfigured');
  await page.reload();
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.locator('[data-needmark] .open-item').click();
  await expect(page.getByRole('link', { name: 'VS Codeで開く', exact: true })).toHaveAttribute('href', href!);
});

test('editor link errors and delayed completion retain a typed reply and cannot replace a newer screen', async ({ page }) => {
  let deliver!: () => void;
  let requested!: () => void;
  const waiting = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/__needmark/editor', async (route) => {
    requested();
    await new Promise<void>((resolve) => { deliver = resolve; });
    await route.fulfill({ json: { url: 'javascript:alert("unexpected")' } });
  });
  await setup(page); await saveAndOpen(page);
  await waiting;
  await page.getByLabel('返信', { exact: true }).fill('リンク確認中でも返信を書き続ける');
  deliver();
  await expect(page.getByRole('button', { name: 'エディタリンクを再取得', exact: true })).toBeEnabled();
  await expect(page.locator('[data-needmark]').getByRole('link')).toHaveCount(0);
  await expect(page.getByLabel('返信', { exact: true })).toHaveValue('リンク確認中でも返信を書き続ける');
  await expect(page.getByLabel('返信', { exact: true })).toBeFocused();
  let retryRequested!: () => void;
  const retry = new Promise<void>((resolve) => { retryRequested = resolve; });
  await page.unroute('**/__needmark/editor');
  await page.route('**/__needmark/editor', async (route) => {
    retryRequested();
    await new Promise<void>((resolve) => { deliver = resolve; });
    await route.fulfill({ json: { url: 'vscode://file/tmp/old.tsx:1:1' } });
  });
  await page.getByLabel('返信', { exact: true }).fill('');
  await page.getByRole('button', { name: 'エディタリンクを再取得', exact: true }).click(); await retry;
  await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  deliver();
  await expect(page.locator('[data-needmark]').getByRole('link')).toHaveCount(0);
  await expect(page.getByLabel('キャプチャ方式')).toBeVisible();
});

test('an unconfigured editor shows no editor action in details and prepares no editor URLs', async ({ page }) => {
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/data-needmark-editor="[^"]*"\s*/g, '') });
  });
  let requests = 0; page.on('request', (request) => { if (request.url().endsWith('/__needmark/editor')) requests++; });
  await setup(page); await saveAndOpen(page);
  await expect(page.getByRole('button', { name: 'コメントの操作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'VS Codeで開く', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'VS Codeで開く', exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});

test('a delayed retry does not take focus from the reviewed application input', async ({ page }) => {
  let deliver!: () => void;
  let requested!: () => void;
  const waiting = new Promise<void>((resolve) => { requested = resolve; });
  let calls = 0;
  await page.route('**/__needmark/editor', async (route) => {
    if (++calls === 1) { await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }); return; }
    requested(); await new Promise<void>((resolve) => { deliver = resolve; });
    await route.fulfill({ json: { url: 'vscode://file/tmp/verified.tsx:1:1' } });
  });
  await setup(page);
  await page.evaluate(() => {
    const input = document.createElement('input'); input.setAttribute('aria-label', 'アプリ側のメモ');
    input.style.cssText = 'position:fixed;top:10px;left:10px;width:180px;z-index:2'; document.body.append(input);
  });
  await saveAndOpen(page);
  await page.getByRole('button', { name: 'エディタリンクを再取得', exact: true }).click(); await waiting;
  await page.getByLabel('アプリ側のメモ').fill('外部入力のフォーカスを保つ');
  deliver();
  await expect(page.getByRole('link', { name: 'VS Codeで開く', exact: true })).toBeVisible();
  await expect(page.getByLabel('アプリ側のメモ')).toBeFocused();
  await expect(page.getByLabel('アプリ側のメモ')).toHaveValue('外部入力のフォーカスを保つ');
});

test('ancestor source and runtime file hint prepare links to their own files', async ({ page }) => {
  await setup(page);
  const token = await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token');
  const saved = await page.request.post('/__needmark/feedback', {
    headers: { 'x-needmark-token': token! },
    data: {
      comment: '親と候補のファイルをそれぞれ確認する', author: 'Reviewer', url: 'http://127.0.0.1:4192/', title: 'Review',
      capturedAt: new Date().toISOString(), viewport: { width: 1200, height: 850, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      target: { kind: 'element', text: 'Buy', selector: '#purchase-button', rect: { x: 10, y: 10, width: 100, height: 40 },
        code: { truncated: false, elements: [{ tag: 'button', selector: '#purchase-button', text: 'Buy', rect: { x: 10, y: 10, width: 100, height: 40 },
          attributes: { id: 'purchase-button' }, styles: {}, headings: [], components: [], sourceRelation: 'ancestor',
          source: { file: 'demo/index.html', line: 1, column: 1 }, sourceHint: { file: 'demo/react.tsx' } }] } },
      capture: { method: 'none', width: 0, height: 0 },
    },
  });
  expect(saved.status()).toBe(201);
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.locator('[data-needmark] .open-item').click();
  const ancestor = page.getByRole('link', { name: '親のソースを開く', exact: true });
  const candidate = page.getByRole('link', { name: '候補ファイルを開く', exact: true });
  await expect(ancestor).toBeVisible(); await expect(candidate).toBeVisible();
  expect(decodeURIComponent((await ancestor.getAttribute('href'))!)).toContain(`${resolve('demo/index.html')}:1:1`);
  expect(decodeURIComponent((await candidate.getAttribute('href'))!)).toContain(`${resolve('demo/react.tsx')}:1:1`);
});
