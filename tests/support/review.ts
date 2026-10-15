import { test as base, expect, type Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { output } from './paths.js';

export { output, tempRoot } from './paths.js';
export { expect };

// Every spec shares one demo server and feedback folder, so the folder is emptied before each test instead of relying on each file to remember it.
// すべてのspecが1つのデモサーバーと保存先を共有するため、各ファイルの書き忘れに頼らず、テストごとに保存先を空にする。
export const test = base.extend<{ cleanOutput: void }>({
  cleanOutput: [async ({}, use) => { await rm(output, { recursive: true, force: true }); await use(); }, { auto: true }],
});

// Native tab capture arrives as video, whose YUV to RGB conversion moves each channel by at most 2 on macOS but by up to 16 in Linux Chromium under Xvfb.
// ネイティブのタブ撮影は動画として届き、YUVからRGBへの変換で各チャンネルはmacOSでは最大2、XvfbのLinux Chromiumでは最大16ずれる。
export const tabColorTolerance = process.platform === 'darwin' ? 2 : 20;

// Settings are changed the way a reviewer does, so specs also exercise the panel that stores these preferences.
// レビュアーと同じ操作で設定を変え、設定を保存するパネル自体も通す。
export async function configureReview(page: Page, options: { method?: 'none' | 'dom' | 'tab'; author?: string } = {}) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  if (options.author !== undefined) await page.getByLabel('投稿者名').fill(options.author);
  if (options.method) await page.getByLabel('キャプチャ方式').selectOption(options.method);
  await page.getByRole('button', { name: '保存', exact: true }).click();
}

// Options such as submission and runtime source lookup are server configuration; rewriting the served script attribute enables them without another demo server.
// 送信や実行時のソース照合はサーバー側の設定なので、配信するスクリプトの属性を書き換え、別のデモサーバーを立てずに有効にする。
export async function enableWidgetOption(page: Page, attribute: 'data-needmark-submit' | 'data-needmark-runtime-source') {
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('data-needmark-capture=', `${attribute}="true" data-needmark-capture=`) });
  });
}

// Saving a new comment returns to selection instead of opening the list, so specs that inspect the saved item leave selection and open the list themselves.
// 新しいコメントを保存すると一覧を開かずに選択へ戻るため、保存結果を確かめるテストは選択を終えて自分で一覧を開く。
export async function saveAndList(page: Page, language: 'ja' | 'en' = 'ja') {
  const cover = page.locator('[data-needmark] .cover');
  // Save is enabled as the capture preview appears, while the panel still grows to fit it, so the click waits for that motion to end instead of landing above the moving button on a slow runner.
  // 撮影プレビューが現れた時点で保存は押せるが、パネルはまだ伸びている途中なので、遅い環境で動くボタンの上を押さないよう動きが終わるのを待つ。
  await expect(page.locator('[data-needmark] .morphing')).toHaveCount(0);
  await page.getByRole('button', { name: language === 'ja' ? '保存' : 'Save', exact: true }).click();
  await expect(page.getByLabel(language === 'ja' ? 'コメント本文' : 'Comment text')).toBeHidden();
  await expect(cover).toBeVisible();
  await page.keyboard.press('Escape'); await expect(cover).toBeHidden();
  await page.getByRole('button', { name: language === 'ja' ? 'コメント一覧' : 'Comments', exact: true }).click();
  await expect(page.getByRole('button', { name: language === 'ja' ? 'キーワード検索' : 'Search by keyword', exact: true })).toBeVisible();
}

// Search and filters sit behind header icons, so specs open them the way a reviewer does.
// 検索と絞り込みはヘッダーのアイコンの奥にあるため、レビュアーと同じ操作で開く。
export async function searchList(page: Page, text: string) {
  const field = page.getByRole('textbox', { name: 'キーワード検索', exact: true });
  if (!await field.isVisible()) await page.getByRole('button', { name: 'キーワード検索', exact: true }).click();
  await field.fill(text);
}
export async function toggleFilter(page: Page, name: 'このページのみ' | '解決済みも表示') {
  await page.getByRole('button', { name: '絞り込み', exact: true }).click();
  const option = page.getByRole('menuitemcheckbox', { name, exact: true }), checked = await option.getAttribute('aria-checked');
  await option.click(); await expect(page.getByRole('menuitemcheckbox', { name, exact: true })).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true');
  await page.keyboard.press('Escape');
}
