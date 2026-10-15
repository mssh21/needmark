import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
const widget = (page: Page) => page.locator('[data-needmark]');
const inheritedTypography = 'font-family:monospace;font-size:24px;font-weight:900;font-style:italic;letter-spacing:.15em;word-spacing:.3em;text-transform:uppercase;text-indent:64px;text-align:right;direction:rtl;white-space:nowrap';
const clientSamples = ['label[for="nm-author"]', '#nm-author', '.panel .mono', '[data-action="settings-save"]', '[data-hint]', '.dock button', '.badge'];

async function typography(root: Locator, selectors: string[]) {
  return root.evaluate((node, selectors) => Object.fromEntries(selectors.map((selector) => {
    const element = (node.shadowRoot ?? node).querySelector(selector)!;
    const style = getComputedStyle(element);
    return [selector, Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'direction', 'whiteSpace'].map((key) => [key, style[key as keyof CSSStyleDeclaration]]))];
  })), selectors);
}
async function prepare(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('needmark-configured', 'true'); localStorage.setItem('needmark-method', 'none'); localStorage.setItem('needmark-language', 'en');
  });
  await page.goto('/');
  await page.evaluate(() => {
    const probe = document.createElement('p'); probe.id = 'app-typography-probe'; probe.textContent = 'Host typography stays unchanged'; document.body.append(probe);
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}
async function sourceTypography(page: Page) {
  return typography(page.locator('body'), ['#app-typography-probe']);
}
async function evidence(page: Page, info: TestInfo, name: string) {
  const path = `/private/tmp/needmark-style-evidence/${info.project.name}-${name}.png`;
  await mkdir('/private/tmp/needmark-style-evidence', { recursive: true });
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
  const metadata = await page.evaluate(() => {
    const viewport = window.visualViewport;
    const bounds = (element: Element) => {
      const rect = element.getBoundingClientRect(), left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      return { ...rect.toJSON(), inViewport: rect.right > left && rect.left < left + (viewport?.width ?? innerWidth) && rect.bottom > top && rect.top < top + (viewport?.height ?? innerHeight) };
    };
    const host = document.querySelector('[data-needmark]')!;
    return {
      scroll: { x: scrollX, y: scrollY, scrollLeft: document.documentElement.scrollLeft, width: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      viewport: { width: innerWidth, height: innerHeight, visual: viewport && { offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop, pageLeft: viewport.pageLeft, pageTop: viewport.pageTop, width: viewport.width, height: viewport.height } },
      host: bounds(host),
      ui: Object.fromEntries(['.panel:not([hidden])', '.dock:not([hidden])'].map((selector) => {
        const element = host.shadowRoot?.querySelector(selector);
        return [selector, element && bounds(element)];
      })),
    };
  });
  const metadataPath = path.replace(/\.png$/, '.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  await info.attach(`${name}-viewport`, { path: metadataPath, contentType: 'application/json' });
  for (const rect of Object.values(metadata.ui)) if (rect) expect(rect.inViewport).toBe(true);
}
async function selectTarget(page: Page, selector: string) {
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const bounds = (await page.locator(selector).boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.getByLabel('Comment text')).toBeVisible();
}
async function saved() {
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  expect(ids).toHaveLength(1);
  return JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
}

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('inherited html typography leaves review fields readable and editable while the RTL page retains its styles', async ({ page }, info) => {
  await prepare(page);
  const expected = await typography(widget(page), clientSamples);
  await page.addStyleTag({ content: `html{${inheritedTypography}}` });
  const appStyle = await sourceTypography(page), actual = await typography(widget(page), clientSamples);
  await info.attach('typography-comparison', { body: JSON.stringify({ expected, actual, appStyle }, null, 2), contentType: 'application/json' });
  expect(actual).toEqual(expected);
  expect(appStyle['#app-typography-probe']?.direction).toBe('rtl');
  await evidence(page, info, 'review-on-styled-rtl-page');
  await page.getByLabel('Author name').fill('投稿者名をそのまま残す');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await selectTarget(page, '#purchase-button');
  const comment = '日本語と MixedCase をそのまま保存する';
  await page.getByLabel('Comment text').fill(comment);
  await saveAndList(page, 'en');
  await expect(widget(page).getByRole('status')).toHaveText('Feedback saved.');
  expect(await saved()).toMatchObject({ comment, author: '投稿者名をそのまま残す', target: { selector: '#purchase-button' } });
  expect(await sourceTypography(page)).toEqual(appStyle);
  await expect(widget(page)).toHaveAttribute('lang', 'en');
});

test('body typography stays outside the review host before a native dialog and after reparenting into it', async ({ page }, info) => {
  await prepare(page);
  const expected = await typography(widget(page), clientSamples);
  await page.addStyleTag({ content: `body{${inheritedTypography}}` });
  expect(await typography(widget(page), clientSamples)).toEqual(expected);
  const appStyle = await sourceTypography(page);
  await page.evaluate(() => {
    const dialog = document.createElement('dialog'); dialog.id = 'styled-native-dialog';
    dialog.innerHTML = '<button id="app-modal-target" style="width:180px;height:60px">Modal action</button>';
    dialog.querySelector('button')!.addEventListener('click', () => { dialog.dataset.clicks = String(Number(dialog.dataset.clicks ?? 0) + 1); });
    document.body.append(dialog); dialog.showModal();
  });
  await expect(page.locator('#styled-native-dialog > [data-needmark]')).toHaveCount(1);
  const actual = await typography(widget(page), clientSamples);
  await info.attach('modal-typography-comparison', { body: JSON.stringify({ expected, actual, appStyle }, null, 2), contentType: 'application/json' });
  expect(actual).toEqual(expected);
  await evidence(page, info, 'review-in-styled-native-dialog');
  await page.getByLabel('Author name').fill('Dialog reviewer');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: 'Modal action', exact: true }).click();
  await expect(page.locator('#styled-native-dialog')).toHaveAttribute('data-clicks', '1');
  await selectTarget(page, '#app-modal-target');
  await expect(page.locator('#styled-native-dialog')).toHaveAttribute('data-clicks', '1');
  await page.getByLabel('Comment text').fill('Dialog text stays editable');
  await saveAndList(page, 'en');
  await expect(widget(page).getByRole('status')).toHaveText('Feedback saved.');
  expect((await saved()).target.selector).toBe('#app-modal-target');
  expect(await sourceTypography(page)).toEqual(appStyle);
  await page.evaluate(() => (document.querySelector('#styled-native-dialog') as HTMLDialogElement).close());
  await expect(page.locator('html > [data-needmark]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await typography(widget(page), clientSamples)).toEqual(expected);
});

test('global important div rules preserve page clicks while selection still intercepts them', async ({ page }, info) => {
  await prepare(page);
  const expected = await typography(widget(page), clientSamples);
  await page.addStyleTag({ content: `div{${inheritedTypography.split(';').map((value) => `${value}!important`).join(';')};pointer-events:auto!important}` });
  const appStyle = await sourceTypography(page), actual = await typography(widget(page), clientSamples);
  const pointerEvents = await widget(page).evaluate((node) => getComputedStyle(node).pointerEvents);
  await info.attach('global-rule-comparison', { body: JSON.stringify({ expected, actual, pointerEvents }, null, 2), contentType: 'application/json' });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  const appBounds = (await page.locator('#purchase-button').boundingBox())!;
  await page.mouse.click(appBounds.x + appBounds.width / 2, appBounds.y + appBounds.height / 2);
  await expect(page.locator('#purchase-status')).toHaveText('Trial reserved. Check your inbox for the setup link.');
  expect(pointerEvents).toBe('none'); expect(actual).toEqual(expected);
  await page.evaluate(() => { document.querySelector('#purchase-status')!.textContent = ''; });
  await selectTarget(page, '#purchase-button');
  await expect(page.locator('#purchase-status')).toHaveText('');
  await page.getByLabel('Comment text').fill('Selection blocks the application action');
  await saveAndList(page, 'en');
  await expect(widget(page).getByRole('status')).toHaveText('Feedback saved.');
  expect((await saved()).target.selector).toBe('#purchase-button');
  expect(await sourceTypography(page)).toEqual(appStyle);
  await evidence(page, info, 'review-under-global-important-div-rules');
});
