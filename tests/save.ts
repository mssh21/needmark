import { expect, type Page } from '@playwright/test';

// Saving a new comment returns to selection instead of opening the list, so specs that inspect the saved item leave selection and open the list themselves.
// 新しいコメントを保存すると一覧を開かずに選択へ戻るため、保存結果を確かめるテストは選択を終えて自分で一覧を開く。
export async function saveAndList(page: Page, language: 'ja' | 'en' = 'ja') {
  const cover = page.locator('[data-needmark] .cover');
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
