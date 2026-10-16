import { type Page } from '@playwright/test';
import { test, expect, saveAndList, output, configureReview, tabColorTolerance } from './support/review.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';


async function savedFeedback(): Promise<Feedback> {
  const entries = (await readdir(output)).filter((id) => !id.startsWith('.'));
  return JSON.parse(await readFile(`${output}/${entries[0]}/context.json`, 'utf8')) as Feedback;
}

async function preparePromptExport(page: Page, browserName: string) {
  if (browserName === 'chromium') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } else {
    // WebKit cannot grant clipboard permissions; exercise the explicit denied-copy fallback.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('Clipboard denied by the test fixture', 'NotAllowedError'); },
      } });
    });
  }
}
async function exportedPrompt(page: Page, browserName: string): Promise<string> {
  await page.getByRole('button', { name: 'プロンプトをコピー' }).click();
  const status = page.locator('[data-needmark] .toast');
  if (browserName === 'chromium') {
    await expect(page.getByRole('button', { name: 'コピーしました', exact: true })).toBeVisible();
    return page.evaluate(() => navigator.clipboard.readText());
  }
  await expect(status).toHaveText('自動コピーできませんでした。表示したテキストを手動でコピーできます。');
  const prompt = page.getByRole('textbox', { name: 'AIへの指示', exact: true });
  await expect(prompt).toBeVisible(); await expect(prompt).toHaveAttribute('readonly', '');
  return prompt.inputValue();
}

test('area selection saves image and feedback, survives reload, and shares status with the CLI files', { tag: '@cross-engine' }, async ({ page, browserName }) => {
  await preparePromptExport(page, browserName);
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('投稿者名').fill('Designer A');
  await page.getByLabel('キャプチャ方式').selectOption('dom');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const bounds = await page.locator('#product-title').boundingBox();
  await page.mouse.move(bounds!.x - 10, bounds!.y - 10);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width + 10, bounds!.y + bounds!.height + 10, { steps: 3 });
  await page.mouse.up();
  await page.getByLabel('コメント本文').fill('見出しとボタンの間隔を小さくしてください。');
  await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  const saved = await savedFeedback();
  expect(saved.target.kind).toBe('area');
  expect(saved.target.code?.elements.some((element) => element.attributes.id === 'product-title' && element.source?.file === 'demo/index.html' && element.sourceRelation === 'self')).toBe(true);
  expect(saved.capture.method).toBe('dom');
  expect(saved.author).toBe('Designer A');
  expect(saved.capture.width).toBeGreaterThan(100);
  const image = await readFile(`${output}/${saved.id}/screenshot.png`);
  expect(image.length).toBeGreaterThan(10000);
  expect(await readFile(`${output}/${saved.id}/comment.md`, 'utf8')).toContain('見出しとボタンの間隔');
  await page.reload();
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await expect(page.getByText('見出しとボタンの間隔を小さくしてください。', { exact: true })).toBeVisible();
  const pin = page.getByRole('button', { name: `コメント: ${saved.comment}`, exact: true });
  await expect(pin).toBeVisible();
  let prompt = await exportedPrompt(page, browserName);
  expect(prompt).toContain(`${saved.id} (open)`);
  expect(prompt).toContain(saved.comment);
  expect(prompt).toContain(`${saved.id}/comment.md`);
  expect(prompt).toContain(`needmark reply ${saved.id} <summary> --directory '${relative(process.cwd(), output)}'`);
  await page.getByRole('button', { name: '解決にする', exact: true }).click();
  await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toBeVisible();
  await expect(pin).toHaveCount(0);
  expect((await savedFeedback()).status).toBe('resolved');
  prompt = await exportedPrompt(page, browserName);
  expect(prompt).not.toContain(`${saved.id}/comment.md`);
  // A focused manual-copy field pauses list redraws, so leave it before waiting for polled CLI changes.
  await page.getByRole('button', { name: 'キーワード検索', exact: true }).focus();
  for (const [command, status] of [['reopen', 'open'], ['resolve', 'resolved']] as const) {
    await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), command, saved.id, output]);
    expect((await savedFeedback()).status).toBe(status);
    await expect(page.getByRole('button', { name: status === 'open' ? '解決にする' : '未解決に戻す', exact: true })).toBeVisible();
    await expect(pin).toHaveCount(status === 'resolved' ? 0 : 1);
  }
});

test('the list shows lost polling connections and clears the notice once polling recovers', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  const notice = page.getByText('サーバーに接続できません。接続が戻ると自動で更新します。', { exact: true });
  await expect(page.getByRole('button', { name: '絞り込み', exact: true })).toBeVisible(); await expect(notice).toHaveCount(0);
  await page.route('**/__needmark/feedback', (route) => route.abort());
  await expect(notice).toBeVisible();
  await page.unroute('**/__needmark/feedback');
  await expect(notice).toHaveCount(0);
});

test('native tab capture records the selected element and actual browser frame', async ({ page, browserName }) => {
  await page.goto('/');
  await configureReview(page, { method: 'tab' });
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(page.locator('[data-needmark] .cover')).toBeVisible();
  const button = await page.locator('#purchase-button').boundingBox();
  await page.mouse.click(button!.x + button!.width / 2, button!.y + button!.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible();
  await page.getByLabel('コメント本文').fill('このボタンを上に移動してください。');
  await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  const saved = await savedFeedback();
  expect(saved.capture.method).toBe('tab');
  expect(saved.target.selector).toBe('#purchase-button');
  const source = (await readFile('demo/index.html', 'utf8')).split('\n');
  const sourceLine = source.findIndex((line) => line.includes('id="purchase-button"')) + 1;
  expect(saved.target.code?.elements[0]?.source).toMatchObject({ file: 'demo/index.html', line: sourceLine });
  expect(saved.target.code?.elements[0]?.attributes.id).toBe('purchase-button');
  expect(saved.target.text).toBe('Start free trial');
  expect(saved.capture.width).toBeGreaterThan(500);
  expect(saved.target.rect.width).toBeCloseTo(button!.width, 0);
  const image = await readFile(`${output}/${saved.id}/screenshot.png`);
  expect(image.length).toBeGreaterThan(10000);
  const color = await page.evaluate(async ({ png, rect, viewport }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return Array.from(context.getImageData((rect.x + 20) * image.width / viewport.width,
      (rect.y + rect.height / 2) * image.height / viewport.height, 1, 1).data);
  }, { png: image.toString('base64'), rect: saved.target.rect, viewport: saved.viewport });
  const expected = await page.locator('#purchase-button').evaluate((element) =>
    getComputedStyle(element).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number));
  expected.forEach((channel, index) => expect(Math.abs(color[index]! - channel)).toBeLessThanOrEqual(tabColorTolerance));
});

test('React comments retain source locations, runtime ownership and distinguish repeated component instances', async ({ page, browserName }) => {
  await preparePromptExport(page, browserName);
  await page.goto('/react.html');
  const purchase = page.locator('#purchase-two');
  await purchase.click();
  await expect(purchase).toHaveText('Add seats · 1');
  await configureReview(page, { method: 'dom' });
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const bounds = await purchase.boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.getByLabel('コメント本文').fill('2つ目のボタンの余白を減らしてください。');
  await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  const saved = await savedFeedback();
  const element = saved.target.code!.elements[0]!;
  const source = (await readFile('demo/react.tsx', 'utf8')).split('\n');
  const line = source.findIndex((line) => line.includes('<button id={id}')) + 1;
  expect(element.source).toEqual({ file: 'demo/react.tsx', line, column: 5, component: 'PurchaseButton' });
  expect(element.sourceRelation).toBe('self');
  expect(element.components).toEqual(['App', 'ProductCard', 'PurchaseButton']);
  expect(element.attributes.id).toBe('purchase-two');
  expect(element.headings).toContain('182 of 200 seats used');
  expect(element.styles.padding).toBe('20px');
  const markdown = await readFile(`${output}/${saved.id}/comment.md`, 'utf8');
  expect(markdown).toContain(`demo/react.tsx:${line}:5`);
  const prompt = await exportedPrompt(page, browserName);
  expect(prompt).toContain(`demo/react.tsx:${line}:5`);
  expect(prompt).toContain(`${saved.id}/context.json`);
});
