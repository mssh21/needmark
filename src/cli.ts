#!/usr/bin/env node
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout } from 'node:timers/promises';
import { initialize, type InitOptions } from './server/init.js';
import { loadProjectConfig } from './server/config.js';
import { startReviewProxy } from './proxy.js';
import { defaultFeedbackDirectory, FeedbackStore } from './server/storage.js';
import { formatFeedbackPrompt, type PromptDetail } from './shared/prompt.js';
import type { CaptureMethod, FeedbackStatus } from './shared/types.js';
import { isNeedMarkLanguage, type NeedMarkLanguage } from './shared/language.js';
import { NeedMarkMcp, serveMcp } from './server/mcp.js';
import { needmarkCommand } from './server/package-manager.js';
import { readFileSync } from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const help = `NeedMark commands / NeedMarkのコマンド
needmark dev --target=http://localhost:3000 [--origin=http://localhost:4190] [--capture=dom|tab|none] [--directory=.needmark/feedback]
needmark init [--language=en|ja] [--share=local|git] [--capture=dom|tab|none]
needmark list [directory]
needmark export [directory] [--detail compact|standard|detailed|forensic]
needmark watch [directory]
needmark mcp [directory]
needmark resolve <id> [directory]
needmark reopen <id> [directory]
needmark reply <id> <comment> [--author name] [--directory path]
needmark edit <id> <comment> [directory]
needmark delete <id> [directory]`;

let language: NeedMarkLanguage = 'ja';
let promptLanguage: NeedMarkLanguage | undefined;
const message = (en: string, ja: string) => language === 'en' ? en : ja;
const invalidLanguage = 'Invalid NeedMark language. Use en or ja. / 言語にはenまたはjaを指定してください。';
async function projectSettings() {
  const settings = await loadProjectConfig();
  if (settings.language !== undefined && !isNeedMarkLanguage(settings.language)) throw new Error(invalidLanguage);
  language = settings.language ?? 'ja';
  promptLanguage = settings.language;
  return settings;
}
const storeAt = (directory: string) => new FeedbackStore(resolve(directory));
async function feedbackDirectory(directory?: string): Promise<string> { return directory ?? (await projectSettings()).outputDir ?? defaultFeedbackDirectory(process.cwd()); }

async function watch(store: FeedbackStore) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let previous = new Map<string, string>();
  let initial = true;
  try {
    while (!controller.signal.aborted) {
      const items = await store.list();
      const current = new Map(items.map((item) => [item.id, JSON.stringify(item)]));
      if (initial) {
        console.log(JSON.stringify({ event: 'snapshot', directory: store.directory, feedback: items }));
        initial = false;
      } else {
        for (const item of items) if (previous.get(item.id) !== current.get(item.id)) {
          console.log(JSON.stringify({ event: previous.has(item.id) ? 'updated' : 'created', feedback: item,
            files: `${store.directory}/${item.id}` }));
        }
        for (const id of previous.keys()) if (!current.has(id)) console.log(JSON.stringify({ event: 'deleted', id }));
      }
      previous = current;
      await setTimeout(1000, undefined, { signal: controller.signal });
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

try {
  if (command === 'dev') {
    const values: { target?: string; origin?: string; capture?: CaptureMethod; directory?: string } = {};
    for (let index = 0; index < args.length; index++) {
      const match = args[index]!.match(/^--(target|origin|capture|directory)(?:=(.*))?$/);
      if (!match) throw new Error(message(`Unknown argument: ${args[index]}`, `不明な引数: ${args[index]}`));
      const key = match[1] as keyof typeof values;
      const value = match[2] ?? args[++index];
      if (!value || values[key] !== undefined) throw new Error(message(`Missing or duplicate ${key} option`, `${key}の値がないか、重複しています。`));
      Object.assign(values, { [key]: value });
    }
    if (!values.target) throw new Error(message('The dev command requires --target=http://localhost:<port>', 'devには--target=http://localhost:<port>が必要です。'));
    const settings = await projectSettings();
    const proxy = await startReviewProxy({ target: values.target, origin: values.origin ?? 'http://localhost:4190',
      capture: values.capture ?? settings.capture, outputDir: values.directory ?? settings.outputDir,
      language: settings.language,
      editor: settings.editor, contextAttributes: settings.contextAttributes, onFeedbackChange: settings.onFeedbackChange, onSubmit: settings.onSubmit });
    const stop = () => { void proxy.close().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log(`NeedMark review: ${proxy.origin}\n${message('Development server', '開発サーバー')}: ${values.target}`);
    console.log(message('Open the review URL to leave feedback. Press Ctrl+C to stop the review proxy.', 'レビューURLを開いてコメントを残してください。Ctrl+Cでレビュープロキシを停止します。'));
    try { await new Promise<void>((done) => proxy.server.once('close', () => done())); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else if (command === 'init') {
    const choices: Partial<InitOptions> = {};
    for (let index = 0; index < args.length; index++) {
      const match = args[index]!.match(/^--(share|capture|language)(?:=(.*))?$/);
      if (!match) throw new Error(message(`Unknown argument: ${args[index]}`, `不明な引数: ${args[index]}`));
      const key = match[1] as keyof InitOptions;
      const value = match[2] ?? args[++index];
      if (!value || choices[key] !== undefined) throw new Error(message(`Missing or duplicate ${key} option`, `${key}の値がないか、重複しています。`));
      if (key === 'language') {
        if (!isNeedMarkLanguage(value)) throw new Error(invalidLanguage);
        language = value;
      }
      Object.assign(choices, { [key]: value });
    }
    language = choices.language ?? 'ja';
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const selected = choices.language ?? ((await terminal.question('Language / 言語: en (English) or ja (日本語) [ja]: ')).trim() || 'ja');
        if (!isNeedMarkLanguage(selected)) throw new Error(invalidLanguage);
        language = choices.language = selected;
        choices.share ??= ((await terminal.question(message('Feedback storage: local or git [local]: ', 'コメントの保存先: local（ローカル）またはgit（共有） [local]: '))).trim() || 'local') as InitOptions['share'];
        choices.capture ??= ((await terminal.question(message('Screenshots: dom, tab or none [dom]: ', 'スクリーンショット: dom、tab、none [dom]: '))).trim() || 'dom') as InitOptions['capture'];
      } finally { terminal.close(); }
    }
    const options: InitOptions = { share: 'local', capture: 'dom', language, ...choices };
    await initialize(process.cwd(), options);
    console.log(message(`Created needmark.config.ts; language: ${language}; feedback storage: ${options.share}; capture: ${options.capture}.`, `needmark.config.tsを作成しました。言語: ${language}、コメントの保存先: ${options.share}、キャプチャ: ${options.capture}。`));
    console.log(message("In vite.config.ts, import { needmark } from 'needmark' and add needmark() to plugins; it loads needmark.config.ts.", "vite.config.tsでimport { needmark } from 'needmark'を追加し、pluginsにneedmark()を設定してください。needmark.config.tsを読み込みます。"));
    const command = needmarkCommand(process.cwd());
    console.log(message(`For a development server at http://localhost:3000, run ${command} dev --target=http://localhost:3000; open http://localhost:4190 for review. Shared settings are loaded from needmark.config.ts.`, `開発サーバーがhttp://localhost:3000の場合、${command} dev --target=http://localhost:3000を実行し、http://localhost:4190を開いてレビューします。共通設定はneedmark.config.tsから読み込みます。`));
  } else if (command === 'list'  || command === 'watch') {
    if (args.length > 1) throw new Error(message('Expected an optional feedback directory', '引数はコメントの保存先のみ指定できます。'));
    const store = storeAt(await feedbackDirectory(args[0]));
    if (command === 'watch') await watch(store);
    else console.log(JSON.stringify((await store.list()).map((item) => ({ ...item, files: `${store.directory}/${item.id}` })), null, 2));
  } else if (command === 'mcp') {
    if (args.length > 1) throw new Error(message('Expected an optional feedback directory', '引数はコメントの保存先のみ指定できます。'));
    const directory = await feedbackDirectory(args[0]);
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    await serveMcp(new NeedMarkMcp(storeAt(directory), promptLanguage), process.stdin, process.stdout, version);
  } else if (command === 'export') {
    let directory: string | undefined;
    let detail: PromptDetail = 'standard';
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--detail') {
        const value = args[++index];
        if (!['compact', 'standard', 'detailed', 'forensic'].includes(value ?? '')) throw new Error(message('Invalid export detail', 'エクスポートの詳細度が不正です。'));
        detail = value as PromptDetail;
      } else if (!directory && !arg.startsWith('--')) directory = arg;
      else throw new Error(message(`Unknown argument: ${arg}`, `不明な引数: ${arg}`));
    }
    directory = await feedbackDirectory(directory);
    const store = storeAt(directory);
    console.log(formatFeedbackPrompt(await store.list(), directory, detail, promptLanguage, false, needmarkCommand(directory)));
  } else if ((command === 'resolve' || command === 'reopen') && args[0]) {
    if (args.length > 2) throw new Error(message('Expected an ID and optional feedback directory', 'IDと任意のコメント保存先を指定してください。'));
    const status: FeedbackStatus = command === 'resolve' ? 'resolved' : 'open';
    await storeAt(await feedbackDirectory(args[1])).setStatus(args[0], status);
    console.log(`${args[0]}: ${message(status, status === 'resolved' ? '解決済み' : '未対応')}`);
  } else if (command === 'reply' && args[0] && args[1]) {
    let author = 'Agent';
    let directory: string | undefined;
    for (let index = 2; index < args.length; index += 2) {
      if (!args[index + 1]) throw new Error(message('Missing option value', 'オプションの値がありません。'));
      if (args[index] === '--author') author = args[index + 1]!;
      else if (args[index] === '--directory') directory = args[index + 1];
      else throw new Error(message(`Unknown option: ${args[index]}`, `不明なオプション: ${args[index]}`));
    }
    const feedback = await storeAt(await feedbackDirectory(directory)).addReply(args[0], { author: author.trim() || 'Agent', comment: args[1] });
    console.log(JSON.stringify(feedback.replies!.at(-1), null, 2));
  } else if (command === 'edit' && args[0] && args[1]) {
    if (args.length > 3) throw new Error(message('Expected an ID, comment and optional feedback directory', 'ID、コメント本文、任意の保存先を指定してください。'));
    console.log(JSON.stringify(await storeAt(await feedbackDirectory(args[2])).update(args[0], { comment: args[1] }), null, 2));
  } else if (command === 'delete' && args[0]) {
    if (args.length > 2) throw new Error(message('Expected an ID and optional feedback directory', 'IDと任意のコメント保存先を指定してください。'));
    await storeAt(await feedbackDirectory(args[1])).remove(args[0]);
    console.log(`${args[0]}: ${message('deleted', '削除済み')}`);
  } else {
    console.log(help);
    process.exitCode = command && !['help', '--help', '-h'].includes(command) ? 1 : 0;
  }
} catch (error) {
  const text = (error as Error).message;
  const initErrors: Record<string, string> = {
    'Invalid initialization choice.': '初期化の選択が不正です。shareにはlocalまたはgit、captureにはdom、tab、noneを指定してください。',
    'Existing needback.config.ts is still supported. Rename it to needmark.config.ts before initializing again.': '既存のneedback.config.tsは引き続き利用できます。再初期化する前にneedmark.config.tsへ名前を変更してください。',
  };
  console.error(language === 'ja' ? initErrors[text] ?? text : text);
  process.exitCode = 1;
}
