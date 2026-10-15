import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMap } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRuntimeSourceResolver } from './runtime-source.js';
import type { RuntimeSourceRequest } from '../shared/types.js';

const folders: string[] = [], target = 'http://127.0.0.1:4199', origin = 'http://127.0.0.1:4200';
afterEach(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function fixture(code = `${'\n'.repeat(11)}export function ProductCard(){ return\n      <button id="buy">Buy</button> }`, contextAttributes?: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'needmark-source-'))); folders.push(root);
  await mkdir(join(root, 'src'), { recursive: true }); const file = join(root, 'src/card.jsx'); await writeFile(file, code);
  return { root, file, resolve: createRuntimeSourceResolver({ root, target, origins: [origin], outputDir: 'reviews', contextAttributes }) };
}
function request(attributes = { id: 'buy' }): RuntimeSourceRequest {
  return { elements: [{ tag: 'button', attributes, frames: [{ url: `${origin}/assets/card.js`, line: 81, column: 350, component: 'ProductCard' }] }] };
}
// The real Next indexed map uses a long generated JSX call. Keep its zero-based segment/offset shape.
function indexedMap(file: string) {
  return { version: 3, sections: [{ offset: { line: 70, column: 0 }, map: {
    version: 3, sources: [pathToFileURL(file).href], names: [], mappings: `${';'.repeat(10)}kCAYM`,
  } }] };
}
function assets(payload: unknown, generated = '/* development chunk */\n//# sourceMappingURL=card.js.map') {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
    fetched.push(String(url));
    return new Response(String(url).includes('.map') ? JSON.stringify(payload) : generated, { status: 200 });
  }));
  return fetched;
}

describe('optional runtime source resolver', () => {
  it('maps real indexed offsets and uses a current uniquely identified JSX opening instead of interpolated columns', async () => {
    const test = await fixture(), payload = indexedMap(test.file), mapped = new SourceMap(JSON.parse(JSON.stringify(payload))).findEntry(80, 349);
    expect(mapped).toMatchObject({ originalLine: 12, originalColumn: 6, originalSource: pathToFileURL(test.file).href });
    const fetched = assets(payload);
    expect(await test.resolve(request())).toEqual({ elements: [{ source: { file: 'src/card.jsx', line: 13, column: 7, component: 'ProductCard' } }] });
    expect(fetched).toEqual([`${target}/assets/card.js`, `${target}/assets/card.js.map`]);
  });

  it('finds the current opening after source lines move and refetches maps on every request', async () => {
    const test = await fixture(); let file = test.file; const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => { fetched.push(String(url)); return new Response(String(url).endsWith('.map') ? JSON.stringify(indexedMap(file)) : '//# sourceMappingURL=card.js.map'); }));
    expect((await test.resolve(request())).elements[0]?.source?.line).toBe(13);
    await writeFile(test.file, `${'\n'.repeat(4)}${'\n'.repeat(11)}export function ProductCard(){ return\n      <button id="buy">Buy</button> }`);
    expect((await test.resolve(request())).elements[0]?.source?.line).toBe(17);
    file = join(test.root, 'src/other.jsx'); await writeFile(file, 'export function OtherCard(){ return <button id="buy">Other</button> }');
    expect(await test.resolve(request())).toEqual({ elements: [{ sourceHint: { file: 'src/other.jsx', component: 'ProductCard' } }] });
    expect(fetched).toHaveLength(6);
  });

  it.each([
    ['duplicated openings', '<button id="buy"/><button id="buy"/>'],
    ['dynamic identifier', '<button id={identifier}/>'],
    ['spread after identifier', '<button id="buy" {...props}/>'],
    ['dynamic override', '<button id="buy" id={identifier}/>'],
    ['possible dynamic duplicate', '<button id="buy"/><button id={identifier}/>'],
    ['possible spread duplicate', '<button id="buy"/><button {...props}/>'],
  ])('returns an honest file hint for %s', async (_name, jsx) => {
    const test = await fixture(`export function ProductCard(){ return <>${jsx}</> }`); assets(indexedMap(test.file));
    expect(await test.resolve(request())).toEqual({ elements: [{ sourceHint: { file: 'src/card.jsx', component: 'ProductCard' } }] });
  });

  it('keeps unconfigured custom captured identifiers as context hints', async () => {
    const test = await fixture('export function ProductCard(){ return <button data-review-id="custom-buy"/> }');
    assets(indexedMap(test.file)); const input = request();
    input.elements[0]!.attributes = { 'data-review-id': 'custom-buy' };
    expect(await test.resolve(input)).toEqual({ elements: [{ sourceHint: { file: 'src/card.jsx', component: 'ProductCard' } }] });
  });

  it('allows a final literal identifier after a spread and a static string expression', async () => {
    const test = await fixture('export function ProductCard(){ return <button {...props} id={"buy"}/> }'); assets(indexedMap(test.file));
    expect((await test.resolve(request())).elements[0]?.source).toMatchObject({ file: 'src/card.jsx', line: 1 });
  });

  it('does not promote another stack frame merely because the creation file has no exact match', async () => {
    const test = await fixture('export function ProductCard(){ return <button id={identifier}/> }');
    const other = join(test.root, 'src/parent.jsx'); await writeFile(other, 'export function ProductCard(){ return <button id="buy"/> }');
    const fetched = assets(indexedMap(test.file)); const input = request(); input.elements[0]!.frames.push({ url: `${origin}/assets/parent.js`, line: 81, column: 350, component: 'ProductCard' });
    expect((await test.resolve(input)).elements[0]?.sourceHint?.file).toBe('src/card.jsx'); expect(fetched).toHaveLength(2);
  });

  it('shares only request-scoped map reads across selected elements and supports bounded inline maps', async () => {
    const test = await fixture(); const payload = indexedMap(test.file);
    const fetched = assets(payload, `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(payload)).toString('base64')}`);
    const input = request(); input.elements.push({ ...input.elements[0]! });
    expect((await test.resolve(input)).elements.map((element) => element.source?.file)).toEqual(['src/card.jsx', 'src/card.jsx']); expect(fetched).toHaveLength(1);
  });

  it.each([
    { elements: null }, { elements: Array(13).fill({}) },
    { elements: [{ tag: 'Button', attributes: {}, frames: [] }] },
    { elements: [{ tag: 'button', attributes: { id: 1 }, frames: [] }] },
    { elements: [{ tag: 'button', attributes: {}, frames: Array(6).fill({}) }] },
    { elements: [{ tag: 'button', attributes: {}, frames: [{ url: 'x', line: 0, column: 1 }] }] },
    { elements: [{ tag: 'button', attributes: {}, frames: [{ url: 'x'.repeat(2049), line: 1, column: 1 }] }] },
  ])('rejects malformed or oversized candidate shapes before fetching', async (invalid) => {
    const test = await fixture(), fetched = assets(indexedMap(test.file)); await expect(test.resolve(invalid)).rejects.toThrow('Invalid runtime source'); expect(fetched).toEqual([]);
  });

  it.each([
    'https://example.com/card.js', 'http://127.0.0.1:4190/card.js', 'file:///etc/source.js', '/assets/card.js',
    `${origin}/assets/../card.js`, `${origin}/assets/%2e%2e/card.js`, `${origin}/assets/%5csecret.js`,
    `${origin}/.needmark/card.js`, `${origin}/__needmark/card.js`, `${origin}/reviews/card.js`,
    `http://user:pass@127.0.0.1:4200/assets/card.js`, `${origin}/api/json`, `${origin}/assets/card.js#frame`,
  ])('never fetches a foreign, private or malformed generated asset: %s', async (url) => {
    const test = await fixture(), fetched = assets(indexedMap(test.file)), input = request(); input.elements[0]!.frames[0]!.url = url;
    expect(await test.resolve(input)).toEqual({ elements: [{}] }); expect(fetched).toEqual([]);
  });

  it.each(['https://example.com/card.js.map', 'file:///etc/private.map', '/reviews/card.js.map', '/.needmark/card.js.map'])('rejects map references outside permitted assets: %s', async (map) => {
    const test = await fixture(), fetched = assets(indexedMap(test.file), `//# sourceMappingURL=${map}`);
    expect(await test.resolve(request())).toEqual({ elements: [{}] }); expect(fetched).toHaveLength(1);
  });

  it('does not follow HTTP redirects and does not let missing or malformed maps prevent review', async () => {
    const test = await fixture();
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://example.com/card.js' } }), new Response('', { status: 404 }), new Response('no source map')]) {
      const fetch = vi.fn(async (_url: URL | string, _options: RequestInit) => response); vi.stubGlobal('fetch', fetch); expect(await test.resolve(request())).toEqual({ elements: [{}] }); expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    }
    assets('invalid map'); expect(await test.resolve(request())).toEqual({ elements: [{}] });
  });

  it('rejects outside-root paths, symlink escapes, dependencies, build output, feedback and disguised directories', async () => {
    const test = await fixture(), outside = await fixture();
    const paths = [outside.file];
    for (const relative of ['node_modules/pkg/file.jsx', 'dist/file.jsx', 'build/file.jsx', '.next/file.jsx', 'reviews/file.jsx', '.hidden/file.jsx']) {
      const path = join(test.root, relative); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'export function ProductCard(){ return <button id="buy"/> }'); paths.push(path);
    }
    const linked = join(test.root, 'src/link.jsx'); await symlink(outside.file, linked); paths.push(linked);
    const directory = join(test.root, 'src/folder.jsx'); await mkdir(directory); paths.push(directory);
    for (const path of paths) { assets(indexedMap(path)); expect(await test.resolve(request()), path).toEqual({ elements: [{}] }); }
  });

  it('bounds decoded assets/maps and current file bytes', async () => {
    const test = await fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)))); expect(await test.resolve(request())).toEqual({ elements: [{}] });
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => String(url).endsWith('.map') ? new Response('', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }) : new Response('//# sourceMappingURL=card.js.map'))); expect(await test.resolve(request())).toEqual({ elements: [{}] });
    await writeFile(test.file, ' '.repeat(1024 * 1024 + 1)); assets(indexedMap(test.file)); expect((await test.resolve(request())).elements[0]).toEqual({ sourceHint: { file: 'src/card.jsx', component: 'ProductCard' } });
  });

  it('ends a stalled whole request at five seconds without permanently caching the failure', async () => {
    const test = await fixture(); vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: URL, options: RequestInit) => new Promise((_done, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))))));
    const pending = test.resolve(request()); await vi.advanceTimersByTimeAsync(5_000); expect(await pending).toEqual({ elements: [{}] });
    vi.useRealTimers(); assets(indexedMap(test.file)); expect((await test.resolve(request())).elements[0]?.source?.file).toBe('src/card.jsx');
  });
});


describe('configured runtime identifying attributes', () => {
  it.each(['data-cy','data-component','data-ticket'])('verifies a static literal %s in the current JSX', async (key) => {
    const test = await fixture(`export function ProductCard(){ return <button ${key}="buy"/> }`,key === 'data-ticket' ? [key] : undefined);
    assets(indexedMap(test.file)); const input = request(); input.elements[0]!.attributes = {[key]:'buy'};
    expect(await test.resolve(input)).toEqual({elements:[{source:{file:'src/card.jsx',line:1,column:39,component:'ProductCard'}}]});
  });
});


for (const key of ['data-cy','data-component','data-ticket']) {
  describe(`literal identity ambiguity for ${key}`, () => {
    const config = key === 'data-ticket' ? [key] : undefined;
    const opening = `<button ${key}="buy"/>`;
    it.each([
      ['duplicate literal',`${opening}${opening}`],
      ['dynamic value',`<button ${key}={identifier}/>`],
      ['later spread',`<button ${key}="buy" {...props}/>`],
      ['later dynamic override',`<button ${key}="buy" ${key}={identifier}/>`],
      ['potential dynamic duplicate',`${opening}<button ${key}={identifier}/>`],
      ['potential spread duplicate',`${opening}<button {...props}/>`],
    ])('keeps %s as a file hint', async (_name,jsx) => {
      const test = await fixture(`export function ProductCard(){ return <>${jsx}</> }`,config);
      assets(indexedMap(test.file)); const input = request(); input.elements[0]!.attributes = {[key]:'buy'};
      expect(await test.resolve(input)).toEqual({elements:[{sourceHint:{file:'src/card.jsx',component:'ProductCard'}}]});
    });

    it('allows a final static string after a spread without trusting overridden identifiers', async () => {
      const test = await fixture(`export function ProductCard(){ return <button {...props} ${key}={"buy"}/> }`,config);
      assets(indexedMap(test.file)); const input = request(); input.elements[0]!.attributes = {[key]:'buy'};
      expect((await test.resolve(input)).elements[0]?.source).toMatchObject({file:'src/card.jsx',component:'ProductCard',line:1});
    });

    it('keeps a differing component owner as a hint despite a matching identifier', async () => {
      const test = await fixture(`export function OtherCard(){ return ${opening} }`,config);
      assets(indexedMap(test.file)); const input = request(); input.elements[0]!.attributes = {[key]:'buy'};
      expect(await test.resolve(input)).toEqual({elements:[{sourceHint:{file:'src/card.jsx',component:'ProductCard'}}]});
    });
  });
}

it('does not let a browser-declared custom list promote unconfigured attributes', async () => {
  const test=await fixture('export function ProductCard(){ return <button data-browser-only="buy"/> }'); assets(indexedMap(test.file));
  const input=request(); input.elements[0]!.attributes={'data-browser-only':'buy'};
  expect(await test.resolve({...input,contextAttributes:['data-browser-only']})).toEqual({elements:[{sourceHint:{file:'src/card.jsx',component:'ProductCard'}}]});
});

it('verifies all six normalized custom slots without consuming defaults or duplicates', async () => {
  const names=Array.from({length:6},(_,index)=>`data-review-${index}`), attributes=Object.fromEntries(names.map((key)=>[key,'buy']));
  const test=await fixture(`export function ProductCard(){ return <button ${names.map((key)=>`${key}="buy"`).join(' ')}/> }`,['id','data-cy',...names,...names]);
  assets(indexedMap(test.file)); const input=request(); input.elements[0]!.attributes=attributes;
  expect((await test.resolve(input)).elements[0]?.source).toMatchObject({file:'src/card.jsx',component:'ProductCard',line:1});
});

it('treats inherited properties and absent literal constructor attributes as no identity evidence', async () => {
  const test=await fixture('export function ProductCard(){ return <button/> }',['constructor']); assets(indexedMap(test.file));
  const input=request(); input.elements[0]!.attributes={};
  expect((await test.resolve(input)).elements[0]).toEqual({sourceHint:{file:'src/card.jsx',component:'ProductCard'}});
  input.elements[0]!.attributes={constructor:'buy'};
  expect((await test.resolve(input)).elements[0]).toEqual({sourceHint:{file:'src/card.jsx',component:'ProductCard'}});
  await writeFile(test.file,'export function ProductCard(){ return <button constructor="buy"/> }');
  expect((await test.resolve(input)).elements[0]?.source).toMatchObject({file:'src/card.jsx',component:'ProductCard'});
  input.elements[0]!.attributes=Object.create({constructor:'buy'}) as Record<string,string>;
  expect((await test.resolve(input)).elements[0]).toEqual({sourceHint:{file:'src/card.jsx',component:'ProductCard'}});
});

it.each([
  {config:['value']},{config:['data-needmark-token']},{config:['Data-Key']},{config:Array.from({length:7},(_,index)=>`data-extra-${index}`)},
])('rejects invalid resolver identifier configuration before fetching: %j', async ({config}) => {
  const fetched=assets({}); await expect(fixture(undefined,config)).rejects.toThrow('contextAttributes'); expect(fetched).toEqual([]);
});

it.each([301, 500])('verifies complete %i-character runtime identifiers against current JSX without trimming', async (length) => {
  const identifier = 'x'.repeat(length);
  const test = await fixture(`export function ProductCard(){ return <button data-cy="${identifier}"/> }`); assets(indexedMap(test.file));
  const input = request(); input.elements[0]!.attributes = { 'data-cy': identifier };
  expect(await test.resolve(input)).toEqual({ elements: [{ source: { file: 'src/card.jsx', line: 1, column: 39, component: 'ProductCard' } }] });
  input.elements[0]!.attributes['data-cy'] = identifier.slice(0, 300);
  expect(await test.resolve(input)).toEqual({ elements: [{ sourceHint: { file: 'src/card.jsx', component: 'ProductCard' } }] });
});

it('rejects 501-character runtime attributes before fetching instead of verifying a partial identifier', async () => {
  const test = await fixture(), fetched = assets(indexedMap(test.file));
  const input = request(); input.elements[0]!.attributes = { id: 'x'.repeat(501) };
  await expect(test.resolve(input)).rejects.toThrow('Invalid runtime source element');
  expect(fetched).toEqual([]);
});
