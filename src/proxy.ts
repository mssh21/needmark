import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { resolve, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Socket } from 'node:net';
import { createReviewApi } from './server/review-api.js';
import { createRuntimeSourceResolver } from './server/runtime-source.js';
import { reviewScriptTag } from './server/review-script.js';
import { defaultFeedbackDirectory } from './server/storage.js';
import type { CaptureMethod, NeedMarkOptions } from './shared/types.js';

/** Specified in docs/getting-started.md#nextjs-and-other-development-servers. / 仕様は docs/getting-started.ja.md#nextjsなどの開発サーバー を参照。 */
export interface ReviewProxyOptions extends Pick<NeedMarkOptions, 'onFeedbackChange' | 'onSubmit' | 'editor' | 'contextAttributes' | 'language'> {
  target: string;
  origin: string;
  capture?: CaptureMethod;
  outputDir?: string;
  root?: string;
}
export interface ReviewProxy { server: Server; origin: string; close(): Promise<void> }
const loopback = (url: URL) => url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

// Appending after the last chunk streams HTML without buffering or parsing it; browsers still run a script after </html>.
// The 2 KB tail finds a CSP nonce split across chunk boundaries without keeping the whole document.
// 最後のチャンクの後に追記すれば、HTMLをバッファも解析もせずにストリームできる（</html>の後のscriptもブラウザは実行する）。
// 末尾2KBだけ保持すれば、チャンク境界で分かれたCSPのnonceも文書全体を持たずに見つけられる。
function injectReview(attrs: Record<string, string | boolean>, policy?: string): Transform {
  let tail = '', nonce = policy?.match(/'nonce-([^']+)'/)?.[1];
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!nonce) { const text = tail + chunk.toString('utf8'); nonce = text.match(/<script\b[^>]*\bnonce\s*=\s*["']([^"']+)["']/i)?.[1]; tail = text.slice(-2048); }
      callback(null, chunk);
    },
    flush(callback) {
      this.push(reviewScriptTag({ ...attrs, ...(nonce ? { nonce } : {}) })); callback();
    },
  });
}

/** See docs/architecture.md#local-review-proxy. / 仕様は docs/architecture.md#local-review-proxy を参照。 */
export async function startReviewProxy(options: ReviewProxyOptions): Promise<ReviewProxy> {
  const target = new URL(options.target), origin = new URL(options.origin);
  if (!loopback(target) || options.target !== target.origin || !loopback(origin) || options.origin !== origin.origin || !origin.port || Number(origin.port) === 0 || target.port === '0') throw new Error('Review proxy target/origin must be exact loopback HTTP origins; origin requires a port.');
  if (target.origin === origin.origin) throw new Error('Review proxy target must differ from its origin.');
  const root = resolve(options.root ?? process.cwd()), output = resolve(root, options.outputDir ?? defaultFeedbackDirectory(root));
  const publicPath = relative(resolve(root, 'public'), output);
  if (output === root || publicPath === '' || publicPath !== '..' && !publicPath.startsWith(`..${sep}`) && !publicPath.startsWith(sep)) throw new Error('Review proxy outputDir must be a dedicated folder outside public.');
  const runtimeSource = createRuntimeSourceResolver({ root, target: target.origin, origins: [origin.origin], outputDir: output, contextAttributes: options.contextAttributes });
  const api = createReviewApi({ runtimeSource, origins: [origin.origin], capture: options.capture, language: options.language, root, outputDir: output, onFeedbackChange: options.onFeedbackChange, onSubmit: options.onSubmit, editor: options.editor, contextAttributes: options.contextAttributes, logger: { error: (message) => console.error(message) } });
  const sockets = new Set<Socket>();
  function permitted(request: IncomingMessage) { return request.headers.host === origin.host && (!request.headers.origin || request.headers.origin === origin.origin); }
  function upstreamHeaders(request: IncomingMessage): OutgoingHttpHeaders {
    // Asking for identity keeps the common case cheap; HTML is still decoded below because servers may ignore the request.
    // 無圧縮を要求して通常は展開処理を省く。ただしサーバーが無視する場合に備え、HTMLは下で展開する。
    const headers: OutgoingHttpHeaders = { ...request.headers, host: target.host, 'accept-encoding': 'identity' };
    if (headers.origin === origin.origin) headers.origin = target.origin;
    if (typeof headers.referer === 'string' && headers.referer.startsWith(`${origin.origin}/`)) headers.referer = `${target.origin}${headers.referer.slice(origin.origin.length)}`;
    return headers;
  }
  function blockedPath(path: string) {
    // Fail closed; a path that cannot be decoded cannot be proven to stay outside feedback storage.
    // デコードできないパスは保存先の外だと証明できないため、安全側に倒して拒否する。
    let decoded: string; try { decoded = decodeURIComponent(path); } catch { return true; }
    const local = relative(root, output).replaceAll('\\', '/');
    return decoded === `/${local}` || decoded.startsWith(`/${local}/`) || decoded.includes(output.replaceAll('\\', '/')) || decoded.split('/').some((segment) => segment === '.needmark' || segment === '.needback');
  }
  function reject(response: ServerResponse, status = 403) { response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(status === 403 ? 'Origin or feedback path is not allowed' : 'Development server is unavailable'); }
  const server = createServer((request, response) => {
    if (!permitted(request)) { reject(response); return; }
    if (api.handle(request, response)) return;
    const url = new URL(request.url ?? '/', origin);
    if (blockedPath(url.pathname)) { reject(response); return; }
    const upstream = httpRequest(target, { method: request.method, path: url.pathname + url.search, headers: upstreamHeaders(request) }, (result) => {
      const headers = { ...result.headers };
      if (headers.location) { try { const redirect = new URL(headers.location, target); if (redirect.origin === target.origin) headers.location = `${origin.origin}${redirect.pathname}${redirect.search}${redirect.hash}`; } catch { /* An unparsable Location is the app's own concern; rewriting it could break the redirect. / 解析できないLocationはアプリ側の値なので、書き換えずに渡す。 */ } }
      // A cookie scoped to the target host would never be sent back through the review origin, breaking app sessions.
      // 対象ホストに限定されたCookieはレビュー用オリジン経由で送り返されず、アプリのセッションが切れるため。
      if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map((cookie) => cookie.replace(/(;\s*Domain=)([^;]+)/i, (match, prefix: string, domain: string) => domain.replace(/^\./, '').toLowerCase() === target.hostname.replace(/^\[|\]$/g, '').toLowerCase() ? `${prefix}${origin.hostname.replace(/^\[|\]$/g, '')}` : match));
      const html = request.method !== 'HEAD' && !!result.statusCode && (result.statusCode === 200 || result.statusCode >= 400) && /\btext\/html\b/i.test(headers['content-type'] ?? '');
      let stream: NodeJS.ReadableStream = result;
      if (html) {
        const encoding = headers['content-encoding'];
        if (encoding && !['gzip', 'deflate', 'br', 'identity'].includes(encoding)) { result.destroy(); reject(response, 502); return; }
        if (encoding && encoding !== 'identity') { const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : createInflate(); decoder.on('error', () => response.destroy()); stream = result.pipe(decoder); }
        // The body is decoded and extended, so upstream length/ETag would be wrong; the injected script carries a per-server token that must not be cached.
        // 本文を展開・追記するため上流の長さとETagは不正確になる。追記するscriptはサーバーごとのトークンを含むためキャッシュさせない。
        delete headers['content-encoding']; delete headers['content-length']; delete headers.etag;
        headers['cache-control'] = 'no-store';
        const policy = headers['content-security-policy'];
        const injection = injectReview(api.scriptAttrs, Array.isArray(policy) ? policy.join(';') : policy);
        injection.on('error', () => response.destroy()); stream = stream.pipe(injection);
      }
      response.writeHead(result.statusCode ?? 502, result.statusMessage, headers);
      result.on('error', () => response.destroy()); stream.pipe(response);
    });
    upstream.on('error', () => { if (response.headersSent) response.destroy(); else reject(response, 502); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  // server.close() waits for keep-alive and HMR sockets, so the proxy tracks and destroys them to stop promptly.
  // server.close()はkeep-aliveやHMRのソケットが閉じるまで待つため、追跡して破棄し、すぐ停止できるようにする。
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    if (!permitted(request) || (request.headers.origin && request.headers.origin !== origin.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname.startsWith('/__needmark') || blockedPath(url.pathname)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = httpRequest(target, { path: url.pathname + url.search, headers: upstreamHeaders(request) });
    upstream.on('upgrade', (result, peer, peerHead) => {
      socket.write(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\n${Object.entries(result.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`)).join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head); if (peerHead.length) socket.write(peerHead);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy()); socket.pipe(peer).pipe(socket);
    });
    upstream.on('response', (result) => { result.resume(); socket.end(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\nContent-Length: 0\r\n\r\n`); });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
    socket.on('close', () => upstream.destroy()); upstream.end();
  });
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(Number(origin.port), origin.hostname.replace(/^\[|\]$/g, ''), () => { server.removeListener('error', reject); ready(); }); });
  let closing: Promise<void> | undefined;
  return { server, origin: origin.origin, close: () => closing ??= new Promise<void>((done, reject) => { sockets.forEach((socket) => socket.destroy()); server.close((error) => error ? reject(error) : done()); }) };
}
