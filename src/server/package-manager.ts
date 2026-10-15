import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const runners: [lockfile: string, command: string][] = [['pnpm-lock.yaml', 'pnpm exec needmark'], ['yarn.lock', 'yarn needmark'], ['package-lock.json', 'npx needmark']];

/** See docs/architecture.md#package-managers. / 仕様は docs/architecture.md#package-managers を参照。 */
export function needmarkCommand(from: string): string {
  // The lockfile, not npm_config_user_agent, decides: prompts are read later by an agent in a shell no package manager started.
  // npm_config_user_agentではなくロックファイルで判定する。プロンプトは後で、パッケージマネージャーを経由しないシェルのエージェントが読むため。
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const found = runners.find(([lockfile]) => existsSync(join(directory, lockfile)));
    if (found) return found[1];
    if (dirname(directory) === directory) return 'npx needmark';
  }
}
