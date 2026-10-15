import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function reviewScriptTag(attrs: Record<string, string | boolean>): string {
  return `\n<script ${Object.entries(attrs).map(([key, value]) => value === true ? key : `${key}="${escapeAttribute(String(value))}"`).join(' ')}></script>\n`;
}

// Frameworks such as Astro render pages in their own middleware and never call transformIndexHtml, so the script is appended after the
// last chunk of their HTML response instead; browsers still run a script after </html>, and the stream is neither buffered nor parsed.
// AstroなどはページをVite独自のミドルウェアで描画しtransformIndexHtmlを呼ばないため、HTMLレスポンスの最後のチャンクの後に追記する。
// </html>の後のscriptもブラウザは実行し、ストリームをバッファも解析もしない。
export function appendReviewScript(response: ServerResponse, attrs: Record<string, string | boolean>, skip: () => boolean): void {
  let html: boolean | undefined;
  const decide = () => {
    if (html !== undefined) return html;
    const type = String(response.getHeader('content-type') ?? ''), encoding = String(response.getHeader('content-encoding') ?? 'identity');
    html = (response.statusCode === 200 || response.statusCode >= 400) && /\btext\/html\b/i.test(type) && encoding === 'identity' && !skip();
    // The appended script changes the body, so a declared length would cut it off.
    // 追記したscriptで本文が変わるため、宣言済みの長さのままだと途中で切れてしまう。
    if (html) response.removeHeader('content-length');
    return html;
  };
  const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
  // Headers passed to writeHead skip getHeader, so they are stored first; raw header arrays are left alone and never get the script.
  // writeHeadに渡したヘッダーはgetHeaderで読めないため先に保存する。生のヘッダー配列はそのまま渡し、scriptも追加しない。
  response.writeHead = ((status: number, ...rest: unknown[]) => {
    const reason = typeof rest[0] === 'string' ? rest.shift() as string : undefined, headers = rest[0];
    if (Array.isArray(headers)) { html = false; return writeHead(status, ...(reason === undefined ? [] : [reason]), headers); }
    for (const [name, value] of Object.entries((headers ?? {}) as OutgoingHttpHeaders)) if (value !== undefined) response.setHeader(name, value);
    response.statusCode = status; decide();
    return reason === undefined ? writeHead(status) : writeHead(status, reason);
  }) as typeof response.writeHead;
  const write = response.write.bind(response) as (...args: unknown[]) => boolean;
  response.write = ((...args: unknown[]) => { if (!response.headersSent) decide(); return write(...args); }) as typeof response.write;
  const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
  response.end = ((...args: unknown[]) => {
    if (!response.headersSent) decide();
    if (!html || typeof args[0] === 'function') return html ? end(reviewScriptTag(attrs), args[0]) : end(...args);
    const callback = args.find((value) => typeof value === 'function');
    if (args[0] !== undefined && args[0] !== null) write(...args.filter((value) => typeof value !== 'function'));
    return callback ? end(reviewScriptTag(attrs), callback) : end(reviewScriptTag(attrs));
  }) as typeof response.end;
}
