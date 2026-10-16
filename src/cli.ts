#!/usr/bin/env node
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout } from 'node:timers/promises';
import { initialize } from './server/init.js';
import { askConnection, askInitChoices, describeConnection, describeInit, type InitChoices } from './server/init-questions.js';
import { planConnection, planDisconnection } from './server/connect.js';
import { loadProjectConfig } from './server/config.js';
import { startReviewProxy } from './proxy.js';
import { needmarkEnabled } from './server/enabled.js';
import { freePort, takePort, waitForPort } from './server/app-command.js';
import { defaultFeedbackDirectory, FeedbackStore } from './server/storage.js';
import { formatFeedbackPrompt, type PromptDetail } from './shared/prompt.js';
import type { CaptureMethod, FeedbackStatus } from './shared/types.js';
import { isNeedMarkLanguage, type NeedMarkLanguage } from './shared/language.js';
import { NeedMarkMcp, serveMcp } from './server/mcp.js';
import { devCommand, needmarkCommand, removeCommand } from './server/package-manager.js';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const [command, ...args] = process.argv.slice(2);
const help = `NeedMark commands / NeedMarkのコマンド
needmark dev [--port=3000] [--capture=dom|tab|none] [--directory=.needmark/feedback] -- <development command>
needmark dev --target=http://localhost:3000 [--origin=http://localhost:4190] [--capture=dom|tab|none] [--directory=.needmark/feedback]
needmark init [--language=en|ja] [--share=local|git] [--capture=dom|tab|none] [--connect=yes|no]
needmark remove
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

/** See docs/architecture.md#local-review-proxy. / 仕様は docs/architecture.md#local-review-proxy を参照。 */
async function runWrapped(options: string[], given: string[]) {
  const values: { port?: string; capture?: CaptureMethod; directory?: string } = {};
  for (let index = 0; index < options.length; index++) {
    const match = options[index]!.match(/^--(port|capture|directory)(?:=(.*))?$/);
    if (!match) throw new Error(message(`Unknown argument: ${options[index]}`, `不明な引数: ${options[index]}`));
    const key = match[1] as keyof typeof values;
    const value = match[2] ?? options[++index];
    if (!value || values[key] !== undefined) throw new Error(message(`Missing or duplicate ${key} option`, `${key}の値がないか、重複しています。`));
    Object.assign(values, { [key]: value });
  }
  if (!given.length) throw new Error(message('Give the development command after --, for example: needmark dev -- next dev', '--の後に開発コマンドを指定してください。例: needmark dev -- next dev'));
  const settings = await projectSettings();
  const start = (argv: string[], env: NodeJS.ProcessEnv) => spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env,
    // Package managers install command shims as .cmd files on Windows, which only a shell can start.
    // Windowsではパッケージマネージャーがコマンドを.cmdとして入れるため、シェル経由でないと起動できない。
    shell: process.platform === 'win32' });
  if (!needmarkEnabled(settings)) {
    console.log(message('NeedMark is off (NEEDMARK or enabled: false); starting the development server without it.', 'NeedMarkはオフです（NEEDMARKまたはenabled: false）。NeedMarkなしで開発サーバーを起動します。'));
    const child = start(given, process.env);
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    process.exitCode = await new Promise<number>((done) => child.once('exit', (code) => done(code ?? 1)));
    return;
  }
  const { command: app, port: requested } = takePort(given);
  const port = Number(values.port ?? requested ?? process.env.PORT ?? 3000), internal = await freePort();
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(message(`Invalid port: ${values.port ?? process.env.PORT}`, `ポートが不正です: ${values.port ?? process.env.PORT}`));
  // The reviewer keeps opening the port they always use, so NeedMark takes that port and moves the app to a free one through PORT,
  // which Next.js and most Node servers read.
  // レビューする人がいつものポートを開けばよいように、NeedMarkがそのポートで待ち受け、アプリはPORTで空いているポートへ移す。
  // Next.jsや多くのNodeサーバーはPORTを読む。
  const proxy = await startReviewProxy({ target: `http://localhost:${internal}`, origin: `http://localhost:${port}`,
    capture: values.capture ?? settings.capture, outputDir: values.directory ?? settings.outputDir, language: settings.language,
    editor: settings.editor, contextAttributes: settings.contextAttributes, onFeedbackChange: settings.onFeedbackChange, onSubmit: settings.onSubmit,
  }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EADDRINUSE' ? new Error(message(`Port ${port} is already in use. Stop the other server or pass --port.`, `ポート${port}は使用中です。ほかのサーバーを止めるか、--portを指定してください。`)) : error;
  });
  const child = start(app, { ...process.env, PORT: String(internal) });
  let exited = false;
  const stop = (signal: NodeJS.Signals) => { if (!exited) child.kill(signal); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const exit = new Promise<number>((done) => child.once('exit', (code) => { exited = true; done(code ?? 1); }));
  try {
    await Promise.race([waitForPort(internal, () => exited), exit]);
    if (!exited) console.log(`\nNeedMark: ${proxy.origin}\n${message(`Open this URL as usual; the app itself runs on port ${internal}. Set NEEDMARK=off to start it without NeedMark.`, `いつもどおりこのURLを開いてください。アプリ本体はポート${internal}で動いています。NEEDMARK=offでNeedMarkなしで起動できます。`)}\n`);
    process.exitCode = await exit;
  } catch (error) { stop('SIGTERM'); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await proxy.close(); }
}

try {
  if (command === 'dev' && args.includes('--')) {
    await runWrapped(args.slice(0, args.indexOf('--')), args.slice(args.indexOf('--') + 1));
  } else if (command === 'dev') {
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
    // Setup runs before the project has a language, and its output is often pasted into issues or chats, so it is always English.
    // 初期設定はプロジェクトの言語が決まる前に動き、出力をissueやチャットに貼ることも多いため、常に英語で表示する。
    language = 'en';
    let choices: Partial<InitChoices> = {};
    for (let index = 0; index < args.length; index++) {
      const match = args[index]!.match(/^--(share|capture|language|connect)(?:=(.*))?$/);
      if (!match) throw new Error(`Unknown argument: ${args[index]}`);
      const key = match[1] as keyof InitChoices;
      const value = match[2] ?? args[++index];
      if (!value || choices[key] !== undefined) throw new Error(`Missing or duplicate ${key} option`);
      if (key === 'language' && !isNeedMarkLanguage(value)) throw new Error('Invalid NeedMark language. Use en or ja.');
      if (key === 'connect' && !['yes', 'no'].includes(value)) throw new Error('Invalid connect option. Use yes or no.');
      Object.assign(choices, { [key]: value });
    }
    const directory = process.cwd(), connection = await planConnection(directory);
    // A project set up before connecting existed already has its config, so running init again only offers the connection and keeps that file.
    // 接続機能より前に設定したプロジェクトには設定ファイルがあるため、initを再実行したときは接続だけを提案し、そのファイルは残す。
    const existing = existsSync(resolve(directory, 'needmark.config.ts'));
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (text: string) => terminal.question(text);
      try {
        if (!existing) choices = await askInitChoices(ask, choices, connection);
        else if (connection.kind === 'edit' && !choices.connect) choices.connect = await askConnection(ask, connection);
      } finally { terminal.close(); }
    }
    // Without a terminal nobody can be asked, so files other than NeedMark's own are changed only when --connect=yes says so.
    // ターミナルがなければ確認できないため、NeedMark自身のもの以外のファイルは--connect=yesの指定があるときだけ変更する。
    const options: InitChoices = { share: 'local', capture: 'dom', language: 'ja', connect: 'no', ...choices };
    if (!existing) await initialize(directory, options);
    const connected = connection.kind === 'edit' && options.connect === 'yes';
    if (connected) await writeFile(resolve(directory, connection.file), connection.content);
    const command = needmarkCommand(directory), run = devCommand(command);
    if (existing) console.log(`\nKept the existing needmark.config.ts.\n  Development server  ${connected || connection.kind !== 'edit' ? describeConnection(connection) : 'Not connected'}`);
    else console.log(`\nCreated needmark.config.ts\n${describeInit(options, connection)}`);
    if (connected) console.log(`\nChanged ${connection.file}:\n${connection.lines.map((line) => `  + ${line.trim()}`).join('\n')}`);
    if (connected || connection.kind === 'connected') {
      console.log(`\nNext step: start your development server as usual (${run}) and open it. The NeedMark toolbar appears at the bottom of the page.
Turn it off with NEEDMARK=off, or for everyone with enabled: false in needmark.config.ts. Undo the change with ${command} remove.`);
    } else {
      console.log(`\nNext step: connect NeedMark to your development server
  Vite     Add needmark() to plugins in vite.config.ts (import { needmark } from 'needmark').
  Astro    Add vite: { plugins: [needmark()] } to astro.config.mjs.
  Others   Start the dev command through NeedMark in package.json, for example
             "dev": "needmark dev -- next dev"
           ${run} then serves the app with the toolbar on its usual port.
${command} init --connect=yes does this for Vite, Astro and Next.js when it can read the config.`);
    }
  } else if (command === 'remove') {
    language = 'en';
    if (args.length) throw new Error('remove takes no arguments.');
    const directory = process.cwd(), changes = await planDisconnection(directory);
    for (const change of changes) {
      await writeFile(resolve(directory, change.file), change.content);
      console.log(`Changed ${change.file}:\n${change.lines.map((line) => `  - ${line.trim()}`).join('\n')}`);
    }
    console.log(`${changes.length ? '\n' : ''}${changes.length ? 'NeedMark is no longer connected to the development server.' : 'NeedMark was not connected to the development server; nothing changed.'}
needmark.config.ts and saved feedback were kept. To uninstall the package: ${removeCommand(needmarkCommand(directory))}`);
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
  console.error(text);
  process.exitCode = 1;
}
