import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureMethod } from '../shared/types.js';
import { defaultFeedbackDirectory } from './storage.js';
import { isNeedMarkLanguage, type NeedMarkLanguage } from '../shared/language.js';

export interface InitOptions { capture: CaptureMethod; share: 'local' | 'git'; language?: NeedMarkLanguage }

export async function initialize(directory: string, options: InitOptions): Promise<void> {
  if (options.language !== undefined && !isNeedMarkLanguage(options.language)) throw new Error('Invalid NeedMark language. Use en or ja.');
  if (!['dom', 'tab', 'none'].includes(options.capture) || !['local', 'git'].includes(options.share)) throw new Error('Invalid initialization choice.');
  const outputDir = defaultFeedbackDirectory(directory), storage = outputDir.split('/')[0]!;
  // The comments name what each value does, because the file is where people come back to change a choice made during setup.
  // 初期設定で選んだ値を後から変えるときに見るのはこのファイルのため、各値の意味をコメントで残す。
  const config = `import type { NeedMarkOptions } from 'needmark';

export default {
  // Set enabled: false to turn NeedMark off for everyone; NEEDMARK=off does it for one person or run.
  // Review screen language: 'en' or 'ja'.
  language: ${JSON.stringify(options.language ?? 'ja')},
  // Screenshots: 'dom' redraws the page (no permission prompt), 'tab' records this browser tab (asks once to share it), 'none' takes no image.
  capture: ${JSON.stringify(options.capture)},
  outputDir: '${outputDir}',
} satisfies NeedMarkOptions;
`;
  const configPath = join(directory, 'needmark.config.ts');
  if (!existsSync(configPath) && existsSync(join(directory, 'needback.config.ts'))) throw new Error('Existing needback.config.ts is still supported. Rename it to needmark.config.ts before initializing again.');
  // The exclusive `wx` flag refuses an existing file atomically, unlike an exists check followed by a write.
  // 存在確認してから書く方法と違い、`wx`フラグなら既存ファイルを原子的に拒否できる。
  await writeFile(configPath, config, { flag: 'wx' });
  const ignorePath = join(directory, '.gitignore');
  let current = '';
  try { current = await readFile(ignorePath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rules = options.share === 'local'
    ? `# NeedMark: keep review feedback local\n/${storage}/\n`
    : `# NeedMark: share only review feedback\n!/${storage}/\n/${storage}/*\n!/${outputDir}/\n!/${outputDir}/**\n`;
  await writeFile(ignorePath, current + (current && !current.endsWith('\n') ? '\n' : '') + rules);
}
