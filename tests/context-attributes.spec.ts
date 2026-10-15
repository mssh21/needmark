import { test, expect } from './support/review.js';
import { resolve } from 'node:path';

const moduleUrl = `/@fs/${resolve('src/client/context/code-context.ts')}`;

test('captures complete attribute values through 500 characters and omits oversized values instead of copying prefixes', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<button>Review target</button>');
  const evidence = await page.evaluate(async (url) => {
    const { configureContextAttributes, describeElement } = await import(url);
    configureContextAttributes(['data-feature', 'data-ticket']);
    const button = document.querySelector('button')!;
    const values = { id: 'i'.repeat(300), 'data-testid': 't'.repeat(301), 'data-cy': 'c'.repeat(500),
      title: 'q'.repeat(501), 'data-feature': '', 'data-ticket': '  日本語 "予約"\\識別子\n次の行  ' };
    for (const [name, value] of Object.entries(values)) button.setAttribute(name, value);
    return { values, context: describeElement(button) };
  }, moduleUrl);
  expect(evidence.context.attributes).toEqual({ id: evidence.values.id, 'data-testid': evidence.values['data-testid'],
    'data-cy': evidence.values['data-cy'], 'data-feature': '', 'data-ticket': evidence.values['data-ticket'] });
  expect(evidence.context.attributes).not.toHaveProperty('title');
});

test('captures configured empty identifiers without including input values, private widget metadata or event attributes', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<input id="review-input" value="private-value" title="Field title" data-feature="" data-needmark-token="private-token" data-needback-id="private-legacy" onclick="private-command">');
  const evidence = await page.evaluate(async (url) => {
    const { configureContextAttributes, describeElement } = await import(url);
    configureContextAttributes(['data-feature']);
    const input = document.querySelector('input')!; input.value = 'current-private-input';
    let rejectsValue = false;
    try { configureContextAttributes(['value']); } catch { rejectsValue = true; }
    return { rejectsValue, context: describeElement(input) };
  }, moduleUrl);
  expect(evidence.rejectsValue).toBe(true);
  expect(evidence.context.attributes).toEqual({ id: 'review-input', title: 'Field title', 'data-feature': '' });
  const saved = JSON.stringify(evidence.context);
  for (const value of ['private-value', 'current-private-input', 'private-token', 'private-legacy', 'private-command']) expect(saved).not.toContain(value);
});

test('restores complete 301-to-500-character identifiers while refusing historical 300-character prefix matches', async ({ page }) => {
  await page.goto('/'); await page.setContent('<main><button>Long identifier</button><button>Other button</button></main>');
  const evidence = await page.evaluate(async (url) => {
    const { configureContextAttributes, describeElement, isElementMatch, resolveContextElement, runtimeSourceRequest } = await import(url);
    configureContextAttributes(['data-ticket']);
    const button = document.querySelector('button')!;
    const values = [];
    for (const length of [301, 500]) {
      button.setAttribute('data-ticket', 'x'.repeat(length));
      const context = describeElement(button), old = structuredClone(context);
      old.attributes['data-ticket'] = context.attributes['data-ticket'].slice(0, 300);
      values.push({ length, selector: context.selector, same: isElementMatch(button, context), resolved: resolveContextElement(context) === button,
        historicalPrefixAccepted: isElementMatch(button, old), requestValue: runtimeSourceRequest({ elements: [context], truncated: false }).elements[0].attributes['data-ticket'] });
    }
    button.setAttribute('data-ticket', 'x'.repeat(501));
    const oversized = describeElement(button);
    return { values, oversized: { attributes: oversized.attributes, selector: oversized.selector, same: resolveContextElement(oversized) === button } };
  }, moduleUrl);
  for (const item of evidence.values) {
    expect(item.selector).toBe(`button[data-ticket="${'x'.repeat(item.length)}"]`);
    expect(item.requestValue).toBe('x'.repeat(item.length));
    expect(item.same).toBe(true); expect(item.resolved).toBe(true); expect(item.historicalPrefixAccepted).toBe(false);
  }
  expect(evidence.oversized.attributes).not.toHaveProperty('data-ticket');
  expect(evidence.oversized.selector).toBe('button:nth-of-type(1)'); expect(evidence.oversized.same).toBe(true);
});

test('falls back to a bounded structural selector when a permitted identifier expands beyond the saved selector limit', async ({ page }) => {
  await page.goto('/'); await page.setContent('<main><button>Escaped identifier</button><button>Other button</button></main>');
  const evidence = await page.evaluate(async (url) => {
    const { describeElement, resolveContextElement } = await import(url);
    const button = document.querySelector('button')!; button.id = '\u001f'.repeat(500);
    const context = describeElement(button);
    return { idLength: context.attributes.id.length, escapedLength: CSS.escape(button.id).length, selector: context.selector,
      resolved: resolveContextElement(context) === button };
  }, moduleUrl);
  expect(evidence.idLength).toBe(500); expect(evidence.escapedLength).toBeGreaterThanOrEqual(2000);
  expect(evidence.selector).toBe('button:nth-of-type(1)'); expect(evidence.resolved).toBe(true);
});
