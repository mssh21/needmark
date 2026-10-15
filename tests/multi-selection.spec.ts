import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Feedback, Rectangle } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
const outlines = (page: Page) => page.locator('[data-needmark] .selected-outline');
const cover = (page: Page) => page.locator('[data-needmark] .cover');
const field = (page: Page) => page.getByLabel('コメント本文');

async function fixture(page: Page, method: 'none' | 'dom' = 'none') {
  const html = await readFile(resolve('tests/fixtures/multi-selection.html'), 'utf8');
  await page.addInitScript((capture) => {
    localStorage.setItem('needmark-configured', 'true'); localStorage.setItem('needmark-method', capture);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } });
  }, method);
  await page.route('http://127.0.0.1:4192/', async (route) => {
    const response = await route.fetch();
    const script = (await response.text()).match(/<script\b[^>]*data-needmark-token=[^>]*>[\s\S]*?<\/script>/)?.[0];
    if (!script) throw new Error('The fixture requires the real protected widget script');
    const closing = '</body>\n</html>';
    if (!html.trimEnd().endsWith(closing) || html.split(closing).length !== 2) throw new Error('The fixture requires one final outer body');
    await route.fulfill({ response, body: html.replace(closing, `${script}${closing}`) });
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'コメント', exact: true })).toBeVisible();
  await expect(page.frameLocator('#review-frame').locator('#frame-review')).toBeVisible();
}
// Multiple selection starts with a Shift gesture, so the first gesture after begin() holds Shift and later ones add plainly.
let shiftNext = false;
async function firstShift(page: Page, gesture: () => Promise<void>) { if (!shiftNext) return gesture(); shiftNext = false; await page.keyboard.down('Shift'); await gesture(); await page.keyboard.up('Shift'); }
async function begin(page: Page, mode: '複数要素' | '要素・範囲' = '複数要素') {
  // The comment button toggles selection off, so a running selection is ended first to start a fresh one.
  if (await cover(page).isVisible()) { await page.keyboard.press('Escape'); await expect(cover(page)).toBeHidden(); }
  await page.getByRole('button', { name: 'コメント', exact: true }).click(); await expect(cover(page)).toBeVisible();
  shiftNext = mode === '複数要素';
}
async function drag(page: Page, from: [number, number], to: [number, number], release = true) {
  await page.mouse.move(...from); await firstShift(page, () => page.mouse.down()); await page.mouse.move(...to, { steps: 4 });
  if (release) await page.mouse.up();
}
async function click(page: Page, id: string) {
  const rect = (await page.locator(`#${id}`).boundingBox())!;
  await firstShift(page, () => page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2));
}
async function selected(page: Page, ids: string[]) {
  await expect(outlines(page)).toHaveCount(ids.length);
  const expected = await Promise.all(ids.map((id) => page.locator(`#${id}`).boundingBox()));
  await expect.poll(() => outlines(page).evaluateAll((nodes) => nodes.map((node) => {
    const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }))).toEqual(expected);
}
async function save(page: Page, comment: string) {
  await page.getByRole('button', { name: '選択を完了', exact: true }).click(); await field(page).fill(comment);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  return stored(comment);
}
async function stored(comment: string): Promise<Feedback> {
  const items = await Promise.all((await readdir(output)).filter((id) => !id.startsWith('.')).map(async (id) => JSON.parse(await readFile(`${output}/${id}/context.json`, 'utf8')) as Feedback));
  const item = items.find((value) => value.comment === comment); if (!item) throw new Error('The saved review is missing'); return item;
}
const idsOf = (item: Feedback) => item.target.code?.elements.map((element) => element.attributes.id);
function union(rects: Rectangle[]): Rectangle {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
}
async function screenshot(page: Page, info: TestInfo, name: string) { await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' }); }
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await screenshot(page, info, 'actual-multi-selection');
  await info.attach('selection-state', { body: JSON.stringify(await page.evaluate(() => {
    const root = document.querySelector('[data-needmark]')?.shadowRoot;
    return { coverHidden: root?.querySelector<HTMLElement>('.cover')?.hidden, hint: root?.querySelector('[data-hint]')?.textContent,
      rectangles: Array.from(root?.querySelectorAll('.selected-outline') ?? [], (node) => node.getBoundingClientRect().toJSON()),
      composer: root?.querySelector<HTMLTextAreaElement>('#nm-comment')?.value };
  }), null, 2), contentType: 'application/json' });
});

test('explicit multi drag selects the whole forward and reverse rectangle, accepts partial overlap and ignores boundaries and empty space', async ({ page }, info) => {
  await fixture(page);
  for (const reverse of [false, true]) {
    await begin(page); await drag(page, reverse ? [500, 250] : [80, 160], reverse ? [80, 160] : [500, 250]);
    await screenshot(page, info, reverse ? 'reverse-marquee' : 'forward-marquee');
    await selected(page, ['target-a', 'target-b']); await expect(field(page)).toHaveCount(0);
  }
  await drag(page, [20, 380], [70, 420]); await selected(page, ['target-a', 'target-b']);
  await drag(page, [420, 160], [500, 250]); await selected(page, ['target-a', 'target-b']);
  await drag(page, [645, 175], [655, 185]); await selected(page, ['target-a', 'target-b', 'partial']);
  await click(page, 'target-a'); await selected(page, ['target-b', 'partial']);
  const item = await save(page, '触れているだけの境界と空白を含めず、部分的に重なった対象を直す');
  expect(item.target.kind).toBe('multi'); expect(idsOf(item)).toEqual(['target-b', 'partial']);
});

test('semantic batch deduplication retains every target and additive drags do not toggle previous selections', async ({ page }) => {
  await fixture(page); await begin(page);
  await firstShift(page, () => page.mouse.click(555, 305)); await selected(page, ['semantic-list']);
  await drag(page, [80, 280], [750, 370]);
  await selected(page, ['semantic-list', 'semantic-button', 'semantic-paragraph', 'semantic-child']);
  await drag(page, [80, 280], [750, 370]);
  await selected(page, ['semantic-list', 'semantic-button', 'semantic-paragraph', 'semantic-child']);
  await click(page, 'target-a'); await drag(page, [80, 280], [750, 370]);
  await selected(page, ['semantic-list', 'semantic-button', 'semantic-paragraph', 'semantic-child', 'target-a']);
  expect(idsOf(await save(page, '前に明示した親と、新しい範囲で選んだ意味のある対象を保持する'))).toEqual(['semantic-list', 'semantic-button', 'semantic-paragraph', 'semantic-child', 'target-a']);
  await begin(page); await drag(page, [20, 460], [1100, 560]);
  const ids = Array.from({ length: 13 }, (_, index) => `cap-${index + 1}`); await selected(page, ids);
  await expect(page.locator('[data-needmark] [data-hint]')).toContainText('13件を選択');
  expect(idsOf(await save(page, '入れ子のspanを重複させず、すべての13ボタンを保存する'))).toEqual(ids);
});

test('marquee originals save current union geometry, actual DOM PNG pixels and complete local AI handoff', async ({ page }, info) => {
  await fixture(page, 'dom'); await begin(page); await drag(page, [80, 160], [500, 250]); await selected(page, ['target-a', 'target-b']);
  await page.locator('#move-originals').evaluate((button) => (button as HTMLButtonElement).click()); await selected(page, ['target-a', 'target-b']);
  await drag(page, [645, 175], [655, 185]); await selected(page, ['target-a', 'target-b', 'partial']);
  const current = await Promise.all(['target-a', 'target-b', 'partial'].map(async (id) => (await page.locator(`#${id}`).boundingBox())!));
  const item = await save(page, '移動後の3箇所の整列を画像と対象情報に基づいて直す');
  expect(item.target.rect).toEqual(union(current)); expect(item.target.code?.elements.map((element) => element.rect)).toEqual(current);
  expect(idsOf(item)).toEqual(['target-a', 'target-b', 'partial']); expect(item.capture.method).toBe('dom');
  const png = await readFile(`${output}/${item.id}/screenshot.png`);
  const pixels = await page.evaluate(async ({ src, rectangle, target, viewport }) => {
    const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const color = (x: number, y: number) => Array.from(context.getImageData(Math.round(x * image.width / viewport.width), Math.round(y * image.height / viewport.height), 1, 1).data);
    return { width: image.width, height: image.height, target: color(target.x + 10, target.y + 25), previous: color(120, 210), outline: color(rectangle.x, rectangle.y + 25) };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, rectangle: item.target.rect, target: current[0]!, viewport: item.viewport });
  expect(pixels.target).toEqual([12, 174, 93, 255]); expect(pixels.previous).toEqual([255, 255, 255, 255]); expect(pixels.outline).toEqual([25, 101, 227, 255]);
  expect(item.capture).toMatchObject({ width: pixels.width, height: pixels.height });
  await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  const prompt = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  for (const value of [item.id, '#target-a', '#target-b', '#partial', 'screenshot.png', 'context.json']) expect(prompt).toContain(value);
  await screenshot(page, info, 'saved-marquee-local-handoff');
});

test('Shift is fixed at gesture onset while normal area, Alt text drags and drag cancellation remain distinct', async ({ page }) => {
  await fixture(page); await begin(page, '要素・範囲'); await page.keyboard.down('Shift');
  await drag(page, [80, 160], [500, 250], false); await page.keyboard.press('Enter');
  await expect(cover(page)).toBeVisible(); await expect(field(page)).toHaveCount(0);
  await page.keyboard.up('Shift'); await page.mouse.up();
  await selected(page, ['target-a', 'target-b']); expect((await save(page, '開始時のShiftで複数選択する')).target.kind).toBe('multi');
  await begin(page, '要素・範囲'); await drag(page, [80, 160], [500, 250], false); await page.keyboard.down('Shift'); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(field(page)).toBeVisible(); await field(page).fill('終了時だけのShiftで範囲を複数選択に変更しない');
  await saveAndList(page); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  expect((await stored('終了時だけのShiftで範囲を複数選択に変更しない')).target.kind).toBe('area');
  await begin(page); await click(page, 'target-a'); await drag(page, [280, 160], [450, 250], false);
  await page.keyboard.press('Escape'); await page.mouse.up(); await selected(page, ['target-a']); await expect(field(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(cover(page)).toBeHidden();
  await begin(page, '要素・範囲'); await expect(outlines(page)).toHaveCount(0);
  await page.keyboard.down('Alt'); await drag(page, [314, 323], [425, 323]); await page.keyboard.up('Alt');
  await expect(field(page)).toBeVisible(); await field(page).fill('明示したテキストモードで文字だけを直す');
  await saveAndList(page); await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const text = await stored('明示したテキストモードで文字だけを直す'); expect(text.target.kind).toBe('text'); expect(text.target.text.length).toBeGreaterThan(1);
  expect(await page.locator('#semantic-paragraph').textContent()).toContain(text.target.text);
});

test('secondary pointers and Enter cannot commit a primary marquee and every cancellation preserves the prior batch and releases capture', async ({ page }) => {
  await fixture(page);
  await cover(page).evaluate((node) => node.addEventListener('pointerdown', (event) => {
    if ((event as PointerEvent).isPrimary) (window as unknown as { reviewPointer: number }).reviewPointer = (event as PointerEvent).pointerId;
  }));
  await begin(page); await click(page, 'target-a'); await drag(page, [280, 160], [450, 250], false);
  const pointer = await page.evaluate(() => (window as unknown as { reviewPointer: number }).reviewPointer);
  expect(await cover(page).evaluate((node, id) => node.hasPointerCapture(id), pointer)).toBe(true);
  await cover(page).evaluate((node, id) => {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id + 10, pointerType: 'touch', isPrimary: false, button: 0, buttons: 1, clientX: 700, clientY: 200 }));
  }, pointer);
  expect(await cover(page).evaluate((node, id) => node.hasPointerCapture(id), pointer)).toBe(true); await selected(page, ['target-a']);
  await page.keyboard.press('Enter'); await expect(field(page)).toHaveCount(0); await selected(page, ['target-a']);
  await page.mouse.up(); await selected(page, ['target-a', 'target-b']);
  for (const cancellation of ['pointercancel', 'lostpointercapture', 'Escape']) {
    await begin(page); await click(page, 'target-a'); await drag(page, [280, 160], [450, 250], false);
    const id = await page.evaluate(() => (window as unknown as { reviewPointer: number }).reviewPointer);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else await cover(page).evaluate((node, data) => node.dispatchEvent(new PointerEvent(data.type, { bubbles: true, pointerId: data.id, isPrimary: true, button: 0 })), { type: cancellation, id });
    expect(await cover(page).evaluate((node, active) => node.hasPointerCapture(active), id)).toBe(false);
    await page.mouse.up(); await selected(page, ['target-a']); await expect(field(page)).toHaveCount(0); await expect(cover(page)).toBeVisible();
    await page.keyboard.press('Escape'); await expect(cover(page)).toBeHidden(); await expect(outlines(page)).toHaveCount(0);
  }
});

test('marquee traverses open roots, selects only visible frame content and excludes the NeedMark while retaining full target geometry', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { for (const id of ['basic', 'semantic', 'caps', 'host-controls']) document.getElementById(id)!.hidden = true; });
  await begin(page); await drag(page, [830, 160], [1190, 835]); await expect(outlines(page)).toHaveCount(3);
  const item = await save(page, 'Shadowとiframeの見えている対象だけを修正する');
  expect(idsOf(item)).toEqual(['shadow-review', 'frame-review', 'frame-partial']);
  expect(item.target.code?.elements.map((element) => element.rootPath)).toEqual([['shadow: #review-shadow'], ['iframe: #review-frame'], ['iframe: #review-frame']]);
  expect(item.target.code?.elements[2]?.rect).toMatchObject({ x: 882, y: 422, width: 140, height: 45 });
  await begin(page);
  await page.evaluate(() => { document.getElementById('review-shadow')!.hidden = true; document.getElementById('review-frame')!.style.top = '900px'; });
  await drag(page, [830, 160], [1190, 835]); await expect(outlines(page)).toHaveCount(0); await expect(field(page)).toHaveCount(0);
  await page.evaluate(() => { document.getElementById('review-frame')!.style.top = '300px'; document.getElementById('roots')!.style.opacity = '0'; });
  await drag(page, [830, 160], [1190, 835]); await expect(outlines(page)).toHaveCount(0); await expect(field(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(cover(page)).toBeHidden();
  await page.evaluate(() => {
    let host = document.createElement('div'); host.id = 'depth-1'; host.style.cssText = 'position:fixed;left:50px;top:100px;width:420px;height:60px'; document.body.append(host);
    for (let depth = 1; depth <= 8; depth++) {
      const root = host.attachShadow({ mode: 'open' });
      if (depth === 8) {
        const leaf = document.createElement('button'); leaf.id = 'depth-eight-leaf'; leaf.textContent = 'Depth eight'; leaf.style.cssText = 'position:absolute;left:0;top:0;width:120px;height:60px'; root.append(leaf);
        const deeper = document.createElement('div'); deeper.id = 'depth-9'; deeper.style.cssText = 'position:absolute;left:150px;top:0;width:120px;height:60px'; root.append(deeper);
        deeper.attachShadow({ mode: 'open' }).innerHTML = '<button id="depth-nine-leaf" style="width:120px;height:60px">Depth nine</button>'; break;
      }
      const child = document.createElement('div'); child.id = `depth-${depth + 1}`; child.style.cssText = 'width:100%;height:100%'; root.append(child); host = child;
    }
    const foreign = document.createElement('div'); foreign.id = 'other-kit'; foreign.dataset.needmark = ''; foreign.style.cssText = 'position:fixed;left:350px;top:100px;width:120px;height:60px'; document.body.append(foreign);
    foreign.attachShadow({ mode: 'open' }).innerHTML = '<button id="other-kit-control" style="width:120px;height:60px">Other NeedMark</button>';
    for (const id of ['depth-eight-leaf', 'depth-nine-leaf', 'other-kit-control']) {
      const find = (root: Document | ShadowRoot): Element | undefined => { for (const node of root.querySelectorAll('*')) { if (node.id === id) return node; if (node.shadowRoot) { const child = find(node.shadowRoot); if (child) return child; } } };
      find(document)!.addEventListener('click', (event) => { (event.currentTarget as HTMLElement).dataset.clicks = '1'; });
    }
  });
  for (const id of ['depth-eight-leaf', 'depth-nine-leaf', 'other-kit-control']) { await page.locator(`#${id}`).click(); await expect(page.locator(`#${id}`)).toHaveAttribute('data-clicks', '1'); }
  await begin(page); await drag(page, [40, 90], [490, 180]); await selected(page, ['depth-eight-leaf']);
  await expect(page.locator('[data-needmark]').getByRole('status')).toContainText('上限');
  const bounded = await save(page, '探索できる8段の対象だけを残し、別Kitと探索外の対象を捏造しない');
  expect(idsOf(bounded)).toEqual(['depth-eight-leaf']); expect(bounded.target.code?.elements[0]?.rootPath).toEqual(Array.from({ length: 8 }, (_, index) => `shadow: #depth-${index + 1}`));
});


test('marquee follows native rendering for positioned overflow escapes, visible overrides and genuine clipping without shrinking stored geometry', async ({ page }, info) => {
  await fixture(page);
  await page.evaluate(() => {
    for (const id of ['basic', 'semantic', 'caps', 'roots', 'host-controls']) document.getElementById(id)!.hidden = true;
    document.getElementById('positioned-cases')!.hidden = false;
  });
  for (const id of ['absolute-escape', 'fixed-escape', 'override-visible']) await page.locator(`#${id}`).click();
  await page.mouse.click(1075, 635);
  expect(await page.evaluate(() => (window as unknown as { multiNativeClicks: Record<string, number> }).multiNativeClicks)).toEqual({ 'absolute-escape': 1, 'fixed-escape': 1, 'override-visible': 1, 'overflow-partial': 1 });
  const nativePNG = await page.screenshot(); await info.attach('native-positioned-visibility', { body: nativePNG, contentType: 'image/png' });
  const colors = await page.evaluate(async (src) => {
    const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return [[270, 620], [430, 620], [560, 620], [1075, 620], [830, 620], [1120, 620]].map(([x, y]) => Array.from(context.getImageData(Math.round(x! * image.width / innerWidth), Math.round(y! * image.height / innerHeight), 1, 1).data));
  }, `data:image/png;base64,${nativePNG.toString('base64')}`);
  expect(colors).toEqual([[187, 52, 46, 255], [34, 142, 75, 255], [178, 101, 28, 255], [32, 117, 193, 255], [255, 255, 255, 255], [255, 255, 255, 255]]);
  await begin(page); await drag(page, [240, 580], [1190, 700]);
  const ids = ['absolute-escape', 'fixed-escape', 'override-visible', 'overflow-partial']; await selected(page, ids);
  const rectangles = await Promise.all(ids.map(async (id) => (await page.locator(`#${id}`).boundingBox())!));
  const item = await save(page, '実際に見える配置対象をコメントし、切り取られた元要素の完全な寸法を残す');
  expect(idsOf(item)).toEqual(ids); expect(item.target.rect).toEqual(union(rectangles)); expect(item.target.code?.elements.map((element) => element.rect)).toEqual(rectangles);
  expect(item.target.code?.elements[3]?.rect).toMatchObject({ x: 1070, y: 610, width: 80, height: 50 });
  await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.style.cssText = 'height:100%;overflow-y:scroll'; document.body.style.minHeight = '2000px';
    const target = document.createElement('button'); target.id = 'scrolled-root'; target.textContent = 'Scrolled root'; target.style.cssText = 'position:relative;left:200px;width:100px;height:50px'; document.body.append(target);
    target.style.top = `${1000 - target.getBoundingClientRect().top}px`; target.onclick = () => { target.dataset.clicks = '1'; };
    document.getElementById('roots')!.hidden = false;
    const frame = document.getElementById('review-frame') as HTMLIFrameElement; frame.style.position = 'fixed'; frame.style.top = '300px';
    const child = frame.contentDocument!; child.documentElement.style.cssText = 'height:100%;overflow-y:scroll'; child.body.style.minHeight = '900px';
    const button = child.createElement('button'); button.id = 'scrolled-frame'; button.textContent = 'Scrolled frame'; button.style.cssText = 'position:relative;left:30px;top:370px;width:140px;height:45px'; child.body.append(button); button.onclick = () => { button.dataset.clicks = '1'; };
    window.scrollTo(0, 800); child.defaultView!.scrollTo(0, 300);
  });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(800);
  await expect.poll(() => page.locator('#review-frame').evaluate((node) => (node as HTMLIFrameElement).contentWindow!.scrollY)).toBe(300);
  await page.locator('#scrolled-root').click(); await page.frameLocator('#review-frame').locator('#scrolled-frame').click();
  await expect(page.locator('#scrolled-root')).toHaveAttribute('data-clicks', '1'); await expect(page.frameLocator('#review-frame').locator('#scrolled-frame')).toHaveAttribute('data-clicks', '1');
  const scrolled = [(await page.frameLocator('#review-frame').locator('#scrolled-frame').boundingBox())!, (await page.locator('#scrolled-root').boundingBox())!];
  expect(scrolled[0]!.y).toBe(372); expect(scrolled[1]!.y).toBe(200);
  await screenshot(page, info, 'native-scrolled-document-and-frame');
  await begin(page); await drag(page, [180, 180], [1100, 450]); await expect(outlines(page)).toHaveCount(2);
  const scrollItem = await save(page, '親と子のページをスクロールしても、現在見える元の対象をコメントする');
  expect(idsOf(scrollItem)).toEqual(['scrolled-frame', 'scrolled-root']); expect(scrollItem.target.code?.elements.map((element) => element.rect)).toEqual(scrolled); expect(scrollItem.target.rect).toEqual(union(scrolled));
  expect(scrollItem.target.code?.elements[0]?.rootPath).toEqual(['iframe: #review-frame']);
});
