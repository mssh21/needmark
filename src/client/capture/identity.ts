import { describeElement, resolveContextElement, viewportRectForRange, viewportRectsForRange, viewportRectOf } from '../context/code-context.js';
import type { ElementContext, FeedbackInput, Rectangle } from '../../shared/types.js';

export type CaptureAnchors = { elements?: readonly Element[]; range?: Range };
export interface CaptureSnapshot {
  rect: Rectangle;
  viewport: FeedbackInput['viewport'];
  capturedAt: string;
  url: string;
  geometry: { context: ElementContext; rect: Rectangle }[];
  lines?: Rectangle[];
}
export interface CaptureGuard { prepare(): CaptureSnapshot; validate(snapshot: CaptureSnapshot): void }
const changedMessage = '選択した対象が変わりました。画像なしで保存するか、場所を選び直してください。';
const rectangleKeys = ['x', 'y', 'width', 'height'] as const;
const viewportKeys = ['width', 'height', 'devicePixelRatio', 'scrollX', 'scrollY'] as const;

export function rectanglesMatch(a: Rectangle, b: Rectangle): boolean {
  return rectangleKeys.every((key) => Number.isFinite(a[key]) && Number.isFinite(b[key]) && Math.abs(a[key] - b[key]) <= 0.5);
}
export function captureViewport(): FeedbackInput['viewport'] {
  return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY };
}
function usable(rect: Rectangle): boolean { return rectangleKeys.every((key) => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0; }
function union(rectangles: Rectangle[]): Rectangle {
  const x = Math.min(...rectangles.map((rect) => rect.x)), y = Math.min(...rectangles.map((rect) => rect.y));
  return { x, y, width: Math.max(...rectangles.map((rect) => rect.x + rect.width)) - x, height: Math.max(...rectangles.map((rect) => rect.y + rect.height)) - y };
}
function visibleRectangle(element: Element, host?: Element): Rectangle {
  const rect = viewportRectOf(element);
  if (!element.isConnected || !element.getClientRects().length || !usable(rect)) throw new Error(changedMessage);
  for (let owner: Element | null = element, depth = 0; owner && depth < 40; depth++) {
    if (owner === host) throw new Error(changedMessage);
    const style = owner.ownerDocument.defaultView!.getComputedStyle(owner);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || style.opacity === '0') throw new Error(changedMessage);
    const root = owner.getRootNode();
    owner = owner.parentElement ?? ('host' in root ? (root as ShadowRoot).host : owner.ownerDocument.defaultView?.frameElement ?? null);
  }
  return rect;
}

// Capture checks the exact nodes that were selected, held only in memory, because a saved selector could match an identical replacement and accept a wrong image.
// 保存用のセレクターは同じ内容の差し替え要素にも一致し誤った画像を受け入れ得るため、撮影時は選択した実ノードそのもの（メモリ上だけに保持）で確認する。
export function createCaptureGuard(target: FeedbackInput['target'], anchors: CaptureAnchors = {}, host?: Element): CaptureGuard {
  type Evidence = { context: ElementContext; identity: ElementContext; element: Element | null; root?: Node; document?: Document; fixed: boolean };
  const evidence = new Map<ElementContext, Evidence>();
  const kind = target.kind, fixed = kind === 'area';
  const selectedRect = { ...target.rect };
  let invalid = false, originalUrl = '', originalViewport: FeedbackInput['viewport'] | undefined;
  let text: { range: Range; start: Node; end: Node; startOffset: number; endOffset: number; root: Node; document: Document; value: string } | undefined;
  const add = (context: ElementContext, element?: Element): void => {
    const existing = evidence.get(context);
    if (existing) { if (element && existing.element !== element) invalid = true; return; }
    const identity = structuredClone(context), original = element ?? resolveContextElement(identity);
    evidence.set(context, { context, identity, element: original, root: original?.getRootNode(), document: original?.ownerDocument, fixed });
  };
  try {
    originalUrl = location.href; originalViewport = captureViewport();
    if (kind === 'element' || kind === 'multi') {
      const contexts = target.code?.elements ?? [], elements = anchors.elements ?? [];
      if (!elements.length || new Set(elements).size !== elements.length || contexts.length !== elements.length || kind === 'element' && elements.length !== 1) invalid = true;
      contexts.forEach((context, index) => add(context, elements[index]));
    } else if (kind === 'text') {
      const range = anchors.range?.cloneRange();
      if (!range || range.startContainer.getRootNode() !== range.endContainer.getRootNode() || !range.startContainer.ownerDocument) invalid = true;
      else text = { range, start: range.startContainer, end: range.endContainer, startOffset: range.startOffset, endOffset: range.endOffset,
        root: range.startContainer.getRootNode(), document: range.startContainer.ownerDocument, value: range.toString() };
    }
    target.code?.elements.forEach((context) => add(context));
  } catch { invalid = true; }
  const prepare = (): CaptureSnapshot => {
    try {
      const viewport = captureViewport(), url = location.href;
      if (invalid || !usable(selectedRect) || url !== originalUrl || !viewportKeys.every((key) => Number.isFinite(viewport[key])) || viewport.width <= 0 || viewport.height <= 0 || viewport.devicePixelRatio <= 0
        || fixed && originalViewport && viewportKeys.some((key) => viewport[key] !== originalViewport![key])) throw new Error(changedMessage);
      const geometry = [...evidence.values()].map((entry) => {
        const { element, identity } = entry;
        if (!element || !element.isConnected || element.getRootNode() !== entry.root || element.ownerDocument !== entry.document || resolveContextElement(identity) !== element) throw new Error(changedMessage);
        if (identity.components.length && describeElement(element).components.at(-1) !== identity.components.at(-1)) throw new Error(changedMessage);
        const rect = visibleRectangle(element, host);
        if (entry.fixed && !rectanglesMatch(rect, identity.rect)) throw new Error(changedMessage);
        return { context: entry.context, rect };
      });
      let rect = selectedRect, lines: Rectangle[] | undefined;
      if (kind === 'element' || kind === 'multi') rect = kind === 'element' ? geometry[0]!.rect : union(geometry.map((entry) => entry.rect));
      if (kind === 'text') {
        if (!text || !text.start.isConnected || !text.end.isConnected || text.start.getRootNode() !== text.root || text.end.getRootNode() !== text.root
          || text.document.defaultView?.document !== text.document || text.range.startContainer !== text.start || text.range.endContainer !== text.end
          || text.range.startOffset !== text.startOffset || text.range.endOffset !== text.endOffset || text.range.toString() !== text.value || !text.value.trim()) throw new Error(changedMessage);
        rect = viewportRectForRange(text.range); lines = viewportRectsForRange(text.range);
      }
      if (!usable(rect)) throw new Error(changedMessage);
      return { rect: { ...rect }, viewport, capturedAt: new Date().toISOString(), url, geometry, ...(lines?.length ? { lines } : {}) };
    } catch { throw new Error(changedMessage); }
  };
  return { prepare, validate(snapshot) {
    const current = prepare();
    if (current.url !== snapshot.url || viewportKeys.some((key) => current.viewport[key] !== snapshot.viewport[key]) || !rectanglesMatch(current.rect, snapshot.rect)
      || current.geometry.length !== snapshot.geometry.length || current.geometry.some((entry, index) => entry.context !== snapshot.geometry[index]?.context || !rectanglesMatch(entry.rect, snapshot.geometry[index]!.rect))) throw new Error(changedMessage);
  } };
}

export function applyCaptureSnapshot(target: FeedbackInput['target'], snapshot: CaptureSnapshot): void {
  target.rect = { ...snapshot.rect };
  for (const entry of snapshot.geometry) entry.context.rect = { ...entry.rect };
}
