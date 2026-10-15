import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { FeedbackInput, Rectangle } from '../src/shared/types.js';

const urls = { identity: `/@fs/${resolve('src/client/capture/identity.ts')}`, context: `/@fs/${resolve('src/client/context/code-context.ts')}` };
test.beforeEach(async ({ page }) => {
  await page.route('**/__needmark/client.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto('/');
});

test('original multi elements rebase before prepare and only successful commit updates context geometry', async ({ page }) => {
  const result = await page.evaluate(async (urls) => {
    const { createCaptureGuard, applyCaptureSnapshot } = await import(urls.identity);
    const { contextForElements, viewportRectOf } = await import(urls.context);
    const elements = [0, 1].map((index) => {
      const button = document.createElement('button'); button.id = `capture-multi-${index}`; button.textContent = `Original ${index}`;
      button.style.cssText = `position:fixed;left:${100 + index * 180}px;top:150px;width:100px;height:40px`; document.body.append(button); return button;
    });
    const code = contextForElements(elements);
    const target: FeedbackInput['target'] = { kind: 'multi', text: 'Original 0 / Original 1', selector: '', rect: { x: 100, y: 150, width: 280, height: 40 }, code };
    const guard = createCaptureGuard(target, { elements }); const original = structuredClone(target);
    elements[0]!.style.left = '140px'; elements[1]!.style.top = '220px';
    const snapshot = guard.prepare(), uncommitted = structuredClone(target), actual = elements.map(viewportRectOf);
    code.elements[0]!.source = { file: 'src/Original.tsx', line: 7, column: 2, component: 'Original' }; code.elements[0]!.sourceRelation = 'self';
    guard.validate(snapshot); applyCaptureSnapshot(target, snapshot);
    const committed = structuredClone(target); elements[1]!.style.left = '290px';
    let rejected = false; try { guard.validate(snapshot); } catch { rejected = true; }
    elements.forEach((element) => element.remove());
    return { original, uncommitted, committed, actual, rect: snapshot.rect, capturedAt: snapshot.capturedAt, url: snapshot.url, viewport: snapshot.viewport, rejected };
  }, urls);
  expect(result.uncommitted).toEqual(result.original);
  expect(result.rect).toEqual({ x: 140, y: 150, width: 240, height: 110 });
  expect(result.committed.rect).toEqual(result.rect); expect(result.committed.code?.elements.map((element) => element.rect)).toEqual(result.actual);
  expect(result.committed.code?.elements[0]?.source).toEqual({ file: 'src/Original.tsx', line: 7, column: 2, component: 'Original' });
  expect(result.rejected).toBe(true); expect(new Date(result.capturedAt).toISOString()).toBe(result.capturedAt); expect(result.url).toBe(page.url());
  expect(result.viewport).toMatchObject({ width: 1200, height: 850, scrollX: 0, scrollY: 0 });
});

test('identical clones remain valid saved targets but cannot replace original capture anchors or a missing multi member', async ({ page }) => {
  const result = await page.evaluate(async (urls) => {
    const { createCaptureGuard } = await import(urls.identity);
    const { contextForElement, contextForElements, resolveContextElement, viewportRectOf } = await import(urls.context);
    const original = document.createElement('button'); original.id = 'capture-original'; original.textContent = 'Same-looking target';
    original.style.cssText = 'position:fixed;left:100px;top:120px;width:150px;height:40px'; document.body.append(original);
    const target: FeedbackInput['target'] = { kind: 'element', text: original.textContent, selector: '#capture-original', rect: viewportRectOf(original), code: contextForElement(original) };
    const before = createCaptureGuard(target, { elements: [original] }), during = createCaptureGuard(target, { elements: [original] }), snapshot = during.prepare();
    const clone = original.cloneNode(true) as HTMLElement; original.replaceWith(clone);
    const rejects = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
    const savedAcceptsClone = resolveContextElement(target.code!.elements[0]) === clone;
    const missing = document.createElement('button'); missing.id = 'capture-missing'; missing.textContent = 'Second original'; missing.style.cssText = 'position:fixed;left:300px;top:120px;width:150px;height:40px'; document.body.append(missing);
    const multi: FeedbackInput['target'] = { kind: 'multi', text: 'Two originals', selector: '', rect: { x: 100, y: 120, width: 350, height: 40 }, code: contextForElements([clone, missing]) };
    const multiGuard = createCaptureGuard(multi, { elements: [clone, missing] }); missing.remove();
    const result = { savedAcceptsClone, beforeRejects: rejects(() => before.prepare()), duringRejects: rejects(() => during.validate(snapshot)), missingRejects: rejects(() => multiGuard.prepare()) };
    clone.remove(); return result;
  }, urls);
  expect(result).toEqual({ savedAcceptsClone: true, beforeRejects: true, duringRejects: true, missingRejects: true });
});

test('reversed text selections retain partial geometry and reject endpoint or full selected text drift beyond saved excerpts', async ({ page }) => {
  const result = await page.evaluate(async (urls) => {
    const { createCaptureGuard, applyCaptureSnapshot } = await import(urls.identity);
    const { contextForRange, rangeBetween, viewportRectForRange, viewportRectOf, resolveContextElement } = await import(urls.context);
    const owner = document.createElement('h2'); owner.id = 'capture-text'; owner.textContent = 'Alpha Beta Gamma';
    owner.style.cssText = 'position:fixed;left:100px;top:160px;width:400px;margin:0;font:24px monospace;white-space:nowrap'; document.body.append(owner);
    const start = document.createRange(), end = document.createRange(); start.setStart(owner.firstChild!, 10); start.collapse(true); end.setStart(owner.firstChild!, 6); end.collapse(true);
    const range = rangeBetween(start, end)!;
    const target: FeedbackInput['target'] = { kind: 'text', text: range.toString(), selector: '#capture-text', rect: viewportRectForRange(range), code: contextForRange(range) };
    const guard = createCaptureGuard(target, { range }); owner.style.left = '180px';
    const snapshot = guard.prepare(), partial = viewportRectForRange(range), whole = viewportRectOf(owner);
    guard.validate(snapshot); applyCaptureSnapshot(target, snapshot); const committed = structuredClone(target);
    (owner.firstChild as Text).insertData(0, 'Z');
    const rejects = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
    const endpointRejected = rejects(() => guard.validate(snapshot));
    const long = document.createElement('p'); long.id = 'capture-long-text'; long.textContent = 'x'.repeat(1200);
    long.style.cssText = 'position:fixed;left:100px;top:220px;width:1000px;margin:0;font:1px monospace;white-space:nowrap'; document.body.append(long);
    const full = document.createRange(); full.selectNodeContents(long);
    const longTarget: FeedbackInput['target'] = { kind: 'text', text: full.toString().slice(0, 1000), selector: '#capture-long-text', rect: viewportRectForRange(full), code: contextForRange(full) };
    const longGuard = createCaptureGuard(longTarget, { range: full }), longSnapshot = longGuard.prepare();
    (long.firstChild as Text).replaceData(1199, 1, 'y');
    const savedExcerptStillMatches = resolveContextElement(longTarget.code!.elements[0]) === long;
    const fullTextRejected = rejects(() => longGuard.validate(longSnapshot)); owner.remove(); long.remove();
    return { selected: committed.text, partial, whole, committed, endpointRejected, fullTextRejected, savedExcerptStillMatches };
  }, urls);
  expect(result.selected).toBe('Beta'); expect(result.committed.rect).toEqual(result.partial); expect(result.partial.width).toBeLessThan(result.whole.width);
  expect(result.committed.code?.elements[0]?.rect).toEqual(result.whole);
  expect(result.endpointRejected).toBe(true); expect(result.savedExcerptStillMatches).toBe(true); expect(result.fullTextRejected).toBe(true);
});

test('fixed area evidence rejects moved samples while a genuinely empty area remains usable', async ({ page }) => {
  const result = await page.evaluate(async (urls) => {
    const { createCaptureGuard } = await import(urls.identity);
    const { contextForElement } = await import(urls.context);
    const original = document.createElement('button'); original.id = 'capture-area-member'; original.textContent = 'Fixed evidence';
    original.style.cssText = 'position:fixed;left:100px;top:100px;width:100px;height:40px'; document.body.append(original);
    const rect = { x: 80, y: 80, width: 180, height: 100 };
    const target: FeedbackInput['target'] = { kind: 'area', text: '', selector: '', rect, code: contextForElement(original) };
    const area = createCaptureGuard(target); original.style.left = '110px';
    const rejects = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
    const areaRejects = rejects(() => area.prepare()); original.style.left = '100px';
    const empty: FeedbackInput['target'] = { kind: 'area', text: '', selector: '', rect: { x: 1000, y: 700, width: 80, height: 60 }, code: { elements: [], truncated: false } };
    const emptyGuard = createCaptureGuard(empty), emptySnapshot = emptyGuard.prepare(); emptyGuard.validate(emptySnapshot); original.remove();
    return { areaRejects, emptyRect: emptySnapshot.rect, emptyGeometry: emptySnapshot.geometry.length };
  }, urls);
  expect(result).toEqual({ areaRejects: true, emptyRect: { x: 1000, y: 700, width: 80, height: 60 }, emptyGeometry: 0 });
});

test('shadow-host and iframe replacement cannot substitute original nodes even when their saved paths resolve again', async ({ page }) => {
  const result = await page.evaluate(async (urls) => {
    const { createCaptureGuard } = await import(urls.identity);
    const { contextForElement, viewportRectOf, resolveContextElement } = await import(urls.context);
    const host = document.createElement('div'); host.id = 'capture-shadow'; host.style.cssText = 'position:fixed;left:80px;top:100px';
    const shadow = host.attachShadow({ mode: 'open' }), original = document.createElement('button'); original.id = 'inside'; original.textContent = 'Original shadow'; original.style.cssText = 'width:120px;height:40px'; shadow.append(original); document.body.append(host);
    const target: FeedbackInput['target'] = { kind: 'element', text: original.textContent, selector: '#inside', rect: viewportRectOf(original), code: contextForElement(original) };
    const shadowGuard = createCaptureGuard(target, { elements: [original] }), shadowSnapshot = shadowGuard.prepare();
    const replacement = host.cloneNode(false) as HTMLElement; const clone = original.cloneNode(true) as HTMLElement; replacement.attachShadow({ mode: 'open' }).append(clone); host.replaceWith(replacement);
    const rejects = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
    const shadowRejected = rejects(() => shadowGuard.validate(shadowSnapshot)), shadowSavedAccepts = resolveContextElement(target.code!.elements[0]) === clone;
    const iframe = document.createElement('iframe'); iframe.id = 'capture-frame'; iframe.style.cssText = 'position:fixed;left:300px;top:150px;width:250px;height:100px;border:0';
    const html = '<button id="inside" style="position:fixed;left:10px;top:10px;width:120px;height:40px">Original frame</button>';
    const load = () => new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
    const firstLoad = load(); iframe.srcdoc = html; document.body.append(iframe); await firstLoad;
    const framed = iframe.contentDocument!.querySelector('button')!;
    const frameTarget: FeedbackInput['target'] = { kind: 'element', text: framed.textContent!, selector: '#inside', rect: viewportRectOf(framed), code: contextForElement(framed) };
    const frameGuard = createCaptureGuard(frameTarget, { elements: [framed] }), frameSnapshot = frameGuard.prepare();
    iframe.style.left = '320px'; const movedFrameRejected = rejects(() => frameGuard.validate(frameSnapshot)); iframe.style.left = '300px';
    const navigationGuard = createCaptureGuard(frameTarget, { elements: [framed] }), navigationSnapshot = navigationGuard.prepare();
    const nextLoad = load(); iframe.srcdoc = html; await nextLoad;
    const frameSavedAccepts = resolveContextElement(frameTarget.code!.elements[0]) === iframe.contentDocument!.querySelector('button');
    const navigationRejected = rejects(() => navigationGuard.validate(navigationSnapshot)); replacement.remove(); iframe.remove();
    return { shadowRejected, shadowSavedAccepts, movedFrameRejected, navigationRejected, frameSavedAccepts, shadowPath: target.code!.elements[0]!.rootPath, framePath: frameTarget.code!.elements[0]!.rootPath };
  }, urls);
  expect(result).toMatchObject({ shadowRejected: true, shadowSavedAccepts: true, movedFrameRejected: true, navigationRejected: true, frameSavedAccepts: true });
  expect(result.shadowPath).toEqual(['shadow: #capture-shadow']); expect(result.framePath).toEqual(['iframe: #capture-frame']);
});

test('a connected host reused by a different React owner is rejected during capture while saved resolution stays permissive', async ({ page }) => {
  const result = await page.evaluate(async (urls) => {
    const { createCaptureGuard } = await import(urls.identity), { contextForElement, viewportRectOf, resolveContextElement } = await import(urls.context);
    const original = document.createElement('button'); original.id = 'capture-reused-host'; original.textContent = 'Unchanged reused host';
    original.style.cssText = 'position:fixed;left:100px;top:180px;width:180px;height:40px'; document.body.append(original);
    function OriginalOwner() {} function OtherOwner() {}
    const fiber = { stateNode: original, type: 'button', return: { type: OriginalOwner } };
    Object.assign(original, { __reactFiber$captureIdentity: fiber });
    const target: FeedbackInput['target'] = { kind: 'element', text: original.textContent, selector: '#capture-reused-host', rect: viewportRectOf(original), code: contextForElement(original) };
    const guard = createCaptureGuard(target, { elements: [original] }), snapshot = guard.prepare();
    fiber.return.type = OtherOwner; let rejected = false; try { guard.validate(snapshot); } catch { rejected = true; }
    const savedAccepts = resolveContextElement(target.code!.elements[0]) === original, sameRect = JSON.stringify(viewportRectOf(original)) === JSON.stringify(snapshot.rect);
    original.remove(); return { capturedOwner: target.code!.elements[0]!.components.at(-1), rejected, savedAccepts, sameRect };
  }, urls);
  expect(result).toEqual({ capturedOwner: 'OriginalOwner', rejected: true, savedAccepts: true, sameRect: true });
});
