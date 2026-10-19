import { describe, expect, it } from 'vitest';
import { parse as parseHtml } from 'parse5';
import { transform } from 'esbuild';
import { instrumentAstro, instrumentHtml, instrumentJsx } from './code-source.js';

describe('development source locations', () => {
  it('maps HTML to original positions without interpreting script text as markup', () => {
    const html = '<html><body>\n<section><button id="buy">Buy</button></section><script>const text="<button>"</script></body></html>';
    const output = instrumentHtml(html, 'demo/index.html');
    const document = parseHtml(output);
    const body = document.childNodes.find((node) => 'tagName' in node && node.tagName === 'html')!;
    if (!('childNodes' in body)) throw new Error();
    const content = body.childNodes.find((node) => 'tagName' in node && node.tagName === 'body')!;
    if (!('childNodes' in content)) throw new Error();
    const section = content.childNodes.find((node) => 'tagName' in node && node.tagName === 'section')!;
    if (!('childNodes' in section)) throw new Error();
    const button = section.childNodes[0]!;
    if (!('attrs' in button)) throw new Error();
    expect(JSON.parse(button.attrs.find((item) => item.name === 'data-needmark-source')!.value)).toEqual({ file: 'demo/index.html', line: 2, column: 10 });
    expect(output).toContain('const text="<button>"');
    expect(output.match(/data-needmark-source/g)).toHaveLength(3);
  });

  it('maps native JSX to the enclosing component, preserving compilation and maps', async () => {
    const code = 'export const Product = () => (\n  <Card><button {...props}>Buy</button><input /></Card>\n);';
    const result = instrumentJsx(code, 'src/Product.tsx', ['http://localhost:5173'])!;
    const compiled = await transform(result.code, { loader: 'tsx', jsx: 'transform' });
    expect(compiled.code).toContain('src/Product.tsx');
    const metadata = result.code.match(/data-needmark-source=\{(.*?)\}(?=\s*[/>])/s)![1]!;
    const source = new Function('window', `return ${metadata}`)({ location: { origin: 'http://localhost:5173' } });
    expect(JSON.parse(source)).toEqual({ file: 'src/Product.tsx', line: 2, column: 9, component: 'Product' });
    expect(new Function('window', `return ${metadata}`)({ location: { origin: 'https://other.example' } })).toBeUndefined();
    expect(result.code.match(/data-needmark-source/g)).toHaveLength(2);
    expect(result.code.indexOf('data-needmark-source')).toBeGreaterThan(result.code.indexOf('{...props}'));
    const map = JSON.parse(result.map);
    expect(map.sourcesContent).toEqual([code]);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it('limits annotations to loopback hostnames on any port when no origins are configured', () => {
    const result = instrumentJsx('export const Buy = () => <button>Buy</button>;', 'src/Buy.tsx', undefined)!;
    const metadata = result.code.match(/data-needmark-source=\{(.*?)\}(?=\s*[/>])/s)![1]!;
    const read = (hostname: string) => new Function('window', `return ${metadata}`)({ location: { hostname } });
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) expect(JSON.parse(read(hostname))).toMatchObject({ file: 'src/Buy.tsx', component: 'Buy' });
    for (const hostname of ['evil.example', '192.168.1.5']) expect(read(hostname)).toBeUndefined();
  });

  it('does not overwrite explicit annotations and handles strings with JSX-like content', () => {
    const code = 'const str = "<button/>"; export function Form(){return <button data-needmark-source="custom">OK</button>}';
    expect(instrumentJsx(code, 'src/Form.tsx', ['http://localhost:5173'])).toBeUndefined();
  });

  it('annotates native Astro tags with their template position and leaves components, scripts and JS strings alone', () => {
    const code = ['---', 'const a = 1 < 2;', '---', '<Layout>', '  <h1 class={a ? "x" : "y"}>Hi</h1>', '  {list.map((x) => <li><b>{x}</b></li>)}', '  {"<div>"}', '  <p>don\'t</p><button>Go</button> {a<b}', '</Layout>', '<script>const t = "<i>";</script>'].join('\n');
    const result = instrumentAstro(code, 'src/pages/index.astro', undefined)!;
    const tagged = [...result.code.matchAll(/<(\w+)\s+data-needmark-source=\{.*?\? "((?:[^"\\]|\\.)*)" : undefined\}/g)].map(([, tag, json]) => [tag, JSON.parse(JSON.parse(`"${json}"`))]);
    expect(tagged).toEqual([
      ['h1', { file: 'src/pages/index.astro', line: 5, column: 3 }],
      ['li', { file: 'src/pages/index.astro', line: 6, column: 20 }],
      ['b', { file: 'src/pages/index.astro', line: 6, column: 24 }],
      ['p', { file: 'src/pages/index.astro', line: 8, column: 3 }],
      ['button', { file: 'src/pages/index.astro', line: 8, column: 15 }],
    ]);
    expect(result.code).toContain('{"<div>"}');
    expect(result.code).toContain('{a<b}');
    expect(result.code).toContain('<Layout>');
    expect(result.code).toContain('<script>const t = "<i>";</script>');
    expect(result.code).toContain('Astro.url.hostname');
  });
});
