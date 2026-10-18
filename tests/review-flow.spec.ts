import { type Page } from '@playwright/test';
import { test, expect, saveAndList, searchList, output, configureReview } from './support/review.js';
import { readFile, readdir } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';

async function saved(): Promise<Feedback[]> {
  const ids = (await readdir(output).catch(() => [] as string[])).filter((id) => !id.startsWith('.'));
  return Promise.all(ids.map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback));
}
async function configure(page: Page) {
  await configureReview(page, { method: 'none' });
}
async function clickAt(page: Page, selector: string) {
  const rect = (await page.locator(selector).boundingBox())!;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}
const review = (page: Page) => page.locator('[data-needmark]');

test('the first comment begins selection immediately without opening settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(review(page).locator('.cover')).toBeVisible();
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toHaveCount(0);
});

test('the bottom-centred icon toolbar names each tool, explains its purpose in tooltips and follows the shortcut preference', async ({ page }) => {
  await page.goto('/'); await configure(page);
  const dock = review(page).locator('.dock'), tip = review(page).locator('.toolbar-tip');
  const names = ['コメント', 'ピンの表示切り替え', 'アニメーションを停止', 'コメント一覧', '設定', 'ツールバーをたたむ'];
  for (const name of names) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '選択方法', exact: true })).toHaveCount(0);
  expect(await dock.locator('[data-action="select"],[data-action="pins"]').evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return [rect.width, rect.height]; }))).toEqual([[32, 32], [32, 32]]);
  expect(await dock.locator(':scope > button').evaluateAll((buttons) => buttons.filter((button) => !(button as HTMLElement).hidden).map((button) => button.textContent!.replace(/\d/g, '').trim()))).toEqual(names.map(() => ''));
  const box = (await dock.boundingBox())!, viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2); expect(viewport.height - (box.y + box.height)).toBeLessThan(30);
  await expect(dock.locator('[title]')).toHaveCount(0);
  await page.getByRole('button', { name: 'コメント', exact: true }).hover();
  await expect(tip).toHaveText('コメントShift+C画面の場所を選んでコメントを残す');
  const tipBox = (await tip.boundingBox())!;
  expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(box.y);
  await page.getByRole('button', { name: 'アニメーションを停止', exact: true }).hover();
  await expect(tip).toContainText('アニメーションを停止Shift+P');
  await page.mouse.move(10, 10);
  await expect(tip).toBeHidden();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(dock.locator('.hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'コメント', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キーボードショートカット').selectOption('false');
  await page.getByLabel('表示言語').selectOption('en');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: 'Comment', exact: true }).hover();
  await expect(tip).toHaveText('CommentPick a spot on the page and leave a comment');
});

test('collapsing leaves only the expand button, keeps shortcuts with their selection controls and an active pause, and persists across reload', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'ツールバーをたたむ', exact: true }).click();
  const expand = page.getByRole('button', { name: 'ツールバーを広げる', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  for (const name of ['コメント', 'ピンの表示切り替え', 'アニメーションを停止', 'コメント一覧', '設定']) await expect(page.getByRole('button', { name, exact: true })).toBeHidden();
  const end = page.getByRole('button', { name: '終了', exact: true });
  await page.keyboard.press('Shift+C'); await expect(review(page).locator('.cover')).toBeVisible();
  await expect(end).toBeVisible(); await expect(expand).toBeHidden();
  await page.keyboard.press('Escape'); await expect(end).toBeHidden(); await expect(expand).toBeVisible();
  await page.keyboard.press('Shift+C'); await clickAt(page, 'h1');
  await expect(page.getByLabel('コメント本文')).toBeVisible(); await expect(end).toBeHidden(); await expect(expand).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(expand).toHaveAttribute('aria-expanded', 'false'); await page.keyboard.press('Shift+P');
  const resume = page.getByRole('button', { name: 'アニメーションを再開', exact: true });
  await expect(resume).toBeHidden();
  await expand.click(); await expect(resume).toBeVisible(); await expect(resume).toHaveText('');
  await page.getByRole('button', { name: 'ツールバーをたたむ', exact: true }).click(); await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(expand).toBeVisible(); await expect(page.getByRole('button', { name: '設定', exact: true })).toBeHidden();
  await expand.click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('needmark-toolbar-collapsed'))).toBe('false');
});

test('comment mode turns the bottom toolbar into the gesture hint and returns its buttons when selection ends', async ({ page }) => {
  await page.goto('/'); await configure(page);
  const dock = review(page).locator('.dock'), list = page.getByRole('button', { name: 'コメント一覧', exact: true });
  const before = (await dock.boundingBox())!;
  const heights = page.evaluate(() => new Promise<number[]>((resolve) => {
    const dock = document.querySelector('[data-needmark]')!.shadowRoot!.querySelector('.dock')!, values: number[] = [];
    const sample = () => { values.push(Math.round(dock.getBoundingClientRect().height)); if (values.length < 20) requestAnimationFrame(sample); else resolve(values); };
    requestAnimationFrame(sample);
  }));
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  expect(new Set(await heights)).toEqual(new Set([Math.round(before.height)]));
  await expect(dock.locator('.hint')).toBeVisible(); await expect(list).toBeHidden();
  await expect(dock.getByRole('button', { name: '終了', exact: true })).toBeFocused();
  await expect(dock.getByRole('link', { name: '使い方', exact: true })).toHaveAttribute('href', /docs\/getting-started\.ja\.md#/);
  await expect.poll(async () => { const box = (await dock.boundingBox())!; return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height) === Math.round(before.y + before.height)]; }).toEqual([Math.round(before.x + before.width / 2), true]);
  await dock.getByRole('button', { name: '終了', exact: true }).click();
  await expect(dock.locator('.hint')).toBeHidden(); await expect(list).toBeVisible();
  await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(Math.round(before.width));
});

test('the guide link in the draggable toolbar opens the guide in a new tab', async ({ page }) => {
  await page.context().route('https://github.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>guide</title>' }));
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await review(page).locator('.dock').getByRole('link', { name: '使い方', exact: true }).click();
  expect(decodeURIComponent((await popup).url())).toBe('https://github.com/mssh21/needmark/blob/main/docs/getting-started.ja.md#コメント');
});

test('a toolbar tip pending when selection starts never appears for the button selection hides', async ({ page }) => {
  await page.goto('/'); await configure(page);
  const tip = review(page).locator('.toolbar-tip');
  await page.getByRole('button', { name: 'コメント', exact: true }).hover(); await expect(tip).toBeVisible();
  await page.keyboard.press('Shift+C'); await expect(review(page).locator('.hint')).toBeVisible(); await expect(tip).toBeHidden();
  // A neighbouring tip opens without delay; hovering the end button must anchor to it, not to the hidden comment button.
  await page.getByRole('button', { name: '終了', exact: true }).hover(); await expect(tip).toContainText('Esc');
  const end = (await page.getByRole('button', { name: '終了', exact: true }).boundingBox())!, box = (await tip.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (end.x + end.width / 2))).toBeLessThan(2);
});

test('one comment tool selects text by Alt drag and several elements after one Shift click', async ({ page }) => {
  await page.goto('/'); await configure(page);
  const title = (await page.locator('#product-title').boundingBox())!;
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(review(page).locator('[data-hint]')).toHaveText('クリック・ドラッグで選択');
  await page.keyboard.down('Alt');
  await page.mouse.move(title.x + 2, title.y + title.height / 2); await page.mouse.down(); await page.mouse.move(title.x + 70, title.y + title.height / 2, { steps: 3 }); await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.getByLabel('コメント本文').fill('Altドラッグの文字');
  await saveAndList(page);
  await expect.poll(async () => (await saved()).map((item) => [item.target.kind, item.comment])).toEqual([['text', 'Altドラッグの文字']]);
  const [text] = await saved(); expect('Halden for Teams').toContain(text!.target.text); expect(text!.target.code?.elements[0]?.source?.file).toBe('demo/index.html');
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.keyboard.down('Shift'); await clickAt(page, '#purchase-button'); await page.keyboard.up('Shift');
  await expect(review(page).locator('[data-hint]')).toHaveText('1件を選択');
  await clickAt(page, '#product-title');
  await page.getByRole('button', { name: '選択を完了', exact: true }).click();
  await page.getByLabel('コメント本文').fill('Shiftなしで複数');
  await saveAndList(page);
  await expect.poll(async () => (await saved()).find((item) => item.comment === 'Shiftなしで複数')?.target.code?.elements.map((element) => element.attributes.id)).toEqual(['purchase-button', 'product-title']);
});

test('category defaults to fix, is chosen above the comment without submitting on Enter, tagged only when not a fix, and editable', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await clickAt(page, '#purchase-button');
  const categories = page.getByRole('radiogroup', { name: 'カテゴリ' });
  await expect(categories.getByRole('radio')).toHaveCount(3);
  await expect(categories.getByRole('radio', { name: '修正' })).toBeChecked();
  await page.getByLabel('コメント本文').fill('ボタンの色は決まっていますか？');
  await categories.getByText('質問', { exact: true }).click(); await expect(categories.getByRole('radio', { name: '質問' })).toBeChecked();
  await categories.getByRole('radio', { name: '質問' }).press('Enter');
  await expect(page.getByLabel('コメント本文')).toBeVisible();
  expect(await saved()).toEqual([]);
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。')).toBeVisible();
  const [item] = await saved();
  expect(item).toMatchObject({ category: 'question' }); expect(item).not.toHaveProperty('severity');
  expect(await readFile(`${output}/${item!.id}/comment.md`, 'utf8')).toContain('- Category: question\n');
  const card = review(page).locator(`.card[data-id="${item!.id}"]`);
  await expect(card.locator('.tag[data-category="question"]')).toHaveText('質問');
  await searchList(page, '質問');
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: '検索を閉じる', exact: true }).click(); await page.getByRole('button', { name: 'パネルを閉じる' }).click();
  const pin = review(page).locator(`.pin[data-id="${item!.id}"]`);
  await expect(pin).toHaveAttribute('aria-label', 'コメント: ボタンの色は決まっていますか？');
  await pin.click();
  await page.getByRole('button', { name: 'コメントの操作', exact: true }).click(); await page.getByRole('menuitem', { name: '編集', exact: true }).click();
  await expect(categories.getByRole('radio', { name: '質問' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'プロンプトをコピー' })).toBeHidden();
  await categories.getByText('修正', { exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: 'コメントの操作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'プロンプトをコピー' })).toBeVisible();
  const [edited] = await saved();
  expect(edited!.category).toBe('fix');
  await page.getByRole('button', { name: '一覧へ', exact: true }).click();
  await searchList(page, '');
  await expect(card).toBeVisible(); await expect(card.locator('.category-line .tag')).toHaveText('修正');
  // Details show the category as a tag, including the default fix; it changes only in the edit form.
  await card.locator('.open-item').click();
  await expect(review(page).locator('.category-line .tag')).toHaveText('修正');
  await expect(page.getByRole('combobox', { name: 'カテゴリ' })).toHaveCount(0);
});

test('the single save keeps reviewing without opening the list, by button or Ctrl/Cmd+Enter', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await clickAt(page, '#purchase-button');
  await expect(review(page).locator('.draft-outline')).toHaveCount(1);
  await page.getByLabel('コメント本文').fill('一つ目');
  await expect(page.getByRole('button', { name: '保存して次へ' })).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(review(page).locator('.cover')).toBeVisible();
  await expect(review(page).locator('.toast')).toHaveText('コメントを保存しました。');
  await expect(page.getByRole('heading', { name: 'コメント一覧' })).toHaveCount(0);
  await clickAt(page, '#product-title');
  await page.getByLabel('コメント本文').fill('二つ目');
  await page.getByLabel('コメント本文').press('ControlOrMeta+Enter');
  await expect(review(page).locator('.cover')).toBeVisible();
  await expect.poll(async () => (await saved()).map((item) => item.comment).sort()).toEqual(['一つ目', '二つ目']);
  await page.keyboard.press('Escape');
  await expect(review(page).locator('.cover')).toBeHidden();
  // The composer closed with the save, so the saved comment's pin previews again.
  await page.getByRole('button', { name: 'コメント: 一つ目' }).hover();
  await expect(review(page).locator('.tip')).toContainText('一つ目');
});

test('Enter completes a multiple selection into a focused composer whose draft outline marks every target and disappears on scroll and close', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.keyboard.down('Shift'); await clickAt(page, '#purchase-button'); await clickAt(page, '#product-title'); await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('コメント本文')).toBeFocused(); await expect(review(page).locator('.selected-outline')).toHaveCount(0);
  const outlines = review(page).locator('.draft-outline');
  await expect(outlines).toHaveCount(2);
  const title = (await page.locator('#product-title').boundingBox())!, outline = (await outlines.nth(1).boundingBox())!;
  expect(Math.abs(outline.x + 3 - title.x)).toBeLessThan(2);
  await page.mouse.wheel(0, 120);
  await expect(outlines).toHaveCount(0);
  await page.waitForFunction(() => new Promise((done) => { const start = scrollY; setTimeout(() => done(scrollY === start), 300); }));
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await clickAt(page, '#purchase-button');
  await expect(outlines).toHaveCount(1);
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(outlines).toHaveCount(0);
});

test('the wheel in comment mode scrolls a page whose content scrolls inside an app shell instead of the document', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.evaluate(() => {
    const shell = document.createElement('div'); shell.id = 'app-shell'; shell.style.cssText = 'height:100vh;overflow:auto';
    shell.append(...Array.from(document.body.children).filter((element) => !element.matches('[data-needmark], script')));
    document.body.prepend(shell); document.documentElement.style.overflow = document.body.style.overflow = 'hidden';
  });
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.mouse.move(600, 400); await page.mouse.wheel(0, 300);
  await expect.poll(() => page.locator('#app-shell').evaluate((shell) => shell.scrollTop)).toBeGreaterThan(0);
});

test('Ctrl/Cmd+Shift+F toggles selection and Shift+L is not a NeedMark shortcut', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(review(page).locator('.cover')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(review(page).locator('.cover')).toBeHidden();
  await page.keyboard.press('Shift+L');
  await expect(review(page).locator('.dock')).toBeVisible(); await expect(review(page).locator('.cover')).toBeHidden();
  await expect(review(page).locator('.panel')).toBeHidden();
});
