import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Feedback } from '../src/shared/types.js';
import { saveAndList } from './save.js';

const output = '/private/tmp/needmark-e2e-feedback';
type Fixture = {
  counts: { timeout: number; interval: number; frame: number; kept: number; canceled: number };
  appAnimation: Animation; priorPaused: Animation; widgetAnimation: Animation;
  canceled: number;
};
async function state(page: Page) {
  return page.evaluate(() => {
    const fixture = (window as unknown as { pauseFixture: Fixture }).pauseFixture;
    return { counts: { ...fixture.counts }, time: fixture.appAnimation.currentTime,
      widgetTime: fixture.widgetAnimation.currentTime, priorState: fixture.priorPaused.playState,
      priorTime: fixture.priorPaused.currentTime };
  });
}

test.beforeEach(async () => { await rm(output, { recursive: true, force: true }); });

test('pause freezes CSS, page loops and WAAPI, keeps the widget/capture/poll live, and resumes cancelable work', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('キャプチャ方式').selectOption('dom');
  await page.getByRole('button', { name: '設定を保存' }).click();
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '@keyframes pause-fixture-spin{from{opacity:.2}to{opacity:1}}.pause-fixture-spin{animation:pause-fixture-spin .3s linear infinite}.pause-fixture-prior{animation-play-state:paused}.pause-fixture-transition{transition:opacity 2s linear}';
    document.head.append(style);
    const fixture = document.createElement('div'); fixture.id = 'pause-fixture';
    fixture.style.cssText = 'position:fixed;left:10px;top:100px;width:35px;height:90px;pointer-events:none';
    fixture.innerHTML = '<span class="pause-fixture-spin">CSS</span><span class="pause-fixture-spin pause-fixture-prior">Prior</span><span id="pause-waapi">WAAPI</span><span id="pause-prior">Prior WAAPI</span>';
    document.body.append(fixture);
    const appAnimation = fixture.querySelector('#pause-waapi')!.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 600, iterations: Infinity });
    const priorPaused = fixture.querySelector('#pause-prior')!.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 600, iterations: Infinity }); priorPaused.pause();
    const host = document.querySelector('[data-needmark]')!;
    const widgetAnimation = host.shadowRoot!.querySelector('[data-action="pause"]')!.animate([{ opacity: .7 }, { opacity: 1 }], { duration: 600, iterations: Infinity });
    const data: Fixture = { counts: { timeout: 0, interval: 0, frame: 0, kept: 0, canceled: 0 }, appAnimation, priorPaused, widgetAnimation, canceled: 0 };
    (window as unknown as { pauseFixture: Fixture }).pauseFixture = data;
    const timeoutLoop = () => { data.counts.timeout++; setTimeout(timeoutLoop, 25); }; timeoutLoop();
    setInterval(() => data.counts.interval++, 25);
    const frameLoop = () => { data.counts.frame++; requestAnimationFrame(frameLoop); }; frameLoop();
  });
  await expect.poll(async () => (await state(page)).counts.frame).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'アニメーションを停止', exact: true }).click();
  await page.waitForTimeout(50);
  const stopped = await state(page);
  await page.waitForTimeout(180);
  const stable = await state(page);
  expect(stable.counts).toEqual(stopped.counts); expect(stable.time).toBe(stopped.time);
  expect(Number(stable.widgetTime)).toBeGreaterThan(Number(stopped.widgetTime));
  expect(stable.priorState).toBe('paused');
  expect(await page.locator('.pause-fixture-spin').first().evaluate((element) => getComputedStyle(element).animationPlayState)).toBe('paused');
  await page.evaluate(() => {
    const fixture = document.querySelector('#pause-fixture')!, node = document.createElement('span');
    node.id = 'pause-new-css'; node.className = 'pause-fixture-spin pause-fixture-transition'; node.textContent = 'New'; fixture.append(node);
    const data = (window as unknown as { pauseFixture: Fixture }).pauseFixture;
    data.canceled = window.setTimeout(() => data.counts.canceled++, 10);
    for (let item = 0; item < 3; item++) setTimeout(() => data.counts.kept++, 10);
  });
  await page.waitForTimeout(60);
  await page.evaluate(() => clearInterval((window as unknown as { pauseFixture: Fixture }).pauseFixture.canceled));
  expect(await page.locator('#pause-new-css').evaluate((element) => getComputedStyle(element).animationPlayState)).toBe('paused');
  expect(await page.locator('#pause-new-css').evaluate((element) => getComputedStyle(element).transitionProperty)).toBe('none');

  // NeedMark's own timers and DOM capture must remain usable while the app's globals are frozen.
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const button = (await page.locator('#purchase-button').boundingBox())!;
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await page.getByLabel('コメント本文').fill('停止した画面でも画像付きでコメントできる');
  const save = page.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeEnabled(); await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const ids = (await readdir(output)).filter((id) => !id.startsWith('.'));
  expect(ids).toHaveLength(1);
  const saved = JSON.parse(await readFile(`${output}/${ids[0]}/context.json`, 'utf8')) as Feedback;
  expect(saved.capture.method).toBe('dom'); expect(saved.image).toBe('screenshot.png');
  expect((await readFile(`${output}/${saved.id}/screenshot.png`)).length).toBeGreaterThan(1000);
  await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'edit', saved.id, '停止中でもCLIの編集が一覧に届く', output]);
  await expect(page.getByText('停止中でもCLIの編集が一覧に届く', { exact: true })).toBeVisible({ timeout: 6000 });
  const still = await state(page); expect(still.counts).toEqual(stopped.counts); expect(still.time).toBe(stopped.time);
  await page.getByRole('button', { name: 'アニメーションを再開', exact: true }).click();
  await expect.poll(async () => (await state(page)).counts.kept).toBe(3);
  await expect.poll(async () => (await state(page)).counts.frame).toBeGreaterThan(stopped.counts.frame);
  const resumed = await state(page);
  expect(resumed.counts.canceled).toBe(0); expect(resumed.counts.timeout).toBeGreaterThan(stopped.counts.timeout);
  expect(resumed.counts.interval).toBeGreaterThan(stopped.counts.interval);
  expect(resumed.priorState).toBe('paused'); expect(resumed.priorTime).toBe(stopped.priorTime);
  expect(await page.locator('.pause-fixture-prior').evaluate((element) => getComputedStyle(element).animationPlayState)).toBe('paused');
  expect(await page.locator('#pause-new-css').evaluate((element) => getComputedStyle(element).animationPlayState)).toBe('running');
  expect(await page.locator('[data-needmark-freeze]').count()).toBe(0);
});

test('pagehide releases page animations and queued loops without resuming a video or animation that was already paused', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const video = document.createElement('video'); video.id = 'pause-empty-video'; document.body.append(video);
    const target = document.querySelector('#product-title')!;
    const running = target.animate([{ opacity: .4 }, { opacity: 1 }], { duration: 1000, iterations: Infinity });
    const prior = target.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(1px)' }], { duration: 1000, iterations: Infinity }); prior.pause();
    (window as unknown as { pausePagehide: { running: Animation; prior: Animation; calls: number } }).pausePagehide = { running, prior, calls: 0 };
  });
  await page.getByRole('button', { name: 'アニメーションを停止', exact: true }).click();
  await page.evaluate(() => setTimeout(() => (window as unknown as { pausePagehide: { calls: number } }).pausePagehide.calls++, 10));
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => (window as unknown as { pausePagehide: { calls: number } }).pausePagehide.calls)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { pausePagehide: { calls: number } }).pausePagehide.calls)).toBe(1);
  expect(await page.evaluate(() => {
    const data = (window as unknown as { pausePagehide: { running: Animation; prior: Animation } }).pausePagehide;
    return { running: data.running.playState, prior: data.prior.playState, videoPaused: (document.querySelector('#pause-empty-video') as HTMLVideoElement).paused };
  })).toEqual({ running: 'running', prior: 'paused', videoPaused: true });
  await expect(page.locator('[data-needmark-freeze]')).toHaveCount(0);
});
