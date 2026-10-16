import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';
import { createReviewApi, validateReviewOptions } from './server/review-api.js';
import { loadProjectConfig } from './server/config.js';
import { defaultFeedbackDirectory } from './server/storage.js';
import type { NeedMarkOptions } from './shared/types.js';
import { instrumentHtml, instrumentJsx } from './server/code-source.js';
import { isAllowedOrigin } from './shared/origin.js';
import { appendReviewScript } from './server/review-script.js';
import { needmarkEnabled } from './server/enabled.js';

export { formatFeedbackPrompt } from './shared/prompt.js';
export type { PromptDetail } from './shared/prompt.js';
export type { NeedMarkLanguage, NeedMarkOptions, Feedback, FeedbackInput, FeedbackStatus, CaptureMethod, FeedbackPatch, FeedbackClearScope, FeedbackClearResult, FeedbackReply, FeedbackReplyInput, CodeContext, ElementContext, SourceLocation, FeedbackChangeEvent, FeedbackSubmission } from './shared/types.js';

export function needmark(options?: NeedMarkOptions): Plugin {
  let settings = options ?? {};
  let { origins } = validateReviewOptions(settings);
  // transformIndexHtml receives no request, so the origin checked in the middleware travels with the request's async context,
  // and the hook marks the page so the appended fallback script is not added twice.
  // transformIndexHtmlはリクエストを受け取らないため、ミドルウェアで確認したオリジンを非同期コンテキストで受け渡し、
  // 追記用の代替scriptを二重に入れないようフック側で印を付ける。
  const requestPage = new AsyncLocalStorage<{ origin: string; injected: boolean }>();
  let endpoint = '/__needmark';
  let api: ReturnType<typeof createReviewApi>;
  let root = '';
  // Vite has already decided which plugins apply before the project config is loaded, so a switched-off plugin stays registered and every hook returns early instead.
  // プロジェクトの設定を読む前にViteが適用するプラグインを決めてしまうため、止めたプラグインも登録したまま、各フックで何もせずに戻る。
  let active = true;

  return {
    name: 'needmark',
    // Source positions must be read from the original JSX/HTML before other plugins compile it.
    // 他のプラグインがコンパイルする前の元のJSX・HTMLからソース位置を読む必要があるため。
    enforce: 'pre',
    apply: (_config, environment) => environment.command === 'serve' && !environment.isPreview,
    async config(config) {
      // Loading the TypeScript config is asynchronous and the factory runs synchronously inside vite.config, so it waits for
      // this hook, which also keeps builds from executing the config.
      // TypeScriptの設定の読み込みは非同期で、ファクトリーはvite.config内で同期的に呼ばれるため、このフックまで待つ。
      // ビルド時に設定を実行しないことにもなる。
      if (!options) ({ origins } = validateReviewOptions(settings = await loadProjectConfig()));
      active = needmarkEnabled(settings);
      if (!active) return;
      const output = resolve(config.root ?? process.cwd(), settings.outputDir ?? defaultFeedbackDirectory(config.root ?? process.cwd()));
      const pattern = `${output.replaceAll('\\', '/')}/**`;
      const legacyPattern = `${resolve(config.root ?? process.cwd(), '.needback/feedback').replaceAll('\\', '/')}/**`;
      const canonicalPattern = `${resolve(config.root ?? process.cwd(), '.needmark/feedback').replaceAll('\\', '/')}/**`;
      // Deny every possible feedback folder (configured, current default, legacy) so changing outputDir never exposes older files to Vite's static server or reloads.
      // outputDirを変えても古いコメントファイルがViteの静的配信や再読み込みに露出しないよう、取り得る保存先をすべて除外する。
      return { server: {
        watch: { ignored: [pattern, canonicalPattern, legacyPattern] },
        fs: { deny: [...(config.server?.fs?.deny ?? ['.env', '.env.*', '*.{crt,pem}', '**/.git/**']), pattern, canonicalPattern, legacyPattern] },
      } };
    },
    configResolved(config) {
      if (!active) return;
      root = config.root;
      endpoint = `${config.base.replace(/\/$/, '')}/__needmark`;
      const output = resolve(config.root, settings.outputDir ?? defaultFeedbackDirectory(config.root));
      const publicPath = config.publicDir ? relative(config.publicDir, output) : '..';
      if (output === config.root || (publicPath !== '..' && !publicPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
        throw new Error('NeedMark outputDir must be a dedicated folder outside publicDir.');
      }
      api = createReviewApi({ ...settings, root: config.root, sourceRoot: process.cwd(), endpoint, secure: !!config.server.https, logger: config.logger });
    },
    configureServer(server) {
      if (!active) return;
      server.middlewares.use((request, response, next) => {
        if (api.handle(request, response)) return;
        const origin = `${server.config.server.https ? 'https' : 'http'}://${request.headers.host ?? ''}`;
        const sameOrigin = !request.headers.origin || request.headers.origin === origin;
        const page = { origin: sameOrigin ? origin : '', injected: false };
        if (request.method === 'GET' && isAllowedOrigin(page.origin, origins)) appendReviewScript(response, api.scriptAttrs, () => page.injected);
        requestPage.run(page, next);
      });
    },
    transform: {
      order: 'pre',
      handler(code, id, transformOptions) {
        if (!active) return;
        const file = id.split('?')[0]!;
        const local = relative(root, file);
        if (transformOptions?.ssr || !/\.[jt]sx$/.test(file) || local.startsWith('..') || local.includes('node_modules')) return;
        try {
          return instrumentJsx(code, relative(process.cwd(), file).replaceAll('\\', '/'), origins, file);
        } catch { return; } /* Source metadata is optional; a parser gap must not break the user's dev server. / ソース情報は任意のため、パーサー非対応で開発サーバーを止めない。 */
      },
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const page = requestPage.getStore();
        if (!active || !page || !isAllowedOrigin(page.origin, origins)) return;
        page.injected = true;
        return { html: instrumentHtml(html, relative(process.cwd(), context.filename).replaceAll('\\', '/')), tags: [{ tag: 'script', attrs: api.scriptAttrs, injectTo: 'body' }] };
      },
    },
  };
}
