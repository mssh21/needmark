import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList } from './save.js';
const output = '/private/tmp/needmark-e2e-feedback';
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

// The protocol response is controlled here to verify UI races. Live React extraction is tested separately.
async function setup(page: Page) {
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('data-needmark-capture=', 'data-needmark-runtime-source="true" data-needmark-capture=') });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('none');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.evaluate(() => {
    document.querySelectorAll('[data-needmark-source]').forEach((element) => element.removeAttribute('data-needmark-source'));
    for (const selector of ['#purchase-button', '#product-title']) {
      const element = document.querySelector(selector)!;
      Object.defineProperty(element, '__reactFiber$kit_test', { enumerable: true, configurable: true, value: {
        stateNode: element, type: element.localName, _debugStack: { stack: `Error: react-stack-top-frame\n    at ProductCard (${location.origin}/assets/product.js:15:301)` },
        return: { type: function ProductCard() {} },
      } });
    }
  });
}
async function select(page: Page, selector = '#purchase-button') {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await page.locator(selector).boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
}
async function stored(): Promise<Feedback> {
  const [id] = (await readdir(output)).filter((id) => !id.startsWith('.'));
  return JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8'));
}
const source = { file: 'src/ProductCard.tsx', line: 13, column: 7, component: 'ProductCard' };

test('runtime enrichment keeps typed text, open context and focus, persists verified source, and pins resolve after reload', async ({ page }) => {
  await setup(page);
  let release: () => void = () => {}; const pending = new Promise<void>((done) => { release = done; });
  await page.route('**/__needmark/source', async (route) => {
    expect(route.request().postDataJSON().elements[0].frames[0].line).toBe(15);
    await pending;
    await route.fulfill({ json: { elements: [{ source }] } });
  });
  await select(page); await expect(page.getByText('対象のコードを確認中…', { exact: true })).toBeVisible();
  await page.getByLabel('コメント本文').fill('コード照合中も入力できる文章');
  release();
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('コメント本文')).toHaveValue('コード照合中も入力できる文章');
  await expect(page.getByLabel('コメント本文')).toBeFocused();
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const saved = await stored(); expect(saved.target.code!.elements[0]!.source).toEqual(source);
  expect(saved.target.code!.elements[0]!.sourceOrigin).toBe('runtime');
  expect(JSON.stringify(saved)).not.toContain('frames');
  await page.reload();
  await page.evaluate(() => {
    document.querySelectorAll('[data-needmark-source]').forEach((element) => element.removeAttribute('data-needmark-source'));
    const element = document.querySelector('#purchase-button')!;
    Object.defineProperty(element, '__reactFiber$kit_test', { enumerable: true, configurable: true, value: { stateNode: element, type: 'button', return: { type: function ProductCard() {} } } });
    element.setAttribute('style', `${element.getAttribute('style') ?? ''};`);
  });
  await expect(page.getByRole('button', { name: 'コメント: コード照合中も入力できる文章', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'コメント: コード照合中も入力できる文章', exact: true }).hover();
  await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
});

test('saving before source lookup finishes stays usable and ignores the late result', async ({ page }) => {
  await setup(page);
  let release: () => void = () => {}; const pending = new Promise<void>((done) => { release = done; });
  await page.route('**/__needmark/source', async (route) => { await pending; await route.fulfill({ json: { elements: [{ source }] } }).catch(() => {}); });
  await select(page); await expect(page.getByText('対象のコードを確認中…', { exact: true })).toBeVisible();
  await page.getByLabel('コメント本文').fill('照合を待たずに保存'); await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible(); release();
  expect((await stored()).target.code!.elements[0]!.source).toBeUndefined();
  await expect(page.getByText('照合を待たずに保存', { exact: true })).toBeVisible();
  await expect(page.getByLabel('コメント本文')).toBeHidden();
});

test('a cancelled lookup cannot replace another target or its new comment', async ({ page }) => {
  await setup(page); let release: () => void = () => {}; const pending = new Promise<void>((done) => { release = done; });
  await page.route('**/__needmark/source', async (route) => {
    const tag = route.request().postDataJSON().elements[0].tag;
    if (tag === 'button') { await pending; await route.fulfill({ json: { elements: [{ source }] } }).catch(() => {}); }
    else await route.fulfill({ json: { elements: [{ source: { ...source, line: 20 } }] } });
  });
  await select(page); await expect(page.getByText('対象のコードを確認中…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await select(page, '#product-title'); await page.getByLabel('コメント本文').fill('タイトルだけを修正する');
  await expect(page.locator('[data-needmark] [data-source-state]')).toHaveText('修正対象のファイルを確認しました。'); release();
  await expect(page.getByLabel('コメント本文')).toHaveValue('タイトルだけを修正する');
  await saveAndList(page); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const saved = await stored(); expect(saved.target.code!.elements[0]!.source?.line).toBe(20); expect(saved.target.code!.elements[0]!.tag).toBe('h2');
});

test('changed target evidence rejects a delayed exact source while failure and file hints retain drafts', async ({ page }) => {
  await setup(page); let release: () => void = () => {}; const pending = new Promise<void>((done) => { release = done; });
  await page.route('**/__needmark/source', async (route) => { await pending; await route.fulfill({ json: { elements: [{ source }] } }); });
  await select(page); await expect(page.getByText('対象のコードを確認中…', { exact: true })).toBeVisible();
  await page.getByLabel('コメント本文').fill('選択後にボタンが変わった');
  await page.locator('#purchase-button').evaluate((element) => { element.textContent = 'Updated action'; }); release();
  await expect(page.getByText('セレクタとコンポーネントを手掛かりとして保存します。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('コメント本文')).toHaveValue('選択後にボタンが変わった');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click(); await page.unroute('**/__needmark/source');
  await page.route('**/__needmark/source', (route) => route.fulfill({ status: 500, json: { error: 'Unavailable map' } }));
  await select(page); await page.getByLabel('コメント本文').fill('ソースがなくても保存できる');
  await expect(page.getByText('セレクタとコンポーネントを手掛かりとして保存します。', { exact: true })).toBeVisible();
  await saveAndList(page); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  expect((await stored()).target.code!.elements[0]!.source).toBeUndefined();
  await page.getByRole('button', { name: 'パネルを閉じる' }).click(); await page.unroute('**/__needmark/source');
  await page.route('**/__needmark/source', (route) => route.fulfill({ json: { elements: [{ sourceHint: { file: 'src/MaybeCard.tsx', component: 'ProductCard' } }] } }));
  await select(page); await page.getByLabel('コメント本文').fill('候補を手掛かりに修正');
  await expect(page.locator('[data-needmark] [data-source-state]')).toHaveText('ファイルの候補を保存します。');
  await expect(page.getByLabel('コメント本文')).toHaveValue('候補を手掛かりに修正');
});


const batchIds = Array.from({ length: 20 }, (_, index) => `runtime-batch-${index + 1}`);
type BatchInput = { elements: { attributes: Record<string, string>; frames: { line: number }[] }[] };
const batchSource = (index: number) => ({ file: 'src/BatchActions.tsx', line: 101 + index, column: 7, component: 'BatchActions' });
function batchResult(input: BatchInput) {
  return { elements: input.elements.map((element) => ({ source: batchSource(batchIds.indexOf(element.attributes.id!)) })) };
}
async function setupBatch(page: Page, firstFrame = 0) {
  await setup(page);
  await page.locator('#purchase-button').evaluate((element) => {
    (element as HTMLElement).style.cssText += ';position:fixed;left:40px;top:620px;width:160px;height:52px;z-index:2';
  });
  await page.evaluate((eligibleFrom) => {
    for (let index = 0; index < 20; index++) {
      const element = document.createElement('button'); element.id = `runtime-batch-${index + 1}`;
      element.textContent = `Batch action ${index + 1}`;
      element.style.cssText = `position:fixed;left:${90 + index % 5 * 205}px;top:${90 + Math.floor(index / 5) * 110}px;width:150px;height:52px;z-index:1`;
      Object.defineProperty(element, '__reactFiber$kit_batch_test', { enumerable: true, configurable: true, value: {
        stateNode: element, type: 'button',
        ...(index >= eligibleFrom ? { _debugStack: { stack: `Error: react-stack-top-frame\n    at BatchActions (${location.origin}/assets/batch.js:${40 + index}:201)` } } : {}),
        return: { type: function BatchActions() {} },
      } });
      document.body.append(element);
    }
  }, firstFrame);
}
async function selectBatch(page: Page) {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  for (const [index, id] of batchIds.entries()) {
    const rect = (await page.locator(`#${id}`).boundingBox())!;
    if (!index) await page.keyboard.down('Shift');
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!index) await page.keyboard.up('Shift');
  }
  await expect(page.locator('[data-needmark] .selected-outline')).toHaveCount(20);
  await page.getByRole('button', { name: '選択を完了', exact: true }).click();
  await expect(page.getByLabel('コメント本文')).toBeVisible();
}
async function storedComment(comment: string): Promise<Feedback> {
  const items = await Promise.all((await readdir(output)).filter((id) => !id.startsWith('.')).map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback));
  const item = items.find((item) => item.comment === comment); if (!item) throw new Error('The saved batch comment is missing'); return item;
}
async function saveBatch(page: Page, comment: string) {
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const item = await storedComment(comment);
  expect(item.target.kind).toBe('multi'); expect(item.target.code!.elements.map((element) => element.attributes.id)).toEqual(batchIds);
  expect(item.target.code!.truncated).toBe(false); expect(JSON.stringify(item)).not.toContain('frames');
  return item;
}

test('controlled source batches skip twelve ineligible hosts without dropping the eight later targets', async ({ page }) => {
  await setupBatch(page, 12); const requests: string[][] = [];
  await page.route('**/__needmark/source', async (route) => {
    const input = route.request().postDataJSON() as BatchInput;
    requests.push(input.elements.map((element) => element.attributes.id!));
    expect(input.elements).toHaveLength(8); expect(input.elements.every((element) => element.frames.length > 0)).toBe(true);
    await route.fulfill({ json: batchResult(input) });
  });
  await selectBatch(page); const comment = '先頭にソースの手掛かりがなくても20件すべてを渡す';
  await page.getByLabel('コメント本文').fill(comment);
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
  expect(requests).toEqual([batchIds.slice(12)]);
  await expect(page.getByLabel('コメント本文')).toHaveValue(comment);
  const saved = await saveBatch(page, comment);
  expect(saved.target.code!.elements.slice(0, 12).every((element) => !element.source)).toBe(true);
  expect(saved.target.code!.elements.slice(12).map((element) => element.source)).toEqual(batchIds.slice(12).map((_, index) => batchSource(12 + index)));
});

test('controlled source failure in the first batch preserves all twenty targets and aligns later results to their originals', async ({ page }) => {
  await setupBatch(page); const requests: string[][] = [];
  await page.route('**/__needmark/source', async (route) => {
    const input = route.request().postDataJSON() as BatchInput;
    requests.push(input.elements.map((element) => element.attributes.id!)); expect(input.elements.length).toBeLessThanOrEqual(12);
    if (input.elements[0]!.attributes.id === batchIds[0]) await route.fulfill({ status: 500, json: { error: 'Unavailable first map' } });
    else await route.fulfill({ json: batchResult(input) });
  });
  await selectBatch(page); const comment = '前半の照合が失敗しても後半の情報を別対象へ混ぜない';
  await page.getByLabel('コメント本文').fill(comment);
  await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
  expect(requests).toEqual([batchIds.slice(0, 12), batchIds.slice(12)]);
  await expect(page.getByLabel('コメント本文')).toHaveValue(comment);
  const saved = await saveBatch(page, comment);
  expect(saved.target.code!.elements.slice(0, 12).every((element) => !element.source)).toBe(true);
  expect(saved.target.code!.elements.slice(12).map((element) => element.source)).toEqual(batchIds.slice(12).map((_, index) => batchSource(12 + index)));
});

test('controlled late batches respect changed evidence, saving and cancellation after earlier results were applied', async ({ page }) => {
  test.setTimeout(60000); await setupBatch(page);
  for (const outcome of ['changed', 'saving', 'cancelled'] as const) {
    await page.unroute('**/__needmark/source');
    let release: () => void = () => {}, seen: () => void = () => {}, finished: () => void = () => {};
    const pending = new Promise<void>((done) => { release = done; }), laterSeen = new Promise<void>((done) => { seen = done; }), delivered = new Promise<void>((done) => { finished = done; });
    const requests: string[][] = [];
    await page.route('**/__needmark/source', async (route) => {
      const input = route.request().postDataJSON() as BatchInput;
      if (input.elements[0]!.attributes.id === 'purchase-button') { await route.fulfill({ json: { elements: [{ source }] } }); return; }
      requests.push(input.elements.map((element) => element.attributes.id!));
      if (input.elements[0]!.attributes.id === batchIds[0]) { await route.fulfill({ json: batchResult(input) }); return; }
      expect(input.elements.map((element) => element.attributes.id)).toEqual(batchIds.slice(12)); seen();
      await pending;
      try { await route.fulfill({ json: batchResult(input) }); } catch (error) { if (outcome === 'changed') throw error; }
      finally { finished(); }
    });
    await selectBatch(page); await laterSeen;
    expect(requests).toEqual([batchIds.slice(0, 12), batchIds.slice(12)]);
    const comment = `20件の入力を保持する・${outcome}`;
    await page.getByLabel('コメント本文').fill(comment);
    if (outcome === 'changed') {
      await page.getByLabel('コメント本文').focus();
      await page.locator(`#${batchIds[12]}`).evaluate((element) => { element.textContent = 'A different action now uses this node'; });
      await page.locator(`#${batchIds[13]}`).evaluate((element) => {
        const fiber = (element as unknown as Record<string, { _debugStack: { stack: string } }>).__reactFiber$kit_batch_test!;
        fiber._debugStack.stack = `Error: react-stack-top-frame\n    at BatchActions (${location.origin}/assets/batch.js:999:201)`;
      });
      release(); await delivered;
      await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
      await expect(page.getByLabel('コメント本文')).toHaveValue(comment); await expect(page.getByLabel('コメント本文')).toBeFocused();
      const saved = await saveBatch(page, comment);
      expect(saved.target.code!.elements.slice(0, 12).map((element) => element.source)).toEqual(batchIds.slice(0, 12).map((_, index) => batchSource(index)));
      expect(saved.target.code!.elements.slice(12, 14).every((element) => !element.source)).toBe(true);
      expect(saved.target.code!.elements.slice(14).map((element) => element.source)).toEqual(batchIds.slice(14).map((_, index) => batchSource(14 + index)));
    } else if (outcome === 'saving') {
      const saved = await saveBatch(page, comment); release(); await delivered;
      expect(saved.target.code!.elements.slice(0, 12).map((element) => element.source)).toEqual(batchIds.slice(0, 12).map((_, index) => batchSource(index)));
      expect(saved.target.code!.elements.slice(12).every((element) => !element.source)).toBe(true);
      const reread = await storedComment(comment); expect(reread).toEqual(saved);
      await expect(page.getByLabel('コメント本文')).toBeHidden();
    } else {
      await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
      await page.getByRole('button', { name: 'コメント', exact: true }).click();
      const rect = (await page.locator('#purchase-button').boundingBox())!;
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const nextComment = 'キャンセル後の別対象の入力を守る'; await page.getByLabel('コメント本文').fill(nextComment);
      release(); await delivered;
      await expect(page.locator('[data-needmark] [data-source-state]')).toHaveText('修正対象のファイルを確認しました。');
      await expect(page.getByLabel('コメント本文')).toHaveValue(nextComment);
      await saveAndList(page);
      await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
      const saved = await storedComment(nextComment); expect(saved.target.code!.elements).toHaveLength(1);
      expect(saved.target.code!.elements[0]!.attributes.id).toBe('purchase-button'); expect(saved.target.code!.elements[0]!.source).toEqual(source);
    }
    await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  }
});
