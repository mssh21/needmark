import { afterEach, describe, expect, it } from 'vitest';
import { createServer, build, preview, type ViteDevServer, type PreviewServer } from 'vite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { needmark } from './index.js';
import { FeedbackStore } from './server/storage.js';
import { input } from '../tests/fixtures.js';
import react from '@vitejs/plugin-react';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';

const folders: string[] = [];
const servers: (ViteDevServer | PreviewServer)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'needmark-vite-'))); folders.push(path);
  await writeFile(join(path, 'index.html'), '<html><head><title>Demo</title></head><body><h1>Example</h1></body></html>');
  return path;
}

describe('Vite integration boundaries', () => {
  it.each(['.needback/feedback', 'custom-reviews'])('protects both canonical and legacy feedback when outputDir is %s', async (outputDir) => {
    const directory = await root();
    for (const folder of ['.needmark/feedback', '.needback/feedback']) {
      await mkdir(join(directory, folder), { recursive: true });
      await writeFile(join(directory, folder, 'private.json'), 'private review data');
    }
    const server = await createServer({ configFile: false, root: directory,
      plugins: [needmark({ origins: ['http://127.0.0.1:9999'], outputDir })],
      server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
    servers.push(server); await server.listen();
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    for (const folder of ['.needmark/feedback', '.needback/feedback']) {
      const response = await fetch(`${origin}/${folder}/private.json`);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('private review data');
    }
  });
  it('injects only on configured origins and gates file access by origin and token', async () => {
    const directory = await root();
    const origin = 'http://127.0.0.1:4194';
    const server = await createServer({ configFile: false, root: directory, plugins: [react(), needmark({ origins: [origin] })],
      server: { host: '127.0.0.1', port: 4194, strictPort: true }, logLevel: 'silent' });
    servers.push(server); await server.listen();
    const html = await (await fetch(origin)).text();
    expect(html).toContain('/__needmark/client.js');
    expect(html).toContain('data-needmark-source');
    await writeFile(join(directory, 'component.tsx'), 'export function Buy(){ return <button id="buy">Buy</button> }');
    const jsx = await (await fetch(`${origin}/component.tsx`)).text();
    expect(jsx).toContain('data-needmark-source');
    expect(jsx).toContain('component.tsx');
    expect(jsx).toContain('Buy');
    const token = html.match(/data-needmark-token="([^"]+)"/)![1]!;
    const unconfigured = await (await fetch('http://localhost:4194')).text();
    expect(unconfigured).not.toContain('needmark');
    expect(await (await fetch(origin, { headers: { Origin: 'http://localhost:1234' } })).text()).not.toContain('data-needmark-token');
    expect((await fetch(`${origin}/__needmark/feedback`)).status).toBe(403);
    const headers = { 'x-needmark-token': token };
    expect(await (await fetch(`${origin}/__needmark/feedback`, { headers })).json()).toMatchObject({
      feedback: [], directory: relative(process.cwd(), join(directory, '.needmark/feedback')),
    });
    expect((await fetch(`${origin}/__needmark/feedback`, { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${origin}/__needmark/feedback`, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${origin}/__needmark/feedback`, { method: 'POST', headers, body: JSON.stringify({ url: 'bad' }) })).status).toBe(400);
    const store = new FeedbackStore(join(directory, '.needmark/feedback'));
    const saved = await store.save({ ...input(), url: origin });
    for (const status of ['resolved', 'open']) {
      const response = await fetch(`${origin}/__needmark/feedback/${saved.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: saved.id, status });
      expect((await store.read(saved.id)).status).toBe(status);
    }
    for (const status of ['invalid', 'in_progress', 'dismissed', null, 1]) {
      expect((await fetch(`${origin}/__needmark/feedback/${saved.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ status }),
      })).status).toBe(400);
    }
    expect((await store.read(saved.id)).status).toBe('open');
    const edited = await fetch(`${origin}/__needmark/feedback/${saved.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ comment: 'Change the radius', author: 'New reviewer' }),
    });
    expect(await edited.json()).toMatchObject({ comment: 'Change the radius', author: 'New reviewer', updatedAt: expect.any(String) });
    const createdReply = await fetch(`${origin}/__needmark/feedback/${saved.id}/replies`, {
      method: 'POST', headers, body: JSON.stringify({ author: 'AI', comment: 'Updated the button' }),
    });
    expect(createdReply.status).toBe(201);
    const threaded = await createdReply.json();
    const replyId = threaded.replies[0].id;
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}/replies/${replyId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ comment: 'Please check the button' }),
    })).status).toBe(200);
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}/replies/${replyId}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await store.read(saved.id)).replies).toEqual([]);
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}`, {
      method: 'DELETE', headers: { ...headers, Origin: 'https://evil.example' },
    })).status).toBe(403);
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}/replies`, {
      method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ author: 'AI', comment: 'Blocked' }),
    })).status).toBe(403);
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}`, { method: 'DELETE' })).status).toBe(403);
    const noImage = await fetch(`${origin}/__needmark/feedback`, { method: 'POST', headers, body: JSON.stringify({
      ...input(), url: origin, screenshot: undefined, capture: { method: 'none', width: 0, height: 0 },
    }) });
    expect(noImage.status).toBe(201);
    const noImageSaved = await noImage.json();
    expect(noImageSaved.image).toBeUndefined();
    expect((await fetch(`${origin}/__needmark/feedback/${noImageSaved.id}/image`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await fetch(`${origin}/__needmark/feedback/${saved.id}`, { headers })).status).toBe(404);
    for (const scope of [{}, { scope: 'page' }, { scope: 'all', url: origin }, { scope: 'url', url: 'https://evil.example' }]) {
      expect((await fetch(`${origin}/__needmark/feedback`, { method: 'DELETE', headers, body: JSON.stringify(scope) })).status).toBe(400);
    }
    expect((await fetch(`${origin}/__needmark/feedback`, { method: 'DELETE', body: JSON.stringify({ scope: 'all' }) })).status).toBe(403);
    expect((await fetch(`${origin}/__needmark/feedback`, { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ scope: 'all' }) })).status).toBe(403);
    expect((await fetch(`${origin}/__needmark/feedback`, { method: 'DELETE', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ scope: 'all' }) })).status).toBe(403);
    const anotherPage = await store.save({ ...input(), url: `${origin}/other` });
    const currentClear = await fetch(`${origin}/__needmark/feedback`, { method: 'DELETE', headers, body: JSON.stringify({ scope: 'url', url: origin }) });
    expect(currentClear.status).toBe(200);
    expect(await currentClear.json()).toMatchObject({ scope: 'url', url: `${origin}/`, deleted: [noImageSaved.id], failed: [] });
    expect((await store.read(anotherPage.id)).id).toBe(anotherPage.id);
    const broken = await store.save({ ...input(), url: origin });
    await rm(join(directory, '.needmark/feedback', broken.id, 'context.json'));
    const partialClear = await fetch(`${origin}/__needmark/feedback`, { method: 'DELETE', headers, body: JSON.stringify({ scope: 'all' }) });
    expect(partialClear.status).toBe(207);
    expect(await partialClear.json()).toMatchObject({ deleted: [anotherPage.id], failed: [{ id: broken.id, error: expect.any(String) }] });
    await rm(join(directory, '.needmark/feedback', broken.id), { recursive: true });
    await mkdir(join(directory, '.needmark/feedback'), { recursive: true });
    await writeFile(join(directory, '.needmark/feedback/secret.json'), 'private feedback');
    const direct = await fetch(`${origin}/.needmark/feedback/secret.json`);
    expect(direct.status).toBe(403);
    expect(await direct.text()).not.toContain('private feedback');
  });

  it('appends the client once to HTML that a framework renders without transformIndexHtml, as Astro does', async () => {
    const directory = await root();
    // Astro renders pages in its own middleware, streams them with writeHead headers and never calls transformIndexHtml.
    const framework = { name: 'framework-pages', configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/page') {
          const head = '<!doctype html><html><body><h1>Rendered</h1>', tail = '</body></html>';
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(head.length + tail.length) });
          response.write(head); response.end(tail); return;
        }
        if (request.url === '/data') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); return; }
        next();
      });
    } };
    const server = await createServer({ configFile: false, root: directory, plugins: [needmark(), framework],
      server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
    servers.push(server); await server.listen();
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    const page = await (await fetch(`${origin}/page`)).text();
    expect(page.startsWith('<!doctype html><html><body><h1>Rendered</h1></body></html>')).toBe(true);
    expect(page.match(/\/__needmark\/client\.js/g)).toHaveLength(1);
    expect(await (await fetch(`${origin}/data`)).text()).toBe('{"ok":true}');
    expect((await (await fetch(origin)).text()).match(/\/__needmark\/client\.js/g)).toHaveLength(1);
    expect(await (await fetch(`${origin}/page`, { headers: { origin: 'http://evil.example' } })).text()).not.toContain('needmark');
  });

  it('allows only loopback hostnames on whatever port Vite chose when origins are omitted', async () => {
    const directory = await root();
    const server = await createServer({ configFile: false, root: directory, plugins: [needmark()],
      server: { host: '127.0.0.1', port: 0, allowedHosts: true }, logLevel: 'silent' });
    servers.push(server); await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const html = await (await fetch(origin)).text();
    expect(html).toContain('/__needmark/client.js');
    expect(html).not.toContain('data-needmark-origins');
    const token = html.match(/data-needmark-token="([^"]+)"/)![1]!;
    expect((await fetch(`${origin}/__needmark/feedback`, { headers: { 'x-needmark-token': token } })).status).toBe(200);
    // fetch replaces a custom Host header, so a DNS-rebinding request is sent with node:http.
    const rebound = (path: string) => new Promise<{ status: number; body: string }>((done, fail) => {
      request({ host: '127.0.0.1', port, path, headers: { host: `evil.example:${port}`, 'x-needmark-token': token } }, (response) => {
        let body = ''; response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; }).on('end', () => done({ status: response.statusCode!, body }));
      }).on('error', fail).end();
    });
    expect((await rebound('/')).body).not.toContain('data-needmark-token');
    expect((await rebound('/__needmark/feedback')).status).toBe(403);
  });

  it('loads needmark.config.ts from the working directory only when called without options', async () => {
    const directory = await root(), previous = process.cwd();
    await writeFile(join(directory, 'needmark.config.ts'), "export default { origins: ['http://example.test'] };");
    process.chdir(directory);
    try {
      for (const [plugin, injected] of [[needmark(), false], [needmark({}), true]] as const) {
        const server = await createServer({ configFile: false, root: directory, plugins: [plugin], server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
        servers.push(server); await server.listen();
        const html = await (await fetch(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`)).text();
        expect(html.includes('/__needmark/client.js')).toBe(injected);
      }
      await writeFile(join(directory, 'needmark.config.ts'), "export default { language: 'fr' };");
      await expect(createServer({ configFile: false, root: directory, plugins: [needmark()], logLevel: 'silent' })).rejects.toThrow('Invalid NeedMark language');
    } finally { process.chdir(previous); }
  });

  it.each([[{ enabled: false }, {}], [{}, { NEEDMARK: 'off' }]])('injects nothing when switched off by %j or %j', async (options, env) => {
    const directory = await root(), previous = process.env.NEEDMARK;
    Object.assign(process.env, env);
    try {
      const server = await createServer({ configFile: false, root: directory, plugins: [needmark(options)], server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
      servers.push(server); await server.listen();
      const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
      expect(await (await fetch(origin)).text()).not.toContain('needmark');
      expect((await fetch(`${origin}/__needmark/feedback`)).status).not.toBe(403);
    } finally { if (previous === undefined) delete process.env.NEEDMARK; else process.env.NEEDMARK = previous; }
  });

  it('does not include scripts, endpoints or feedback files in production or preview', async () => {
    const directory = await root();
    await mkdir(join(directory, '.needmark/feedback'), { recursive: true });
    await writeFile(join(directory, '.needmark/feedback/comment.md'), 'private feedback');
    await writeFile(join(directory, 'index.html'), '<html><body><script type="module" src="/component.tsx"></script></body></html>');
    await writeFile(join(directory, 'component.tsx'), 'document.body.textContent = JSON.stringify(<button>Buy</button>);');
    // Under Vitest's NODE_ENV=test Oxc would add JSX `__source` paths, and the temporary directory's name contains "needmark".
    // Vitestでは NODE_ENV=test のためOxcがJSXに`__source`のパスを足し、一時ディレクトリ名に「needmark」が含まれてしまう。
    await build({ configFile: false, root: directory, oxc: { jsx: { runtime: 'classic', pragma: 'createElement', development: false } }, plugins: [needmark({ origins: ['http://127.0.0.1:4195'] })], logLevel: 'silent' });
    expect(await readdir(join(directory, 'dist'))).toEqual(['assets', 'index.html']);
    const assets = await readdir(join(directory, 'dist/assets'));
    for (const asset of assets) expect(await readFile(join(directory, 'dist/assets', asset), 'utf8')).not.toContain('needmark');
    expect(await readFile(join(directory, 'dist/index.html'), 'utf8')).not.toContain('needmark');
    const server = await preview({ configFile: false, root: directory,
      plugins: [needmark({ origins: ['http://127.0.0.1:4195'] })], preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
    servers.push(server);
    const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    expect(await (await fetch(origin)).text()).not.toContain('__needmark');
    expect(await (await fetch(`${origin}/__needmark/feedback`)).text()).not.toContain('private feedback');
  });
});
