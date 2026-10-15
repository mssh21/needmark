import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { ElementContext, Feedback, FeedbackInput, FeedbackStatus } from '../src/shared/types.js';
import { input } from './fixtures.js';
import { searchList, toggleFilter } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
type ClipboardState = { compactCopied?: string; compactCopyPending?: boolean; rejectCompactCopy?: (error: Error) => void };
const copied = (page: Page) => page.evaluate(() => (window as unknown as ClipboardState).compactCopied ?? '');
function element(selector = '#compact-target', file = 'src/CompactButton.tsx'): ElementContext {
  return { tag: 'button', selector, text: 'Compact review target', rect: { x: 100, y: 120, width: 130, height: 44 },
    attributes: { id: selector.slice(1), class: 'compact-review' }, styles: { color: 'rgb(12, 34, 56)' }, headings: ['Review page'],
    components: ['App', 'CompactButton'], source: { file, line: 17, column: 3, component: 'CompactButton' }, sourceRelation: 'self' };
}
function target(item = element()): FeedbackInput['target'] {
  return { kind: 'element', text: item.text, selector: item.selector, rect: item.rect, code: { elements: [item], truncated: false } };
}
async function setup(page: Page, submit = false, compact = true) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      const state = window as unknown as ClipboardState;
      state.compactCopied = value;
      if (state.compactCopyPending) return new Promise<void>((_resolve, reject) => { state.rejectCompactCopy = reject; });
    } } });
  });
  // Control the optional UI transport; the actual Node callback is covered by review-api tests.
  if (submit) await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('data-needmark-capture=', 'data-needmark-submit="true" data-needmark-capture=') });
  });
  await page.goto('/'); await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('AIへの情報量')).toHaveValue('standard');
  await page.getByLabel('キャプチャ方式').selectOption('none');
  if (compact) await page.getByLabel('AIへの情報量').selectOption({ label: '簡潔：コメントと場所・画像パス' });
  await page.getByRole('button', { name: '保存', exact: true }).click();
}
async function headers(page: Page) { return { 'x-needmark-token': (await page.locator('script[data-needmark-token]').getAttribute('data-needmark-token'))! }; }
async function seed(page: Page, comment: string, selected = target(), status: FeedbackStatus = 'open', url = page.url(), image = false): Promise<Feedback> {
  const base = input();
  if (!image) { delete base.screenshot; base.capture = { method: 'none', width: 0, height: 0 }; }
  const response = await page.request.post('/__needmark/feedback', { headers: await headers(page), data: { ...base, comment, url, target: selected } });
  expect(response.status()).toBe(201); let item = await response.json() as Feedback;
  if (status !== 'open') {
    const updated = await page.request.patch(`/__needmark/feedback/${item.id}`, { headers: await headers(page), data: { status } });
    expect(updated.ok()).toBe(true); item = await updated.json() as Feedback;
  }
  return item;
}
async function list(page: Page) {
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click();
  await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible();
}
async function copyList(page: Page) { await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click(); return copied(page); }

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('compact preference survives saving and reload, changes actual output, and invalid saved values fall back to standard', async ({ page }) => {
  await setup(page); const item = await seed(page, '保存した簡潔設定でこのボタンを修正する');
  expect(await page.evaluate(() => localStorage.getItem('needmark-detail'))).toBe('compact');
  await page.reload(); await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('AIへの情報量')).toHaveValue('compact');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await list(page);
  const compact = await copyList(page);
  for (const value of [item.id, item.comment, item.url, `${item.id}/context.json`, 'src/CompactButton.tsx:17:3']) expect(compact).toContain(value);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('AIへの情報量').selectOption('standard');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await list(page);
  const standard = await copyList(page); expect(standard).not.toEqual(compact);
  expect(standard).toContain(item.comment);
  await page.evaluate(() => localStorage.setItem('needmark-detail', 'unsupported-format'));
  await page.reload(); await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('AIへの情報量')).toHaveValue('standard');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('needmark-detail'))).toBe('standard');
});

test('compact copy and send use the same searched current-page open scope and exclude resolved feedback', async ({ page }) => {
  await setup(page, true);
  const open = await seed(page, '簡潔共有：未対応', target(element('#compact-open')));
  const second = await seed(page, '簡潔共有：未対応2', target(element('#compact-progress')));
  const closed = await seed(page, '簡潔共有：解決済み', target(element('#compact-closed')), 'resolved');
  const other = await seed(page, '簡潔共有：別ページ', target(element('#compact-other')), 'open', `${page.url()}?variant=other`);
  const unrelated = await seed(page, '検索対象外の別件', target(element('#compact-unrelated')));
  await list(page); await toggleFilter(page, 'このページのみ'); await searchList(page, '簡潔共有：');
  await expect(page.getByRole('button', { name: 'プロンプトをコピー', exact: true })).toHaveAttribute('title', 'AIへ渡す対象：表示中の未対応 2件');
  const prompt = await copyList(page);
  for (const item of [open, second]) { expect(prompt).toContain(item.id); expect(prompt).toContain(item.comment); }
  for (const item of [closed, other, unrelated]) { expect(prompt).not.toContain(item.id); expect(prompt).not.toContain(item.comment); }
  const delivered: { ids: string[]; detail: string }[] = [];
  await page.route('**/__needmark/submit', async (route) => {
    delivered.push(route.request().postDataJSON()); await route.fulfill({ json: { submitted: [open.id, second.id], skipped: [] } });
  });
  await page.getByRole('button', { name: 'AIへ送信', exact: true }).click();
  await expect(page.getByText('2件を送信しました。コメントと画像は手元に残っています。', { exact: true })).toBeVisible();
  expect(delivered).toHaveLength(1); expect(delivered[0]!.detail).toBe('compact');
  expect(delivered[0]!.ids.sort()).toEqual([open.id, second.id].sort());
  await page.getByRole('button', { name: '検索を閉じる', exact: true }).click(); await toggleFilter(page, '解決済みも表示'); await searchList(page, closed.comment); await expect(page.getByText(closed.comment, { exact: true })).toBeVisible();
  const empty = await copyList(page); expect(empty).not.toContain(closed.id); expect(empty).not.toContain(closed.comment);
  await expect(page.getByRole('button', { name: 'AIへ送信', exact: true })).toBeDisabled();
});

test('denied compact clipboard retains complete comments, replies and honest source evidence without taking focus from a typed reply', async ({ page }) => {
  await setup(page);
  const runtime = element('#compact-runtime', 'src/RuntimeButton.tsx'); runtime.sourceOrigin = 'runtime'; runtime.rootPath = ['#review-shadow'];
  const ancestor = element('#compact-ancestor', 'src/AncestorPanel.tsx'); ancestor.sourceRelation = 'ancestor'; ancestor.source!.component = 'AncestorPanel'; ancestor.rootPath = ['iframe[data-review]'];
  const candidate = element('#compact-candidate'); delete candidate.source; delete candidate.sourceRelation; candidate.sourceHint = { file: 'src/FileCandidate.tsx', component: 'FileCandidate' };
  const selected: FeedbackInput['target'] = { kind: 'multi', text: 'Three source evidence kinds', selector: '', rect: { x: 100, y: 120, width: 400, height: 44 }, code: { elements: [runtime, ancestor, candidate], truncated: false } };
  const comment = `長いコメント：${'この条件を省略しない。'.repeat(180)}全文コメント末尾：省略しない`;
  const reply = `保存済みの補足：${'この検証結果も必要。'.repeat(140)}返信の末尾：この条件も必要`;
  const item = await seed(page, comment, selected, 'open', page.url(), true);
  const posted = await page.request.post(`/__needmark/feedback/${item.id}/replies`, { headers: await headers(page), data: { author: 'Reviewer', comment: reply } }); expect(posted.ok()).toBe(true);
  await list(page); await page.locator(`.card[data-id="${item.id}"]`).locator('.open-item').click();
  await page.evaluate(() => { (window as unknown as ClipboardState).compactCopyPending = true; });
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as ClipboardState).rejectCompactCopy)).toBe('function');
  const draft = 'コピーの待機中に入力した未保存の返信';
  await page.getByLabel('返信', { exact: true }).fill(draft);
  await page.evaluate(() => (window as unknown as Required<ClipboardState>).rejectCompactCopy(new Error('Clipboard denied')));
  const fallback = page.getByRole('textbox', { name: 'AIへの指示', exact: true });
  await expect(fallback).toBeVisible(); await expect(fallback).toHaveAttribute('readonly', '');
  const value = await fallback.inputValue(); expect(value).toEqual(await copied(page));
  for (const text of [comment, reply, item.url, `${item.id}/context.json`, `${item.id}/screenshot.png`, '#compact-runtime', '#compact-ancestor', '#compact-candidate', '#review-shadow', 'iframe[data-review]', 'src/RuntimeButton.tsx:17:3', 'src/AncestorPanel.tsx:17:3', 'src/FileCandidate.tsx']) expect(value).toContain(text);
  expect(value).toMatch(/runtime[^\n]*verified/i); expect(value).toContain('ancestor hint'); expect(value).toContain('Source file search hint');
  expect(value).not.toMatch(/FileCandidate\.tsx:\d/); expect(value).not.toContain(draft);
  await expect(page.getByLabel('返信', { exact: true })).toHaveValue(draft); await expect(page.getByLabel('返信', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.locator('[data-needmark] .reply p').last()).toHaveText(draft);
  const saved = await (await page.request.get(`/__needmark/feedback/${item.id}`, { headers: await headers(page) })).json() as Feedback;
  expect(saved.replies?.map((entry) => entry.comment)).toEqual([reply, draft]);
});
