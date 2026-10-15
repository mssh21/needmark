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
