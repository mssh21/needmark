import type { NeedMarkOptions } from '../shared/types.js';

const off = ['0', 'off', 'false', 'no'], on = ['1', 'on', 'true', 'yes'];

/** See docs/getting-started.md#turn-needmark-off. / 仕様は docs/getting-started.ja.md#needmarkを止める を参照。 */
export function needmarkEnabled(settings: Pick<NeedMarkOptions, 'enabled'>, env: NodeJS.ProcessEnv = process.env): boolean {
  // The variable wins over the shared config so one person can opt out, or back in, without editing a committed file.
  // 共有の設定より環境変数を優先し、コミット済みのファイルを書き換えずに一人だけ止めたり戻したりできるようにする。
  const value = env.NEEDMARK?.trim().toLowerCase();
  if (value && off.includes(value)) return false;
  if (value && on.includes(value)) return true;
  return settings.enabled !== false;
}
