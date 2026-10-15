import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { hasReferenceTarget, isFeedbackStatus, isFeedbackCategory, isFrameUrls, type Feedback, type FeedbackInput, type FeedbackStatus, type CodeContext, type Rectangle,
  type FeedbackPatch, type FeedbackReply, type FeedbackReplyInput, type FeedbackClearScope, type FeedbackClearResult } from '../shared/types.js';

export function defaultFeedbackDirectory(root: string): string {
  const canonical = '.needmark/feedback', legacy = '.needback/feedback';
  return existsSync(join(root, canonical)) || !existsSync(join(root, legacy)) ? canonical : legacy;
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const isText = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
const isTimestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

export class InputError extends Error {}

function validateContext(value: unknown): FeedbackInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid feedback');
  const input = value as FeedbackInput;
  for (const [name, limit] of [['comment', 10000], ['author', 100], ['url', 4096], ['title', 1000]] as const) {
    if (!isText(input[name], limit)) throw new InputError(`Invalid ${name}`);
  }
  if (input.intent !== undefined && input.intent !== 'reference') throw new InputError('Invalid feedback intent');
  if (input.category !== undefined && !isFeedbackCategory(input.category)) throw new InputError('Invalid feedback category');
  if (input.intent === 'reference' && input.category !== undefined) throw new InputError('Target references cannot have a category');
  if (input.intent === 'reference' ? !!input.comment.trim() : !input.comment.trim()) {
    throw new InputError(input.intent === 'reference' ? 'Target references cannot contain a comment; add a reply instead' : 'Comment is required');
  }
  if (!isTimestamp(input.capturedAt)) throw new InputError('Invalid capture timestamp');
  try {
    if (!['http:', 'https:'].includes(new URL(input.url).protocol)) throw new Error();
  } catch { throw new InputError('Invalid URL'); }
  if (!input.viewport || !input.target || !input.capture || !input.target.rect) throw new InputError('Missing capture context');
  const { viewport, target, capture } = input;
  for (const number of [viewport.width, viewport.height, viewport.devicePixelRatio, viewport.scrollX, viewport.scrollY,
    target.rect.x, target.rect.y, target.rect.width, target.rect.height, capture.width, capture.height]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new InputError('Invalid capture dimensions');
  }
  if (Math.min(viewport.width, viewport.height, viewport.devicePixelRatio, target.rect.width, target.rect.height) <= 0
    || (capture.method !== 'none' && Math.min(capture.width, capture.height) <= 0)
    || (capture.method === 'none' && (capture.width !== 0 || capture.height !== 0))) {
    throw new InputError('Invalid capture dimensions');
  }
  if (!['element', 'area', 'text', 'multi'].includes(target.kind) || !['tab', 'dom', 'none'].includes(capture.method)
    || !isText(target.text, 1000) || !isText(target.selector, 2000)) throw new InputError('Invalid target');
  if (target.code !== undefined) validateCodeContext(target.code, input.url, target.kind === 'multi');
  if (input.intent === 'reference' && !hasReferenceTarget(target)) throw new InputError('Target reference requires recorded identifiers');
  return input;
}


export function validateInput(value: unknown): FeedbackInput {
  const input = validateContext(value);
  if (input.capture.method === 'none') {
    if (input.screenshot !== undefined) throw new InputError('Image must be omitted when capture is disabled');
    return input;
  }
  if (typeof input.screenshot !== 'string' || !input.screenshot.startsWith('data:image/png;base64,')) throw new InputError('PNG capture required');
  const png = Buffer.from(input.screenshot.slice(22), 'base64');
  if (png.length < 24 || png.length > 5 * 1024 * 1024 || !png.subarray(0, 8).equals(pngSignature)
    || png.toString('ascii', 12, 16) !== 'IHDR'
    || png.readUInt32BE(16) !== input.capture.width || png.readUInt32BE(20) !== input.capture.height) throw new InputError('Invalid or oversized PNG');
  return input;
}

function validateCodeContext(value: CodeContext, pageUrl: string, explicitMulti = false) {
  const list = (value: unknown, count: number, limit: number) => Array.isArray(value) && value.length <= count && value.every((item) => isText(item, limit));
  const record = (value: unknown, count: number, limit: number) => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).length <= count && Object.entries(value).every(([key, item]) => isText(key, 100) && isText(item, limit));
  if (!value || !Array.isArray(value.elements) || (!explicitMulti && value.elements.length > 12) || typeof value.truncated !== 'boolean') throw new InputError('Invalid code context');
  for (const element of value.elements) {
    const source = element?.source;
    const hint = element?.sourceHint;
    if (!element || !isText(element.tag, 100) || !isText(element.selector, 2000) || !isText(element.text, 500)
      || !record(element.attributes, 20, 500) || !record(element.styles, 30, 100)
      || !list(element.headings, 5, 200) || !list(element.components, 20, 100)
      || (element.accessibleName !== undefined && !isText(element.accessibleName, 500))
      || (element.rootPath !== undefined && !list(element.rootPath, 8, 2000))
      || (element.frameUrls !== undefined && !isFrameUrls(element.frameUrls, element.rootPath, pageUrl))
      || (element.sourceOrigin !== undefined && (element.sourceOrigin !== 'runtime' || !source || element.sourceRelation !== 'self'))
      || (hint !== undefined && (!hint || Array.isArray(hint) || !isText(hint.file, 1024) || !hint.file.trim()
        || (hint.component !== undefined && !isText(hint.component, 100))))
      || !element.rect || ![element.rect.x, element.rect.y, element.rect.width, element.rect.height].every((number) => typeof number === 'number' && Number.isFinite(number))
      || element.rect.width < 0 || element.rect.height < 0
      || (source !== undefined && (!source || !isText(source.file, 1024) || !source.file || !Number.isSafeInteger(source.line) || source.line < 1
        || !Number.isSafeInteger(source.column) || source.column < 1 || (source.component !== undefined && !isText(source.component, 100))
        || !['self', 'ancestor'].includes(element.sourceRelation ?? '')))) throw new InputError('Invalid code context');
  }
}

const persistedRect = ({ x, y, width, height }: Rectangle): Rectangle => ({ x, y, width, height });
function persistedCode(code?: CodeContext): CodeContext | undefined {
  return code && { truncated: code.truncated, elements: code.elements.map((element) => ({
    tag: element.tag, selector: element.selector, text: element.text, rect: persistedRect(element.rect),
    attributes: { ...element.attributes }, styles: { ...element.styles }, headings: [...element.headings], components: [...element.components],
    ...(element.accessibleName !== undefined ? { accessibleName: element.accessibleName } : {}),
    ...(element.rootPath !== undefined ? { rootPath: [...element.rootPath] } : {}),
    ...(element.frameUrls !== undefined ? { frameUrls: [...element.frameUrls] } : {}),
    ...(element.source ? { source: { file: element.source.file, line: element.source.line, column: element.source.column,
      ...(element.source.component !== undefined ? { component: element.source.component } : {}) } } : {}),
    ...(element.sourceRelation !== undefined ? { sourceRelation: element.sourceRelation } : {}),
    ...(element.sourceOrigin !== undefined ? { sourceOrigin: element.sourceOrigin } : {}),
    ...(element.sourceHint ? { sourceHint: { file: element.sourceHint.file,
      ...(element.sourceHint.component !== undefined ? { component: element.sourceHint.component } : {}) } } : {}),
  })) };
}
function persistedTarget(target: FeedbackInput['target']): Omit<FeedbackInput['target'], 'kind'> {
  const code = persistedCode(target.code);
  return { selector: target.selector, text: target.text, rect: persistedRect(target.rect), ...(code ? { code } : {}) };
}
function persistedContext(input: FeedbackInput): Pick<FeedbackInput, 'target' | 'viewport' | 'capture'> {
  const { target, viewport, capture } = input;
  return { target: { kind: target.kind, ...persistedTarget(target) },
    viewport: { width: viewport.width, height: viewport.height, devicePixelRatio: viewport.devicePixelRatio, scrollX: viewport.scrollX, scrollY: viewport.scrollY },
    capture: { method: capture.method, width: capture.width, height: capture.height } };
}

function validateReplyInput(value: unknown): FeedbackReplyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid reply');
  const { comment, author } = value as FeedbackReplyInput;
  if (!isText(author, 100)) throw new InputError('Invalid author');
  return { comment: validateReplyComment(comment), author: author.trim() };
}

function validateReplyComment(comment: string): string {
  if (!isText(comment, 10000) || !comment.trim()) throw new InputError('Reply is required');
  return comment.trim();
}

function quote(text: string): string { return text.split('\n').map((line) => `> ${line}`).join('\n'); }
function codeMarkdown(code?: CodeContext): string {
  if (!code) return '';
  return '\n## Code context\n\n' + code.elements.map((element) =>
    `### ${element.tag}: ${element.selector}\n\n` +
    (element.source ? `- Source (${element.sourceOrigin === 'runtime' ? 'runtime; current JSX verified by identifiers' : element.sourceRelation === 'self' ? 'element' : 'ancestor hint'}): ${element.source.file}:${element.source.line}:${element.source.column}\n- Source owner: ${element.source.component ?? 'HTML'}\n` : '- Source: unavailable; search using the identifiers below.\n') +
    (element.sourceHint ? `- Source file search hint: ${JSON.stringify(element.sourceHint.file)}${element.sourceHint.component ? `; component ${JSON.stringify(element.sourceHint.component)}` : ''}\n` : '') +
    (element.accessibleName ? `- Accessible name: ${JSON.stringify(element.accessibleName)}\n` : '') +
    (element.rootPath?.length ? `- Target roots: ${JSON.stringify(element.rootPath)}\n` : '') +
    (element.frameUrls?.length ? `- Frame pages: ${JSON.stringify(element.frameUrls)}\n` : '') +
    `- Components: ${element.components.join(' > ') || 'unavailable'}\n- Text: ${JSON.stringify(element.text)}\n- Nearby headings: ${JSON.stringify(element.headings)}\n` +
    `- Attributes: ${JSON.stringify(element.attributes)}\n- Computed styles: ${JSON.stringify(element.styles)}\n`).join('\n') +
    (code.truncated ? '\nTarget discovery is incomplete or the context is a bounded sample. Verify the scope against the current page and any saved screenshot.\n' : '');
}

/** Files written before categories became fix/discuss/question still load instead of failing the whole listing: change asked for a change and becomes fix, approve asked for no code change and becomes discuss, and severity is dropped because every item is now treated as important. / カテゴリが修正・相談・質問になる前のファイルも一覧全体を失敗させずに読み込む。changeは変更依頼なのでfix、approveはコード変更不要なのでdiscussにし、すべて重要として扱うため重要度は捨てる。 */
function retiredClassification(feedback: Feedback): Feedback {
  const { severity: _severity, ...rest } = feedback as Feedback & { severity?: unknown }, category = (rest as { category?: unknown }).category;
  return category === 'change' ? { ...rest, category: 'fix' } : category === 'approve' ? { ...rest, category: 'discuss' } : rest;
}

function markdown(feedback: Feedback): string {
  return (feedback.intent === 'reference' ? `# Target reference ${feedback.id}\n\nNo change requested.\n\n` : `# Feedback ${feedback.id}\n\n${quote(feedback.comment)}\n\n`) +
    `- Author: ${JSON.stringify(feedback.author || 'Guest')}\n` +
    (feedback.category ? `- Category: ${feedback.category}\n` : '') +
    `- Page: ${JSON.stringify(feedback.url)}\n` +
    `- Captured: ${feedback.capturedAt}\n- Capture method: ${feedback.capture.method}\n` +
    `- Target: ${JSON.stringify(feedback.target.selector || 'Selected area')}\n- Visible text: ${JSON.stringify(feedback.target.text)}\n` +
    `- Viewport: ${feedback.viewport.width} × ${feedback.viewport.height}\n\n` +
    (feedback.image ? `![Selected spot](./${feedback.image})\n\n` : 'Screenshot disabled for this feedback.\n\n') +
    'Read context.json for the current status, timestamps, viewport coordinates and capture dimensions.\n' + codeMarkdown(feedback.target.code) +
    ((feedback.replies?.length ?? 0) ? '\n## Replies\n\n' + feedback.replies!.map((reply) =>
      `### ${JSON.stringify(reply.author || 'Guest')} · ${reply.createdAt}\n\n${quote(reply.comment)}\n`).join('\n') : '');
}

export class FeedbackStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}

  private path(id: string): string {
    if (!idPattern.test(id)) throw new InputError('Invalid feedback ID');
    return join(this.directory, id);
  }

  // The dev server, CLI and MCP server can write the same item from different processes. mkdir is an atomic
  // cross-process lock without dependencies; the in-process promise chain avoids polling against our own lock.
  // 開発サーバー・CLI・MCPサーバーが別プロセスから同じコメントを更新し得る。mkdirは依存なしで使える原子的なプロセス間ロックで、
  // プロセス内のPromiseの連鎖により自分自身のロック待ちでポーリングしないようにしている。
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.path(id);
    const previous = this.mutations.get(id) ?? Promise.resolve();
    // A failed earlier mutation must not block the next one for the same item.
    // 同じコメントへの前の更新が失敗しても、次の更新を止めないため。
    const result = previous.catch(() => {}).then(async () => {
      const lock = join(this.directory, `.lock-${id}`);
      const deadline = Date.now() + 2000;
      while (true) {
        try { await mkdir(lock); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (Date.now() >= deadline) throw new InputError(`Feedback update is locked. Retry after the active process finishes. If it exited unexpectedly, remove ${lock}.`);
          await setTimeout(20);
        }
      }
      try { return await operation(); }
      finally { await rm(lock, { recursive: true, force: true }); }
    });
    this.mutations.set(id, result);
    try { return await result; }
    finally { if (this.mutations.get(id) === result) this.mutations.delete(id); }
  }

  async save(value: unknown): Promise<Feedback> {
    const input = validateInput(value);
    const feedback: Feedback = { comment: input.comment.trim(), author: input.author.trim(), url: input.url, title: input.title,
      ...(input.intent === 'reference' ? { intent: 'reference' as const } : {}),
      ...(input.category ? { category: input.category } : {}),
      capturedAt: input.capturedAt, ...persistedContext(input),
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'open',
      ...(input.screenshot ? { image: 'screenshot.png' as const } : {}) };
    await mkdir(this.directory, { recursive: true });
    // Writing into a hidden folder and renaming it means list/watch never see a half-written item.
    // 隠しフォルダーに書いてから名前を変えることで、一覧や監視が書きかけのコメントを読まないようにする。
    const temporary = join(this.directory, `.pending-${feedback.id}`);
    await mkdir(temporary);
    try {
      await Promise.all([
        ...(input.screenshot ? [writeFile(join(temporary, 'screenshot.png'), Buffer.from(input.screenshot.slice(22), 'base64'))] : []),
        writeFile(join(temporary, 'context.json'), JSON.stringify(feedback, null, 2) + '\n'),
        writeFile(join(temporary, 'comment.md'), markdown(feedback)),
      ]);
      await rename(temporary, this.path(feedback.id));
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    return feedback;
  }

  async read(id: string): Promise<Feedback> {
    const path = this.path(id);
    if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, 'context.json'))).isFile()) throw new InputError('Invalid feedback file');
    const feedback = retiredClassification(JSON.parse(await readFile(join(path, 'context.json'), 'utf8')) as Feedback);
    validateContext(feedback);
    if (feedback.id !== id || feedback.version !== 1 || !isFeedbackStatus(feedback.status) || !isTimestamp(feedback.createdAt)
      || (feedback.updatedAt !== undefined && !isTimestamp(feedback.updatedAt))
      || (feedback.capture.method === 'none' ? feedback.image !== undefined : feedback.image !== 'screenshot.png')) throw new InputError('Invalid feedback file');
    if (feedback.replies !== undefined) {
      if (!Array.isArray(feedback.replies) || feedback.replies.length > 200) throw new InputError('Invalid feedback replies');
      for (const reply of feedback.replies) {
        validateReplyInput(reply);
        if (!idPattern.test(reply.id) || !isTimestamp(reply.createdAt) || (reply.updatedAt !== undefined && !isTimestamp(reply.updatedAt))) throw new InputError('Invalid feedback replies');
      }
    }
    return feedback;
  }

  async list(): Promise<Feedback[]> {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const items = await Promise.all(entries.filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
      .map(async (entry) => {
        try { return await this.read(entry.name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      }));
    return items.filter((item): item is Feedback => item !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async image(id: string): Promise<Buffer> {
    const feedback = await this.read(id);
    if (!feedback.image) throw Object.assign(new Error('No screenshot for this feedback'), { code: 'ENOENT' });
    const file = join(this.path(id), feedback.image);
    if (!(await lstat(file)).isFile()) throw new InputError('Invalid image file');
    return readFile(file);
  }

  private async write(feedback: Feedback): Promise<Feedback> {
    feedback = { ...feedback, ...persistedContext(feedback) };
    const path = this.path(feedback.id);
    // rename makes each file replacement atomic. Markdown is renamed first so context.json, the status source of truth, never points ahead of its readable copy.
    // renameで各ファイルの置き換えを原子的にする。ステータスの正本であるcontext.jsonが読みやすいMarkdownより先に進まないよう、Markdownを先に置き換える。
    const suffix = randomUUID();
    const temporary = join(path, `.context-${suffix}.json`);
    const temporaryMarkdown = join(path, `.comment-${suffix}.md`);
    try {
      await Promise.all([writeFile(temporary, JSON.stringify(feedback, null, 2) + '\n'), writeFile(temporaryMarkdown, markdown(feedback))]);
      await rename(temporaryMarkdown, join(path, 'comment.md'));
      await rename(temporary, join(path, 'context.json'));
    } finally { await Promise.all([rm(temporary, { force: true }), rm(temporaryMarkdown, { force: true })]); }
    return feedback;
  }

  async update(id: string, value: unknown): Promise<Feedback> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid feedback update');
    const patch = value as FeedbackPatch;
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((key) => !['comment', 'author', 'status', 'category'].includes(key))) throw new InputError('Invalid feedback update');
    if ('category' in patch && patch.category !== null && !isFeedbackCategory(patch.category)) throw new InputError('Invalid feedback category');
    if ('author' in patch && !isText(patch.author, 100)) throw new InputError('Invalid author');
    if ('status' in patch && !isFeedbackStatus(patch.status)) throw new InputError('Invalid status');
    return this.serial(id, async () => {
      const feedback = await this.read(id);
      if (feedback.intent === 'reference' && 'comment' in patch) throw new InputError('Target reference comments cannot be edited; add a reply instead');
      if (feedback.intent === 'reference' && 'category' in patch) throw new InputError('Target references cannot have a category');
      if ('comment' in patch && (!isText(patch.comment, 10000) || !patch.comment!.trim())) throw new InputError('Comment is required');
      const now = new Date().toISOString();
      const classified = { ...feedback };
      if ('category' in patch) { if (patch.category === null) delete classified.category; else classified.category = patch.category!; }
      return this.write({ ...classified, updatedAt: now,
        ...('comment' in patch ? { comment: patch.comment!.trim() } : {}),
        ...('author' in patch ? { author: patch.author!.trim() } : {}),
        ...('status' in patch ? { status: patch.status! } : {}) });
    });
  }

  async setStatus(id: string, status: FeedbackStatus): Promise<Feedback> { return this.update(id, { status }); }

  async addReply(id: string, value: unknown): Promise<Feedback> {
    const input = validateReplyInput(value);
    return this.serial(id, async () => {
      const feedback = await this.read(id);
      if ((feedback.replies?.length ?? 0) >= 200) throw new InputError('Feedback has reached its reply limit');
      const now = new Date().toISOString();
      return this.write({ ...feedback, updatedAt: now, replies: [...feedback.replies ?? [], { ...input, id: randomUUID(), createdAt: now }] });
    });
  }

  async updateReply(id: string, replyId: string, value: unknown): Promise<Feedback> {
    if (!idPattern.test(replyId)) throw new InputError('Invalid reply ID');
    // Anyone may edit any reply, so an edit that carried the editor's author would rewrite who wrote it; the patch takes only the text.
    // 誰でもどの返信でも編集できるため、編集者の投稿者名を受け取ると書いた人が書き換わってしまう。そのため変更は本文だけを受け付ける。
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'comment')) throw new InputError('Invalid reply update');
    const comment = validateReplyComment((value as { comment: string }).comment);
    return this.serial(id, async () => {
      const feedback = await this.read(id);
      if (!feedback.replies?.some((reply) => reply.id === replyId)) throw Object.assign(new Error('Reply not found'), { code: 'ENOENT' });
      const now = new Date().toISOString();
      return this.write({ ...feedback, updatedAt: now, replies: feedback.replies.map((reply): FeedbackReply =>
        reply.id === replyId ? { ...reply, comment, updatedAt: now } : reply) });
    });
  }

  async removeReply(id: string, replyId: string): Promise<Feedback> {
    if (!idPattern.test(replyId)) throw new InputError('Invalid reply ID');
    return this.serial(id, async () => {
      const feedback = await this.read(id);
      if (!feedback.replies?.some((reply) => reply.id === replyId)) throw Object.assign(new Error('Reply not found'), { code: 'ENOENT' });
      return this.write({ ...feedback, updatedAt: new Date().toISOString(), replies: feedback.replies.filter((reply) => reply.id !== replyId) });
    });
  }

  async clear(value: unknown): Promise<FeedbackClearResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid deletion scope');
    const input = value as FeedbackClearScope;
    const keys = Object.keys(input);
    if (input.scope === 'all') {
      if (keys.length !== 1) throw new InputError('Invalid deletion scope');
    } else if (input.scope === 'url') {
      if (keys.length !== 2 || keys.some((key) => !['scope', 'url'].includes(key)) || !isText(input.url, 4096)) throw new InputError('Invalid deletion scope');
      try { if (!['http:', 'https:'].includes(new URL(input.url).protocol)) throw new Error(); }
      catch { throw new InputError('Invalid deletion URL'); }
    } else throw new InputError('Invalid deletion scope');
    const url = input.scope === 'url' ? new URL(input.url).href : undefined;
    const result: FeedbackClearResult = { scope: input.scope, ...(url ? { url } : {}), deleted: [], failed: [] };
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    // Iterating a snapshot keeps the operation bounded while others keep submitting.
    // 一覧のスナップショットを順に処理し、他の投稿が続いても処理が終わるようにする。
    for (const entry of entries.filter((entry) => idPattern.test(entry.name))) {
      try {
        const feedback = await this.read(entry.name);
        if (url && new URL(feedback.url).href !== url) continue;
        await this.remove(entry.name);
        result.deleted.push(entry.name);
      } catch (error) {
        let gone = false;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try { await lstat(this.path(entry.name)); }
          catch (check) { gone = (check as NodeJS.ErrnoException).code === 'ENOENT'; }
        }
        // A concurrent deletion is the requested outcome, not a failure; a missing context file alone could still be a broken item.
        // 並行して削除済みなら目的は達成しているので失敗扱いにしない。context.jsonだけ無い場合は壊れたコメントの可能性があるため区別する。
        if (gone) result.deleted.push(entry.name);
        else result.failed.push({ id: entry.name, error: error instanceof Error ? error.message : 'Unable to delete feedback' });
      }
    }
    return result;
  }

  async remove(id: string): Promise<void> {
    return this.serial(id, async () => {
      // read() rejects symlinks first, so deletion cannot follow a link out of storage; renaming before rm hides the item from list at once.
      // 先にread()でシンボリックリンクを拒否し、保存先の外を消さないようにする。rmの前に名前を変え、一覧からすぐ見えなくする。
      await this.read(id);
      const deleted = join(this.directory, `.deleted-${randomUUID()}`);
      await rename(this.path(id), deleted);
      await rm(deleted, { recursive: true, force: true });
    });
  }
}
