import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type IncomingHttpHeaders, type RequestListener, type RequestOptions } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { startReviewProxy, type ReviewProxyOptions } from './proxy.js';
import { input } from '../tests/fixtures.js';

const folders: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function developmentServer(handler: RequestListener, hostname: string | null = '127.0.0.1') {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, hostname ?? undefined, () => ready()); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => new Promise<void>((done, reject) => {
    sockets.forEach((socket) => socket.destroy());
    if (!server.listening) { done(); return; }
    server.close((error) => error ? reject(error) : done());
  }));
  return { server, origin };
}

async function availableOrigin() {
  const reservation = createServer();
  await new Promise<void>((ready, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', ready); });
  const origin = `http://127.0.0.1:${(reservation.address() as AddressInfo).port}`;
  await new Promise<void>((done, reject) => reservation.close((error) => error ? reject(error) : done()));
  return origin;
}

async function review(target: string, options: Partial<ReviewProxyOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'needmark-proxy-')));
  folders.push(root);
  const proxy = await startReviewProxy({ target, origin: await availableOrigin(), root, ...options });
  cleanup.push(() => proxy.close());
  return { ...proxy, root };
}

function readResponse(url: string, options: RequestOptions = {}, body?: string | Buffer, onChunk?: (chunk: Buffer) => void) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((done, reject) => {
    const pending = request(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); onChunk?.(chunk); });
      response.on('error', reject);
      response.on('end', () => done({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    pending.setTimeout(3_000, () => pending.destroy(new Error('Request timed out')));
    pending.on('error', reject);
    pending.end(body);
  });
}

function rawUpgrade(origin: string, path: string, headers: Record<string, string>, head = '', expected = '\r\n\r\n') {
  return new Promise<{ data: string; socket: Socket }>((done, reject) => {
    const url = new URL(origin);
    const socket = connect(Number(url.port), url.hostname);
    cleanup.push(async () => { socket.destroy(); });
    let data = '';
    socket.setTimeout(3_000, () => socket.destroy(new Error('Upgrade timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes(expected)) { socket.setTimeout(0); done({ data, socket }); }
    });
    socket.once('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${head}`));
  });
}

describe('standalone review proxy', () => {
  it('forwards HTML as it arrives, preserves CSP, and injects the local script with its nonce at the end', async () => {
    const first = '<!doctype html><html><body><h1>Streaming page</h1>';
    const last = '</body></html>';
    let finish: (() => void) | undefined;
    let forwarded: IncomingHttpHeaders | undefined;
    const upstream = await developmentServer((incoming, response) => {
      forwarded = incoming.headers;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(first + last), ETag: 'original',
        'Content-Security-Policy': "default-src 'self'; script-src 'nonce-policy-nonce'" });
      response.write(first);
      finish = () => response.end(last);
    });
    const proxy = await review(upstream.origin, { capture: 'none' });
    let received: ((chunk: Buffer) => void) | undefined;
    const firstChunk = new Promise<Buffer>((done) => { received = done; });
    const pending = readResponse(`${proxy.origin}/page?mode=review`, {
      headers: { Origin: proxy.origin, Referer: `${proxy.origin}/previous`, 'Accept-Encoding': 'gzip' },
    }, undefined, (chunk) => received?.(chunk));
    expect((await firstChunk).toString()).toBe(first);
    finish!();
    const response = await pending;
    expect(response.body.toString()).toMatch(/^<!doctype html>[\s\S]*<\/html>\n<script /);
    expect(response.body.toString()).toContain('src="/__needmark/client.js"');
    expect(response.body.toString()).toContain('nonce="policy-nonce"');
    expect(response.body.toString()).toContain('data-needmark-capture="none"');
    expect(response.body.toString()).toContain(`data-needmark-origins="[&quot;${proxy.origin}&quot;]"`);
    expect(response.headers).toMatchObject({ 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'nonce-policy-nonce'" });
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect(forwarded).toMatchObject({ host: new URL(upstream.origin).host, origin: upstream.origin, referer: `${upstream.origin}/previous`, 'accept-encoding': 'identity' });
  });

  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ] as const)('decompresses %s HTML and reuses an inline script nonce', async (encoding, compress) => {
    const original = '<html><body>日本語の画面<script nonce="inline-nonce">window.ready=true</script></body></html>';
    const compressed = compress(Buffer.from(original));
    const upstream = await developmentServer((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': encoding, 'Content-Length': compressed.length, ETag: 'compressed' });
      response.end(compressed);
    });
    const proxy = await review(upstream.origin);
    const response = await readResponse(proxy.origin);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain(`${original}\n<script `);
    expect(response.body.toString().match(/nonce="inline-nonce"/g)).toHaveLength(2);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
  });

  it('preserves binary, HEAD and request-body traffic while allowing reviews on HTML error pages', async () => {
    const binary = gzipSync(Buffer.from([0, 1, 2, 255, 128]));
    let posted = '';
    const upstream = await developmentServer((incoming, response) => {
      if (incoming.url === '/binary') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' }); response.end(binary); }
      else if (incoming.url === '/missing') { response.writeHead(404, { 'Content-Type': 'text/html' }); response.end('<h1>Missing</h1>'); }
      else if (incoming.method === 'HEAD') { response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 100 }); response.end(); }
      else {
        incoming.on('data', (chunk) => { posted += chunk.toString(); });
        incoming.on('end', () => { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ url: incoming.url, method: incoming.method, posted })); });
      }
    });
    const proxy = await review(upstream.origin);
    const asset = await readResponse(`${proxy.origin}/binary`);
    expect(asset.body).toEqual(binary);
    expect(asset.headers['content-encoding']).toBe('gzip');
    const missing = await readResponse(`${proxy.origin}/missing`);
    expect(missing.status).toBe(404);
    expect(missing.body.toString()).toContain('<h1>Missing</h1>\n<script ');
    expect(missing.body.toString()).toContain('src="/__needmark/client.js"');
    const head = await readResponse(proxy.origin, { method: 'HEAD' });
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe('100');
    const post = await readResponse(`${proxy.origin}/submit?draft=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'review body');
    expect(post.status).toBe(201);
    expect(JSON.parse(post.body.toString())).toEqual({ url: '/submit?draft=1', method: 'POST', posted: 'review body' });
  });

  it('rewrites local redirects and matching cookie domains while preserving external destinations', async () => {
    const upstream = await developmentServer((incoming, response) => {
      response.writeHead(302, { Location: incoming.url === '/external' ? 'https://example.com/login' : incoming.url === '/relative' ? '/login?from=review#form' : `http://localhost:${(upstream.server.address() as AddressInfo).port}/login?from=review#form`,
        'Set-Cookie': ['session=abc; Domain=.localhost; Path=/; HttpOnly; SameSite=Lax', 'other=xyz; Domain=example.com; Secure', 'host=local; Path=/'] });
      response.end();
    }, null);
    const target = upstream.origin.replace('127.0.0.1', 'localhost');
    const proxy = await review(target);
    for (const path of ['/', '/relative']) {
      const response = await readResponse(`${proxy.origin}${path}`);
      expect(response.headers.location).toBe(`${proxy.origin}/login?from=review#form`);
      expect(response.headers['set-cookie']).toEqual(['session=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax', 'other=xyz; Domain=example.com; Secure', 'host=local; Path=/']);
    }
    expect((await readResponse(`${proxy.origin}/external`)).headers.location).toBe('https://example.com/login');
  });

  it('gates the local API by session token, origin and request site before saving feedback', async () => {
    let upstreamRequests = 0;
    const upstream = await developmentServer((_incoming, response) => { upstreamRequests++; response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Review</h1>'); });
    const proxy = await review(upstream.origin, { outputDir: 'reviews' });
    const html = (await readResponse(proxy.origin)).body.toString();
    const token = html.match(/data-needmark-token="([^"]+)"/)![1]!;
    const headers = { 'x-needmark-token': token };
    const endpoint = `${proxy.origin}/__needmark/feedback`;
    for (const denied of [{}, { 'x-needmark-token': 'wrong' }, { ...headers, Origin: 'https://evil.example' }, { ...headers, 'sec-fetch-site': 'cross-site' }, { ...headers, Host: 'evil.example' }]) {
      expect((await readResponse(endpoint, { headers: denied })).status).toBe(403);
    }
    expect((await readResponse(proxy.origin, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect(upstreamRequests).toBe(1);
    const listed = await readResponse(endpoint, { headers });
    expect(JSON.parse(listed.body.toString())).toMatchObject({ feedback: [] });
    const body = { ...input(), url: `${proxy.origin}/products`, screenshot: undefined, capture: { method: 'none', width: 0, height: 0 } };
    expect((await readResponse(endpoint, { method: 'POST', headers, }, JSON.stringify({ ...body, url: `${upstream.origin}/products` }))).status).toBe(400);
    const saved = await readResponse(endpoint, { method: 'POST', headers }, JSON.stringify(body));
    expect(saved.status).toBe(201);
    const feedback = JSON.parse(saved.body.toString()) as { id: string };
    expect(JSON.parse((await readResponse(`${endpoint}/${feedback.id}`, { headers })).body.toString())).toMatchObject({ id: feedback.id, comment: 'Move this button up', url: `${proxy.origin}/products` });
    expect(JSON.parse(await readFile(join(proxy.root, 'reviews', feedback.id, 'context.json'), 'utf8'))).toMatchObject({ id: feedback.id });
    const updated = await readResponse(`${endpoint}/${feedback.id}`, { method: 'PATCH', headers }, JSON.stringify({ status: 'resolved' }));
    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body.toString())).toMatchObject({ status: 'resolved' });
    expect(upstreamRequests).toBe(1);
  });

  it('enriches current JSX locations through fixed upstream maps and keeps missing maps optional', async () => {
    let file = '', missing = false; const assets: string[] = [];
    const upstream = await developmentServer((incoming, response) => {
      if (incoming.url === '/assets/card.js') { assets.push(incoming.url); response.end('//# sourceMappingURL=card.js.map'); }
      else if (incoming.url === '/assets/card.js.map') { assets.push(incoming.url); response.writeHead(missing ? 404 : 200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ version: 3, sources: [pathToFileURL(file).href], names: [], mappings: 'AAAA' })); }
      else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Review</h1>'); }
    });
    const proxy = await review(upstream.origin); await mkdir(join(proxy.root, 'src'));
    file = join(proxy.root, 'src/card.jsx'); await writeFile(file, 'export function ProductCard(){ return <button id="buy">Buy</button> }');
    const html = (await readResponse(proxy.origin)).body.toString();
    expect(html).toContain('data-needmark-runtime-source="true"');
    const token = html.match(/data-needmark-token="([^"]+)"/)![1]!, headers = { 'x-needmark-token': token };
    const body = { elements: [{ tag: 'button', attributes: { id: 'buy' }, frames: [{ url: `${proxy.origin}/assets/card.js`, line: 1, column: 5, component: 'ProductCard' }] }] };
    const endpoint = `${proxy.origin}/__needmark/source`;
    expect((await readResponse(endpoint, { method: 'POST' }, JSON.stringify(body))).status).toBe(403);
    expect(assets).toEqual([]);
    const enriched = await readResponse(endpoint, { method: 'POST', headers }, JSON.stringify(body));
    expect(enriched.status).toBe(200); expect(JSON.parse(enriched.body.toString())).toEqual({ elements: [{ source: { file: 'src/card.jsx', line: 1, column: 39, component: 'ProductCard' } }] });
    expect(assets).toEqual(['/assets/card.js', '/assets/card.js.map']);
    missing = true;
    expect(JSON.parse((await readResponse(endpoint, { method: 'POST', headers }, JSON.stringify(body))).body.toString())).toEqual({ elements: [{}] });
    const feedback = { ...input(), url: proxy.origin, screenshot: undefined, capture: { method: 'none', width: 0, height: 0 } };
    expect((await readResponse(`${proxy.origin}/__needmark/feedback`, { method: 'POST', headers }, JSON.stringify(feedback))).status).toBe(201);
  });

  it('blocks saved-feedback paths and malformed encodings before they reach the development server', async () => {
    let upstreamRequests = 0;
    const upstream = await developmentServer((_incoming, response) => { upstreamRequests++; response.end('private data'); });
    const proxy = await review(upstream.origin, { outputDir: 'reviews' });
    for (const path of ['/reviews', '/reviews/secret.json', '/.needmark/feedback/secret.json', '/%2eneedmark/feedback/secret.json', `/@fs${proxy.root}/reviews/secret.json`, '/%E0%A4%A']) {
      const response = await readResponse(`${proxy.origin}${path}`);
      expect(response.status, path).toBe(403);
      expect(response.body.toString(), path).not.toContain('private data');
    }
    expect(upstreamRequests).toBe(0);
  });

  it('forwards upgrade headers and bytes in both directions and rejects foreign or private upgrades', async () => {
    let upgrades = 0;
    let forwarded: IncomingHttpHeaders | undefined;
    const upstream = await developmentServer((_incoming, response) => { response.end(); });
    upstream.server.on('upgrade', (incoming, socket, head) => {
      upgrades++; forwarded = incoming.headers;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nREADY');
      if (head.length) socket.write(`ECHO:${head.toString()}`);
      socket.on('data', (chunk) => socket.write(`ECHO:${chunk.toString()}`));
    });
    const proxy = await review(upstream.origin);
    const headers = { Origin: proxy.origin, Referer: `${proxy.origin}/page` };
    const tunnel = await rawUpgrade(proxy.origin, '/hmr?session=1', headers, 'early', 'ECHO:early');
    expect(tunnel.data).toContain('HTTP/1.1 101 Switching Protocols');
    expect(tunnel.data).toContain('READY');
    expect(forwarded).toMatchObject({ host: new URL(upstream.origin).host, origin: upstream.origin, referer: `${upstream.origin}/page` });
    const echoed = new Promise<string>((done) => tunnel.socket.once('data', (chunk) => done(chunk.toString())));
    tunnel.socket.write('later');
    expect(await echoed).toContain('ECHO:later');
    for (const [path, origin] of [['/hmr', 'https://evil.example'], ['/__needmark/feedback', proxy.origin], ['/.needmark/feedback/secret', proxy.origin]]) {
      expect((await rawUpgrade(proxy.origin, path!, { Origin: origin! })).data).toContain('HTTP/1.1 403 Forbidden');
    }
    expect(upgrades).toBe(1);
    const closed = new Promise<void>((done) => tunnel.socket.once('close', () => done()));
    const closing = proxy.close();
    expect(proxy.close()).toBe(closing);
    await closing;
    await closed;
    expect(proxy.server.listening).toBe(false);
  });

  it('returns 502 when the upstream is unavailable or uses unsupported HTML compression', async () => {
    const unavailable = await review(await availableOrigin());
    expect((await readResponse(unavailable.origin)).status).toBe(502);
    expect((await rawUpgrade(unavailable.origin, '/hmr', { Origin: unavailable.origin })).data).toContain('HTTP/1.1 502 Bad Gateway');
    const upstream = await developmentServer((_incoming, response) => { response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'zstd' }); response.end('compressed'); });
    const proxy = await review(upstream.origin);
    const response = await readResponse(proxy.origin);
    expect(response.status).toBe(502);
    expect(response.body.toString()).not.toContain('data-needmark-token');
  });

  it('closes an unfinished upstream response when the reviewer disconnects', async () => {
    let upstreamClosed: (() => void) | undefined;
    const closed = new Promise<void>((done) => { upstreamClosed = done; });
    const upstream = await developmentServer((_incoming, response) => {
      response.once('close', () => upstreamClosed?.());
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.write('<html><body>Still streaming');
    });
    const proxy = await review(upstream.origin);
    await new Promise<void>((done, reject) => {
      const pending = request(proxy.origin, (response) => {
        response.on('error', () => { /* The client deliberately interrupts this response. */ });
        response.once('data', () => { response.destroy(); done(); });
      });
      pending.on('error', reject);
      pending.setTimeout(3_000, () => pending.destroy(new Error('Response did not stream')));
      pending.end();
    });
    await closed;
  });

  it('rejects non-loopback, non-exact, same-origin and public-output configuration', async () => {
    const target = await availableOrigin();
    const origin = await availableOrigin();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'needmark-proxy-options-')));
    folders.push(root);
    for (const invalid of [
      { target: 'https://127.0.0.1:12345' }, { target: 'http://example.com:12345' }, { target: `${target}/page` }, { target: `${target}/` },
      { origin: 'http://example.com:12345' }, { origin: 'https://127.0.0.1:12345' }, { origin: 'http://127.0.0.1' }, { origin: 'http://127.0.0.1:0' }, { origin: `${origin}/` },
      { origin: target }, { outputDir: '.' }, { outputDir: 'public' }, { outputDir: 'public/feedback' },
    ]) {
      const started = startReviewProxy({ target, origin, root, ...invalid }).then((proxy) => {
        cleanup.push(() => proxy.close());
        return proxy;
      });
      await expect(started).rejects.toThrow();
    }
  });
});


it('passes optional editor and normalized context identifiers through the standalone proxy without changing upstream sources', async () => {
  const upstream = await developmentServer((_incoming, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html><body>Local source</body></html>'); });
  const proxy = await review(upstream.origin, { editor: 'cursor', contextAttributes: ['data-review-key', 'data-review-key'] });
  await writeFile(join(proxy.root, 'Card.tsx'), '<button />');
  const html = await (await fetch(proxy.origin)).text();
  expect(html).toContain('data-needmark-editor="cursor"');
  expect(html).toContain('data-needmark-context-attributes="[&quot;data-review-key&quot;]"');
  const token = html.match(/data-needmark-token="([^"]+)"/)![1]!;
  const result = await fetch(`${proxy.origin}/__needmark/editor`, { method: 'POST', headers: { 'x-needmark-token': token }, body: JSON.stringify({ file: 'Card.tsx', line: 1, column: 1 }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ url: `cursor://file${join(proxy.root, 'Card.tsx')}:1:1` });
  expect(await readFile(join(proxy.root, 'Card.tsx'), 'utf8')).toBe('<button />');
});


it('passes configured runtime identifying attributes through the protected proxy resolver', async () => {
  let file = ''; const fetched: string[] = [];
  const upstream = await developmentServer((incoming,response) => {
    if (incoming.url === '/assets/card.js') { fetched.push(incoming.url); response.end('//# sourceMappingURL=card.js.map'); }
    else if (incoming.url === '/assets/card.js.map') { fetched.push(incoming.url); response.writeHead(200,{'Content-Type':'application/json'}); response.end(JSON.stringify({version:3,sources:[pathToFileURL(file).href],names:[],mappings:'AAAA'})); }
    else { response.writeHead(200,{'Content-Type':'text/html'}); response.end('<h1>Review</h1>'); }
  });
  const proxy = await review(upstream.origin,{contextAttributes:['data-ticket','data-ticket','id']});
  file=join(proxy.root,'Card.jsx'); await writeFile(file,'export function ProductCard(){ return <button data-ticket="buy" data-browser-only="other"/> }');
  const html=(await readResponse(proxy.origin)).body.toString();
  expect(html).toContain('data-needmark-context-attributes="[&quot;data-ticket&quot;]"');
  const token=html.match(/data-needmark-token="([^"]+)"/)![1]!, endpoint=`${proxy.origin}/__needmark/source`;
  const body={elements:[{tag:'button',attributes:{'data-ticket':'buy'},frames:[{url:`${proxy.origin}/assets/card.js`,line:1,column:5,component:'ProductCard'}]}]};
  expect((await readResponse(endpoint,{method:'POST'},JSON.stringify(body))).status).toBe(403); expect(fetched).toEqual([]);
  const response=await readResponse(endpoint,{method:'POST',headers:{'x-needmark-token':token}},JSON.stringify(body));
  expect(response.status).toBe(200); expect(JSON.parse(response.body.toString())).toEqual({elements:[{source:{file:'Card.jsx',line:1,column:39,component:'ProductCard'}}]});
  const browserOnly={contextAttributes:['data-browser-only'],elements:[{...body.elements[0]!,attributes:{'data-browser-only':'other'}}]};
  const hint=await readResponse(endpoint,{method:'POST',headers:{'x-needmark-token':token}},JSON.stringify(browserOnly));
  expect(hint.status).toBe(200); expect(JSON.parse(hint.body.toString())).toEqual({elements:[{sourceHint:{file:'Card.jsx',component:'ProductCard'}}]});
  expect(await readFile(file,'utf8')).toBe('export function ProductCard(){ return <button data-ticket="buy" data-browser-only="other"/> }');

});


it('rejects invalid identifying attribute configuration before starting a review proxy', async () => {
  let upstreamRequests=0;
  const upstream=await developmentServer((_incoming,response)=>{upstreamRequests++;response.end('Review');});
  await expect(review(upstream.origin,{contextAttributes:['value']})).rejects.toThrow('unsupported attribute name');
  expect(upstreamRequests).toBe(0);
});
