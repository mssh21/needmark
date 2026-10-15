import { lstat, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import type { NeedMarkOptions } from '../shared/types.js';

/** See docs/architecture.md#initial-setup-and-preferences. / 仕様は docs/architecture.md#initial-setup-and-preferences を参照。 */
export async function loadProjectConfig(directory = process.cwd()): Promise<Partial<NeedMarkOptions>> {
  let name = 'needmark.config.ts';
  try {
    let file;
    for (const candidate of ['needmark.config.ts', 'needback.config.ts']) {
      name = candidate;
      // lstat makes a dangling needmark.config.ts symlink fail loudly instead of silently falling back to the legacy config.
      // lstatを使い、リンク切れのneedmark.config.tsが旧設定へ黙って切り替わらず、明示的に失敗するようにする。
      try { file = await lstat(resolve(directory, name)); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!file) return {};
    if (file.isSymbolicLink()) file = await stat(resolve(directory, name));
    if (!file.isFile()) throw new Error(`${name} must be a file.`);
    // jiti loads a TypeScript config without a build step; tryNative=false gives the same result on Node versions with and
    // without built-in type stripping, and interopDefault=false lets us detect a missing default export. moduleCache=false
    // matters for the Vite plugin, whose factory runs again in the same process when Vite restarts and would otherwise get
    // the first import's settings.
    // jitiならビルドなしでTypeScriptの設定を読める。tryNative=falseで型除去機能の有無にかかわらずNodeの版で結果を揃え、
    // interopDefault=falseでdefault exportの欠落を検出できるようにする。Viteの再起動では同じプロセスでプラグインの
    // ファクトリーが再実行されるため、moduleCache=falseにしないと最初に読み込んだ設定が返ってしまう。
    const module = await createJiti(import.meta.url, { interopDefault: false, tryNative: false, moduleCache: false }).import<unknown>(resolve(directory, name));
    const settings = module && typeof module === 'object' && Object.hasOwn(module, 'default') ? (module as { default: unknown }).default : undefined;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('The default export must be a settings object.');
    return settings as Partial<NeedMarkOptions>;
  } catch (error) {
    throw new Error(`Could not load ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
