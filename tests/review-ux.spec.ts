import type { Page } from '@playwright/test';
import { test, expect, saveAndList, searchList, toggleFilter, output } from './support/review.js';
import { readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { Feedback } from '../src/shared/types.js';
async function storedAll(): Promise<Feedback[]> { const ids = (await readdir(output)).filter((id) => !id.startsWith('.')); return Promise.all(ids.map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback)); }
async function stored(): Promise<Feedback> { const [id] = (await readdir(output)).filter((id) => !id.startsWith('.')); return JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')); }
async function configure(page: import('@playwright/test').Page, method = 'none') {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('投稿者名').fill('Reviewer');
  await page.getByLabel('キャプチャ方式').selectOption(method);
  await page.getByRole('button', { name: '保存', exact: true }).click();
}
async function clickTarget(page: import('@playwright/test').Page, selector = '#purchase-button') {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator(selector).boundingBox(); await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
}

test('image-free comments edit, cancel, reply, survive reload and delete through the local API', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('余白を20pxにしてください。');
  await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  const original = await stored(); expect(original.capture.method).toBe('none'); expect(original.image).toBeUndefined();
  expect(await readdir(`${output}/${original.id}`)).toEqual(expect.not.arrayContaining(['screenshot.png']));
  await page.locator('[data-needmark] .open-item').click();
  await page.getByRole('button', { name: 'コメントの操作', exact: true }).click(); await page.getByRole('menuitem', { name: '編集', exact: true }).click();
  await page.getByLabel('コメント本文').fill('取り消す変更');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  expect((await stored()).comment).toBe(original.comment);
  await page.getByRole('button', { name: 'コメントの操作', exact: true }).click(); await page.getByRole('menuitem', { name: '編集', exact: true }).click();
  await page.getByLabel('コメント本文').fill('余白は24pxで、横幅は変えないでください。');
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await expect(page.getByLabel('コメント本文')).toHaveValue('余白は24pxで、横幅は変えないでください。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: 'コメントの操作', exact: true })).toBeVisible();
  expect((await stored()).comment).toContain('24px');
  await page.getByLabel('返信', { exact: true }).fill('変更しました。確認してください。');
  await expect(page.getByLabel('返信', { exact: true })).toHaveValue('変更しました。確認してください。');
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByText('変更しました。確認してください。', { exact: true })).toBeVisible();
  expect((await stored()).replies?.[0]?.author).toBe('Reviewer');
  await page.reload(); await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('キャプチャ方式')).toHaveValue('none'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: `コメント: ${(await stored()).comment}`, exact: true }).click();
  await page.getByRole('button', { name: 'コメントの操作', exact: true }).click(); await page.getByRole('menuitem', { name: '削除', exact: true }).click(); await page.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(page.locator('[data-needmark] .card')).toHaveCount(0); expect((await readdir(output)).filter((id) => !id.startsWith('.'))).toHaveLength(0);
});

test('failed save preserves text and image preview opens accessible zoom and pan viewer', async ({ page }) => {
  await page.goto('/'); await configure(page, 'dom'); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('画像を確認してから保存します。');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '画像プレビュー' }); await expect(dialog).toBeVisible();
  await page.keyboard.press('Shift+C');
  await expect(page.getByText('クリックで要素をコメント・ドラッグで範囲をコメント / Escで戻る', { exact:true })).toBeHidden();
  await dialog.getByRole('button', { name: '拡大', exact: true }).click(); await expect(dialog.getByRole('button', { name: '表示をリセット', exact: true })).toHaveText('125%');
  const image = dialog.getByRole('img', { name: 'コメントした場所のキャプチャ拡大', exact: true }), reset = dialog.getByRole('button', { name: '表示をリセット', exact: true });
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const box = (await image.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200); await expect(reset).toHaveText('125%');
  await page.keyboard.down('Meta'); await page.mouse.wheel(0, -200); await page.keyboard.up('Meta'); await expect(reset).toHaveText('150%');
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control'); await expect(reset).toHaveText('175%');
  await page.keyboard.down('Meta'); for (let index = 0; index < 8; index++) await page.mouse.wheel(0, -200); await page.keyboard.up('Meta');
  await expect(reset).toHaveText('300%'); await expect(dialog.getByRole('button', { name: '拡大', exact: true })).toBeDisabled();
  const transform = () => image.evaluate((node) => (node as HTMLElement).style.transform);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 5000, box.y + box.height / 2 + 5000, { steps: 4 }); await page.mouse.up();
  const dragged = await transform(); expect(dragged).toMatch(/^translate\((\d+)px, ?(\d+)px\) scale\(3\)$/);
  const [, x, y] = dragged.match(/translate\((\d+)px, ?(\d+)px\)/)!.map(Number); expect(x).toBeLessThan(5000); expect(y).toBeLessThan(5000);
  await page.keyboard.press('ArrowLeft'); expect(await transform()).toContain(`translate(${x! - 40}px`);
  for (let index = 0; index < 10; index++) await page.keyboard.press('-');
  await expect(reset).toHaveText('50%'); expect(await transform()).toMatch(/^translate\(0px(, ?0px)?\) scale\(0\.5\)$/);
  await reset.click(); await expect(reset).toHaveText('100%');
  await page.mouse.click(5, 5); await expect(dialog).toBeHidden();
  await page.getByRole('img', { name: 'コメントした場所のキャプチャ', exact: true }).click(); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.getByLabel('コメント本文')).toHaveValue('画像を確認してから保存します。');
  let fail = true;
  await page.route('**/__needmark/feedback', async (route) => { if (route.request().method() === 'POST' && fail) { fail = false; await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Simulated save failure"}' }); } else await route.continue(); });
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('Simulated save failure')).toBeVisible();
  await expect(page.getByLabel('コメント本文')).toHaveValue('画像を確認してから保存します。');
  await saveAndList(page); await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  await page.locator('[data-needmark] .open-item').click();
  await page.getByRole('img', { name: 'コメントのキャプチャ', exact: true }).click(); await expect(dialog).toBeVisible();
});

test('multiple separate elements and exact text ranges retain code context without screenshots', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  for (const [index, selector] of ['#purchase-button', '#product-title'].entries()) { const rect = await page.locator(selector).boundingBox(); if (!index) await page.keyboard.down('Shift'); await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2); if (!index) await page.keyboard.up('Shift'); }
  await page.getByRole('button', { name: '選択を完了' }).click(); await page.getByLabel('コメント本文').fill('選んだ2つの整列を直す'); await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(1); let saved = await stored(); expect(saved.target.kind).toBe('multi'); expect(saved.target.code?.elements.map((element) => element.attributes.id)).toEqual(['purchase-button', 'product-title']);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator('#product-title').boundingBox(); await page.keyboard.down('Alt'); await page.mouse.move(rect!.x + 2, rect!.y + rect!.height / 2); await page.mouse.down(); await page.mouse.move(rect!.x + 85, rect!.y + rect!.height / 2, { steps: 3 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await page.getByLabel('コメント本文').fill('この文字だけ変えて'); await saveAndList(page); await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(2);
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.')); const comments: Feedback[] = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')))); saved = comments.find((item) => item.target.kind === 'text')!;
  expect(saved.target.text.length).toBeGreaterThan(1); expect('Halden for Teams').toContain(saved.target.text); expect(saved.target.code?.elements[0]?.source?.file).toBe('demo/index.html');
});

test('an Alt/Option text drag previews and captures the text range instead of an area rectangle', async ({ page }) => {
  await page.goto('/'); await configure(page, 'dom');
  const cursor = () => page.locator('[data-needmark] .cover').evaluate((node) => getComputedStyle(node).cursor);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = (await page.locator('#product-title').boundingBox())!, y = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + 2, y); expect(await cursor()).toBe('crosshair');
  await page.keyboard.down('Alt'); await expect.poll(cursor).toBe('text'); await page.mouse.down(); await page.mouse.move(rect.x + 85, y, { steps: 3 }); expect(await cursor()).toBe('text');
  const preview = page.locator('[data-needmark] .text-preview span');
  await expect(preview).not.toHaveCount(0); await expect(page.locator('[data-needmark] .outline').first()).toBeHidden();
  const boxes = await preview.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as DOMRect));
  for (const box of boxes) { expect(box.y).toBeGreaterThanOrEqual(rect.y - 4); expect(box.y + box.height).toBeLessThanOrEqual(rect.y + rect.height + 4); }
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(preview).toHaveCount(0);
  await page.getByLabel('コメント本文').fill('プレビューした文字');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled(); await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(1);
  const saved = await stored(); expect(saved.target.kind).toBe('text'); expect('Halden for Teams').toContain(saved.target.text);
  const png = await readFile(`${output}/${saved.id}/screenshot.png`), line = boxes[0]!;
  const pixels = await page.evaluate(async ({ src, line, width }) => {
    const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const scale = image.width / width;
    const at = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    return { inside: at(line.x + 1, line.y + 1), outside: at(line.x + 1, line.y - 6) };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, line, width: saved.viewport.width });
  expect(pixels.inside[2]! - pixels.inside[0]!).toBeGreaterThan(30); expect(pixels.inside).not.toEqual(pixels.outside);
});

test('CLI changes appear automatically while an unsent reply remains intact', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page); await page.getByLabel('コメント本文').fill('CLIとの連携'); await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible(); const saved = await stored();
  await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'edit', saved.id, 'CLIで書き換えたコメント', output]); await expect(page.getByText('CLIで書き換えたコメント', { exact: true })).toBeVisible({ timeout: 6000 });
  await page.locator('[data-needmark] .open-item').click(); await page.getByLabel('返信', { exact: true }).fill('まだ送っていない文章');
  await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'reply', saved.id, 'AIの検証結果', '--author', 'Codex', '--directory', output]);
  await page.waitForTimeout(2400); await expect(page.getByLabel('返信', { exact: true })).toHaveValue('まだ送っていない文章');
  await page.getByRole('button', { name: '送信', exact: true }).click(); await expect(page.getByText('AIの検証結果', { exact: true })).toBeVisible(); expect((await stored()).replies).toHaveLength(2);
});

test('closing a delayed list request does not reopen the panel', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.route('**/__needmark/feedback', async (route) => { if (route.request().method() === 'GET') { await new Promise((resolve) => setTimeout(resolve, 600)); } await route.continue(); });
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await page.getByRole('button', { name: 'パネルを閉じる' }).click(); await page.waitForTimeout(800); await expect(page.getByRole('region', { name: 'NeedMark', exact: true })).toBeHidden();
});


test('existing pins do not intercept selecting the same element for another comment', async ({ page }) => {
  await page.goto('/'); await configure(page);
  for (const comment of ['最初のコメント', '同じボタンへの追加コメント']) {
    await clickTarget(page);
    await page.getByLabel('コメント本文').fill(comment);
    await saveAndList(page);
    await expect(page.getByText(comment, { exact:true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(2);
});

test('resolving from details hides the pin and export until reopened, keeps failed attempts retryable, and reply edits can cancel', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('今回は仕様を維持するコメント'); await saveAndList(page);
  await page.locator('[data-needmark] .open-item').click();
  await page.getByLabel('返信', { exact: true }).fill('最初の補足'); await page.getByRole('button', { name: '送信', exact: true }).click();
  await page.getByRole('button', { name: '返信の操作', exact: true }).click(); await page.getByRole('menuitem', { name: '返信を編集', exact: true }).click(); await page.getByLabel('返信の編集内容', { exact: true }).fill('キャンセルする文章'); await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(page.getByText('最初の補足', { exact: true })).toBeVisible(); expect((await stored()).replies?.[0]?.comment).toBe('最初の補足');
  let fail = true; await page.route('**/__needmark/feedback/*', async (route) => { if (route.request().method() === 'PATCH' && fail) { fail = false; await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Resolve save failed"}' }); } else await route.continue(); });
  await page.getByRole('button', { name: '解決にする', exact: true }).click(); await expect(page.getByText('Resolve save failed', { exact:true })).toBeVisible(); expect((await stored()).status).toBe('open');
  await page.getByRole('button', { name: '解決にする', exact: true }).click(); await expect.poll(async () => (await stored()).status).toBe('resolved');
  await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'コメント: 今回は仕様を維持するコメント', exact:true })).toBeHidden();
  const saved = await stored(); const exported = await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'export', output]); expect(exported.stdout).not.toContain(saved.comment);
  await page.getByRole('button', { name: '未解決に戻す', exact: true }).click(); await expect.poll(async () => (await stored()).status).toBe('open');
  await expect(page.getByRole('button', { name: 'コメント: 今回は仕様を維持するコメント', exact:true })).toBeVisible();
});

test('a comment resolved from the list stays until the list reopens, and resolving all covers only the shown open items', async ({ page }) => {
  await page.goto('/'); await configure(page);
  for (const comment of ['一覧で解決するコメント', '検索で絞るコメント', '検索で絞る別のコメント']) { await clickTarget(page); await page.getByLabel('コメント本文').fill(comment); await saveAndList(page); await expect(page.getByText(comment, { exact:true })).toBeVisible(); }
  const card = page.locator('[data-needmark] .card', { hasText: '一覧で解決するコメント' });
  await card.getByRole('button', { name: '解決にする', exact: true }).click(); await expect(card.getByRole('button', { name: '未解決に戻す', exact: true })).toBeVisible();
  await expect.poll(async () => (await storedAll()).find((item) => item.comment === '一覧で解決するコメント')!.status).toBe('resolved');
  await page.waitForTimeout(2400); await expect(card).toBeVisible(); // A polled re-render keeps the row the reviewer just resolved.
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await expect(page.locator('[data-needmark] .card')).toHaveCount(2); await expect(card).toHaveCount(0);
  await searchList(page, '検索で絞るコメント'); await expect(page.locator('[data-needmark] .card')).toHaveCount(1);
  await page.getByRole('button', { name: '検索を閉じる', exact: true }).click(); await expect(page.locator('[data-needmark] .card')).toHaveCount(2);
  await searchList(page, '別の'); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '一覧の操作', exact: true }).click(); await page.getByRole('menuitem', { name: 'すべて解決済みにする', exact: true }).click();
  await expect(page.getByText('2件を解決済みにしました。', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toHaveCount(2);
  expect((await storedAll()).map((item) => item.status)).toEqual(['resolved', 'resolved', 'resolved']);
  await page.getByRole('button', { name: '一覧の操作', exact: true }).click(); await expect(page.getByRole('menuitem', { name: 'すべて解決済みにする', exact: true })).toBeDisabled();
});

test('multiple selection keeps numbered outlines, Backspace removes the last, and Enter completes', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  for (const [index, selector] of ['#purchase-button', '#product-title'].entries()) { const rect = await page.locator(selector).boundingBox(); if (!index) await page.keyboard.down('Shift'); await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2); if (!index) await page.keyboard.up('Shift'); }
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(2);
  await page.keyboard.press('Backspace'); await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(1);
  await page.keyboard.press('Enter'); await expect(page.getByLabel('コメント本文')).toBeFocused();
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(0);
  await page.getByLabel('コメント本文').fill('選択を戻してボタンだけ修正'); await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(1); const saved = await stored(); expect(saved.target.kind).toBe('multi'); expect(saved.target.code?.elements.map((element) => element.attributes.id)).toEqual(['purchase-button']);
});

test('current-page filtering and confirmed deletion of the shown items respect query strings and preserve other pages', async ({ page }) => {
  await page.goto('/?variant=a'); await configure(page, 'dom'); await clickTarget(page); await page.getByLabel('コメント本文').fill('variant a のコメント'); await saveAndList(page);
  await expect(page.getByText('variant a のコメント', { exact:true })).toBeVisible(); const original = await stored();
  await page.goto('/?variant=b'); await clickTarget(page); await page.getByLabel('コメント本文').fill('variant b のコメント'); await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(2);
  await toggleFilter(page, 'このページのみ'); await expect(page.getByText('variant b のコメント', { exact:true })).toBeVisible(); await expect(page.getByText('variant a のコメント', { exact:true })).toBeHidden();
  await page.getByRole('button', { name: '一覧の操作', exact: true }).click(); await page.getByRole('menuitem', { name: 'すべて削除', exact: true }).click();
  await expect(page.getByText('表示中の1件を画像・返信と一緒に削除します。元に戻せません。', { exact:true })).toBeVisible();
  await page.getByRole('button', { name: '1件を削除する', exact:true }).click(); await expect.poll(async () => (await readdir(output)).filter((id) => !id.startsWith('.'))).toHaveLength(1);
  expect((await readdir(output)).filter((id) => !id.startsWith('.'))).toEqual([original.id]); expect(await readdir(`${output}/${original.id}`)).toContain('screenshot.png');
  await page.getByRole('button', { name: '一覧の操作', exact: true }).click(); await expect(page.getByRole('menuitem', { name: 'すべて削除', exact: true })).toBeDisabled();
});

test('bulk deletion reports partial failure and keeps the locked item visible', async ({ page }) => {
  await page.goto('/'); await configure(page);
  for (const comment of ['削除できるコメント', '他のプロセスが編集中のコメント']) { await clickTarget(page); await page.getByLabel('コメント本文').fill(comment); await saveAndList(page); await expect(page.getByText(comment, { exact:true })).toBeVisible(); }
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.')); const locked = (await Promise.all(ids.map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback))).find((item) => item.comment.startsWith('他の'))!;
  const lock = `${output}/.lock-${locked.id}`; await mkdir(lock);
  try { await page.getByRole('button', { name: '一覧の操作', exact: true }).click(); await page.getByRole('menuitem', { name: 'すべて削除', exact: true }).click(); await page.getByRole('button', { name: '2件を削除する', exact:true }).click(); await expect(page.getByText(/1件を削除、1件は削除できませんでした/)).toBeVisible(); await expect(page.getByText(locked.comment, { exact:true })).toBeVisible(); expect((await readdir(output)).filter((id) => !id.startsWith('.'))).toEqual([locked.id]); }
  finally { await rm(lock, { recursive:true, force:true }); }
});


test('keyboard shortcuts from a button preserve an unsaved comment and the toolbar', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page); await page.getByLabel('コメント本文').fill('ショートカットでも消してはいけない文章');
  await page.getByRole('button', { name: 'キャンセル', exact:true }).focus();
  await page.keyboard.press('Shift+C'); await expect(page.getByLabel('コメント本文')).toHaveValue('ショートカットでも消してはいけない文章');
  await page.keyboard.press('Shift+H'); await expect(page.getByLabel('コメント本文')).toHaveValue('ショートカットでも消してはいけない文章'); await expect(page.getByRole('button', { name:'コメント', exact:true })).toBeVisible();
  await saveAndList(page); await expect(page.getByText('ショートカットでも消してはいけない文章', { exact:true })).toBeVisible();
});


test('successful writes use their returned feedback even while subsequent list requests fail', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page); await page.getByLabel('コメント本文').fill('保存済み結果は失わない');
  await page.route('**/__needmark/feedback', async (route) => { if (route.request().method() === 'GET') await route.fulfill({ status:500, contentType:'application/json', body:'{"error":"List unavailable"}' }); else await route.continue(); });
  // The list itself cannot load here, so the saved item is reached through its pin, which uses the feedback returned by the save.
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('コメントを保存しました。', { exact:true })).toBeVisible();
  await expect(page.locator('[data-needmark] .cover')).toBeVisible(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'コメント: 保存済み結果は失わない', exact: true }).click(); await page.getByLabel('返信', { exact: true }).fill('重複させない返信'); await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.locator('[data-needmark] .reply p')).toHaveText('重複させない返信'); expect((await stored()).replies).toHaveLength(1);
  await page.getByRole('button', { name: '解決にする', exact: true }).click(); await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toBeVisible(); expect((await stored()).status).toBe('resolved');
});

test('a delayed clipboard failure cannot replace a newer unsaved composer', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable:true, value: { writeText: () => new Promise<void>((_resolve, reject) => { (window as unknown as { rejectClipboard: (error: Error) => void }).rejectClipboard = reject; }) } }); });
  await page.goto('/'); await configure(page); await clickTarget(page); await page.getByLabel('コメント本文').fill('コピー元のコメント'); await saveAndList(page);
  await page.getByRole('button', { name:'プロンプトをコピー' }).click(); await clickTarget(page); await page.getByLabel('コメント本文').fill('コピー待ちの間に書いた新しいコメント');
  await page.evaluate(() => (window as unknown as { rejectClipboard: (error: Error) => void }).rejectClipboard(new Error('Clipboard rejected')));
  await expect(page.getByLabel('コメント本文')).toHaveValue('コピー待ちの間に書いた新しいコメント');
  await saveAndList(page); await expect(page.getByText('コピー待ちの間に書いた新しいコメント', { exact:true })).toBeVisible();
});


test('pushState and replaceState immediately scope pins to the exact route', async ({ page }) => {
  await page.goto('/?variant=a'); await configure(page); await clickTarget(page); await page.getByLabel('コメント本文').fill('ルートaのコメント'); await saveAndList(page);
  await expect(page.getByRole('button', { name:'コメント: ルートaのコメント', exact:true })).toBeVisible();
  const pins = await page.evaluate(() => {
    const labels = () => [...document.querySelector('[data-needmark]')!.shadowRoot!.querySelectorAll('.pin')].map((pin) => pin.getAttribute('aria-label'));
    history.pushState({ check:'preserve' }, '', '/?variant=b'); const other = labels();
    history.replaceState({ check:'replace' }, '', '/?variant=a'); return { other, original:labels(), state:history.state };
  });
  expect(pins.other).toEqual([]); expect(pins.original).toEqual(['コメント: ルートaのコメント']); expect(pins.state).toEqual({ check:'replace' });
});


test('pins follow asynchronous DOM replacement and visibility without losing keyboard focus', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page); await page.getByLabel('コメント本文').fill('DOM更新後も対象を追う'); await saveAndList(page); await page.getByRole('button', { name:'パネルを閉じる' }).click();
  await page.evaluate(() => { const target = document.querySelector('#purchase-button')!; const copy = target.cloneNode(true) as HTMLElement; copy.hidden = true; target.replaceWith(copy); });
  const pin = page.getByRole('button', { name:'コメント: DOM更新後も対象を追う', exact:true }); await expect(pin).toBeHidden({ timeout:1000 });
  await page.evaluate(() => { (document.querySelector('#purchase-button') as HTMLElement).hidden = false; }); await expect(pin).toBeVisible({ timeout:1000 }); await pin.focus();
  await page.evaluate(() => { document.querySelector('main')!.classList.add('layout-refreshed'); }); await expect(pin).toBeFocused({ timeout:1000 });
});


test('explicitly closing typed drafts and replies allows starting another review', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('明示的にキャンセルする文章');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await clickTarget(page); await expect(page.getByLabel('コメント本文')).toHaveValue('');
  await page.getByLabel('コメント本文').fill('保存するコメント'); await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  await page.locator('[data-needmark] .open-item').click();
  await page.getByLabel('返信', { exact: true }).fill('閉じる返信'); await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  await clickTarget(page); await expect(page.getByLabel('コメント本文')).toBeVisible();
  const saved = await stored(); expect(saved.status).toBe('open'); expect(saved.replies ?? []).toEqual([]);
});

test('the header check resolves without a notice, shows the resolved state with prompt copy still available and reopens on a second click', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('AIの修正を確認して承認する');
  await saveAndList(page);
  await page.locator('[data-needmark] .open-item').click();
  // Marking the rendered comment proves the toggle swaps only its button instead of re-rendering the details.
  const comment = page.locator('[data-needmark] .panel .comment'); await comment.evaluate((node) => { (node as HTMLElement).dataset.marker = 'kept'; });
  await page.getByRole('button', { name: '解決にする', exact: true }).click();
  const reopen = page.getByRole('button', { name: '未解決に戻す', exact: true });
  await expect(reopen).toHaveAttribute('aria-pressed', 'true'); expect((await stored()).status).toBe('resolved');
  await expect(page.locator('[data-needmark] .toast')).toBeHidden();
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeVisible();
  await expect(comment).toHaveAttribute('data-marker', 'kept');
  await reopen.click(); await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible(); await expect(comment).toHaveAttribute('data-marker', 'kept');
  expect((await stored()).status).toBe('open'); await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toBeVisible();
});

test('clicking a pin opens its details without leaving the hover preview on screen after re-renders', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('ピンのプレビューを残さない'); await saveAndList(page);
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  const pin = page.getByRole('button', { name: 'コメント: ピンのプレビューを残さない', exact: true }), tip = page.locator('[data-needmark] .tip');
  await pin.hover(); await expect(tip).toBeVisible();
  await pin.click(); await expect(page.getByRole('heading', { name: 'コメント', exact: true })).toBeVisible();
  await page.mouse.move(5, 5);
  // Pins re-render on local polling and route checks; the focused pin must not bring the preview back.
  await page.waitForTimeout(2500); await expect(tip).toBeHidden();
  await page.keyboard.press('Escape'); await page.locator('body').focus(); await pin.focus(); await expect(tip).toBeVisible();
});

test('the target outline shown when details open stays on the commented element while the page scrolls', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => { document.body.style.minHeight = '3000px'; }); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('枠をその場所に固定する'); await saveAndList(page);
  await page.locator('[data-needmark] .open-item').click();
  const outline = page.locator('[data-needmark] > .outline'), target = page.locator('#purchase-button');
  const matches = async () => { const a = (await outline.boundingBox())!, b = (await target.boundingBox())!; return [a.x, a.y, a.width, a.height].map((value, index) => Math.round(value - [b.x, b.y, b.width, b.height][index]!)); };
  await expect(outline).toBeVisible(); await expect.poll(matches).toEqual([0, 0, 0, 0]);
  await page.evaluate(() => window.scrollBy(0, 240));
  await expect.poll(matches).toEqual([0, 0, 0, 0]);
});

const leaveDetails = {
  'going back to the list': async (page: Page) => { await page.getByRole('button', { name: '一覧へ', exact: true }).click(); },
  'closing the panel': async (page: Page) => { await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); },
  'deleting the comment': async (page: Page) => {
    await page.getByRole('button', { name: 'コメントの操作', exact: true }).click(); await page.getByRole('menuitem', { name: '削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する', exact: true }).click(); await expect(page.locator('[data-needmark] .open-item')).toHaveCount(0);
  },
};
for (const [exit, leave] of Object.entries(leaveDetails)) {
  test(`${exit} hides the target outline that details showed`, async ({ page }) => {
    await page.goto('/'); await configure(page); await clickTarget(page);
    await page.getByLabel('コメント本文').fill('枠を消す'); await saveAndList(page);
    await page.locator('[data-needmark] .open-item').click();
    const outline = page.locator('[data-needmark] > .outline');
    await expect(outline).toBeVisible();
    await leave(page);
    await expect(outline).toBeHidden();
  });
}

test('opening a comment from another page in the list goes to that page and shows its details there', async ({ page }) => {
  await page.goto('/?variant=a'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('別ページから開くコメント'); await saveAndList(page);
  const outline = page.locator('[data-needmark] > .outline'), target = page.locator('#purchase-button');
  const matches = async () => { const a = (await outline.boundingBox())!, b = (await target.boundingBox())!; return [a.x, a.y, a.width, a.height].map((value, index) => Math.round(value - [b.x, b.y, b.width, b.height][index]!)); };
  await page.goto('/?variant=b'); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await expect(page.locator('[data-needmark] .card .page-path')).toHaveText('/?variant=a');
  await page.locator('[data-needmark] .open-item').click();
  await expect(page).toHaveURL(/\/\?variant=a$/);
  await expect(page.getByRole('button', { name: 'コメントの操作', exact: true })).toBeVisible(); await expect(page.locator('[data-needmark] .panel')).toContainText('別ページから開くコメント');
  await expect(outline).toBeVisible(); await expect.poll(matches).toEqual([0, 0, 0, 0]);
  // A page differing only by its hash stays the same document, so the details open without a reload.
  await page.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; history.pushState({}, '', '/?variant=a#faq'); });
  await page.getByRole('button', { name: '一覧へ', exact: true }).click(); await page.locator('[data-needmark] .open-item').click();
  await expect(page).toHaveURL(/\/\?variant=a#?$/); await expect(page.getByRole('button', { name: 'コメントの操作', exact: true })).toBeVisible();
  await expect(outline).toBeVisible(); await expect.poll(matches).toEqual([0, 0, 0, 0]);
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
});

test('details show authors with relative times, keep edit and delete in kebab menus, and offer reply actions on every reply without taking over its author', async ({ page }) => {
  await page.goto('/'); await configure(page); await clickTarget(page);
  await page.getByLabel('コメント本文').fill('投稿者と相対時刻を表示する'); await saveAndList(page);
  const saved = await stored(), token = (await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token'))!;
  const agent = await page.request.post(`/__needmark/feedback/${saved.id}/replies`, { headers: { 'x-needmark-token': token }, data: { author: 'Agent', comment: 'エージェントの返信' } }); expect(agent.ok()).toBe(true);
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await page.locator('[data-needmark] .open-item').click();
  const byline = page.locator('[data-needmark] .panel > .byline');
  await expect(byline).toContainText('Reviewer'); await expect(byline.locator('time')).toHaveText('たった今');
  await expect(page.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);
  await page.getByLabel('返信', { exact: true }).fill('自分の返信'); await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.locator('[data-needmark] .reply')).toHaveCount(2);
  await expect(page.locator('[data-needmark] .reply', { hasText: '自分の返信' }).getByRole('button', { name: '返信の操作' })).toHaveCount(1);
  await page.locator('[data-needmark] .reply', { hasText: 'エージェントの返信' }).getByRole('button', { name: '返信の操作' }).click();
  await page.getByRole('menuitem', { name: '返信を編集', exact: true }).click(); await page.getByLabel('返信の編集内容', { exact: true }).fill('レビュアーが直した返信'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('[data-needmark] .reply', { hasText: 'レビュアーが直した返信' }).locator('.byline strong')).toHaveText('Agent');
  expect((await stored()).replies?.find((reply) => reply.comment === 'レビュアーが直した返信')?.author).toBe('Agent');
  await expect(page.locator('[data-needmark] .reply', { hasText: '自分の返信' }).locator('.byline time')).toHaveText('たった今');
  const kebab = page.getByRole('button', { name: 'コメントの操作', exact: true }), menu = page.locator('[data-needmark] .panel > .byline .menu');
  await kebab.click(); await expect(menu).toBeVisible(); await expect(page.getByRole('menuitem', { name: '編集', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(kebab).toBeFocused(); await expect(page.locator('[data-needmark] .panel')).toBeVisible();
  await kebab.click(); await expect(menu).toBeVisible(); await page.mouse.click(5, 5); await expect(menu).toBeHidden();
});

test('an area comment outlines the dragged rectangle in details and keeps it on the page while scrolling', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => { document.body.style.minHeight = '3000px'; }); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.mouse.move(100, 300); await page.mouse.down(); await page.mouse.move(500, 520, { steps: 5 }); await page.mouse.up();
  await page.getByLabel('コメント本文').fill('ドラッグした範囲を示す'); await saveAndList(page);
  const area = (await stored()).target.rect; expect((await stored()).target.kind).toBe('area');
  await page.locator('[data-needmark] .open-item').click();
  const outline = page.locator('[data-needmark] > .outline'), box = async () => { const b = (await outline.boundingBox())!; return [b.x, b.y, b.width, b.height].map(Math.round); };
  await expect.poll(box).toEqual([area.x, area.y, area.width, area.height].map(Math.round));
  await page.evaluate(() => window.scrollBy(0, 150));
  await expect.poll(box).toEqual([area.x, area.y - 150, area.width, area.height].map(Math.round));
});

test('pins count up in creation order and keep their numbers when earlier comments are resolved', async ({ page }) => {
  await page.goto('/'); await configure(page);
  for (const [selector, comment] of [['#purchase-button', '最初のコメント'], ['#product-title', '二番目のコメント']] as const) {
    await clickTarget(page, selector); await page.getByLabel('コメント本文').fill(comment); await saveAndList(page); await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  }
  const first = page.getByRole('button', { name: 'コメント: 最初のコメント', exact: true }), second = page.getByRole('button', { name: 'コメント: 二番目のコメント', exact: true });
  await expect(first).toHaveText('1'); await expect(second).toHaveText('2');
  await first.click(); await page.getByRole('button', { name: '解決にする', exact: true }).click(); await expect(page.getByRole('button', { name: '未解決に戻す', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await expect(first).toHaveCount(0); await expect(second).toHaveText('2');
});

test('focus rings appear after keyboard input but not after clicks that move focus by script', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  const ring = () => page.evaluate(() => { const active = document.querySelector('[data-needmark]')!.shadowRoot!.activeElement!; return getComputedStyle(active).outlineStyle; });
  await page.getByRole('button', { name: '絞り込み', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'このページのみ', exact: true })).toBeFocused(); expect(await ring()).toBe('none');
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '絞り込み', exact: true })).toBeFocused(); expect(await ring()).toBe('solid');
});

test('a pin stays put and opens while hovering it changes the text of its target', async ({ page }) => {
  // The card mimics a chart tooltip: entering it adds text, so the saved text only matches while the pointer is elsewhere.
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const card = document.createElement('div'); card.id = 'hover-card'; card.textContent = 'Card';
    card.style.cssText = 'position:fixed;left:100px;top:100px;width:400px;height:200px;background:#eee;z-index:5';
    card.addEventListener('mouseenter', () => { const tip = document.createElement('span'); tip.className = 'tip'; tip.textContent = ' Mar $171,000'; card.append(tip); });
    card.addEventListener('mouseleave', () => card.querySelector('.tip')?.remove());
    document.body.append(card);
  }));
  await page.goto('/'); await configure(page);
  const token = await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token');
  const rect = { x: 300, y: 150, width: 40, height: 40 };
  const saved = await page.request.post('/__needmark/feedback', { headers: { 'x-needmark-token': token! }, data: {
    comment: 'ホバーで中身が変わるカード', author: 'Reviewer', url: 'http://127.0.0.1:4192/', title: 'Review', capturedAt: new Date().toISOString(),
    viewport: { width: 1200, height: 850, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }, capture: { method: 'none', width: 0, height: 0 },
    target: { kind: 'element', text: 'Card', selector: '#hover-card', rect, code: { truncated: false, elements: [{ tag: 'div', selector: '#hover-card', text: 'Card', rect,
      attributes: { id: 'hover-card' }, styles: {}, headings: [], components: [] }] } },
  } });
  expect(saved.status()).toBe(201);
  const pin = page.locator('[data-needmark] .pin'); await expect(pin).toBeVisible({ timeout: 5000 });
  // Over the card the text no longer matches, so the pin falls back to its recorded spot inside the card.
  await page.mouse.move(150, 280); await expect.poll(async () => (await pin.boundingBox())!.x + 12).toBeCloseTo(320, 0);
  const box = (await pin.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  expect(await pin.boundingBox()).toEqual(box);
  await page.mouse.down(); await page.mouse.up();
  await expect(page.getByLabel('返信', { exact: true })).toBeVisible();
});
