import type { NeedMarkLanguage } from './language.js';
import { isContextAttributeName } from './context-attributes.js';

export type { NeedMarkLanguage } from './language.js';

export const FEEDBACK_STATUSES = ['open', 'resolved'] as const;
export type FeedbackStatus = typeof FEEDBACK_STATUSES[number];
export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return FEEDBACK_STATUSES.some((status) => status === value);
}

export const FEEDBACK_CATEGORIES = ['fix', 'discuss', 'question'] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];
export const isFeedbackCategory = (value: unknown): value is FeedbackCategory => FEEDBACK_CATEGORIES.some((item) => item === value);

/** These URLs come from the browser, so only their shape is checked; nothing fetches them or treats them as permission, which avoids server-side request forgery. / URLはブラウザ由来のため形だけを検査し、取得も権限としての利用もしない（サーバー側リクエスト偽造を避ける）。 */
export function isFrameUrls(value: unknown, rootPath: readonly string[] | undefined, pageUrl: string): value is string[] {
  const roots = rootPath ?? [];
  if (!Array.isArray(roots) || roots.length > 8 || Array.from(roots).some((entry) => typeof entry !== 'string')
    || !Array.isArray(value) || value.length > 8 || value.length !== roots.filter((entry) => entry.startsWith('iframe: ')).length) return false;
  return Array.from(value).every((url) => {
    if (typeof url !== 'string' || !url || url.length > 4096) return false;
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) return true;
      if (parsed.protocol === 'about:' && ['blank', 'srcdoc'].includes(parsed.pathname)) return true;
      if (parsed.protocol !== 'blob:') return false;
      const inner = new URL(url.slice(5));
      return ['http:', 'https:'].includes(inner.protocol) && inner.origin === new URL(pageUrl).origin;
    } catch { return false; }
  });
}

export interface Rectangle { x: number; y: number; width: number; height: number }

export interface SourceLocation { file: string; line: number; column: number; component?: string }
/** Field meanings: docs/architecture.md#code-identification. / 各項目の意味は docs/architecture.md#code-identification を参照。 */
export interface ElementContext {
  tag: string; selector: string; text: string; rect: Rectangle;
  attributes: Record<string, string>; styles: Record<string, string>;
  headings: string[]; components: string[];
  accessibleName?: string;
  rootPath?: string[];
  frameUrls?: string[];
  source?: SourceLocation;
  sourceOrigin?: 'runtime';
  sourceHint?: { file: string; component?: string };
  sourceRelation?: 'self' | 'ancestor';
}
export interface CodeContext { elements: ElementContext[]; truncated: boolean }

export interface RuntimeSourceFrame { url: string; line: number; column: number; component?: string }
export interface RuntimeSourceRequest {
  elements: { tag: string; attributes: Record<string, string>; frames: RuntimeSourceFrame[] }[];
}
export interface RuntimeSourceResult { source?: SourceLocation; sourceHint?: { file: string; component?: string } }


/** File format: docs/architecture.md#files-and-mutation. / 保存形式は docs/architecture.md#files-and-mutation を参照。 */
export interface FeedbackInput {
  intent?: 'reference';
  category?: FeedbackCategory;
  comment: string;
  author: string;
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  target: { kind: 'element' | 'area' | 'text' | 'multi'; text: string; selector: string; rect: Rectangle; code?: CodeContext };
  capture: { method: 'tab' | 'dom' | 'none'; width: number; height: number };
  screenshot?: string;
}

export interface FeedbackReply {
  id: string;
  createdAt: string;
  updatedAt?: string;
  author: string;
  comment: string;
}
export interface FeedbackReplyInput { author: string; comment: string }
export interface FeedbackPatch { comment?: string; author?: string; status?: FeedbackStatus; category?: FeedbackCategory | null }
export type FeedbackClearScope = { scope: 'all' } | { scope: 'url'; url: string };
export interface FeedbackClearResult { scope: 'all' | 'url'; url?: string; deleted: string[]; failed: { id: string; error: string }[] }

export interface Feedback extends Omit<FeedbackInput, 'screenshot'> {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: FeedbackStatus;
  image?: 'screenshot.png';
  replies?: FeedbackReply[];
}

/** Position and visible text change with layout and content, so only recorded identifiers let a later reader find the same target. / 位置や表示テキストはレイアウトや内容で変わるため、後から同じ対象を見つけられるのは記録した識別子だけだから。 */
export function hasReferenceTarget(target: FeedbackInput['target']): boolean {
  const text = (value: unknown) => typeof value === 'string' && !!value.trim();
  return text(target.selector) || !!target.code?.elements.some((element) => text(element.selector)
    || text(element.source?.file) || text(element.sourceHint?.file) || element.components.some(text)
    || Object.entries(element.attributes).some(([name, value]) => isContextAttributeName(name) && text(value)));
}

/** One predicate shared by the UI, CLI, API and prompts keeps every handoff path consistent about what counts as a repair request. / UI・CLI・API・プロンプトで同じ判定を共有し、どの受け渡し経路でも修正依頼の範囲を揃えるため。 */
export function isRepairFeedback(item: Pick<Feedback, 'intent' | 'status'>): boolean {
  return item.intent === undefined && item.status === 'open';
}

export type CaptureMethod = 'tab' | 'dom' | 'none';

export type FeedbackChangeEvent = { directory: string } & (
  { type: 'created' | 'updated'; feedback: Feedback }
  | { type: 'deleted'; id: string }
  | { type: 'cleared'; result: FeedbackClearResult }
);
export interface FeedbackSubmission {
  feedback: Feedback[];
  prompt: string;
  directory: string;
  detail: 'compact' | 'standard' | 'detailed' | 'forensic';
  language?: NeedMarkLanguage;
}

/** Options are specified in docs/getting-started.md#project-configuration. / 各オプションの仕様は docs/getting-started.ja.md#プロジェクト設定 を参照。 */
export interface NeedMarkOptions {
  enabled?: boolean;
  origins?: string[];
  language?: NeedMarkLanguage;
  capture?: CaptureMethod;
  outputDir?: string;
  contextAttributes?: string[];
  editor?: 'vscode' | 'cursor';
  onFeedbackChange?: (event: FeedbackChangeEvent) => void | Promise<void>;
  onSubmit?: (submission: FeedbackSubmission) => void | Promise<void>;
}
