import { test, expect } from './support/review.js';
import { resolve } from 'node:path';

const moduleUrl = `/@fs/${resolve('src/client/context/code-context.ts')}`;

test('deep picking skips an overlay label and its ancestors while excluding the widget', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<main style="position:fixed;inset:0">
    <button id="underlay" style="position:absolute;left:20px;top:20px;width:160px;height:60px">Covered button</button>
    <div id="overlay" style="position:absolute;left:20px;top:20px;width:160px;height:60px;z-index:2"><span id="overlay-label" style="display:block;width:100%;height:100%">Overlay label</span></div>
    <div id="widget" style="position:absolute;left:20px;top:20px;width:160px;height:60px;z-index:3"><span style="display:block;width:100%;height:100%">Widget</span></div>
  </main>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    const widget = document.querySelector('#widget')!;
    const overlay = document.querySelector('#overlay')!, style = overlay.getAttribute('style');
    return { normal: elementAtPoint(100, 50, widget)?.id, deep: elementAtPoint(100, 50, widget, true)?.id,
      styleUnchanged: overlay.getAttribute('style') === style };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'overlay-label', deep: 'underlay', styleUnchanged: true });
});

test('skipping an outer overlay retains meaningful front content in the lower open shadow host', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<div id="shadow-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px"></div>
    <div id="outer-overlay" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2">Outer overlay</div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint, contextForElement } = await import(url);
    const shadow = document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<button id="shadow-covered" style="position:absolute;inset:0">Covered shadow button</button>
      <button id="shadow-front" style="position:absolute;inset:0;z-index:1">Front shadow button</button>`;
    const deep = elementAtPoint(100, 50, undefined, true)!;
    return { normal: elementAtPoint(100, 50)?.id, deep: deep.id, rootPath: contextForElement(deep).elements[0].rootPath };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'outer-overlay', deep: 'shadow-front', rootPath: ['shadow: #shadow-host'] });
});

test('deep picking prefers a lower branch inside the frontmost open shadow root', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<button id="page-underlay" style="position:fixed;left:20px;top:20px;width:160px;height:60px">Page underlay</button>
    <div id="shadow-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:1"></div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    const shadow = document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<button id="shadow-underlay" style="position:absolute;inset:0">Shadow underlay</button>
      <div style="position:absolute;inset:0;z-index:1"><span id="shadow-overlay-label" style="display:block;width:100%;height:100%">Shadow overlay</span></div>`;
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'shadow-overlay-label', deep: 'shadow-underlay' });
});

test('skipping an outer overlay preserves slotted light DOM targets within the lower shadow host', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="shadow-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px"><button id="slotted" style="position:absolute;inset:0">Slotted button</button></div><div id="outer-overlay" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2">Outer overlay</div>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'outer-overlay', deep: 'slotted' });
});

test('deep frame picking preserves padded scaled coordinates and retains a meaningful inner overlay', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<button id="page-underlay" style="position:fixed;left:300px;top:100px;width:300px;height:200px">Page underlay</button>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint, viewportRectOf, contextForElement } = await import(url);
    const frame = document.createElement('iframe'); frame.id = 'embed';
    frame.style.cssText = 'position:fixed;left:300px;top:100px;width:200px;height:120px;border:4px solid;padding:9px;transform:scale(1.25);transform-origin:0 0;z-index:1';
    frame.srcdoc = `<body style="margin:0"><button id="frame-underlay" style="position:absolute;left:15px;top:12px;width:80px;height:40px">Frame underlay</button>
      <div style="position:absolute;left:15px;top:12px;width:80px;height:40px;z-index:1"><span id="frame-overlay-label" style="display:block;width:100%;height:100%">Frame overlay</span></div></body>`;
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame); await ready;
    const button = frame.contentDocument!.querySelector('button')!, rect = viewportRectOf(button);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const deep = elementAtPoint(x, y, undefined, true)!;
    const inner = { normal: elementAtPoint(x, y)?.id, deep: deep.id, same: deep === button,
      context: contextForElement(deep).elements[0] };
    const overlay = document.createElement('div'); overlay.id = 'outer-overlay';
    overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:2`;
    overlay.textContent = 'Outer overlay'; document.body.append(overlay);
    return { inner, outer: { normal: elementAtPoint(x, y)?.id, deep: elementAtPoint(x, y, undefined, true)?.id } };
  }, moduleUrl);
  expect(hits.inner).toMatchObject({ normal: 'frame-overlay-label', deep: 'frame-underlay', same: true,
    context: { rootPath: ['iframe: #embed'], rect: { x: 335, y: 131.25, width: 100, height: 50 } } });
  expect(hits.outer).toEqual({ normal: 'outer-overlay', deep: 'frame-overlay-label' });
});

test('deep picking retains the normal hit when only its ancestors lie underneath', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<main style="position:fixed;inset:0"><button id="only-hit" style="position:absolute;left:20px;top:20px;width:160px;height:60px">Only hit</button></main>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'only-hit', deep: 'only-hit' });
});

test('deep picking reaches meaningful content beneath two independent empty overlays', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<button id="underlay" style="position:fixed;left:20px;top:20px;width:160px;height:60px">Covered button</button>
    <div id="lower-cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:1"></div>
    <div id="upper-cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'upper-cover', deep: 'underlay' });
});

test('deep picking searches through empty outer and inner shadow covers', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<button id="page-underlay" style="position:fixed;left:20px;top:20px;width:160px;height:60px">Page underlay</button>
    <div id="shadow-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:1"></div>
    <div id="outer-cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint, contextForElement } = await import(url);
    const shadow = document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="shadow-underlay" style="position:absolute;inset:0">Shadow underlay</button><div id="inner-cover" style="position:absolute;inset:0;z-index:1"></div>';
    const deep = elementAtPoint(100, 50, undefined, true)!;
    return { normal: elementAtPoint(100, 50)?.id, deep: deep.id, rootPath: contextForElement(deep).elements[0].rootPath };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'outer-cover', deep: 'shadow-underlay', rootPath: ['shadow: #shadow-host'] });
});

test('deep picking searches through empty outer and padded scaled frame covers', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<button id="page-underlay" style="position:fixed;left:300px;top:100px;width:300px;height:200px">Page underlay</button>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint, viewportRectOf, contextForElement } = await import(url);
    const frame = document.createElement('iframe'); frame.id = 'embed';
    frame.style.cssText = 'position:fixed;left:300px;top:100px;width:200px;height:120px;border:4px solid;padding:9px;transform:scale(1.25);transform-origin:0 0;z-index:1';
    frame.srcdoc = '<body style="margin:0"><button id="frame-underlay" style="position:absolute;left:15px;top:12px;width:80px;height:40px">Frame underlay</button><div id="inner-cover" style="position:absolute;left:15px;top:12px;width:80px;height:40px;z-index:1"></div></body>';
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame); await ready;
    const rect = viewportRectOf(frame.contentDocument!.querySelector('button')!);
    const overlay = document.createElement('div'); overlay.id = 'outer-cover';
    overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:2`;
    document.body.append(overlay);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, deep = elementAtPoint(x, y, undefined, true)!;
    return { normal: elementAtPoint(x, y)?.id, deep: deep.id, context: contextForElement(deep).elements[0] };
  }, moduleUrl);
  expect(hits).toMatchObject({ normal: 'outer-cover', deep: 'frame-underlay',
    context: { rootPath: ['iframe: #embed'], rect: { x: 335, y: 131.25, width: 100, height: 50 } } });
});

test('deep picking ignores an opacity-zero intermediate hit and retains normal fallback when all lower hits are invisible', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<button id="visible" style="position:fixed;left:20px;top:20px;width:160px;height:60px">Visible button</button>
    <button id="invisible" style="position:fixed;left:20px;top:20px;width:160px;height:60px;opacity:0;z-index:1">Invisible button</button>
    <div id="cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    const normal = elementAtPoint(100, 50)?.id, deep = elementAtPoint(100, 50, undefined, true)?.id;
    document.querySelector('#visible')!.remove();
    return { normal, deep, fallback: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'cover', deep: 'visible', fallback: 'cover' });
});

test('deep picking uses the smallest visible rectangle when lower branches contain no meaningful content', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<div id="swatch" style="position:fixed;left:70px;top:35px;width:60px;height:30px;background:blue"></div>
    <div id="large-visual" style="position:fixed;left:20px;top:20px;width:160px;height:60px;background:green;z-index:1"></div>
    <div id="cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'cover', deep: 'swatch' });
});

test('deep picking ranks an empty accessible control above a smaller decorative visual', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<div id="swatch" style="position:fixed;left:70px;top:35px;width:60px;height:30px;background:blue"></div>
    <div id="accessible-control" role="button" aria-label="Confirm" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:1"></div>
    <div id="cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>`);
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'cover', deep: 'accessible-control' });
});

test('a frontmost slotted button retains normal fallback rather than selecting its rendered slot ancestor', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="shadow-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px"><button id="slotted" style="position:absolute;inset:0">Slotted button</button></div>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' }).innerHTML = '<slot id="styled-slot" style="display:block;position:absolute;inset:0"></slot>';
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'slotted', deep: 'slotted' });
});

test('deep root search keeps the existing eight-level descent bound', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="root-0" style="position:fixed;left:20px;top:20px;width:160px;height:60px"></div><div id="cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint, contextForElement } = await import(url);
    let host = document.querySelector('#root-0')!;
    for (let depth = 1; depth <= 8; depth++) {
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<div id="root-${depth}" style="position:absolute;inset:0"></div>`;
      host = root.querySelector('div')!;
    }
    host.attachShadow({ mode: 'open' }).innerHTML = '<button id="too-deep" style="position:absolute;inset:0">Too deep</button>';
    const deep = elementAtPoint(100, 50, undefined, true)!;
    return { normal: elementAtPoint(100, 50)?.id, deep: deep.id, roots: contextForElement(deep).elements[0].rootPath.length };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'cover', deep: 'root-7', roots: 7 });
});

test('closed shadow roots and inaccessible frames remain opaque targets in deep mode', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="closed-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px"></div>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    document.querySelector('#closed-host')!.attachShadow({ mode: 'closed' }).innerHTML = '<button style="position:absolute;inset:0">Closed button</button>';
    const frame = document.createElement('iframe'); frame.id = 'opaque-frame'; frame.setAttribute('sandbox', '');
    frame.style.cssText = 'position:fixed;left:300px;top:20px;width:160px;height:60px';
    frame.srcdoc = '<button style="position:absolute;inset:0">Inaccessible button</button>';
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame); await ready;
    return { closedNormal: elementAtPoint(100, 50)?.id, closedDeep: elementAtPoint(100, 50, undefined, true)?.id,
      frameNormal: elementAtPoint(380, 50)?.id, frameDeep: elementAtPoint(380, 50, undefined, true)?.id, inaccessible: frame.contentDocument === null };
  }, moduleUrl);
  expect(hits).toEqual({ closedNormal: 'closed-host', closedDeep: 'closed-host', frameNormal: 'opaque-frame', frameDeep: 'opaque-frame', inaccessible: true });
});

test('a hidden lower shadow host can still supply an explicitly visible child', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="shadow-host" style="position:fixed;left:20px;top:20px;width:160px;height:60px;visibility:hidden"></div><div id="cover" style="position:fixed;left:20px;top:20px;width:160px;height:60px;z-index:2"></div>');
  const hits = await page.evaluate(async (url) => {
    const { elementAtPoint } = await import(url);
    document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' }).innerHTML = '<button id="visible-child" style="position:absolute;inset:0;visibility:visible">Visible child</button>';
    return { normal: elementAtPoint(100, 50)?.id, deep: elementAtPoint(100, 50, undefined, true)?.id };
  }, moduleUrl);
  expect(hits).toEqual({ normal: 'cover', deep: 'visible-child' });
});
