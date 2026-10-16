import { test, expect } from './support/review.js';
import { resolve } from 'node:path';
import type { ElementContext } from '../src/shared/types.js';

const moduleUrl = `/@fs/${resolve('src/client/context/code-context.ts')}`;

test('real React dev host creation frames are aligned, bounded and do not use parent metadata', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/react.html');
  await expect(page.locator('#purchase-one')).toBeVisible();
  const evidence = await page.evaluate(async (url) => {
    const { contextForElements, contextForElement, runtimeSourceRequest } = await import(url);
    const buttons = [document.querySelector('#purchase-one')!, document.querySelector('#purchase-two')!];
    const compile = runtimeSourceRequest(contextForElements(buttons));
    buttons[0]!.removeAttribute('data-needmark-source');
    const code = contextForElements(buttons);
    const before = document.documentElement.outerHTML;
    const request = runtimeSourceRequest(code);
    const fiberKey = Object.keys(buttons[0]!).find((key) => key.startsWith('__reactFiber$'))!;
    const host = (buttons[0] as unknown as Record<string, { _debugStack?: { stack?: string } }>)[fiberKey];
    const hostHasUserFrame = /PurchaseButton.*react\.tsx/.test(host?._debugStack?.stack ?? '');
    const unchanged = document.documentElement.outerHTML === before;
    const section = buttons[0]!.parentElement!;
    section.removeAttribute('data-needmark-source');
    const child = document.createElement('span'); child.id = 'native-child'; child.textContent = 'A plain native child'; section.append(child);
    const parentRequest = runtimeSourceRequest(contextForElement(section));
    const childRequest = runtimeSourceRequest(contextForElement(child));
    return { compile, request, hostHasUserFrame, relation: code.elements[0].sourceRelation, unchanged,
      parentFrames: parentRequest.elements[0].frames, childFrames: childRequest.elements[0].frames,
      contextKeys: Object.keys(code.elements[0]) };
  }, moduleUrl);
  expect(evidence.compile.elements.map((entry: { frames: unknown[] }) => entry.frames)).toEqual([[], []]);
  expect(evidence.request.elements).toHaveLength(2);
  expect(evidence.request.elements[0]?.frames.length).toBeGreaterThan(0);
  expect(evidence.request.elements[0]?.frames.length).toBeLessThanOrEqual(5);
  expect(evidence.request.elements[0]?.frames.some((frame: { url: string; component?: string }) => frame.url.includes('/react.tsx') && frame.component === 'PurchaseButton')).toBe(evidence.hostHasUserFrame);
  expect(evidence.request.elements[1]?.frames).toEqual([]);
  expect(evidence.relation).toBe('ancestor');
  expect(evidence.unchanged).toBe(true);
  expect(evidence.parentFrames.length).toBeGreaterThan(0);
  expect(evidence.childFrames).toEqual([]);
  expect(evidence.contextKeys).not.toContain('frames');
  expect(evidence.contextKeys).not.toContain('stack');
});

// Stack syntax is parsed in code-context.test.ts; this checks which fiber the page offers and that the raw stack never reaches saved context.
test('runtime source requests read frames only from the element\'s own unambiguous host fiber and never save the stack', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<section id="container"><button id="runtime">Action</button><span id="native">Plain native text</span></section>');
  const evidence = await page.evaluate(async (url) => {
    const { contextForElement, runtimeSourceRequest } = await import(url);
    const element = document.querySelector('#runtime')!;
    const stack = 'Error: raw-stack-sentinel\n    at RuntimeWidget (http://user:secret@127.0.0.1:4192/private.tsx:2:5)\n    at RuntimeWidget (http://127.0.0.1:4192/src/Widget.tsx:12:3)';
    const fiber: { stateNode: Element; type: string; _debugStack?: { stack: string }; return: { type: unknown; _debugStack: { stack: string } } } = {
      stateNode: element, type: 'button', _debugStack: { stack },
      return: { type: function RuntimeWidget() {}, _debugStack: { stack: '    at ParentComponent (http://127.0.0.1:4192/src/Parent.tsx:4:2)' } },
    };
    Object.defineProperty(element, '__reactFiber$fixture', { value: fiber, configurable: true, enumerable: true });
    const code = contextForElement(element);
    const own = runtimeSourceRequest(code);
    Object.defineProperty(element, '__reactFiber$ambiguous', { value: fiber, configurable: true, enumerable: true });
    const ambiguous = runtimeSourceRequest(code);
    Reflect.deleteProperty(element, '__reactFiber$ambiguous');
    fiber.stateNode = document.querySelector('#container')!;
    const nonhost = runtimeSourceRequest(code);
    fiber.stateNode = element; delete fiber._debugStack;
    const missing = runtimeSourceRequest(code);
    const native = runtimeSourceRequest(contextForElement(document.querySelector('#native')!));
    return { own, ambiguous, nonhost, missing, native, serializedContext: JSON.stringify(code) };
  }, moduleUrl);
  expect(evidence.own.elements[0]?.frames).toEqual([{ url: 'http://127.0.0.1:4192/src/Widget.tsx', line: 12, column: 3, component: 'RuntimeWidget' }]);
  for (const request of [evidence.ambiguous, evidence.nonhost, evidence.missing, evidence.native]) expect(request.elements[0]?.frames).toEqual([]);
  expect(evidence.serializedContext).not.toContain('raw-stack-sentinel');
  expect(evidence.serializedContext).not.toContain('secret');
  expect(evidence.serializedContext).not.toContain('http://');
});

test('runtime source pins survive a real React reload and source line drift while strong identity still rejects changes', async ({ page }) => {
  await page.goto('/react.html');
  await expect(page.locator('#purchase-one')).toBeVisible();
  const saved = await page.evaluate(async (url): Promise<ElementContext> => {
    const { describeElement, resolveContextElement } = await import(url);
    const element = document.querySelector('#purchase-one')!;
    element.removeAttribute('data-needmark-source');
    const context = describeElement(element) as ElementContext;
    // The source bridge verifies this location separately; identity must tolerate later source line movement.
    context.source = { file: 'demo/react.tsx', line: 999, column: 99, component: 'PurchaseButton' };
    context.sourceRelation = 'self'; context.sourceOrigin = 'runtime';
    if (resolveContextElement(context) !== element) throw new Error('Runtime identity did not resolve');
    return context;
  }, moduleUrl);
  await page.reload();
  await expect(page.locator('#purchase-one')).toBeVisible();
  const evidence = await page.evaluate(async ({ url, saved }) => {
    const { resolveContextElement, runtimeSourceRequest } = await import(url);
    const element = document.querySelector('#purchase-one')!;
    const currentSource = JSON.parse(element.getAttribute('data-needmark-source')!);
    const same = resolveContextElement(saved) === element;
    const request = runtimeSourceRequest({ elements: [saved], truncated: false });
    const withoutUniqueId = structuredClone(saved); delete withoutUniqueId.attributes.id;
    const ambiguousTestId = resolveContextElement(withoutUniqueId) === null;
    const wrongComponent = structuredClone(saved); wrongComponent.components[wrongComponent.components.length - 1] = 'OtherComponent';
    const componentChanged = resolveContextElement(wrongComponent) === null;
    const hint = structuredClone(saved); hint.sourceHint = { file: 'another/file.tsx', component: 'Another' };
    const hintIgnored = resolveContextElement(hint) === element;
    element.setAttribute('data-needmark-source', JSON.stringify({ ...currentSource, file: 'demo/Other.tsx' }));
    const compileFileChanged = resolveContextElement(saved) === null;
    element.setAttribute('data-needmark-source', JSON.stringify({ ...currentSource, component: 'OtherButton' }));
    const compileComponentChanged = resolveContextElement(saved) === null;
    element.setAttribute('data-needmark-source', JSON.stringify({ ...currentSource, line: currentSource.line + 200, column: currentSource.column + 10 }));
    const compilePositionsAccepted = resolveContextElement(saved) === element;
    element.setAttribute('data-needmark-source', JSON.stringify(currentSource));
    element.setAttribute('aria-label', 'Another product');
    const nameChanged = resolveContextElement(saved) === null;
    return { currentSource, same, request, ambiguousTestId, componentChanged, hintIgnored, compileFileChanged, compileComponentChanged, compilePositionsAccepted, nameChanged };
  }, { url: moduleUrl, saved });
  expect(evidence.currentSource.line).not.toBe(saved.source!.line);
  expect(evidence.same).toBe(true);
  expect(evidence.request.elements[0]?.frames.length).toBeGreaterThan(0);
  expect(evidence.ambiguousTestId).toBe(true);
  expect(evidence.componentChanged).toBe(true);
  expect(evidence.hintIgnored).toBe(true);
  expect(evidence.compileFileChanged).toBe(true);
  expect(evidence.compileComponentChanged).toBe(true);
  expect(evidence.compilePositionsAccepted).toBe(true);
  expect(evidence.nameChanged).toBe(true);
});

test('developer component and Cypress identifiers remain available to code search and conservative identity checks', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<button id="buy" data-cy="purchase" data-component="PurchaseButton">Buy</button>');
  const evidence = await page.evaluate(async (url) => {
    const { describeElement, resolveContextElement } = await import(url);
    const element = document.querySelector('button')!;
    const context = describeElement(element);
    element.setAttribute('data-cy', 'other-purchase'); const changedCy = resolveContextElement(context) === null;
    element.setAttribute('data-cy', 'purchase'); element.setAttribute('data-component', 'OtherButton'); const changedComponent = resolveContextElement(context) === null;
    return { attributes: context.attributes, changedCy, changedComponent };
  }, moduleUrl);
  expect(evidence.attributes).toMatchObject({ 'data-cy': 'purchase', 'data-component': 'PurchaseButton' });
  expect(evidence.changedCy).toBe(true);
  expect(evidence.changedComponent).toBe(true);
});

test('a real React component with a retained creation frame exposes its own source and captured identifiers in both engines', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/react.html');
  const fixtureUrl = `/@fs/${resolve('tests/fixtures/runtime-nontail.tsx')}`;
  await page.evaluate(async (url) => {
    const { mountRetainedFrameButton } = await import(url);
    const container = document.createElement('div'); container.id = 'retained-frame-root'; document.body.append(container);
    mountRetainedFrameButton(container);
  }, fixtureUrl);
  await expect(page.locator('#retained-frame-button')).toBeVisible();
  const evidence = await page.evaluate(async (url) => {
    const { contextForElement, runtimeSourceRequest, resolveContextElement } = await import(url);
    const element = document.querySelector('#retained-frame-button')!;
    const code = contextForElement(element), before = document.documentElement.outerHTML;
    const request = runtimeSourceRequest(code);
    const unchanged = before === document.documentElement.outerHTML;
    const resolved = resolveContextElement(code.elements[0]) === element;
    element.id = 'different-purchase';
    const identifierChanged = resolveContextElement(code.elements[0]) === null;
    return { code, request, unchanged, resolved, identifierChanged };
  }, moduleUrl);
  expect(evidence.code.elements[0]?.sourceRelation).toBe('ancestor');
  expect(evidence.code.elements[0]?.source?.file).toBe('demo/react.html');
  expect(evidence.code.elements[0]?.tag).toBe('button');
  expect(evidence.code.elements[0]?.attributes).toMatchObject({ id: 'retained-frame-button', class: 'primary purchase', 'data-testid': 'retained-purchase' });
  expect(evidence.code.elements[0]?.components.at(-1)).toBe('RetainedFrameButton');
  expect(evidence.request.elements[0]?.frames.some((frame: { url: string; line: number; column: number; component?: string }) =>
    frame.url.includes('/tests/fixtures/runtime-nontail.tsx') && frame.component === 'RetainedFrameButton' && frame.line > 0 && frame.column > 0)).toBe(true);
  expect(evidence.unchanged).toBe(true);
  expect(evidence.resolved).toBe(true);
  expect(evidence.identifierChanged).toBe(true);
});
