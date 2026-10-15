import { test, expect } from '@playwright/test';
import { readFile, readdir, rm } from 'node:fs/promises';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('native modal keeps page controls usable and review drafts through nested modal changes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('none');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name:'コメント', exact:true }).click(); const target = await page.locator('#purchase-button').boundingBox(); await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2); await page.getByLabel('コメント本文').fill('モーダルの外のコメント'); await saveAndList(page); await page.getByRole('button', { name:'パネルを閉じる' }).click();
  await page.evaluate(() => {
    const outer = document.createElement('dialog'); outer.id = 'outer-modal';
    outer.innerHTML = '<button id="modal-action" style="padding:16px 25px">Modal action</button><dialog id="inner-modal"><button>Inner action</button></dialog>';
    outer.querySelector('button')!.addEventListener('click', () => { outer.dataset.clicks = String(Number(outer.dataset.clicks ?? 0) + 1); });
    document.body.append(outer); outer.showModal();
  });
  await expect(page.locator('#outer-modal > [data-needmark]')).toHaveCount(1);
  await expect(page.getByRole('button', { name:'コメント: モーダルの外のコメント', exact:true })).toBeHidden();
  await expect.poll(() => page.locator('[data-needmark]').evaluate((host) => host.matches(':popover-open'))).toBe(true);
  await page.getByRole('button', { name: 'Modal action', exact: true }).click();
  await expect(page.locator('#outer-modal')).toHaveAttribute('data-clicks', '1');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const bounds = await page.locator('#modal-action').boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.getByLabel('コメント本文').fill('modal内の余白を小さくする');
  await expect(page.getByLabel('コメント本文')).toBeFocused();
  await expect(page.locator('#outer-modal')).toHaveAttribute('data-clicks', '1');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('コメント本文')).toBeHidden();
  await expect(page.locator('#outer-modal')).toHaveJSProperty('open', true);
  await page.evaluate(() => (document.querySelector('#inner-modal') as HTMLDialogElement).showModal());
  await expect(page.locator('#inner-modal > [data-needmark]')).toHaveCount(1);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByLabel('キャプチャ方式')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#inner-modal')).toHaveJSProperty('open', true);
  await page.evaluate(() => (document.querySelector('#inner-modal') as HTMLDialogElement).close());
  await expect(page.locator('#outer-modal > [data-needmark]')).toHaveCount(1);
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.getByLabel('コメント本文').fill('移動しても下書きを保持する');
  await page.evaluate(() => (document.querySelector('#outer-modal') as HTMLDialogElement).close());
  await expect(page.locator('html > [data-needmark]')).toHaveCount(1);
  await expect(page.getByRole('button', { name:'コメント: モーダルの外のコメント', exact:true })).toBeVisible();
  await expect(page.getByLabel('コメント本文')).toHaveValue('移動しても下書きを保持する');
  await saveAndList(page);
  await expect(page.getByRole('article').filter({ hasText: '移動しても下書きを保持する' }).getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name:'コメント: 移動しても下書きを保持する', exact:true })).toBeHidden();
});

test('DOM capture preserves a native modal target and redaction while excluding review controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('dom');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.evaluate(() => {
    const dialog = document.createElement('dialog'); dialog.id = 'capture-modal';
    dialog.style.cssText = 'padding:28px;width:440px;border:3px solid rgb(80,90,100);background:rgb(245,242,235)';
    dialog.innerHTML = '<button id="modal-capture-target" style="display:block;padding:20px 30px;border:0;border-radius:0;background:rgb(24,120,180);color:white">Modal capture target</button><div id="modal-sensitive" data-needmark-redact style="width:100px;height:35px;margin-top:20px;background:rgb(230,20,60)">PRIVATE</div>';
    document.body.append(dialog); dialog.showModal();
  });
  await expect(page.locator('#capture-modal > [data-needmark]')).toHaveCount(1);
  const bounds = await page.locator('#modal-capture-target').boundingBox();
  const sensitive = await page.locator('#modal-sensitive').boundingBox();
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.getByLabel('コメント本文').fill('modalボタンの余白を修正');
  await saveAndList(page);
  await expect(page.getByRole('button', { name: '解決にする', exact: true })).toBeVisible();
  const entries = (await readdir(output)).filter((id) => !id.startsWith('.'));
  const saved = JSON.parse(await readFile(`${output}/${entries[0]}/context.json`, 'utf8')) as Feedback;
  expect(saved.target.selector).toBe('#modal-capture-target');
  const image = await readFile(`${output}/${saved.id}/screenshot.png`);
  const colors = await page.evaluate(async ({ png, bounds, sensitive, viewport }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const color = (x: number, y: number) => Array.from(context.getImageData(Math.floor(x * image.width / viewport.width), Math.floor(y * image.height / viewport.height), 1, 1).data).slice(0, 3);
    return {
      target: color(bounds.x + 10, bounds.y + bounds.height / 2),
      mask: color(sensitive.x + sensitive.width / 2, sensitive.y + sensitive.height / 2),
      border: color(bounds.x, bounds.y + bounds.height / 2),
    };
  }, { png: image.toString('base64'), bounds: bounds!, sensitive: sensitive!, viewport: saved.viewport });
  expect(colors.target).toEqual([24, 120, 180]);
  expect(colors.mask).toEqual([46, 49, 52]);
  expect(colors.border).toEqual([25, 101, 227]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#capture-modal')).toHaveJSProperty('open', true);
});
