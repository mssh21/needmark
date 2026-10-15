import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultFeedbackDirectory, FeedbackStore, InputError } from './storage.js';
import { isRepairFeedback, type CaptureMethod, type FeedbackChangeEvent, type NeedMarkOptions, type RuntimeSourceResult } from '../shared/types.js';
import { formatFeedbackPrompt, type PromptDetail } from '../shared/prompt.js';
import { sourceEditorUrl } from './source-editor.js';
import { needmarkCommand } from './package-manager.js';
import { normalizeContextAttributes } from '../shared/context-attributes.js';
import { isNeedMarkLanguage, type NeedMarkLanguage } from '../shared/language.js';
import { isAllowedOrigin } from '../shared/origin.js';

export function validateReviewOptions(options: Pick<NeedMarkOptions, 'enabled' | 'origins' | 'language' | 'capture' | 'editor' | 'contextAttributes'>): { origins?: string[]; capture: CaptureMethod; language: NeedMarkLanguage } {
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error('NeedMark enabled must be true or false.');
  if (options.language !== undefined && !isNeedMarkLanguage(options.language)) throw new Error('Invalid NeedMark language. Use en or ja.');
  if (options.editor !== undefined && !['vscode', 'cursor'].includes(options.editor)) throw new Error('Invalid NeedMark editor.');
  normalizeContextAttributes(options.contextAttributes);
  if (options.capture !== undefined && !['dom', 'tab', 'none'].includes(options.capture)) throw new Error('Invalid NeedMark capture method.');
  const origins = options.origins?.map((origin) => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || origin !== url.origin) {
      throw new Error('NeedMark origins must be exact origins without paths or trailing slashes.');
    }
    return origin;
  });
  if (origins && !origins.length) throw new Error('NeedMark requires at least one allowed origin.');
  return { origins, capture: options.capture ?? 'dom', language: options.language ?? 'ja' };
}

export interface ReviewApiOptions extends NeedMarkOptions {
  root: string;
  /** Vite records source paths from the process directory while the proxy uses its project root. / Viteはプロセスの作業ディレクトリ、プロキシはプロジェクトルートを基準にソースパスを記録するため。 */
  sourceRoot?: string;
  endpoint?: string;
  secure?: boolean;
  logger?: { error(message: string): void };
  runtimeSource?: (input: unknown) => Promise<{ elements: RuntimeSourceResult[] }>;
}

/** One implementation serves both the Vite plugin and the proxy so their security checks cannot drift apart. / Viteプラグインとプロキシで同じ実装を使い、セキュリティ検査が食い違わないようにする。 */
export function createReviewApi(options: ReviewApiOptions) {
  const { origins, capture, language } = validateReviewOptions(options);
  const contextAttributes = normalizeContextAttributes(options.contextAttributes);
  for (const name of ['onFeedbackChange', 'onSubmit'] as const) {
    if (options[name] !== undefined && typeof options[name] !== 'function') throw new Error(`Invalid NeedMark ${name} callback.`);
  }
  const endpoint = options.endpoint ?? '/__needmark';
  // A random per-server token in a custom header blocks cross-site requests without CORS; cookies would be sent automatically and allow CSRF.
  // サーバーごとの乱数トークンを独自ヘッダーで要求すれば、CORSなしでクロスサイトの要求を防げる。Cookieは自動送信されCSRFを許してしまう。
  const token = randomBytes(32).toString('hex');
  const output = resolve(options.root, options.outputDir ?? defaultFeedbackDirectory(options.root));
  if (output === resolve(options.root)) throw new Error('NeedMark outputDir must be a dedicated folder.');
  const directory = relative(process.cwd(), output).replaceAll('\\', '/'), command = needmarkCommand(output);
  const store = new FeedbackStore(output);
  const logger = options.logger;
  function hookError(name: string, error: unknown) {
    try {
      const message = `[needmark] ${name} failed: ${String(error)}`;
      if (logger) logger.error(message); else console.error(message);
    } catch { /* A broken logger must not turn a saved change into a failed request. / ログ出力の失敗で、保存済みの変更を失敗扱いにしない。 */ }
  }
  function changed(event: FeedbackChangeEvent) {
    if (!options.onFeedbackChange) return;
    // The hook runs after the response on its own clone, so slow or mutating user code cannot delay saving or alter stored data.
    // フックは応答とは切り離して複製に対して呼ぶ。遅いコードや書き換えるコードが保存を遅らせたりデータを変えたりしないため。
    void Promise.resolve().then(() => options.onFeedbackChange!(structuredClone(event)))
      .catch((error: unknown) => hookError('onFeedbackChange', error));
  }
  function send(response: ServerResponse, code: number, body: unknown) {
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  async function body(request: IncomingMessage, maximum = 8 * 1024 * 1024): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximum) throw new InputError('Request exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new InputError('Invalid JSON'); }
  }

  const scriptAttrs: Record<string, string | boolean> = {
    src: `${endpoint}/client.js`, defer: true, 'data-needmark-token': token,
    ...(origins ? { 'data-needmark-origins': JSON.stringify(origins) } : {}), 'data-needmark-endpoint': endpoint,
    'data-needmark-capture': capture,
    'data-needmark-language': language,
    ...(options.runtimeSource ? { 'data-needmark-runtime-source': 'true' } : {}),
    ...(options.onSubmit ? { 'data-needmark-submit': 'true' } : {}),
    ...(options.editor ? { 'data-needmark-editor': options.editor } : {}),
    ...(contextAttributes.length ? { 'data-needmark-context-attributes': JSON.stringify(contextAttributes) } : {}),
  };

  function handle(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = `${options.secure ? 'https' : 'http'}://${request.headers.host ?? ''}`;
    const path = (request.url ?? '').split('?')[0]!;
    if (path !== endpoint && !path.startsWith(`${endpoint}/`)) return false;
    if (!isAllowedOrigin(origin, origins) || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site') {
      send(response, 403, { error: 'Origin is not allowed' }); return true;
    }
    void (async () => {
      // A <script src> cannot send the token header, and the bundle holds no secrets, so it is the only route served before the token check.
      // <script src>はトークンのヘッダーを送れず、バンドルに秘密も含まないため、トークン確認より前に配信する唯一の経路にしている。
      if (path === `${endpoint}/client.js` && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        response.end(await readFile(new URL('./client.js', import.meta.url)));
        return;
      }
      if (request.headers['x-needmark-token'] !== token) { send(response, 403, { error: 'Invalid session token' }); return; }
      if (path === `${endpoint}/editor` && request.method === 'POST' && options.editor) {
        const url = await sourceEditorUrl({ root: options.root, sourceRoot: options.sourceRoot, outputDir: output, editor: options.editor }, await body(request, 8 * 1024));
        send(response, 200, { url }); return;
      }
      if (path === `${endpoint}/source` && request.method === 'POST' && options.runtimeSource) {
        send(response, 200, await options.runtimeSource(await body(request, 128 * 1024))); return;
      }
      if (path === `${endpoint}/submit` && request.method === 'POST' && options.onSubmit) {
        const value = await body(request, 64 * 1024);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid feedback submission');
        const { ids, detail, language: submittedLanguage } = value as { ids?: unknown; detail?: unknown; language?: unknown };
        if (Object.keys(value).some((key) => !['ids', 'detail', 'language'].includes(key))
          || (Object.hasOwn(value, 'language') && !isNeedMarkLanguage(submittedLanguage)) || !Array.isArray(ids) || !ids.length || ids.length > 1000
          || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
          || new Set(ids).size !== ids.length || typeof detail !== 'string' || !['compact', 'standard', 'detailed', 'forensic'].includes(detail)) throw new InputError('Invalid feedback submission');
        const saved = await Promise.all(ids.map((id: string) => store.read(id)));
        const feedback = saved.filter(isRepairFeedback);
        const skipped = saved.filter((item) => !isRepairFeedback(item)).map((item) => item.id);
        if (!feedback.length) throw new InputError('No repair requests selected');
        const promptLanguage = isNeedMarkLanguage(submittedLanguage) ? submittedLanguage : options.language ?? 'en';
        const payload = { feedback, prompt: formatFeedbackPrompt(feedback, directory, detail as PromptDetail, promptLanguage, false, command),
          directory, detail: detail as PromptDetail,
          ...(Object.hasOwn(value, 'language') || options.language !== undefined ? { language: promptLanguage } : {}) };
        try { await options.onSubmit(structuredClone(payload)); }
        catch (error) { hookError('onSubmit', error); send(response, 502, { error: 'Unable to send feedback. Saved feedback is unchanged.' }); return; }
        send(response, 200, { submitted: feedback.map((item) => item.id), skipped }); return;
      }
      if (path === `${endpoint}/feedback` && request.method === 'GET') {
        send(response, 200, { feedback: await store.list(), directory, command }); return;
      }
      if (path === `${endpoint}/feedback` && request.method === 'DELETE') {
        const input = await body(request) as { scope?: unknown; url?: unknown };
        if (input?.scope === 'url') {
          let feedbackOrigin = '';
          try { if (typeof input.url === 'string') feedbackOrigin = new URL(input.url).origin; } catch { /* An unparsable URL leaves the origin empty, which the allowlist check below rejects. / 解析できないURLはオリジンが空のままになり、直後の許可リスト確認で拒否される。 */ }
          if (!isAllowedOrigin(feedbackOrigin, origins)) throw new InputError('Deletion URL is not allowed');
        }
        const result = await store.clear(input);
        changed({ type: 'cleared', directory, result });
        send(response, result.failed.length ? 207 : 200, result); return;
      }
      if (path === `${endpoint}/feedback` && request.method === 'POST') {
        const input = await body(request) as { url?: unknown };
        let feedbackOrigin = '';
        try { if (typeof input?.url === 'string') feedbackOrigin = new URL(input.url).origin; } catch { /* An unparsable URL leaves the origin empty, which the allowlist check below rejects. / 解析できないURLはオリジンが空のままになり、直後の許可リスト確認で拒否される。 */ }
        if (!isAllowedOrigin(feedbackOrigin, origins)) throw new InputError('Feedback URL is not allowed');
        const feedback = await store.save(input);
        changed({ type: 'created', directory, feedback });
        send(response, 201, feedback); return;
      }
      const match = path.match(/\/feedback\/([^/]+)(?:\/(image|replies)(?:\/([^/]+))?)?$/);
      if (match?.[1] && match[2] === 'image' && !match[3] && request.method === 'GET') {
        const image = await store.image(match[1]);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        response.end(image); return;
      }
      if (match?.[1] && !match[2] && request.method === 'GET') {
        send(response, 200, await store.read(match[1])); return;
      }
      if (match?.[1] && !match[2] && request.method === 'PATCH') {
        const feedback = await store.update(match[1], await body(request));
        changed({ type: 'updated', directory, feedback });
        send(response, 200, feedback); return;
      }
      if (match?.[1] && !match[2] && request.method === 'DELETE') {
        await store.remove(match[1]);
        changed({ type: 'deleted', directory, id: match[1] });
        send(response, 200, { deleted: match[1] }); return;
      }
      if (match?.[1] && match[2] === 'replies') {
        if (!match[3] && request.method === 'POST') {
          const feedback = await store.addReply(match[1], await body(request));
          changed({ type: 'updated', directory, feedback });
          send(response, 201, feedback); return;
        }
        if (match[3] && request.method === 'PATCH') {
          const feedback = await store.updateReply(match[1], match[3], await body(request));
          changed({ type: 'updated', directory, feedback });
          send(response, 200, feedback); return;
        }
        if (match[3] && request.method === 'DELETE') {
          const feedback = await store.removeReply(match[1], match[3]);
          changed({ type: 'updated', directory, feedback });
          send(response, 200, feedback); return;
        }
      }
      send(response, 404, { error: 'Not found' });
    })().catch((error: unknown) => {
      const status = error instanceof InputError ? 400 : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      if (status === 500) logger?.error(`[needmark] ${String(error)}`);
      if (!response.headersSent) send(response, status, { error: status === 500 ? 'Unable to access feedback files' : String((error as Error).message) });
      else response.end();
    });
    return true;
  }

  return { token, directory, origins, scriptAttrs, handle };
}
