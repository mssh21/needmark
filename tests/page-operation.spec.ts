import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Feedback, Rectangle } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
const resume = (page: Page) => page.getByRole('button', { name: '選択を再開', exact: true });
const outlines = (page: Page) => page.locator('[data-needmark] .selected-outline');
type HostState = { counter: number; submitted: number; modalCancelled: number; keys: { key: string; prevented: boolean; composing: boolean }[] };
type PermissionState = { devices: MediaDevices; streams: MediaStream[]; tracks: MediaStreamTrack[]; requests: number; deferInitial?: boolean; deliver(index: number): void };
async function fixture(page: Page) {
  const html = await readFile(resolve('tests/fixtures/page-operation.html'), 'utf8');
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    const script = (await response.text()).match(/<script\b[^>]*data-needmark-token=[^>]*>[\s\S]*?<\/script>/)?.[0];
    if (!script) throw new Error('The fixture needs the real protected widget script');
    await route.fulfill({ response, body: html.replace('</body>', `${script}</body>`) });
  });
  await page.goto('/');
}
async function configure(page: Page, method = 'none', shortcuts = true) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption(method);
  await page.getByLabel('キーボードショートカット').selectOption(String(shortcuts));
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
}
async function choose(page: Page, ids = ['target-a', 'target-b']) {
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  for (const [index, id] of ids.entries()) { const rect = (await page.locator(`#${id}`).boundingBox())!; if (!index) await page.keyboard.down('Shift'); await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2); if (!index) await page.keyboard.up('Shift'); }
  await expect(page.getByRole('button', { name: 'ページを操作', exact: true })).toBeVisible();
  await expect(outlines(page)).toHaveCount(ids.length);
}
async function operate(page: Page, count: number) {
  await page.getByRole('button', { name: 'ページを操作', exact: true }).click();
  await expect(resume(page)).toHaveText(`選択を再開 · ${count}件`);
  await expect(page.locator('[data-needmark] .cover')).toBeHidden();
  await expect(outlines(page)).toHaveCount(0);
}
async function save(page: Page, comment: string) {
  await page.getByRole('button', { name: '選択を完了', exact: true }).click();
  await page.getByLabel('コメント本文').fill(comment);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
}
async function stored(): Promise<Feedback[]> {
  const ids = (await readdir(output).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).filter((id) => !id.startsWith('.'));
  return Promise.all(ids.map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback));
}
const host = (page: Page) => page.evaluate(() => (window as unknown as { pageOperationHost: HostState }).pageOperationHost);
function union(rects: Rectangle[]): Rectangle {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
}
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('page operation releases real host controls and form keys while retaining multiple targets through resume and saving', async ({ page }) => {
  await fixture(page); await configure(page);
  await page.getByRole('button', { name: 'アニメーションを停止', exact: true }).click();
  await choose(page); await operate(page, 2);
  await page.locator('#host-counter').click(); await expect(page.locator('#counter-value')).toHaveText('1');
  const field = page.getByLabel('ホスト入力', { exact: true });
  await field.focus(); await expect(field).toBeFocused();
  const initialCaret = await field.evaluate((node) => ({ start: (node as HTMLInputElement).selectionStart, end: (node as HTMLInputElement).selectionEnd }));
  await field.evaluate((node) => { const input = node as HTMLInputElement; input.setSelectionRange(input.value.length, input.value.length); });
  const beforeEdit = await field.evaluate((node) => { const input = node as HTMLInputElement; return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }; });
  expect(beforeEdit).toEqual({ value: 'AB', start: 2, end: 2, focused: true }); await page.keyboard.press('Backspace');
  const afterEdit = await field.evaluate((node) => { const input = node as HTMLInputElement; return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }; });
  const editKeys = (await host(page)).keys;
  await test.info().attach('host-native-edit.json', { body: JSON.stringify({ initialCaret, beforeEdit, afterEdit, keys: editKeys }, null, 2), contentType: 'application/json' });
  expect(editKeys.filter((event) => event.key === 'Backspace').at(-1)?.prevented).toBe(false);
  await expect(page.getByLabel('ホスト入力', { exact: true })).toHaveValue('A'); await page.keyboard.press('Enter');
  await expect(page.locator('#submit-value')).toHaveText('1');
  await page.getByLabel('ホストの文章', { exact: true }).fill('ホストの文章');
  await page.keyboard.press('Enter'); await expect(page.getByLabel('ホストの文章', { exact: true })).toHaveValue('ホストの文章\n');
  await page.keyboard.press('Control+Enter'); await page.keyboard.press('Escape'); await expect(page.locator('#submit-value')).toHaveText('1');
  await expect(resume(page)).toHaveText('選択を再開 · 2件');
  const events = (await host(page)).keys; expect(events.map((event) => event.key)).toEqual(expect.arrayContaining(['Backspace', 'Enter', 'Escape'])); expect(events.every((event) => !event.prevented)).toBe(true);
  await page.locator('#open-modal').click(); await expect(page.locator('#host-modal')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.locator('#host-modal')).toBeHidden(); expect((await host(page)).modalCancelled).toBe(1);
  expect(await stored()).toEqual([]);
  await resume(page).click(); await expect(outlines(page)).toHaveCount(2);
  const third = (await page.locator('#target-c').boundingBox())!; await page.mouse.click(third.x + third.width / 2, third.y + third.height / 2);
  await save(page, 'ページを操作してから元の2件と追加した1件を直す');
  const items = await stored(); expect(items).toHaveLength(1); expect(items[0]!.target.kind).toBe('multi');
  expect(items[0]!.target.code?.elements.map((element) => element.attributes.id)).toEqual(['target-a', 'target-b', 'target-c']);
  await expect(page.getByRole('button', { name: 'アニメーションを再開', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('resumed original nodes use current rectangles and DOM PNG pixels after host reflow and scrolling', async ({ page }) => {
  await fixture(page); await configure(page, 'dom');
  const before = (await page.locator('#target-a').boundingBox())!;
  await choose(page); await operate(page, 2); await page.locator('#move-targets').click();
  await page.mouse.move(1000, 500); await page.mouse.wheel(0, 60); await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const current = await Promise.all(['target-a', 'target-b'].map(async (id) => (await page.locator(`#${id}`).boundingBox())!));
  expect(current[0]!.x).toBe(before.x + 70);
  await resume(page).click(); await expect(outlines(page)).toHaveCount(2);
  const drawn = await outlines(page).evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  expect(drawn).toEqual(current); await save(page, '操作後の現在の位置で保存する');
  const item = (await stored())[0]!;
  expect(item.target.rect).toEqual(union(current)); expect(item.target.code?.elements.map((element) => element.rect)).toEqual(current);
  expect(item.viewport.scrollY).toBeGreaterThan(0); expect(item.capture.method).toBe('dom'); expect(item.image).toBe('screenshot.png');
  const png = await readFile(`${output}/${item.id}/screenshot.png`);
  const pixels = await page.evaluate(async ({ src, selected, old, viewport }) => {
    const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const color = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * image.width / viewport.width), Math.round(y * image.height / viewport.height), 1, 1).data);
    return { width: image.width, height: image.height, center: color(selected.x + 20, selected.y + selected.height / 2), outline: color(selected.x, selected.y + selected.height / 2), old: color(old.x + 20, old.y + old.height / 2) };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, selected: current[0]!, old: before, viewport: item.viewport });
  expect(pixels.center).toEqual([12, 174, 93, 255]); expect(pixels.outline).toEqual([25, 101, 227, 255]); expect(pixels.old).toEqual([255, 255, 255, 255]);
  expect(item.capture).toMatchObject({ width: pixels.width, height: pixels.height });
});

test('DOM capture renders every selected target when one moved outside the viewport during page operation', async ({ page }) => {
  await fixture(page); await configure(page, 'dom');
  await choose(page); await operate(page, 2); await page.locator('#offscreen-b').click(); await resume(page).click();
  await expect(page.locator('[data-needmark] [data-hint]')).toContainText('2件を選択');
  const current = await Promise.all(['target-a', 'target-b'].map(async (id) => (await page.locator(`#${id}`).boundingBox())!));
  expect(current[1]!.y).toBeGreaterThan(850);
  await save(page, '画面外へ移動した対象も画像に含める');
  const item = (await stored())[0]!;
  expect(item.target.rect).toEqual(union(current)); expect(item.image).toBe('screenshot.png');
  const png = await readFile(`${output}/${item.id}/screenshot.png`);
  const pixels = await page.evaluate(async ({ src, targets, region }) => {
    const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const scale = image.width / region.width;
    const color = (x: number, y: number) => Array.from(context.getImageData(Math.round((x - region.x) * scale), Math.round((y - region.y) * scale), 1, 1).data);
    return { height: image.height / scale, colors: targets.map((rect) => color(rect.x + 20, rect.y + rect.height / 2)) };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, targets: current,
    region: { x: 0, y: item.target.rect.y - 48, width: item.viewport.width } });
  expect(pixels.height).toBeCloseTo(item.target.rect.height + 96, 0);
  expect(pixels.colors).toEqual([[12, 174, 93, 255], [25, 132, 209, 255]]);
});

test('an area drag held at the viewport edge scrolls the page and captures the whole extended area', async ({ page }) => {
  await fixture(page); await configure(page, 'dom');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const a = (await page.locator('#target-a').boundingBox())!;
  await page.mouse.move(60, 200); await page.mouse.down(); await page.mouse.move(600, 500); await page.mouse.move(600, 835);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await page.mouse.move(600, 836); await page.mouse.up();
  await page.getByLabel('コメント本文').fill('画面外まで広げた範囲');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const item = (await stored())[0]!, scroll = item.viewport.scrollY;
  expect(item.target.kind).toBe('area');
  expect(item.target.rect).toMatchObject({ x: 60, y: 200 - scroll, width: 540, height: 636 + scroll });
  const height = item.target.rect.height + 96, top = Math.min(Math.max(item.target.rect.y - 48, -scroll), 1600 - scroll - height);
  const png = await readFile(`${output}/${item.id}/screenshot.png`);
  const pixels = await page.evaluate(async ({ src, target, region }) => {
    const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const scale = image.width / region.width;
    return { height: image.height / scale, color: Array.from(context.getImageData(Math.round((target.x + 20) * scale), Math.round((target.y - region.y) * scale), 1, 1).data) };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, target: { x: a.x, y: a.y + a.height / 2 - scroll }, region: { y: top, width: item.viewport.width } });
  expect(pixels.height).toBeCloseTo(height, 0); expect(pixels.color).toEqual([12, 174, 93, 255]);
});

test('removed, cloned and reused-owner targets never rebind; all missing targets require selection and hidden originals fail capture explicitly', async ({ page }) => {
  await fixture(page); await configure(page);
  await page.evaluate(() => {
    function OriginalOwner() {} function OtherOwner() {}
    const node = document.querySelector('#target-c')!;
    const fiber = { stateNode: node, type: 'button', return: { type: OriginalOwner } };
    Object.defineProperty(node, '__reactFiber$pageOperation', { enumerable: true, value: fiber });
    (window as unknown as { replacePageOwner: () => void }).replacePageOwner = () => { fiber.return.type = OtherOwner; };
  });
  await choose(page, ['target-a', 'target-b', 'target-c', 'target-d']); await operate(page, 4);
  await page.locator('#clone-a').click(); await expect(resume(page)).toHaveText('選択を再開 · 3件');
  await page.locator('#remove-b').click(); await expect(resume(page)).toHaveText('選択を再開 · 2件');
  await page.evaluate(() => (window as unknown as { replacePageOwner: () => void }).replacePageOwner());
  await resume(page).click(); await expect(outlines(page)).toHaveCount(1);
  await expect(page.getByText('1件の選択対象が消えたか変わったため、選択から外しました。', { exact: true })).toBeVisible();
  await save(page, '元の所有者が残るDだけを保存する'); expect((await stored())[0]!.target.code?.elements.map((element) => element.attributes.id)).toEqual(['target-d']);
  await page.goto('/'); await choose(page); await operate(page, 2); await page.locator('#remove-all').click(); await resume(page).click();
  await expect(outlines(page)).toHaveCount(0); await expect(page.getByText(/もう一度場所を選んでください。/)).toBeVisible();
  await page.getByRole('button', { name: '選択を完了', exact: true }).click(); await expect(page.getByLabel('コメント本文')).toHaveCount(0);
  const valid = (await page.locator('#target-c').boundingBox())!; await page.mouse.click(valid.x + valid.width / 2, valid.y + valid.height / 2); await save(page, '全対象が消えた後で選び直したC');
  expect((await stored()).find((item) => item.comment.endsWith('選び直したC'))!.target.code?.elements.map((element) => element.attributes.id)).toEqual(['target-c']);
  await page.goto('/'); await configure(page, 'dom'); await choose(page); await operate(page, 2);
  await page.locator('#hide-a').click(); await page.locator('#offscreen-b').click(); await resume(page).click();
  await expect(page.locator('[data-needmark] [data-hint]')).toContainText('2件を選択');
  await page.getByRole('button', { name: '選択を完了', exact: true }).click(); await page.getByLabel('コメント本文').fill('不可視の対象も黙って別の場所に割り当てない');
  await expect(page.getByRole('button', { name: '画像なしで保存する', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled(); await expect(page.getByLabel('コメント本文')).toHaveValue('不可視の対象も黙って別の場所に割り当てない');
  await page.getByRole('button', { name: '画像なしで保存する', exact: true }).click(); await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click(); expect(await stored()).toHaveLength(2);
});

test('exact SPA, query and hash changes and explicit discard, mode, list and hide actions end retained selections', async ({ page }) => {
  await fixture(page); await configure(page);
  await choose(page, ['target-a']); await page.evaluate(() => history.pushState({}, '', '/?selection=changed'));
  await expect(page.locator('[data-needmark] .cover')).toBeHidden(); await expect(outlines(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
  for (const id of ['push-route', 'query-route', 'hash-route']) {
    await page.goto('/'); await choose(page, ['target-a']); await operate(page, 1); await page.locator(`#${id}`).click();
    await expect(resume(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
    await expect(page.getByText('ページのURLが変わったため、保持していた選択を終了しました。', { exact: true })).toBeVisible();
    await choose(page, ['target-b']); await save(page, `URL変更後の新規対象 ${id}`);
    const item = (await stored()).find((item) => item.comment.endsWith(id))!; expect(item.url).toBe(page.url()); expect(item.target.code?.elements.map((element) => element.attributes.id)).toEqual(['target-b']);
  }
  for (const action of ['discard', 'list', 'hide']) {
    await page.goto('/'); await choose(page, ['target-a']); await operate(page, 1);
    if (action === 'discard') await page.getByRole('button', { name: '選択を破棄', exact: true }).click();
    else if (action === 'list') { await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); }
    else { await page.keyboard.press('Shift+H'); await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeHidden(); await page.keyboard.press('Shift+H'); }
    await expect(resume(page)).toHaveCount(0); await choose(page, ['target-b']); await expect(outlines(page)).toHaveCount(1); await page.keyboard.press('Escape');
  }
  expect(await stored()).toHaveLength(3);
});

test('ended native sharing asks again, cancellation retains original selections and late permission cannot revive a discarded session', async ({ page }) => {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const devices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    const pending = new Map<number, (stream: MediaStream) => void>();
    const state: PermissionState = { devices, streams: [], tracks: [], requests: 0, deliver(index) { pending.get(index)!(state.streams[index]!); pending.delete(index); } };
    Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: () => {
      const index = state.requests++, stream = canvas.captureStream(); state.streams.push(stream);
      const track = stream.getVideoTracks()[0]!; state.tracks.push(track);
      Object.defineProperty(track, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
      return index === 0 && !state.deferInitial ? Promise.resolve(stream) : new Promise<MediaStream>((resolve) => { pending.set(index, resolve); });
    } });
    HTMLMediaElement.prototype.play = () => Promise.resolve(); (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission = state;
  });
  await fixture(page); await configure(page, 'tab');
  const deviceEvidence = await page.evaluate(() => {
    const state = (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission;
    return { sameDevices: navigator.mediaDevices === state.devices, ownDisplayOverride: Object.hasOwn(navigator.mediaDevices, 'getDisplayMedia'), requests: state.requests };
  });
  await test.info().attach('native-device-before-start.json', { body: JSON.stringify(deviceEvidence, null, 2), contentType: 'application/json' });
  expect(deviceEvidence).toEqual({ sameDevices: true, ownDisplayOverride: true, requests: 0 });
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.requests)).toBe(1);
  const trackEvidence = await page.evaluate(() => {
    const state = (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission;
    return { requests: state.requests, tracks: state.streams.map((stream, index) => { const current = stream.getVideoTracks()[0]!;
      return { sameWrapper: current === state.tracks[index], currentSettings: current.getSettings(), storedSettings: state.tracks[index]!.getSettings(),
        currentState: current.readyState, currentId: current.id, storedId: state.tracks[index]!.id,
        handle: (current as MediaStreamTrack & { getCaptureHandle?: () => unknown }).getCaptureHandle?.() }; }) };
  });
  await test.info().attach('native-initial-track.json', { body: JSON.stringify(trackEvidence, null, 2), contentType: 'application/json' });
  expect(trackEvidence.requests).toBe(1); expect(trackEvidence.tracks[0]!.currentSettings.displaySurface).toBe('browser'); expect(trackEvidence.tracks[0]!.sameWrapper).toBe(true); expect(trackEvidence.tracks[0]!.currentState).toBe('live');
  for (const [index, id] of ['target-a', 'target-b'].entries()) { const r = (await page.locator(`#${id}`).boundingBox())!; if (!index) await page.keyboard.down('Shift'); await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2); if (!index) await page.keyboard.up('Shift'); }
  await expect(page.getByRole('button', { name: 'ページを操作', exact: true })).toBeVisible();
  await expect(outlines(page)).toHaveCount(2); await operate(page, 2);
  await page.locator('#host-counter').click(); expect(await page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.requests)).toBe(1);
  const end = () => page.evaluate(() => { const state = (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission; const track = state.streams.at(-1)!.getVideoTracks()[0]!; track.stop(); track.dispatchEvent(new Event('ended')); });
  await end(); await resume(page).click(); await expect(page.getByRole('heading', { name: 'このタブの撮影を開始', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click(); await expect(resume(page)).toHaveText('選択を再開 · 2件');
  await expect(page.getByText('撮影の再開をキャンセルしました。選択は保持しています。', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.deliver(1));
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.streams[1]!.getTracks().map((track) => track.readyState))).toEqual(['ended']);
  await expect(page.locator('[data-needmark] .cover')).toBeHidden(); await expect(resume(page)).toHaveText('選択を再開 · 2件');
  await resume(page).click(); await expect.poll(() => page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.requests)).toBe(3);
  await page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.deliver(2)); await expect(outlines(page)).toHaveCount(2);
  await operate(page, 2); await end(); await resume(page).click(); await expect.poll(() => page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.requests)).toBe(4);
  await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.deliver(3));
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.streams[3]!.getTracks().map((track) => track.readyState))).toEqual(['ended']);
  await expect(resume(page)).toHaveCount(0); await expect(page.locator('[data-needmark] .cover')).toBeHidden(); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible(); expect(await stored()).toEqual([]);
  // An initial sharing request has no retained selection; leaving it must invalidate its late result too.
  for (const action of ['list', 'settings', 'hide', 'route']) {
    await page.goto('/'); await page.evaluate(() => { (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.deferInitial = true; });
    await page.getByRole('button', { name: 'コメント', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'このタブの撮影を開始', exact: true })).toBeVisible();
    if (action === 'list') { await page.getByRole('button', { name: 'コメント一覧', exact: true }).click(); await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible(); }
    else if (action === 'settings') { await page.getByRole('button', { name: '設定', exact: true }).click(); await expect(page.getByLabel('キャプチャ方式')).toBeVisible(); }
    else if (action === 'hide') { await page.keyboard.press('Shift+H'); await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeHidden(); }
    else await page.locator('#push-route').click();
    await page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.deliver(0));
    await expect.poll(() => page.evaluate(() => (window as unknown as { pageOperationPermission: PermissionState }).pageOperationPermission.streams[0]!.getTracks().map((track) => track.readyState))).toEqual(['ended']);
    await expect(page.locator('[data-needmark] .cover')).toBeHidden(); await expect(outlines(page)).toHaveCount(0); await expect(resume(page)).toHaveCount(0);
    if (action === 'list') await expect(page.getByRole('button', { name: 'キーワード検索', exact: true })).toBeVisible();
    else if (action === 'settings') await expect(page.getByLabel('キャプチャ方式')).toBeVisible();
    else if (action === 'hide') { await page.keyboard.press('Shift+H'); await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible(); }
  }
  expect(await stored()).toEqual([]);
});

test('page operation respects composing keys and disabled global shortcuts and cannot replace an unsaved composer', async ({ page }) => {
  await fixture(page); await configure(page); await choose(page, ['target-a']); await operate(page, 1);
  await page.locator('#host-counter').focus();
  await page.locator('#host-counter').evaluate((node) => { for (const key of ['C', 'P', 'H']) node.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, isComposing: true, bubbles: true, composed: true, cancelable: true })); });
  await expect(resume(page)).toHaveText('選択を再開 · 1件'); expect((await host(page)).keys.filter((event) => event.composing).map((event) => event.prevented)).toEqual([false, false, false]);
  await configure(page, 'none', false); await expect(resume(page)).toHaveCount(0); await choose(page, ['target-b']); await operate(page, 1);
  await page.locator('#host-counter').focus(); for (const key of ['Shift+C', 'Shift+P', 'Shift+H']) await page.keyboard.press(key);
  await expect(resume(page)).toHaveText('選択を再開 · 1件'); expect((await host(page)).keys.slice(-3).map((event) => event.prevented)).toEqual([false, false, false]);
  await expect(page.getByRole('button', { name: 'アニメーションを停止', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await resume(page).click(); await page.getByRole('button', { name: '選択を完了', exact: true }).click(); await page.getByLabel('コメント本文').fill('未保存のコメントを保持する');
  await expect(page.getByRole('button', { name: 'ページを操作', exact: true })).toBeHidden(); await expect(resume(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await expect(page.getByLabel('コメント本文')).toHaveValue('未保存のコメントを保持する');
  await expect(page.getByLabel('コメント本文')).toBeVisible(); expect(await stored()).toEqual([]);
});

test('a narrow viewport supports actual operation, resume, completion and discard clicks without losing selected targets', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 850 });
  await fixture(page); await configure(page); await choose(page); await operate(page, 2);
  await page.locator('#host-counter').click(); await expect(page.locator('#counter-value')).toHaveText('1');
  await resume(page).click(); await expect(outlines(page)).toHaveCount(2);
  await save(page, '狭い画面でもページを操作してから選択を保存する');
  const items = await stored(); expect(items).toHaveLength(1); expect(items[0]!.target.code?.elements.map((element) => element.attributes.id)).toEqual(['target-a', 'target-b']);
  await choose(page, ['target-a']); await operate(page, 1);
  await page.getByRole('button', { name: '選択を破棄', exact: true }).click(); await expect(resume(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await expect(page.locator('[data-needmark] [data-hint]')).toHaveText('クリック・ドラッグで選択');
  await page.keyboard.press('Escape'); expect(await stored()).toHaveLength(1);
});
