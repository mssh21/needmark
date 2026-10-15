import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const moduleUrl = `/@fs/${resolve('src/client/context/code-context.ts')}`;

test('hover labels are bounded, normalized and preserve authored HTML-like text as plain data', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="target"></div><img id="image"><div id="named"></div>');
  const descriptors = await page.evaluate(async (url) => {
    const { hoverDescriptor } = await import(url);
    const target = document.querySelector('#target')!;
    target.setAttribute('aria-label', '  Save\n  <img src=x onerror=alert(1)>\t  now  ');
    const raw = hoverDescriptor(target);
    target.setAttribute('aria-label', '  ' + 'Long label '.repeat(100));
    const bounded = hoverDescriptor(target);
    const image = document.querySelector('#image')!; image.setAttribute('alt', '  Product\n preview  ');
    const named = document.querySelector('#named')!; named.id = 'x'.repeat(400);
    return { raw, bounded, image: hoverDescriptor(image), id: hoverDescriptor(named), images: document.images.length };
  }, moduleUrl);
  expect(descriptors.raw).toEqual({ tag: 'div', name: 'Save <img src=x onerror=alert(1)> now' });
  expect(descriptors.bounded.name).toHaveLength(160);
  expect(descriptors.bounded.name).toMatch(/^Long label Long label/);
  expect(descriptors.image).toEqual({ tag: 'img', name: 'Product preview' });
  expect(descriptors.id).toEqual({ tag: 'div', name: 'x'.repeat(160) });
  expect(descriptors.images).toBe(1);
});

test('hover control labels use bounded local labels and never form values', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<span id="reference">  Confirm\n booking  </span>
    <button id="referenced" aria-labelledby="reference" aria-label="Lower priority">Different text</button>
    <button id="nested"><span> Book </span><strong> now </strong></button>
    <label for="password"> Account password <input value="nested-private-value"></label><input id="password" type="password" value="private-password">
    <input value="private-input"><textarea>private-textarea</textarea><select><option selected>private-selection</option></select>
    <label for="notes">Your notes</label><textarea id="notes">private-labelled-textarea</textarea>
    <div id="large-control" role="button"></div>`);
  const descriptors = await page.evaluate(async (url) => {
    const { hoverDescriptor } = await import(url);
    const large = document.querySelector('#large-control')!;
    for (let index = 0; index < 50; index++) large.append(document.createElement('span'));
    large.append('Beyond the local traversal bound');
    return {
      referenced: hoverDescriptor(document.querySelector('#referenced')!),
      nested: hoverDescriptor(document.querySelector('#nested')!),
      password: hoverDescriptor(document.querySelector('#password')!),
      unlabelled: Array.from(document.querySelectorAll('input:not([id]),textarea:not([id]),select')).map(hoverDescriptor),
      notes: hoverDescriptor(document.querySelector('#notes')!),
      large: hoverDescriptor(large),
    };
  }, moduleUrl);
  expect(descriptors.referenced).toEqual({ tag: 'button', name: 'Confirm booking' });
  expect(descriptors.nested).toEqual({ tag: 'button', name: 'Book now' });
  expect(descriptors.password).toEqual({ tag: 'input', name: 'Account password' });
  expect(descriptors.unlabelled).toEqual([{ tag: 'input' }, { tag: 'input' }, { tag: 'textarea' }, { tag: 'select' }]);
  expect(descriptors.notes).toEqual({ tag: 'textarea', name: 'Your notes' });
  expect(descriptors.large).toEqual({ tag: 'div', name: 'large-control' });
  expect(JSON.stringify(descriptors)).not.toContain('private-');
});

test('hover components use the closest existing local hint then runtime component without fabrication', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<main><button><span aria-label="Exact span"></span></button></main>');
  const descriptors = await page.evaluate(async (url) => {
    const { hoverDescriptor } = await import(url);
    const main = document.querySelector('main')!, button = document.querySelector('button')!, span = document.querySelector('span')!;
    main.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Outer.tsx', line: 1, column: 1, component: 'OuterCompile' }));
    button.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Inner.tsx', line: 2, column: 3, component: 'InnerCompile' }));
    (span as unknown as Record<string, unknown>).__reactFiber$hover = { type: 'span', stateNode: span,
      return: { type: { displayName: 'InnerRuntime' }, return: { type: { displayName: 'OuterRuntime' } } } };
    const sourceBefore = button.getAttribute('data-needmark-source');
    const compile = hoverDescriptor(span);
    const sourceAfterCompile = button.getAttribute('data-needmark-source');
    button.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/NoComponent.tsx', line: 2, column: 3 }));
    const runtime = hoverDescriptor(span);
    delete (span as unknown as Record<string, unknown>).__reactFiber$hover;
    span.setAttribute('data-component', 'MustNotFabricateComponent');
    const unnamed = hoverDescriptor(span);
    return { compile, runtime, unnamed, sourceBefore, sourceAfterCompile };
  }, moduleUrl);
  expect(descriptors.compile).toEqual({ tag: 'span', name: 'Exact span', component: 'InnerCompile' });
  expect(descriptors.runtime).toEqual({ tag: 'span', name: 'Exact span', component: 'InnerRuntime' });
  expect(descriptors.unnamed).toEqual({ tag: 'span', name: 'Exact span' });
  expect(descriptors.sourceBefore).toBe(descriptors.sourceAfterCompile);
});

test('hover descriptors keep the exact slotted node and its DOM source owner', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="host" style="position:fixed;left:20px;top:20px;width:180px;height:80px"><button style="position:absolute;inset:0"><span aria-label="Slotted span" style="display:block;width:100%;height:100%"></span></button></div>');
  const result = await page.evaluate(async (url) => {
    const { elementAtPoint, hoverDescriptor } = await import(url);
    const host = document.querySelector('#host')!, span = host.querySelector('span')!;
    host.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Light.tsx', line: 1, column: 1, component: 'LightOwner' }));
    const shadow = host.attachShadow({ mode: 'open' }); shadow.innerHTML = '<slot></slot>';
    shadow.querySelector('slot')!.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Slot.tsx', line: 1, column: 1, component: 'SlotOwner' }));
    const hit = elementAtPoint(100, 50)!;
    return { exact: hit === span, descriptor: hoverDescriptor(hit) };
  }, moduleUrl);
  expect(result).toEqual({ exact: true, descriptor: { tag: 'span', name: 'Slotted span', component: 'LightOwner' } });
});

test('hover descriptors keep exact same-origin frame nodes and use no layout or source requests', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<body></body>');
  const result = await page.evaluate(async (url) => {
    const { elementAtPoint, viewportRectOf, hoverDescriptor } = await import(url);
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:300px;top:100px;width:200px;height:120px;border:4px solid;padding:9px;transform:scale(1.25);transform-origin:0 0';
    frame.srcdoc = '<body style="margin:0"><button style="position:absolute;left:15px;top:12px;width:100px;height:40px"><span aria-label="Frame span" style="display:block;width:100%;height:100%"></span></button></body>';
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame); await ready;
    const span = frame.contentDocument!.querySelector('span')!;
    span.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Frame.tsx', line: 1, column: 1, component: 'FrameOwner' }));
    const rect = viewportRectOf(span), hit = elementAtPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)!;
    const view = frame.contentWindow!, originalStyle = view.getComputedStyle, originalFetch = window.fetch;
    view.getComputedStyle = () => { throw new Error('Hover must not read computed styles'); };
    window.fetch = () => { throw new Error('Hover must not request source'); };
    let descriptor;
    try { descriptor = hoverDescriptor(hit); }
    finally { view.getComputedStyle = originalStyle; window.fetch = originalFetch; }
    return { exact: hit === span, descriptor };
  }, moduleUrl);
  expect(result).toEqual({ exact: true, descriptor: { tag: 'span', name: 'Frame span', component: 'FrameOwner' } });
});
