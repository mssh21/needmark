import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';
import { createReviewApi, validateReviewOptions } from './server/review-api.js';
import { loadProjectConfig } from './server/config.js';
import { defaultFeedbackDirectory } from './server/storage.js';
import type { NeedMarkOptions } from './shared/types.js';
import { instrumentHtml, instrumentJsx } from './server/code-source.js';
import { isAllowedOrigin } from './shared/origin.js';

export { formatFeedbackPrompt } from './shared/prompt.js';
export type { PromptDetail } from './shared/prompt.js';
export type { NeedMarkLanguage, NeedMarkOptions, Feedback, FeedbackInput, FeedbackStatus, CaptureMethod, FeedbackPatch, FeedbackClearScope, FeedbackClearResult, FeedbackReply, FeedbackReplyInput, CodeContext, ElementContext, SourceLocation, FeedbackChangeEvent, FeedbackSubmission } from './shared/types.js';

export function needmark(options?: NeedMarkOptions): Plugin {
  let settings = options ?? {};
  let { origins } = validateReviewOptions(settings);
  // transformIndexHtml receives no request, so the origin checked in the middleware travels with the request's async context.
  // transformIndexHtmlはリクエストを受け取らないため、ミドルウェアで確認したオリジンを非同期コンテキストで受け渡す。
  const requestOrigin = new AsyncLocalStorage<string>();
  let endpoint = '/__needmark';
  let api: ReturnType<typeof createReviewApi>;
  let root = '';

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
      server.middlewares.use((request, response, next) => {
        if (api.handle(request, response)) return;
        const origin = `${server.config.server.https ? 'https' : 'http'}://${request.headers.host ?? ''}`;
        const sameOrigin = !request.headers.origin || request.headers.origin === origin;
        requestOrigin.run(sameOrigin ? origin : '', next);
      });
    },
    transform: {
      order: 'pre',
      handler(code, id, transformOptions) {
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
        if (!isAllowedOrigin(requestOrigin.getStore() ?? '', origins)) return;
        return { html: instrumentHtml(html, relative(process.cwd(), context.filename).replaceAll('\\', '/')), tags: [{ tag: 'script', attrs: api.scriptAttrs, injectTo: 'body' }] };
      },
    },
  };
}
