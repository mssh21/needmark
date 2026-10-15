import { test, expect } from './support/review.js';
import { resolve } from 'node:path';

const moduleUrl = `/@fs/${resolve('src/client/context/code-context.ts')}`;

test('area context keeps text blocks with inline children, controls and image names without duplicate spans', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  await page.setContent(`<main style="position:fixed;left:0;top:0;width:480px;height:420px">
    <h2 id="heading">Title <span>with emphasis</span></h2>
    <p id="description">Description with a <strong>bold word</strong><br>and another line.</p>
    <button id="buy" title="Purchase tooltip"><span>Buy</span></button>
    <p style="visibility:hidden">Hidden description</p>
    <img id="photo" width="40" height="30" alt="Product photo">
  </main>`);
  const context = await page.evaluate(async (url) => {
    const { contextForArea } = await import(url);
    return contextForArea({ x: 0, y: 0, width: 480, height: 420 });
  }, moduleUrl);
  expect(context.elements.map((element: { tag: string }) => element.tag)).toEqual(['h2', 'p', 'button', 'img']);
  expect(context.elements[1]?.text).toContain('another line');
  expect(context.elements[2]?.accessibleName).toBe('Buy');
  expect(context.elements[3]?.accessibleName).toBe('Product photo');
  expect(context.truncated).toBe(false);
});

test('selectors escape unusual identifiers and remain unique with duplicate ids and test ids', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<main><button></button><button></button><button></button><button></button></main>');
  const contexts = await page.evaluate(async (url) => {
    const { contextForElements, resolveElement } = await import(url);
    const buttons = [...document.querySelectorAll('button')];
    buttons[0]!.id = '123 "quoted" #item';
    buttons[1]!.setAttribute('data-testid', 'a"b\\c\nline');
    buttons[2]!.id = buttons[3]!.id = 'duplicated';
    buttons[2]!.setAttribute('data-testid', 'duplicate-test');
    buttons[3]!.setAttribute('data-testid', 'duplicate-test');
    const context = contextForElements([...buttons, buttons[0]]);
    return { context, same: context.elements.map((element: { selector: string }, index: number) => resolveElement(element.selector) === buttons[index]) };
  }, moduleUrl);
  expect(contexts.context.elements).toHaveLength(4);
  expect(contexts.same).toEqual([true, true, true, true]);
});

test('text ranges identify semantic owners and accessibility names without reading field values', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  await page.setContent('<h2>Selected <span>heading</span></h2><p>Description <strong>selected text</strong><br>second line.</p><label for="password">Secret field</label><input id="password" type="password"><span id="label">Confirm changes</span><button aria-labelledby="label">OK</button>');
  const evidence = await page.evaluate(async (url) => {
    const { contextForRange, contextForElement } = await import(url);
    const range = document.createRange();
    range.setStart(document.querySelector('h2')!.firstChild!, 0);
    range.setEnd(document.querySelector('strong')!.firstChild!, 8);
    const input = document.querySelector('input')!; input.value = 'private-password';
    return { selection: contextForRange(range), input: contextForElement(input), button: contextForElement(document.querySelector('button')!) };
  }, moduleUrl);
  expect(evidence.selection.elements.map((element: { tag: string }) => element.tag)).toEqual(['h2', 'p']);
  expect(evidence.input.elements[0]?.accessibleName).toBe('Secret field');
  expect(evidence.button.elements[0]?.accessibleName).toBe('Confirm changes');
  expect(JSON.stringify(evidence)).not.toContain('private-password');
});

test('open shadow roots and same-origin frames retain source evidence, resolvable paths and top viewport bounds', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="shadow-host" style="position:fixed;left:10px;top:10px;width:150px;height:80px"></div>');
  const evidence = await page.evaluate(async (url) => {
    const { contextForElement, contextForArea, elementAtPoint, resolveElement, viewportRectOf } = await import(url);
    const host = document.querySelector('#shadow-host')!;
    host.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Card.tsx', line: 8, column: 3, component: 'Card' }));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="shadow-buy" style="position:absolute;left:20px;top:10px;width:100px;height:40px">Shadow buy</button>';
    const frame = document.createElement('iframe'); frame.id = 'embed';
    frame.style.cssText = 'position:fixed;left:300px;top:100px;width:200px;height:100px;border:2px solid;transform:scale(1.25);transform-origin:0 0';
    frame.srcdoc = `<body style="margin:0"><button id="frame-buy" style="position:absolute;left:15px;top:12px;width:80px;height:40px" data-needmark-source='{"file":"src/Frame.tsx","line":4,"column":5}'>Frame buy</button></body>`;
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame); await ready;
    const elements = [shadow.querySelector('button')!, frame.contentDocument!.querySelector('button')!];
    return {
      contexts: elements.map((element) => {
        const context = contextForElement(element).elements[0];
        const rect = viewportRectOf(element);
        return { context, resolved: resolveElement(context.selector, context.rootPath) === element,
          hit: elementAtPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element };
      }),
      area: contextForArea({ x: 0, y: 0, width: 600, height: 300 }),
    };
  }, moduleUrl);
  expect(evidence.contexts[0]?.context).toMatchObject({ sourceRelation: 'ancestor', source: { file: 'src/Card.tsx', line: 8 }, rootPath: ['shadow: #shadow-host'] });
  expect(evidence.contexts[1]?.context).toMatchObject({ sourceRelation: 'self', source: { file: 'src/Frame.tsx', line: 4 }, rootPath: ['iframe: #embed'] });
  expect(evidence.contexts.every((item: { resolved: boolean; hit: boolean }) => item.resolved && item.hit)).toBe(true);
  expect(evidence.contexts[1]?.context.rect.x).toBeCloseTo(321.25);
  expect(evidence.contexts[1]?.context.rect.y).toBeCloseTo(117.5);
  expect(evidence.contexts[1]?.context.rect.width).toBeCloseTo(100);
  expect(evidence.area.elements.map((element: { text: string }) => element.text)).toEqual(['Shadow buy', 'Frame buy']);
});

test('text caret selection works in open roots and scaled frames, accepts reversed drags and rejects root crossings', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  await page.setContent('<p id="top-text" style="position:fixed;left:10px;top:0;margin:0;font:16px monospace">Top words</p><div id="text-host" style="position:fixed;left:10px;top:50px;width:180px;height:40px"></div><input id="private-field" type="password" style="position:fixed;left:10px;top:250px">');
  const evidence = await page.evaluate(async (url) => {
    const { caretRangeAtPoint, rangeBetween, viewportRectForRange, contextForRange } = await import(url);
    const shadow = document.querySelector('#text-host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p id="shadow-text" style="margin:0;font:16px monospace">Shadow words</p>';
    const frame = document.createElement('iframe'); frame.id = 'text-frame';
    frame.style.cssText = 'position:fixed;left:300px;top:100px;width:220px;height:100px;border:2px solid;transform:scale(1.25);transform-origin:0 0';
    frame.srcdoc = '<body style="margin:0"><p id="frame-text" style="margin:0;font:16px monospace">Frame words</p></body>';
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame); await ready;
    const elements = [document.querySelector('#top-text')!, shadow.querySelector('#shadow-text')!, frame.contentDocument!.querySelector('#frame-text')!];
    const carets = elements.map((element) => {
      const node = element.firstChild!;
      const first = element.ownerDocument.createRange(); first.setStart(node, 0); first.setEnd(node, 1);
      const last = element.ownerDocument.createRange(); last.setStart(node, node.textContent!.length - 1); last.setEnd(node, node.textContent!.length);
      const start = viewportRectForRange(first), end = viewportRectForRange(last);
      return [caretRangeAtPoint(start.x + .1, start.y + start.height / 2), caretRangeAtPoint(end.x + end.width - .1, end.y + end.height / 2)];
    });
    const selections = carets.map(([start, end]) => {
      if (!start || !end) return null;
      const range = rangeBetween(start, end), reverse = rangeBetween(end, start);
      return { text: range?.toString(), reverse: reverse?.toString(), context: range ? contextForRange(range) : null,
        bounds: range ? viewportRectForRange(range) : null };
    });
    const input = document.querySelector<HTMLInputElement>('#private-field')!; input.value = 'private-password';
    const rect = input.getBoundingClientRect();
    const privateCaret = caretRangeAtPoint(rect.x + 10, rect.y + rect.height / 2);
    return { selections, differentRoots: [rangeBetween(carets[0]![0]!, carets[1]![1]!), rangeBetween(carets[1]![0]!, carets[2]![1]!)], privateCaret: privateCaret === null };
  }, moduleUrl);
  expect(evidence.selections.map((selection) => selection?.text)).toEqual(['Top words', 'Shadow words', 'Frame words']);
  expect(evidence.selections.every((selection) => selection?.text === selection?.reverse)).toBe(true);
  expect(evidence.selections[1]?.context.elements[0]?.rootPath).toEqual(['shadow: #text-host']);
  expect(evidence.selections[2]?.context.elements[0]?.rootPath).toEqual(['iframe: #text-frame']);
  expect(evidence.selections[2]?.bounds.x).toBeCloseTo(302.5);
  expect(evidence.selections[2]?.bounds.y).toBeGreaterThan(100);
  expect(evidence.differentRoots).toEqual([null, null]);
  expect(evidence.privateCaret).toBe(true);
});

test('text caret selection falls back to the legacy browser API when the standard API is unavailable', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  await page.setContent('<p style="margin:0;font:16px monospace">Legacy text</p>');
  const evidence = await page.evaluate(async (url) => {
    const { caretRangeAtPoint, rangeBetween, viewportRectForRange } = await import(url);
    const legacyAvailable = typeof (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint === 'function';
    Object.defineProperty(document, 'caretPositionFromPoint', { value: undefined });
    const node = document.querySelector('p')!.firstChild!;
    const range = document.createRange(); range.selectNodeContents(node);
    const rect = viewportRectForRange(range);
    const start = caretRangeAtPoint(rect.x + .1, rect.y + rect.height / 2);
    const end = caretRangeAtPoint(rect.x + rect.width - .1, rect.y + rect.height / 2);
    return { legacyAvailable, selected: start && end ? rangeBetween(start, end)?.toString() : null };
  }, moduleUrl);
  expect(evidence.selected).toBe(evidence.legacyAvailable ? 'Legacy text' : null);
});

test('deep repeated DOM paths resolve uniquely and ambiguous selectors or root hosts are rejected', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<main></main><div class="host"></div><div class="host"></div>');
  const evidence = await page.evaluate(async (url) => {
    const { selectorOf, resolveElement } = await import(url);
    const main = document.querySelector('main')!;
    for (let instance = 0; instance < 2; instance++) {
      const section = document.createElement('section'); main.append(section);
      let parent: Element = section;
      for (let depth = 0; depth < 15; depth++) { const child = document.createElement('div'); parent.append(child); parent = child; }
      const button = document.createElement('button'); button.textContent = 'Repeated'; parent.append(button);
    }
    const buttons = [...main.querySelectorAll('button')];
    const selectors: string[] = buttons.map((button) => selectorOf(button));
    for (const host of document.querySelectorAll('.host')) host.attachShadow({ mode: 'open' }).innerHTML = '<button id="action">Action</button>';
    return { selectors, unique: selectors.map((selector: string, index: number) => resolveElement(selector) === buttons[index]),
      ambiguous: resolveElement('button') === null, ambiguousRoot: resolveElement('#action', ['shadow: .host']) === null };
  }, moduleUrl);
  expect(evidence.unique).toEqual([true, true]);
  expect(evidence.selectors[1]?.split(' > ').length).toBeGreaterThan(8);
  expect(evidence.selectors.every((selector: string) => selector.length <= 2000)).toBe(true);
  expect(evidence.ambiguous).toBe(true);
  expect(evidence.ambiguousRoot).toBe(true);
});

test('live target restoration accepts style repairs and identical rerenders but rejects changed identity evidence', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<button id="purchase" data-testid="buy">Buy item</button>');
  const evidence = await page.evaluate(async (url) => {
    const { describeElement, resolveContextElement, isElementMatch } = await import(url);
    let button = document.querySelector('button')!;
    button.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Buy.tsx', line: 6, column: 3, component: 'Buy' }));
    const context = describeElement(button);
    button.style.padding = '20px'; button.className = 'repaired';
    const styled = resolveContextElement(context) === button;
    const replacement = button.cloneNode(true) as HTMLButtonElement; button.replaceWith(replacement); button = replacement;
    const rerendered = resolveContextElement(context) === button;
    button.textContent = 'Different product'; const changedText = resolveContextElement(context) === null;
    button.textContent = 'Buy item'; button.setAttribute('aria-label', 'Other action'); const changedName = resolveContextElement(context) === null;
    button.removeAttribute('aria-label'); button.setAttribute('data-testid', 'different-buy'); const changedTestId = resolveContextElement(context) === null;
    button.setAttribute('data-testid', 'buy');
    button.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Other.tsx', line: 6, column: 3, component: 'Buy' }));
    const changedFile = resolveContextElement(context) === null;
    button.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Buy.tsx', line: 7, column: 3, component: 'Buy' }));
    const changedPosition = resolveContextElement(context) === null;
    button.setAttribute('data-needmark-source', JSON.stringify({ file: 'src/Buy.tsx', line: 6, column: 3, component: 'Buy' }));
    button.id = 'another'; const changedId = isElementMatch(button, context) === false;
    return { styled, rerendered, changedText, changedName, changedTestId, changedFile, changedPosition, changedId };
  }, moduleUrl);
  expect(Object.values(evidence).every(Boolean)).toBe(true);
});

test('configured developer identifiers are captured in every selection mode and remain conservative after configuration changes', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<main style="position:fixed;inset:0"><button id="custom-one" data-review-id="product-a" data-ticket-id="NB-1" data-review-flag="" value="private-value" nonce="private-nonce">First</button><p id="custom-two" data-review-id="product-b">Second <strong>description</strong></p></main>');
  const evidence = await page.evaluate(async (url) => {
    const { configureContextAttributes, contextForElement, contextForElements, contextForArea, contextForRange, resolveContextElement } = await import(url);
    const button = document.querySelector('button')!, paragraph = document.querySelector('p')!;
    configureContextAttributes(['data-review-id', 'data-ticket-id', 'data-review-flag', 'id', 'data-review-id']);
    const element = contextForElement(button), multi = contextForElements([button, paragraph]);
    const area = contextForArea({ x: 0, y: 0, width: innerWidth, height: innerHeight });
    const range = document.createRange(); range.selectNodeContents(paragraph); const text = contextForRange(range);
    let rejected = false; try { configureContextAttributes(['value']); } catch { rejected = true; }
    const afterInvalid = contextForElement(button);
    configureContextAttributes([]);
    const noLongerCaptured = contextForElement(button);
    const savedStillMatches = resolveContextElement(element.elements[0]) === button;
    button.setAttribute('data-review-id', 'product-other');
    const identityChanged = resolveContextElement(element.elements[0]) === null;
    button.setAttribute('data-review-id', 'product-a');
    button.removeAttribute('data-review-flag');
    const emptyIdentityRemoved = resolveContextElement(element.elements[0]) === null;
    button.setAttribute('data-review-flag', 'changed');
    const emptyIdentityChanged = resolveContextElement(element.elements[0]) === null;
    return { element, multi, area, text, rejected, afterInvalid, noLongerCaptured, savedStillMatches, identityChanged, emptyIdentityRemoved, emptyIdentityChanged };
  }, moduleUrl);
  expect(evidence.element.elements[0]?.attributes).toMatchObject({ 'data-review-id': 'product-a', 'data-ticket-id': 'NB-1', 'data-review-flag': '' });
  expect(evidence.multi.elements.map((element: { attributes: Record<string, string> }) => element.attributes['data-review-id'])).toEqual(['product-a', 'product-b']);
  expect(evidence.area.elements.map((element: { attributes: Record<string, string> }) => element.attributes['data-review-id'])).toEqual(['product-a', 'product-b']);
  expect(evidence.text.elements[0]?.attributes['data-review-id']).toBe('product-b');
  expect(JSON.stringify(evidence)).not.toContain('private-value');
  expect(JSON.stringify(evidence)).not.toContain('private-nonce');
  expect(evidence.rejected).toBe(true);
  expect(evidence.afterInvalid.elements[0]?.attributes['data-review-id']).toBe('product-a');
  expect(evidence.noLongerCaptured.elements[0]?.attributes['data-review-id']).toBeUndefined();
  expect(evidence.savedStillMatches).toBe(true);
  expect(evidence.identityChanged).toBe(true);
  expect(evidence.emptyIdentityRemoved).toBe(true);
  expect(evidence.emptyIdentityChanged).toBe(true);
});

test('explicit multiple context keeps twenty owners while area and text collection remain bounded samples', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/');
  await page.setContent(`<main style="position:fixed;left:20px;top:20px;width:480px;height:400px">
    ${Array.from({ length: 20 }, (_, index) => `<p id="owner-${index + 1}" style="margin:0;height:18px;font:14px/18px monospace">Paragraph ${index + 1} with <strong>emphasis</strong></p>`).join('')}
  </main>`);
  const evidence = await page.evaluate(async (url) => {
    const { contextForElements, contextForArea, contextForRange } = await import(url);
    const main = document.querySelector('main')!, owners = Array.from(main.querySelectorAll('p'));
    const bounds = main.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(main);
    return {
      nativeVisible: owners.every((owner) => { const rect = owner.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }),
      explicit: contextForElements(owners),
      area: contextForArea({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
      text: contextForRange(range),
    };
  }, moduleUrl);
  expect(evidence.nativeVisible).toBe(true);
  expect(evidence.explicit.elements.map((element: { selector: string }) => element.selector)).toEqual(Array.from({ length: 20 }, (_, index) => `#owner-${index + 1}`));
  expect(evidence.explicit.truncated).toBe(false);
  for (const context of [evidence.area, evidence.text]) {
    expect(context.elements.map((element: { selector: string; tag: string }) => ({ selector: element.selector, tag: element.tag }))).toEqual(
      Array.from({ length: 12 }, (_, index) => ({ selector: `#owner-${index + 1}`, tag: 'p' })));
    expect(context.truncated).toBe(true);
  }
});

test('area sampling requires half of the original box to be visibly covered and preserves native center fallback', { tag: '@cross-engine' }, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/');
  await page.setContent('<div id="clip" style="position:fixed;left:80px;top:80px;width:50px;height:60px;overflow:hidden"><button id="partial" style="display:block;width:100px;height:40px;border:0;margin:0;padding:0">Partial target</button></div>');
  const evidence = await page.evaluate(async (url) => {
    const { contextForArea } = await import(url);
    const target = document.querySelector<HTMLElement>('#partial')!, clip = document.querySelector<HTMLElement>('#clip')!;
    const rect = target.getBoundingClientRect(), bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const majority = { nativeHit: document.elementFromPoint(100, 100) === target,
      outsideHit: document.elementFromPoint(150, 100) === target, clip: clip.getBoundingClientRect().toJSON(),
      context: contextForArea({ x: 80, y: 80, width: 50, height: 40 }) };
    clip.style.width = '40px';
    const hiddenSide = { nativeHit: document.elementFromPoint(150, 100) === target,
      clip: clip.getBoundingClientRect().toJSON(), context: contextForArea({ x: 120, y: 80, width: 60, height: 40 }) };
    const fallback = { nativeHit: document.elementFromPoint(92.5, 90) === target,
      context: contextForArea({ x: 85, y: 85, width: 15, height: 10 }) };
    return { bounds, after: target.getBoundingClientRect().toJSON(), majority, hiddenSide, fallback };
  }, moduleUrl);
  expect(evidence.bounds).toEqual({ x: 80, y: 80, width: 100, height: 40 });
  expect(evidence.majority.clip.width).toBe(50);
  expect(evidence.majority.nativeHit).toBe(true); expect(evidence.majority.outsideHit).toBe(false);
  expect(evidence.majority.context.elements.map((element: { selector: string }) => element.selector)).toEqual(['#partial']);
  expect(evidence.majority.context.elements[0]?.rect).toEqual(evidence.bounds);
  expect(evidence.hiddenSide.clip.right).toBe(120); expect(evidence.hiddenSide.nativeHit).toBe(false);
  expect(evidence.hiddenSide.context.elements.some((element: { selector: string }) => element.selector === '#partial')).toBe(false);
  expect(evidence.fallback.nativeHit).toBe(true);
  expect(evidence.fallback.context.elements.map((element: { selector: string }) => element.selector)).toEqual(['#partial']);
  expect(evidence.fallback.context.elements[0]?.rect).toEqual(evidence.bounds);
  expect(evidence.after).toMatchObject(evidence.bounds);
});

test('area sampling keeps painted absolute and fixed escapes but rejects their containing block clips', { tag: '@cross-engine' }, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/');
  await page.setContent('<body style="margin:0"><div id="clip" style="margin-left:20px;margin-top:20px;width:40px;height:40px;overflow:hidden"><button id="positioned" style="position:absolute;left:200px;top:120px;width:100px;height:40px;border:0;margin:0;padding:0">Positioned target</button></div></body>');
  const evidence = await page.evaluate(async (url) => {
    const { contextForArea } = await import(url);
    const target = document.querySelector<HTMLElement>('#positioned')!, clip = document.querySelector<HTMLElement>('#clip')!;
    function sample() {
      const rect = target.getBoundingClientRect(), bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      return { bounds, clip: clip.getBoundingClientRect().toJSON(),
        nativeHit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === target,
        context: contextForArea(bounds) };
    }
    return (['absolute', 'fixed'] as const).map((kind) => {
      clip.style.position = 'static'; clip.style.transform = 'none'; target.style.position = kind;
      const escaped = sample();
      if (kind === 'absolute') clip.style.position = 'relative'; else clip.style.transform = 'translateZ(0)';
      return { kind, escaped, constrained: sample() };
    });
  }, moduleUrl);
  for (const state of evidence) {
    expect(state.escaped.nativeHit, `${state.kind} escapes static overflow`).toBe(true);
    expect(state.escaped.bounds.x).toBeGreaterThan(state.escaped.clip.right);
    expect(state.escaped.bounds.y).toBeGreaterThan(state.escaped.clip.bottom);
    expect(state.escaped.context.elements.map((element: { selector: string }) => element.selector)).toEqual(['#positioned']);
    expect(state.escaped.context.elements[0]?.rect).toEqual(state.escaped.bounds);
    expect(state.constrained.nativeHit, `${state.kind} is clipped by its containing block`).toBe(false);
    expect(state.constrained.bounds.x).toBeGreaterThan(state.constrained.clip.right);
    expect(state.constrained.bounds.y).toBeGreaterThan(state.constrained.clip.bottom);
    expect(state.constrained.context.elements.some((element: { selector: string }) => element.selector === '#positioned')).toBe(false);
  }
});

test('area sampling rejects ancestor opacity zero while retaining an explicitly visible child of a hidden ancestor', { tag: '@cross-engine' }, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/');
  await page.setContent('<div id="transparent-owner" style="position:fixed;left:80px;top:80px;opacity:0"><button id="transparent" style="width:100px;height:40px;border:0;padding:0">Transparent target</button></div><button id="solid" style="position:fixed;left:250px;top:80px;width:100px;height:40px;border:0;padding:0">Visible target</button><div id="hidden-owner" style="position:fixed;left:80px;top:180px;visibility:hidden"><button id="override" style="width:100px;height:40px;border:0;padding:0;visibility:visible">Visible override</button></div>');
  const evidence = await page.evaluate(async (url) => {
    const { contextForArea } = await import(url);
    const targets = ['transparent', 'solid', 'override'].map((id) => {
      const element = document.getElementById(id)!, rect = element.getBoundingClientRect();
      return { id, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        nativeHit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element,
        opacity: getComputedStyle(element).opacity, visibility: getComputedStyle(element).visibility };
    });
    return { targets, parentOpacity: getComputedStyle(document.querySelector('#transparent-owner')!).opacity,
      parentVisibility: getComputedStyle(document.querySelector('#hidden-owner')!).visibility,
      context: contextForArea({ x: 70, y: 70, width: 300, height: 170 }) };
  }, moduleUrl);
  expect(evidence.targets.every((target: { bounds: { width: number; height: number }; nativeHit: boolean }) =>
    target.bounds.width === 100 && target.bounds.height === 40 && target.nativeHit)).toBe(true);
  expect(evidence.parentOpacity).toBe('0'); expect(evidence.targets[0]?.opacity).toBe('1');
  expect(evidence.parentVisibility).toBe('hidden'); expect(evidence.targets[2]?.visibility).toBe('visible');
  expect(evidence.context.elements.map((element: { selector: string }) => element.selector)).toEqual(['#solid', '#override']);
  expect(evidence.context.elements.map((element: { rect: unknown }) => element.rect)).toEqual(evidence.targets.slice(1).map((target: { bounds: unknown }) => target.bounds));
  expect(evidence.context.truncated).toBe(false);
});
