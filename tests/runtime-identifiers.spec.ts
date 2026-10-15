import { type Locator, type Page } from '@playwright/test';
import { test, expect, saveAndList, output, tempRoot, configureReview } from './support/review.js';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startReviewProxy, type ReviewProxy } from '../dist/proxy.js';
import type { ElementContext, Feedback, RuntimeSourceRequest, RuntimeSourceResult, SourceLocation } from '../src/shared/types.js';

type Scenario = 'static' | 'duplicate' | 'dynamic' | 'unconfigured' | 'roots';
type Review = { root: string; output: string; source: string; origin: string; mapRequests: () => number };
const fixturePath = resolve('tests/fixtures/runtime-identifiers.jsx');
const sourceFile = 'src/runtime-identifiers.jsx';
test.setTimeout(45_000);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral loopback port');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}

/** Real React dev frames, HTTP assets/maps, current JSX files, and the public review proxy. No /source responses are stubbed. */
async function withReview(page: Page, scenario: Scenario, run: (review: Review) => Promise<void>) {
  const root = await mkdtemp(join(tempRoot, 'needmark-runtime-identifiers-'));
  let upstream: Server | undefined, proxy: ReviewProxy | undefined;
  try {
    let source = await readFile(fixturePath, 'utf8');
    if (scenario === 'duplicate') source = source.replace('{/* EXTRA_TARGET */}', '<button data-cy="cy-checkout">Duplicate identifier</button>');
    if (scenario === 'dynamic') source = source.replace('data-cy="cy-checkout"', 'data-cy={String("cy-checkout")}');
    await mkdir(`${root}/src`); await writeFile(`${root}/${sourceFile}`, source);
    await build({ absWorkingDir: root, entryPoints: [sourceFile], outfile: `${root}/app.js`, bundle: true,
      format: 'esm', jsx: 'automatic', jsxDev: true, sourcemap: 'linked', keepNames: true, minify: false,
      nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"development"' } });
    await build({ entryPoints: [resolve('src/client/context/code-context.ts')], outfile: `${root}/identity.js`, bundle: true, format: 'esm' });
    let maps = 0;
    upstream = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/app.js' || pathname === '/app.js.map' || pathname === '/identity.js') {
        if (pathname.endsWith('.map')) maps++;
        void readFile(`${root}${pathname}`).then((body) => {
          response.writeHead(200, { 'Content-Type': pathname.endsWith('.map') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
        }, () => { response.writeHead(404); response.end(); });
      } else if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><head><title>Runtime identifier integration</title><style>body{margin:0;font:16px sans-serif}#app{padding:80px}.targets{display:flex;flex-direction:column;gap:28px;padding-top:48px;width:280px}button{width:280px;height:48px;font:16px sans-serif}#reorder{position:absolute;top:20px;left:80px}</style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
      } else { response.writeHead(404); response.end(); }
    });
    const target = await listen(upstream);
    const reservation = createServer(); const origin = await listen(reservation); await close(reservation);
    proxy = await startReviewProxy({ root, target, origin, capture: 'none', editor: 'vscode', contextAttributes: ['data-ticket'] });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
        (window as unknown as { copied: string }).copied = value;
      } } });
    });
    await page.goto(`${origin}/${scenario === 'roots' ? '?roots' : ''}`);
    await expect(page.locator('.targets [data-cy]')).toBeVisible();
    await configureReview(page, { method: 'none' });
    await run({ root, output: `${root}/.needmark/feedback`, source, origin, mapRequests: () => maps });
  } finally {
    await proxy?.close(); if (upstream?.listening) await close(upstream); await rm(root, { recursive: true, force: true });
  }
}

function expectedSource(review: Review, marker: string, component: string): SourceLocation {
  const lines = review.source.split('\n'), line = lines.findIndex((value) => value.includes(marker));
  expect(line).toBeGreaterThanOrEqual(0);
  return { file: sourceFile, line: line + 1, column: lines[line]!.indexOf('<button') + 1, component };
}
async function select(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const response = page.waitForResponse((response) => response.url().endsWith('/__needmark/source') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'コメント', exact: true }).click();
  const rect = await target.boundingBox(); if (!rect) throw new Error('Target has no visible rectangle');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect(page.getByLabel('コメント本文')).toBeVisible();
  const result = await response;
  expect(result.status()).toBe(200);
  const request = result.request().postDataJSON() as RuntimeSourceRequest;
  expect(request.elements).toHaveLength(1);
  expect(request.elements[0]!.frames.some((frame) => frame.url.endsWith('/app.js') && !!frame.component)).toBe(true);
  return { request, token: result.request().headers()['x-needmark-token']!, result: (await result.json() as { elements: RuntimeSourceResult[] }).elements[0]! };
}
async function save(page: Page, review: Review, comment: string): Promise<Feedback> {
  await page.getByLabel('コメント本文').fill(comment);
  await saveAndList(page);
  await expect(page.getByText('コメントを保存しました。', { exact: true })).toBeVisible();
  const records = await Promise.all((await readdir(review.output)).filter((name) => !name.startsWith('.')).map(async (id) => JSON.parse(await readFile(`${review.output}/${id}/context.json`, 'utf8')) as Feedback));
  const item = records.find((record) => record.comment === comment);
  if (!item) throw new Error('Saved feedback was not found');
  return item;
}
async function closePanel(page: Page) { await page.getByRole('button', { name: 'パネルを閉じる', exact: true }).click(); }
const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string }).copied);

test('real proxy verifies cy, component and configured custom identifiers through saved source, editor, prompt and reordered pins', { tag: '@cross-engine' }, async ({ page }) => {
  await withReview(page, 'static', async (review) => {
    const targets = [
      { attribute: 'data-cy', value: 'cy-checkout', component: 'CypressTarget', text: 'Cypress source review' },
      { attribute: 'data-component', value: 'InvoiceAction', component: 'ComponentTarget', text: 'Component source review' },
      { attribute: 'data-ticket', value: 'NB-42', component: 'CustomTarget', text: 'Custom source review' },
    ];
    for (const target of targets) {
      const selector = `button[${target.attribute}="${target.value}"]`;
      const evidence = await select(page, page.locator(`.targets ${selector}`));
      const source = expectedSource(review, `${target.attribute}="${target.value}"`, target.component);
      expect(evidence.request.elements[0]!.attributes).toEqual({ [target.attribute]: target.value });
      expect(evidence.result).toEqual({ source });
      await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
      const item = await save(page, review, target.text);
      expect(item.target.selector).toBe(selector);
      expect(item.target.code?.elements[0]).toMatchObject({ selector, attributes: { [target.attribute]: target.value }, source, sourceOrigin: 'runtime', sourceRelation: 'self' });
      const serialized = JSON.stringify(item);
      for (const forbidden of ['"frames"', '"stack"', '__reactFiber', '_debugStack', '/app.js']) expect(serialized).not.toContain(forbidden);
      await page.locator('[data-needmark] .open-item').first().click();
      await expect(page.getByRole('link', { name: 'VS Codeで開く', exact: true })).toHaveAttribute('href', `vscode://file${review.root}/${sourceFile}:${source.line}:${source.column}`);
      await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
      expect(await copied(page)).toContain('Source (runtime; current JSX verified by identifiers)');
      expect(await copied(page)).toContain(`${sourceFile}:${source.line}:${source.column}`);
      expect(await copied(page)).toContain(target.text);
      await closePanel(page);
    }
    expect(review.mapRequests()).toBeGreaterThanOrEqual(3);
    await page.reload();
    const cy = page.locator('.targets button[data-cy="cy-checkout"]');
    await expect(cy).toBeVisible();
    for (const target of targets) {
      const marker = page.getByRole('button', { name: `コメント: ${target.text}`, exact: true });
      await expect(marker).toBeVisible(); await marker.hover();
      await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
    }
    const original = await cy.boundingBox();
    await page.getByRole('button', { name: 'Reorder existing targets', exact: true }).click();
    await expect.poll(async () => (await cy.boundingBox())!.y).not.toBe(original!.y);
    const pin = page.getByRole('button', { name: 'コメント: Cypress source review', exact: true });
    await expect.poll(async () => {
      const target = await cy.boundingBox(), marker = await pin.boundingBox();
      return marker && target ? Math.abs((marker.y + marker.height / 2) - (target.y + target.height / 2)) : Infinity;
    }).toBeLessThan(1);
    // Pins hold still while hovered, so the pointer leaves before the page changes the target.
    await pin.hover(); await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認'); await page.mouse.move(10, 10);
    await cy.evaluate((element) => { const duplicate = document.createElement('button'); duplicate.hidden = true; duplicate.setAttribute('data-cy', 'cy-checkout'); document.body.append(duplicate); });
    await expect.poll(async () => {
      const marker = await pin.boundingBox();
      return marker ? Math.abs((marker.y + marker.height / 2) - (original!.y + original!.height / 2)) : Infinity;
    }).toBeLessThan(1);
    await page.mouse.move(10, 10); await pin.hover(); await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
    await page.evaluate(() => document.querySelector('body > button[data-cy]')!.remove());
    await cy.evaluate((element) => element.setAttribute('data-cy', 'changed-checkout'));
    await page.mouse.move(10, 10); await pin.hover(); await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
  });
});

for (const scenario of ['duplicate', 'dynamic', 'unconfigured'] as const) {
  test(`real current ${scenario} JSX remains a file hint without invented exact source`, async ({ page }) => {
    await withReview(page, scenario, async (review) => {
      const selector = scenario === 'unconfigured' ? '.targets [data-experiment]' : '.targets [data-cy]';
      const evidence = await select(page, page.locator(selector));
      expect(evidence.result.source).toBeUndefined();
      expect(evidence.result.sourceHint?.file).toBe(sourceFile);
      if (scenario === 'unconfigured') {
        expect(evidence.request.elements[0]!.attributes).not.toHaveProperty('data-experiment');
        // A caller supplying an extra browser key must not expand the server's startup allowlist.
        const supplied = structuredClone(evidence.request);
        supplied.elements[0]!.attributes['data-experiment'] = 'experimental-action';
        const response = await page.request.post(`${review.origin}/__needmark/source`, {
          headers: { 'x-needmark-token': evidence.token, Origin: review.origin }, data: supplied,
        });
        expect(response.status()).toBe(200);
        expect((await response.json()).elements[0]).toMatchObject({ sourceHint: { file: sourceFile } });
        expect((await response.json()).elements[0].source).toBeUndefined();
      }
      await expect(page.getByText('ファイルの候補を保存します。', { exact: true })).toBeVisible();
      const item = await save(page, review, `${scenario} keeps honest evidence`);
      expect(item.target.code?.elements[0]?.source).toBeUndefined();
      expect(item.target.code?.elements[0]?.sourceHint?.file).toBe(sourceFile);
      expect(JSON.stringify(item)).not.toContain('"frames"');
      if (scenario === 'unconfigured') expect(item.target.code?.elements[0]?.attributes).not.toHaveProperty('data-experiment');
      await page.locator('[data-needmark] .open-item').click();
      await expect(page.getByRole('link', { name: '候補ファイルを開く', exact: true })).toHaveAttribute('href', `vscode://file${review.root}/${sourceFile}:1:1`);
      await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
      expect(await copied(page)).toContain('Source file search hint');
      expect(await copied(page)).not.toContain('Source (runtime; current JSX verified by identifiers)');
      expect(review.mapRequests()).toBeGreaterThan(0);
    });
  });
}

test('real shadow and iframe React targets keep per-root unique identifiers and source evidence after reload', { tag: '@cross-engine' }, async ({ page }, testInfo) => {
  await withReview(page, 'roots', async (review) => {
    const source = expectedSource(review, 'data-cy="cy-checkout"', 'CypressTarget');
    const targets = [
      { target: page.locator('#shadow-review-root button[data-cy]'), rootPath: ['shadow: #shadow-review-root'], comment: 'Shadow source review', context: undefined as ElementContext | undefined },
      { target: page.frameLocator('#embedded-review-frame').locator('button[data-cy]'), rootPath: ['iframe: #embedded-review-frame'], comment: 'Frame source review', context: undefined as ElementContext | undefined },
    ];
    for (const target of targets) {
      const evidence = await select(page, target.target);
      expect(evidence.result).toEqual({ source });
      await expect(page.getByText('修正対象のファイルを確認しました。', { exact: true })).toBeVisible();
      const saved = await save(page, review, target.comment);
      target.context = saved.target.code!.elements[0]!;
      expect(saved.target.code?.elements[0]).toMatchObject({ selector: 'button[data-cy="cy-checkout"]', rootPath: target.rootPath, source, sourceOrigin: 'runtime' });
      await page.locator('[data-needmark] .open-item').first().click();
      await page.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
      expect(await copied(page)).toContain(`Target roots: ${JSON.stringify(target.rootPath)}`);
      await closePanel(page);
    }
    await page.reload();
    for (const target of targets) {
      await expect(target.target).toBeVisible();
      const identity = await page.evaluate(async ({ origin, context }) => {
        const { describeElement, resolveContextElement } = await import(`${origin}/identity.js`);
        const entry = context.rootPath![0]!;
        const expected = entry.startsWith('shadow:')
          ? document.querySelector('#shadow-review-root')!.shadowRoot!.querySelector('button[data-cy]')!
          : (document.querySelector('#embedded-review-frame') as HTMLIFrameElement).contentDocument!.querySelector('button[data-cy]')!;
        const current = describeElement(expected) as ElementContext;
        const fiberKey = Object.keys(expected).find((key) => key.startsWith('__reactFiber$'))!;
        const fiber = (expected as unknown as Record<string, { stateNode: Element; type: string }>)[fiberKey];
        return { resolvedExactNode: resolveContextElement(context) === expected, hostFiberMatches: fiber?.stateNode === expected && fiber?.type === expected.localName,
          isConnected: expected.isConnected, saved: context, current, ownerDocumentIsCurrent: expected.ownerDocument.defaultView!.document === expected.ownerDocument };
      }, { origin: review.origin, context: target.context! });
      await testInfo.attach(`${target.comment}-reload-identity`, { body: JSON.stringify(identity, null, 2), contentType: 'application/json' });
      expect(identity).toMatchObject({ resolvedExactNode: true, hostFiberMatches: true, isConnected: true, ownerDocumentIsCurrent: true });
      const pin = page.getByRole('button', { name: `コメント: ${target.comment}`, exact: true });
      await expect(pin).toBeVisible(); await pin.hover();
      await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認'); await page.mouse.move(10, 10);
      const original = await target.target.elementHandle();
      if (!original) throw new Error('Original root target is missing');
      await original.evaluate((element) => element.setAttribute('data-cy', 'changed-root-target'));
      await pin.focus(); await expect(page.locator('[data-needmark] .tip')).toContainText('対象未確認');
      await original.evaluate((element) => element.setAttribute('data-cy', 'cy-checkout'));
      await pin.focus(); await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
      if (target.rootPath[0]!.startsWith('iframe:')) {
        const before = await target.target.boundingBox();
        await original.evaluate((element) => element.ownerDocument.defaultView!.scrollTo(0, 36));
        await expect.poll(async () => (await target.target.boundingBox())?.y ?? Infinity).toBeCloseTo(before!.y - 36, 1);
        await expect.poll(async () => {
          const box = await target.target.boundingBox(), marker = await pin.boundingBox();
          return box && marker ? Math.abs((marker.y + marker.height / 2) - (box.y + box.height / 2)) : Infinity;
        }).toBeLessThan(1);
        await pin.focus(); await expect(page.locator('[data-needmark] .tip')).not.toContainText('対象未確認');
      }
      await original.dispose();
    }
  });
});
