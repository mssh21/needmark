import html2canvas from 'html2canvas-pro';
import { nativeSetTimeout, nativeClearTimeout } from '../animation-freeze.js';
import { viewportRectOf } from '../context/code-context.js';
import { rectanglesMatch } from './identity.js';

type NextNode = { selector: string } | { style: string[] } | { type: number; index: number; text: string | null };
interface FrameLocation { roots: string[]; parent?: string; next?: NextNode }
interface FrameSnapshot {
  frame: HTMLIFrameElement; location: FrameLocation; attributes: [string, string][]; styles: [string, string][];
  rect: ReturnType<typeof viewportRectOf>; localRect: ReturnType<typeof viewportRectOf>; parentRect: ReturnType<typeof viewportRectOf>;
  document: Document | null; url?: string;
  width: number; height: number; scrollX: number; scrollY: number; png?: string; children?: FrameCapturePlan;
}
export interface FrameCapturePlan {
  restore(clone: Document): Promise<void>;
  validate(): void;
}
const changed = () => new Error('撮影中に埋め込み画面が変わりました。画像なしで保存するか、場所を選び直してください。');
const unavailable = () => new Error('埋め込み画面を再現できませんでした。画像なしで保存するか、高精度キャプチャを選んでください。');
const ignored = (element: Element) => !!element.closest('[data-needmark],[data-html2canvas-ignore]') || element.localName === 'script';
// html2canvas scrolls its clone before onclone, and a page with smooth scrolling is still moving there, so frames are compared in document coordinates.
// html2canvasはoncloneの前に複製をスクロールし、なめらかなスクロールのページではまだ移動中のため、iframeは文書座標で比較する。
const documentRect = (element: Element) => {
  const rect = element.getBoundingClientRect(), view = element.ownerDocument.defaultView;
  return { x: rect.x + (view?.scrollX ?? 0), y: rect.y + (view?.scrollY ?? 0), width: rect.width, height: rect.height };
};
const styleEntries = (element: Element): [string, string][] => {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return Array.from(style).map((name): [string, string] => [name, style.getPropertyValue(name)]);
};

// html2canvas removes its clone iframe only in a finally that our onclone rejection runs before, so we remove just that clone to avoid leaking it.
// html2canvasは複製用iframeをfinallyでしか削除せず、oncloneでの拒否はその前に起きるため、その複製だけを自分で取り除いて残さないようにする。
export function removeFailedCaptureClone(clone: Document): void {
  const frame = clone.defaultView?.frameElement;
  if (frame?.classList.contains('html2canvas-container')) frame.remove();
}

function locationOf(frame: HTMLIFrameElement, document: Document): FrameLocation {
  const roots: string[] = [];
  let root = frame.getRootNode() as Document | ShadowRoot;
  while (root !== document) {
    if (!('host' in root) || root.host.shadowRoot !== root || roots.length >= 8) throw unavailable();
    roots.unshift(cloneSelectorOf(root.host)); root = root.host.getRootNode() as Document | ShadowRoot;
  }
  let next = frame.nextSibling;
  while (next && next.nodeType === 1 && ((next as Element).localName === 'iframe' || ignored(next as Element))) next = next.nextSibling;
  let position: NextNode | undefined;
  if (next?.nodeType === 1 && (next as Element).localName === 'style') {
    const style = next as HTMLStyleElement, text = style.textContent ?? '';
    let rules = ''; try { rules = Array.from(style.sheet?.cssRules ?? [], (rule) => rule.cssText).join(''); } catch { throw unavailable(); }
    // The renderer may copy either CSSOM edits or the literal text, and its own pseudo-element stylesheet shifts STYLE ordinals, so match by content.
    // レンダラーはCSSOMの変更と元のテキストのどちらも複製し得て、独自の疑似要素用スタイルでSTYLEの順番もずれるため、内容で照合する。
    position = { style: [...new Set([text, rules, rules + text])] };
  } else if (next?.nodeType === 1) position = { selector: cloneSelectorOf(next as Element) };
  else if (next) position = { type: next.nodeType, index: Array.from(next.parentNode!.childNodes).filter((node) => node.nodeType === next!.nodeType).indexOf(next), text: next.textContent };
  return { roots, ...(frame.parentElement ? { parent: cloneSelectorOf(frame.parentElement) } : {}), ...(position ? { next: position } : {}) };
}

// The clone drops iframes, scripts and ignored nodes and renames custom elements, so paths count only siblings that survive cloning.
// 複製ではiframe・script・除外ノードが消え、独自要素の名前も変わるため、複製後に残る兄弟だけを数えて経路を作る。
function cloneSelectorOf(element: Element): string {
  const parts: string[] = [];
  const tagOf = (node: Element) => node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.localName.includes('-') ? 'div' : node.localName;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (parts.length >= 40) throw unavailable();
    const tag = tagOf(node), parent = node.parentElement ?? node.getRootNode() as Document | ShadowRoot;
    const siblings = Array.from(parent.children).filter((sibling) => !ignored(sibling) && sibling.localName !== 'iframe' && tagOf(sibling) === tag);
    const index = siblings.indexOf(node);
    if (index < 0) throw unavailable();
    parts.unshift(`${CSS.escape(tag)}:nth-of-type(${index + 1})`);
  }
  const selector = parts.join(' > '); if (selector.length > 2000) throw unavailable();
  return selector;
}

function unique(root: Document | ShadowRoot | Element, selector: string): Element {
  const elements = root.querySelectorAll(selector);
  if (elements.length !== 1) throw unavailable();
  return elements[0]!;
}
function locate(clone: Document, location: FrameLocation): { parent: Element | ShadowRoot; next: Node | null } {
  let root: Document | ShadowRoot | Element = clone;
  for (const selector of location.roots) {
    const host = unique(root, selector); root = host.shadowRoot ?? host; /* The renderer may flatten an open shadow root into its host. / レンダラーがopen shadow rootをホストへ平坦化する場合があるため。 */
  }
  const parent = location.parent ? unique(root, location.parent) : root;
  if (parent.nodeType === 9) throw unavailable();
  let next: Node | null = null;
  const position = location.next;
  if (position) {
    if ('selector' in position) next = unique(root, position.selector);
    else if ('style' in position) {
      const styles = Array.from(parent.childNodes).filter((node) => node.nodeType === 1 && (node as Element).localName === 'style' && position.style.includes(node.textContent ?? ''));
      if (styles.length !== 1) throw unavailable(); next = styles[0]!;
    }
    else {
      next = Array.from(parent.childNodes).filter((node) => node.nodeType === position.type)[position.index] ?? null;
      if (!next || next.textContent !== position.text) throw unavailable();
    }
  }
  if (next && next.parentNode !== parent) throw unavailable();
  return { parent: parent as Element | ShadowRoot, next };
}

function inertFrame(clone: Document, record: FrameSnapshot): HTMLIFrameElement {
  const frame = clone.createElement('iframe');
  for (const [name, value] of record.attributes) {
    if (!['src', 'srcdoc', 'sandbox'].includes(name.toLowerCase()) && !name.toLowerCase().startsWith('on')) frame.setAttribute(name, value);
  }
  for (const [name, value] of record.styles) frame.style.setProperty(name, value);
  frame.style.setProperty('animation', 'none'); frame.style.setProperty('transition-property', 'none');
  if (record.png) {
    const previous = frame.style.backgroundImage || 'none';
    const clip = frame.style.backgroundClip.split(',')[0]!.trim() || 'border-box';
    frame.style.setProperty('background-image', `url("${record.png}"), ${previous}`, 'important');
    // html2canvas applies the first background-clip to the whole stack, so the page's clip stays first and origin/repeat confine our PNG instead.
    // html2canvasは最初のbackground-clipを背景全体に適用するため、ページのclipを先頭に残し、PNGの範囲はoriginとrepeatで制限する。
    for (const [name, value] of [['background-size', '100% 100%'], ['background-position', '0 0'], ['background-repeat', 'no-repeat'], ['background-origin', 'content-box'], ['background-clip', clip]] as const) {
      const previousValue = frame.style.getPropertyValue(name);
      frame.style.setProperty(name, `${value}, ${previousValue}`, 'important');
    }
  }
  // An empty sandboxed srcdoc keeps the iframe's box and selector path for layout while preventing the renderer from loading the live child page again.
  // 空のsandbox付きsrcdocにすると、iframeの箱と経路はレイアウト用に残したまま、レンダラーが子ページを再読み込みしないようにできる。
  frame.setAttribute('sandbox', ''); frame.loading = 'eager'; frame.srcdoc = '<!doctype html><html><head></head><body></body></html>';
  return frame;
}

// html2canvas cannot render iframe contents, so each accessible child is rendered separately at its own viewport and pasted back as an image.
// html2canvasはiframeの中身を描画できないため、アクセスできる子ページをそれぞれの表示領域で個別に描画し、画像として貼り戻す。
export async function captureFramePlan(document: Document, scale: number,
  cloneOptions: (source: Document) => (clone: Document) => void,
  budget = { frames: 0 }, depth = 0): Promise<FrameCapturePlan> {
  const records: FrameSnapshot[] = [];
  const view = document.defaultView, viewport = document.scrollingElement ?? document.documentElement;
  const scrollbars = !!view && (view.innerWidth > viewport.clientWidth || view.innerHeight > viewport.clientHeight);
  function frameElements(root: Document | ShadowRoot): HTMLIFrameElement[] {
    const frames: HTMLIFrameElement[] = [];
    for (const element of root.querySelectorAll('*')) {
      if (ignored(element)) continue;
      if (element.shadowRoot) frames.push(...frameElements(element.shadowRoot));
      if (element.localName === 'iframe') frames.push(element as HTMLIFrameElement);
    }
    return frames;
  }
  for (const frame of frameElements(document)) {
      if (++budget.frames > 64 || depth >= 8) throw unavailable();
      let child: Document | null = null;
      try { child = frame.contentDocument; } catch { /* Cross-origin documents throw on access; they keep their outer box only. / 別オリジンの文書はアクセス時に例外を投げるため、外枠だけを残す。 */ }
      const view = child?.defaultView;
      const styles = styleEntries(frame);
      if (child && styles.some(([name, value]) => name === 'background-blend-mode' && value.split(',').some((mode) => mode.trim() !== 'normal'))) throw unavailable();
      const parent = frame.parentElement ?? (frame.getRootNode() as ShadowRoot).host;
      records.push({ frame, location: locationOf(frame, document), rect: viewportRectOf(frame), localRect: documentRect(frame), parentRect: documentRect(parent),
        attributes: Array.from(frame.attributes, ({ name, value }): [string, string] => [name, value]), styles, document: child,
        ...(child ? { url: child.URL } : {}), width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0,
        scrollX: view?.scrollX ?? 0, scrollY: view?.scrollY ?? 0 });
  }
  const validate = () => {
    const current = frameElements(document);
    if (current.length !== records.length || current.some((frame, index) => frame !== records[index]!.frame)) throw changed();
    for (const record of records) {
      try {
        const child = record.frame.contentDocument, view = child?.defaultView;
        if (!record.frame.isConnected || child !== record.document || child?.URL !== record.url
          || (view?.innerWidth ?? 0) !== record.width || (view?.innerHeight ?? 0) !== record.height
          || (view?.scrollX ?? 0) !== record.scrollX || (view?.scrollY ?? 0) !== record.scrollY
          || !rectanglesMatch(viewportRectOf(record.frame), record.rect)
          || JSON.stringify(locationOf(record.frame, document)) !== JSON.stringify(record.location)
          || JSON.stringify(styleEntries(record.frame)) !== JSON.stringify(record.styles)) throw changed();
        record.children?.validate();
      } catch { throw changed(); }
    }
  };
  for (const record of records) {
    if (!record.document || !record.width || !record.height || !record.rect.width || !record.rect.height) continue;
    record.children = await captureFramePlan(record.document, scale, cloneOptions, budget, depth + 1);
    const prepareClone = cloneOptions(record.document);
    const canvas = await html2canvas(record.document.documentElement, {
      x: record.scrollX, y: record.scrollY, width: record.width, height: record.height,
      windowWidth: record.width, windowHeight: record.height, scrollX: record.scrollX, scrollY: record.scrollY,
      scale: Math.min(scale, 2560 / record.width, 2560 / record.height), useCORS: true, logging: false, backgroundColor: null,
      ignoreElements: (element) => ignored(element) || element.localName === 'iframe',
      onclone: async (clone) => {
        try { await record.children!.restore(clone); prepareClone(clone); }
        catch (error) { removeFailedCaptureClone(clone); throw error; }
      },
    });
    record.png = canvas.toDataURL('image/png');
    const image = new Image(); image.src = record.png;
    try { await image.decode(); } catch { throw unavailable(); }
    validate();
  }
  return { validate, async restore(clone) {
    // html2canvas lays its clone out with scrolling="no", so a page that reserves room for classic scrollbars would be laid out wider there and every box would move.
    // Giving the clone its own scrollbars back keeps the live layout, including media queries, instead of loosening the frame position check.
    // html2canvasは複製をscrolling="no"で配置するため、従来型スクロールバーの幅を確保するページでは複製の方が広く配置され、すべての箱がずれる。
    // 枠の位置確認を緩める代わりに複製へスクロールバーを戻し、メディアクエリも含めて実際の配置を保つ。
    if (scrollbars) clone.defaultView?.frameElement?.removeAttribute('scrolling');
    const locations = records.map((record) => locate(clone, record.location));
    const frames = records.map((record) => inertFrame(clone, record));
    const detach: (() => void)[] = [];
    try {
      await Promise.all(frames.map((frame, index) => new Promise<void>((resolve, reject) => {
        const loaded = () => { nativeClearTimeout(deadline); resolve(); };
        const deadline = nativeSetTimeout(() => reject(unavailable()), 3000);
        frame.addEventListener('load', loaded, { once: true });
        detach.push(() => { nativeClearTimeout(deadline); frame.removeEventListener('load', loaded); });
        const { parent, next } = locations[index]!;
        parent.insertBefore(frame, next);
      })));
      for (let index = 0; index < frames.length; index++) {
        const parent = locations[index]!.parent;
        const box = parent.nodeType === 11 ? (parent as ShadowRoot).host : parent as Element;
        if (!rectanglesMatch(documentRect(frames[index]!), records[index]!.localRect)
          || !rectanglesMatch(documentRect(box), records[index]!.parentRect)) throw unavailable();
      }
    } catch (error) { frames.forEach((frame) => frame.remove()); throw error; }
    finally { detach.forEach((clean) => clean()); }
  } };
}
