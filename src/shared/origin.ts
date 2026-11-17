// Hostnames rather than full origins, because Vite may move to another port when the configured one is taken and the
// plugin cannot know the final port before it transforms modules. A DNS-rebinding page still sends its own hostname.
// Viteは設定したポートが使用中だと別のポートへ移り、プラグインはモジュール変換前に最終ポートを知れないため、オリジンではなく
// ホスト名で判定する。DNSリバインディングを使うページは自分のホスト名を送るので、この判定で防げる。
export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export function isAllowedOrigin(origin: string, origins?: readonly string[]): boolean {
  if (origins) return origins.includes(origin);
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && LOOPBACK_HOSTNAMES.includes(url.hostname);
  } catch { return false; } /* A malformed Host header must be refused, not crash the request. / 不正なHostヘッダーで要求処理を落とさず、拒否する。 */
}

// Over HTTP/2 (Vite's default for https without a proxy) the host arrives as the :authority pseudo-header and `host` may be absent,
// which would make the origin "https://" and refuse every page; Vite's own host check reads both the same way.
// HTTP/2（proxyなしのhttpsでのViteの既定）ではホストが:authority疑似ヘッダーで届き、hostが無いことがある。
// そのままではオリジンが"https://"になり全ページを拒否してしまうため、Vite自身のホスト検査と同じく両方を読む。
export function requestOrigin(request: { headers: Record<string, string | string[] | undefined> }, secure: boolean): string {
  const host = request.headers[':authority'] ?? request.headers.host;
  return `${secure ? 'https' : 'http'}://${Array.isArray(host) ? host[0] : host ?? ''}`;
}
