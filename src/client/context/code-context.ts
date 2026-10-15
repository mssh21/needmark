import { isFrameUrls, type CodeContext, type ElementContext, type Rectangle, type RuntimeSourceFrame, type RuntimeSourceRequest, type SourceLocation } from '../../shared/types.js';

import { DEFAULT_CONTEXT_ATTRIBUTES, identifyingContextAttributes, normalizeContextAttributes } from '../../shared/context-attributes.js';

let customContextAttributes: string[] = [];

// One widget is mounted per document, so module state set once avoids threading the attribute list through every selection helper.
// ウィジェットは文書ごとに1つなので、一度設定するモジュールの状態にして、属性リストをすべての選択処理へ引き回さずに済むようにする。
export function configureContextAttributes(attributes?: readonly string[]): void {
  customContextAttributes = normalizeContextAttributes(attributes);
}
const styleProperties = ['display', 'position', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'margin', 'padding', 'gap', 'align-items', 'justify-content', 'width', 'height', 'border-radius', 'border', 'text-align', 'overflow'] as const;
const controls = 'button,a,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"]';
const textBlocks = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,pre,figcaption,caption,th,td,label,summary';
const media = 'img,svg,canvas,video,iframe';
const inlineTags = new Set(['span', 'b', 'strong', 'i', 'em', 'small', 'mark', 'code', 's', 'u', 'br', 'wbr']);
const omittedTags = new Set(['script', 'style', 'noscript', 'br', 'wbr', 'meta', 'link', 'head', 'title']);

function rootOf(element: Element): Document | ShadowRoot {
  return element.getRootNode() as Document | ShadowRoot;
}

export function selectorOf(element: Element): string {
  const parts: string[] = [];
  const root = rootOf(element), identifiers = identifyingContextAttributes(customContextAttributes);
  for (let node: Element | null = element; node && parts.length < 40; node = node.parentElement) {
    let part = CSS.escape(node.localName);
    let anchor: string | undefined;
    for (const name of identifiers) {
      const value = node.getAttribute(name); if (!value || value.length > 500) continue;
      const marker: string = name === 'id' ? `#${CSS.escape(value)}` : `[${name}="${CSS.escape(value)}"]`;
      const candidate = name === 'id' ? marker : part + marker;
      if ([candidate, ...parts].join(' > ').length > 2000) continue;
      const matched: NodeListOf<Element> = root.querySelectorAll(marker);
      if (matched.length === 1 && matched[0] === node) { anchor = candidate; break; }
    }
    if (anchor) part = anchor;
    else {
      const siblings = Array.from(node.parentElement?.children ?? root.children).filter((sibling) => sibling.tagName === node!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    const candidate = [part, ...parts].join(' > ');
    if (candidate.length > 2000) break;
    parts.unshift(part);
    const matched = root.querySelectorAll(candidate);
    if (matched.length === 1 && matched[0] === element) return candidate;
  }
  // A non-unique path is still worth saving as a code-search hint, because resolution later rejects ambiguous matches.
  // 一意でない経路でもコード検索の手掛かりとして保存する価値があり、後の解決時に曖昧な一致は拒否されるため。
  return parts.join(' > ');
}

function frameOf(document: Document): Element | null {
  try { return document.defaultView?.frameElement ?? null; } catch { return null; }
}

function parentOf(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = rootOf(element);
  return 'host' in root ? root.host : frameOf(element.ownerDocument);
}

// A partial URL list could match an iframe on a different nested route, so URLs are recorded only when every frame on the path is readable.
// URLの一部だけだと別の階層にあるiframeに一致し得るため、経路上のすべてのフレームを読めた場合だけURLを記録する。
function rootEvidenceOf(element: Element): { rootPath: string[]; frameUrls?: string[] } {
  const rootPath: string[] = [], frameUrls: string[] = [];
  let root = rootOf(element), reliable = true;
  try {
    for (let depth = 0; root !== document && depth < 8; depth++) {
      if ('host' in root) {
        if (root.host.shadowRoot !== root) reliable = false;
        rootPath.unshift(`shadow: ${selectorOf(root.host)}`); root = rootOf(root.host);
      } else {
        const frame = frameOf(root) as HTMLIFrameElement | null;
        if (!frame) break;
        if (frame.contentDocument !== root || root.defaultView?.document !== root) reliable = false;
        frameUrls.unshift(root.URL); rootPath.unshift(`iframe: ${selectorOf(frame)}`); root = rootOf(frame);
      }
    }
  } catch { reliable = false; }
  reliable &&= root === document && isFrameUrls(frameUrls, rootPath, document.URL);
  return { rootPath, ...(reliable ? { frameUrls } : {}) };
}

export function resolveElement(selector: string, rootPath: readonly string[] = []): Element | null {
  if (!selector || rootPath.length > 8) return null;
  let root: Document | ShadowRoot = document;
  try {
    for (const entry of rootPath) {
      const separator = entry.indexOf(': ');
      const kind = entry.slice(0, separator);
      const hosts: NodeListOf<Element> = root.querySelectorAll(entry.slice(separator + 2));
      if (hosts.length !== 1) return null;
      const host = hosts[0]!;
      if (kind === 'shadow' && host.shadowRoot) root = host.shadowRoot;
      else if (kind === 'iframe' && host.tagName.toLowerCase() === 'iframe') {
        const content: Document | null = (host as HTMLIFrameElement).contentDocument;
        if (!content) return null;
        root = content;
      } else return null;
    }
    const matched = root.querySelectorAll(selector);
    return matched.length === 1 ? matched[0]! : null;
  } catch { return null; }
}

// getBoundingClientRect returns the iframe's border box, but the child viewport starts at its content box, so border and padding are added before scaling.
// getBoundingClientRectはiframeのボーダーボックスを返すが、子ページの表示領域はコンテンツボックスから始まるため、拡大縮小の前にボーダーとパディングを足す。
function frameTransform(frame: HTMLElement) {
  const bounds = frame.getBoundingClientRect(), style = frame.ownerDocument.defaultView!.getComputedStyle(frame);
  const scaleX = frame.offsetWidth ? bounds.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight ? bounds.height / frame.offsetHeight : 1;
  return { bounds, scaleX, scaleY,
    offsetX: frame.clientLeft + Number.parseFloat(style.paddingLeft),
    offsetY: frame.clientTop + Number.parseFloat(style.paddingTop) };
}

function rectInTopViewport(rect: Rectangle, owner: Document): Rectangle {
  let result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  for (let depth = 0; depth < 8; depth++) {
    const frame = frameOf(owner) as HTMLElement | null;
    if (!frame) break;
    const { bounds, scaleX, scaleY, offsetX, offsetY } = frameTransform(frame);
    result = { x: bounds.x + (offsetX + result.x) * scaleX, y: bounds.y + (offsetY + result.y) * scaleY,
      width: result.width * scaleX, height: result.height * scaleY };
    owner = frame.ownerDocument;
  }
  return result;
}

export function viewportRectOf(element: Element): Rectangle {
  return rectInTopViewport(element.getBoundingClientRect(), element.ownerDocument);
}

export function viewportRectForRange(range: Range): Rectangle {
  return rectInTopViewport(range.getBoundingClientRect(), range.startContainer.ownerDocument ?? document);
}

export function viewportRectsForRange(range: Range): Rectangle[] {
  const owner = range.startContainer.ownerDocument ?? document;
  return Array.from(range.getClientRects(), (rect) => rectInTopViewport(rect, owner)).filter((rect) => rect.width > 0 && rect.height > 0);
}

function belongsTo(element: Element, host?: Element): boolean {
  for (let node: Element | null = element, depth = 0; host && node && depth < 40; node = parentOf(node), depth++) {
    if (node === host) return true;
  }
  return false;
}

// elementsFromPoint gives the whole hit stack without hiding overlays; toggling pointer-events or visibility would alter the app and could leak into screenshots.
// elementsFromPointならオーバーレイを隠さずに重なり全体を得られる。pointer-eventsや表示を切り替えるとアプリが変わり、撮影結果にも影響し得るため。
function lowerElementAtPoint(x: number, y: number, excludedHost?: Element): Element | undefined {
  const rectangles = new Map<Element, Rectangle | undefined>();
  const visible = (element: Element): Rectangle | undefined => {
    if (!rectangles.has(element)) rectangles.set(element, visibleRectOf(element));
    return rectangles.get(element);
  };
  const descendantOf = (element: Element, ancestor: Element): boolean => {
    for (let node: Element | null = element, depth = 0; node && depth < 200; node = node.assignedSlot ?? parentOf(node), depth++) if (node === ancestor) return true;
    return false;
  };
  const independent = (element: Element, top: Element): boolean => !element.contains(top) && !top.contains(element)
    && !descendantOf(element, top) && !descendantOf(top, element);
  const content = (element: Element): boolean => element.matches(controls) || !element.shadowRoot && (!element.matches('div,span,section,article,main,aside,header,footer,nav,slot')
    || Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim()));
  const child = (element: Element, x: number, y: number): { root: Document | ShadowRoot; x: number; y: number } | undefined => {
    if (element.shadowRoot) return { root: element.shadowRoot, x, y };
    if (element.localName !== 'iframe') return;
    try {
      const frame = element as HTMLIFrameElement, root = frame.contentDocument; if (!root) return;
      const { bounds, scaleX, scaleY, offsetX, offsetY } = frameTransform(frame);
      return { root, x: (x - bounds.x) / scaleX - offsetX, y: (y - bounds.y) / scaleY - offsetY };
    } catch { return; }
  };
  const search = (root: Document | ShadowRoot, x: number, y: number, depth: number, parent?: Element, skipTop = true): Element | undefined => {
    const hits = root.elementsFromPoint(x, y).filter((element) => element !== parent && (!excludedHost || !descendantOf(element, excludedHost))
      && (!('host' in root) || element.getRootNode() === root || root.host.contains(element) || descendantOf(element, root.host)));
    const top = hits[0]; if (!top) return;
    const inner = depth < 7 ? child(top, x, y) : undefined;
    // A deep click inside an open modal or embedded page usually means content inside it, so that root is searched before the outer page.
    // 開いているモーダルや埋め込みページ内での奥の選択は、その中の内容を指すことが多いため、外側のページより先にそのルートを探す。
    if (inner) { const found = search(inner.root, inner.x, inner.y, depth + 1, top, skipTop); if (found) return found; }
    let smallest: Element | undefined, area = Infinity;
    for (const element of hits) {
      if (element === top ? skipTop : !independent(element, top)) continue;
      if (element === element.ownerDocument.body || element === element.ownerDocument.documentElement) continue;
      const nested = element !== top && depth < 7 ? child(element, x, y) : undefined;
      const candidate = nested ? search(nested.root, nested.x, nested.y, depth + 1, element, false) ?? element : element;
      const rect = visible(candidate); if (!rect) continue;
      if (content(candidate)) return candidate;
      if (rect.width * rect.height < area) { smallest = candidate; area = rect.width * rect.height; }
    }
    return smallest;
  };
  return search(document, x, y, 0);
}

export function elementAtPoint(x: number, y: number, excludedHost?: Element, deep = false): Element | undefined {
  if (deep) return lowerElementAtPoint(x, y, excludedHost) ?? elementAtPoint(x, y, excludedHost);
  let root: Document | ShadowRoot = document;
  let result: Element | undefined;
  for (let depth = 0; depth < 8; depth++) {
    const candidate: Element | undefined = root.elementsFromPoint(x, y).find((element) => !belongsTo(element, excludedHost) && element !== result);
    if (!candidate) break;
    result = candidate;
    if (candidate.shadowRoot) { root = candidate.shadowRoot; continue; }
    if (candidate.localName === 'iframe') {
      try {
        const frame = candidate as HTMLIFrameElement, content = frame.contentDocument; if (!content) break;
        const { bounds, scaleX, scaleY, offsetX, offsetY } = frameTransform(frame);
        x = (x - bounds.x) / scaleX - offsetX; y = (y - bounds.y) / scaleY - offsetY;
        root = content; continue;
      } catch { break; }
    }
    break;
  }
  return result;
}


// The caret APIs stop at document and shadow-root boundaries, so the rendered root under the pointer is found first and queried directly.
// キャレット取得APIは文書とシャドウルートの境界で止まるため、先にポインター下で描画されているルートを特定し、そこへ直接問い合わせる。
export function caretRangeAtPoint(x: number, y: number, excludedHost?: Element): Range | null {
  const element = elementAtPoint(x, y, excludedHost);
  if (!element || element.matches('input,textarea')) return null;
  const owner = element.ownerDocument;
  const frames: HTMLElement[] = [];
  for (let document = owner, depth = 0; depth < 8; depth++) {
    const frame = frameOf(document) as HTMLElement | null;
    if (!frame) break;
    frames.unshift(frame); document = frame.ownerDocument;
  }
  for (const frame of frames) {
    const { bounds, scaleX, scaleY, offsetX, offsetY } = frameTransform(frame);
    if (!bounds.width || !bounds.height) return null;
    x = (x - bounds.x) / scaleX - offsetX;
    y = (y - bounds.y) / scaleY - offsetY;
  }
  const shadows: ShadowRoot[] = [];
  for (let root = rootOf(element), depth = 0; 'host' in root && depth < 8; depth++) {
    shadows.push(root); root = rootOf(root.host);
  }
  type CaretDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots: ShadowRoot[] }) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const target = owner as CaretDocument;
  try {
    const position = target.caretPositionFromPoint?.(x, y, { shadowRoots: shadows });
    let range: Range | null = null;
    if (position) { range = owner.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); }
    else range = target.caretRangeFromPoint?.(x, y) ?? null;
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || range.startContainer.getRootNode() !== rootOf(element)) return null;
    return range;
  } catch { return null; }
}

// A DOM Range cannot span documents or shadow roots, so a cross-root drag returns null instead of a misleading range.
// DOMのRangeは文書やシャドウルートをまたげないため、またいだドラッグでは誤解を招く範囲ではなくnullを返す。
export function rangeBetween(start: Range, end: Range): Range | null {
  if (start.startContainer.getRootNode() !== end.startContainer.getRootNode()) return null;
  try {
    const range = (start.startContainer.ownerDocument ?? document).createRange();
    const [first, last] = start.compareBoundaryPoints(Range.START_TO_START, end) <= 0 ? [start, end] : [end, start];
    range.setStart(first.startContainer, first.startOffset); range.setEnd(last.startContainer, last.startOffset);
    return range;
  } catch { return null; }
}

function sourceOf(element: Element): Pick<ElementContext, 'source' | 'sourceRelation'> {
  for (let owner: Element | null = element, depth = 0; owner && depth < 40; owner = parentOf(owner), depth++) {
    const value = owner.getAttribute('data-needmark-source');
    if (!value) continue;
    try {
      const source = JSON.parse(value) as SourceLocation;
      if (typeof source.file !== 'string' || !source.file || source.file.length > 1024 || !Number.isSafeInteger(source.line) || source.line < 1 || !Number.isSafeInteger(source.column) || source.column < 1) continue;
      return { source: { file: source.file, line: source.line, column: source.column, ...(typeof source.component === 'string' ? { component: source.component.slice(0, 100) } : {}) }, sourceRelation: owner === element ? 'self' : 'ancestor' };
    } catch { /* Source annotations come from the page and may be malformed; they are optional hints. / ソースの注釈はページ由来で壊れている場合があり、任意の手掛かりにすぎないため。 */ }
  }
  return {};
}

type Fiber = { type?: unknown; stateNode?: unknown; return?: Fiber; _debugStack?: unknown };

function hostFiberOf(element: Element): Fiber | null {
  const keys = Object.keys(element).filter((key) => key.startsWith('__reactFiber$'));
  if (keys.length !== 1) return null;
  const fiber = (element as unknown as Record<string, unknown>)[keys[0]!];
  if (!fiber || typeof fiber !== 'object') return null;
  const host = fiber as Fiber;
  return host.stateNode === element && typeof host.type === 'string' && host.type.toLowerCase() === element.tagName.toLowerCase() ? host : null;
}

function framesOf(fiber: Fiber): RuntimeSourceFrame[] {
  if (!Object.hasOwn(fiber, '_debugStack')) return [];
  const debug = fiber._debugStack;
  if (!debug || typeof debug !== 'object' || !('stack' in debug) || typeof debug.stack !== 'string') return [];
  const frames: RuntimeSourceFrame[] = [];
  for (const line of debug.stack.slice(0, 16000).split('\n').slice(0, 40)) {
    // V8 (`at name (url:line:col)`) and JavaScriptCore (`name@url:line:col`) print stacks differently, so each has a pattern and both produce one result shape.
    // V8とJavaScriptCoreはスタックの書式が異なるため、それぞれのパターンで解析し、同じ形の結果にそろえる。
    const match = /^\s*at\s+(?:(.*?)\s+\()?((?:https?:\/\/)\S+):([1-9]\d*):([1-9]\d*)\)?\s*$/.exec(line)
      ?? /^\s*([^@\r\n]*)@((?:https?:\/\/)\S+):([1-9]\d*):([1-9]\d*)\s*$/.exec(line);
    if (!match) continue;
    const [, owner, address, lineText, columnText] = match;
    if (!address || address.length > 2048) continue;
    const lineNumber = Number(lineText), column = Number(columnText);
    if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column) || lineNumber > 1000000 || column > 1000000) continue;
    try {
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      const name = owner?.split('.').at(-1);
      const component = name && /^[A-Z][A-Za-z0-9_$]{0,99}$/.test(name) ? name : undefined;
      if (frames.some((frame) => frame.url === url.href && frame.line === lineNumber && frame.column === column)) continue;
      frames.push({ url: url.href, line: lineNumber, column, ...(component ? { component } : {}) });
      if (frames.length === 5) break;
    } catch { /* blob:, eval and other unusual frame URLs cannot be mapped to project files. / blob:やevalなどのフレームURLはプロジェクトのファイルに対応付けられないため。 */ }
  }
  return frames;
}

// Only parsed frames are sent and never saved, because raw stacks can contain local paths and URL tokens.
// 生のスタックにはローカルのパスやURLのトークンが含まれ得るため、解析したフレームだけを送り、保存はしない。
export function runtimeSourceRequest(code: CodeContext, offset = 0): RuntimeSourceRequest {
  return { elements: code.elements.slice(offset, offset + 12).map((context) => {
    const entry = { tag: context.tag, attributes: { ...context.attributes }, frames: [] as RuntimeSourceFrame[] };
    if (context.source && context.sourceRelation === 'self' && context.sourceOrigin !== 'runtime') return entry;
    const element = resolveContextElement(context);
    if (!element) return entry;
    const fiber = hostFiberOf(element);
    if (fiber) entry.frames = framesOf(fiber);
    return entry;
  }) };
}

// Reading React's fiber through the DOM property avoids importing React, keeping the widget framework-independent.
// DOMのプロパティ経由でReactのfiberを読むことで、Reactをimportせずフレームワークに依存しないウィジェットのままにできる。
function componentsOf(element: Element): string[] {
  const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
  if (!key) return [];
  let fiber = (element as unknown as Record<string, Fiber>)[key];
  const names: string[] = [];
  for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
    let type = fiber.type as { displayName?: string; name?: string; render?: unknown; type?: unknown } | undefined;
    if (type && typeof type !== 'string') {
      type = (type.render ?? type.type ?? type) as typeof type;
      const name = type?.displayName ?? type?.name;
      if (typeof name === 'string' && name && name !== names.at(-1)) names.push(name.slice(0, 100));
    }
  }
  return names.slice(0, 20).reverse();
}

function textOf(element: Element): string {
  return ('innerText' in element ? (element as HTMLElement).innerText : element.textContent ?? '').trim();
}

function accessibleNameOf(element: Element): string {
  const root = rootOf(element);
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => root.getElementById(id)?.textContent ?? '').join(' ').trim();
  const label = 'labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).map(textOf).join(' ').trim() : '';
  return (labelledBy || element.getAttribute('aria-label')?.trim() || label || element.getAttribute('alt') || (element.matches(controls) ? textOf(element) : '') || element.getAttribute('title') || '').slice(0, 500);
}

// This runs on every pointer move, so it reads only cheap local hints and never builds saved context or calls the server.
// ポインターが動くたびに実行されるため、軽いローカルの手掛かりだけを読み、保存用の情報作成やサーバー呼び出しはしない。
export function hoverDescriptor(element: Element): { tag: string; name?: string; component?: string } {
  const normalize = (value: string | null | undefined, limit = 160) => value?.slice(0, 640).replace(/\s+/g, ' ').trim().slice(0, limit) ?? '';
  const labelText = (label: Element): string => {
    const privateText = 'input,textarea,select,script,style,noscript';
    if (label.matches(privateText)) return '';
    let text = '', node: Node | null = label.firstChild;
    const siblings: Node[] = [];
    for (let count = 0; node && count < 40 && text.length < 160; count++) {
      if (node.nodeType === Node.TEXT_NODE) text = normalize(`${text} ${normalize(node.nodeValue)}`);
      if (node.nodeType === Node.ELEMENT_NODE && !(node as Element).matches(privateText) && node.firstChild) {
        if (node.nextSibling) siblings.push(node.nextSibling);
        node = node.firstChild;
      } else node = node.nextSibling ?? siblings.pop() ?? null;
    }
    return text;
  };
  const root = rootOf(element);
  const labelledBy = element.getAttribute('aria-labelledby')?.slice(0, 640).trim().split(/\s+/).slice(0, 4)
    .map((id) => { const label = root.getElementById(id); return label ? labelText(label) : ''; }).join(' ');
  const labels = 'labels' in element ? (element as HTMLInputElement).labels : null;
  const label = labels ? [labels[0], labels[1]].filter((label): label is HTMLLabelElement => !!label).map(labelText).join(' ') : '';
  const name = normalize(labelledBy) || normalize(element.getAttribute('aria-label')) || normalize(label)
    || normalize(element.getAttribute('alt')) || (element.matches(controls) ? labelText(element) : '')
    || normalize(element.getAttribute('title')) || normalize(element.id);
  const component = normalize(sourceOf(element).source?.component, 100) || normalize(componentsOf(element).at(-1), 100);
  return { tag: element.localName.slice(0, 100), ...(name ? { name } : {}), ...(component ? { component } : {}) };
}

export function describeElement(element: Element): ElementContext {
  const attributes: Record<string, string> = {};
  for (const name of [...DEFAULT_CONTEXT_ATTRIBUTES, ...customContextAttributes]) {
    const value = element.getAttribute(name);
    if (value !== null && value.length <= 500 && (value || customContextAttributes.includes(name))) attributes[name] = value;
  }
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const styles = Object.fromEntries(styleProperties.map((name) => [name, style.getPropertyValue(name).slice(0, 100)]));
  const scope = element.closest('section,article,main,nav,aside,header,footer') ?? rootOf(element);
  const headings = Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 5).map((node) => textOf(node).slice(0, 200));
  const { rootPath, frameUrls } = rootEvidenceOf(element);
  return { tag: element.tagName.toLowerCase(), selector: selectorOf(element), text: textOf(element).slice(0, 500),
    attributes, styles, headings, components: componentsOf(element), accessibleName: accessibleNameOf(element),
    ...(rootPath.length ? { rootPath } : {}), ...(frameUrls?.length ? { frameUrls } : {}), ...sourceOf(element), rect: viewportRectOf(element) };
}


function normalizedText(value: string): string { return value.replace(/\s+/g, ' ').trim(); }

// A pin on the wrong element misleads more than a pin at its recorded position, so any changed evidence rejects the match.
// 誤った要素に付くピンは記録位置のピンより誤解を招くため、手掛かりが1つでも変わっていれば一致とみなさない。
export function isElementMatch(element: Element, context: ElementContext): boolean {
  if (context.frameUrls !== undefined) {
    if (!isFrameUrls(context.frameUrls, context.rootPath, document.URL)) return false;
    const current = rootEvidenceOf(element).frameUrls;
    if (!current || current.length !== context.frameUrls.length || current.some((url, index) => url !== context.frameUrls![index])) return false;
  }
  if (element.tagName.toLowerCase() !== context.tag) return false;
  let customIdentifiers: string[];
  try { customIdentifiers = normalizeContextAttributes(Object.keys(context.attributes)); } catch { return false; }
  for (const name of ['id', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-component', 'name', 'role', 'href', ...customIdentifiers]) {
    const expected = context.attributes[name];
    if ((expected || customIdentifiers.includes(name)) && element.getAttribute(name) !== expected) return false;
  }
  if (normalizedText(textOf(element).slice(0, 500)) !== normalizedText(context.text)) return false;
  if (context.accessibleName !== undefined && normalizedText(accessibleNameOf(element)) !== normalizedText(context.accessibleName)) return false;
  if (context.sourceOrigin === 'runtime') {
    if (!context.source || context.sourceRelation !== 'self' || !hostFiberOf(element)) return false;
    const mapped = sourceOf(element);
    if (mapped.sourceRelation === 'self' && mapped.source
      && (mapped.source.file !== context.source.file
        || (mapped.source.component && context.source.component && mapped.source.component !== context.source.component))) return false;
    const root = rootOf(element);
    const strongIdentity = identifyingContextAttributes(customIdentifiers).some((name) => {
      const value = context.attributes[name];
      if (!Object.hasOwn(context.attributes, name) || typeof value !== 'string' || !value || element.getAttribute(name) !== value) return false;
      const selector = name === 'id' ? `#${CSS.escape(value)}` : `[${name}="${CSS.escape(value)}"]`;
      const matched = root.querySelectorAll(selector);
      return matched.length === 1 && matched[0] === element;
    });
    const expectedComponent = context.components.at(-1) ?? context.source.component;
    if (!strongIdentity || !expectedComponent || componentsOf(element).at(-1) !== expectedComponent) return false;
  } else if (context.source) {
    const current = sourceOf(element);
    if (!current.source || current.source.file !== context.source.file || current.sourceRelation !== context.sourceRelation
      || (context.source.component && current.source.component !== context.source.component)) return false;
    if (context.sourceRelation === 'self' && (current.source.line !== context.source.line || current.source.column !== context.source.column)) return false;
  }
  return true;
}

export function resolveContextElement(context: ElementContext): Element | null {
  const element = resolveElement(context.selector, context.rootPath);
  return element && isElementMatch(element, context) ? element : null;
}

export function contextForElements(elements: readonly Element[], truncated = false): CodeContext {
  return { elements: [...new Set(elements)].map(describeElement), truncated };
}

export function contextForElement(element: Element): CodeContext { return contextForElements([element]); }

function meaningful(element: Element): boolean {
  if (omittedTags.has(element.tagName.toLowerCase()) || element.shadowRoot) return false;
  if (element.matches(`${controls},${media}`)) return true;
  if (!element.matches(textBlocks) && element.children.length && !Array.from(element.children).every((child) => inlineTags.has(child.tagName.toLowerCase()))) return false;
  const text = textOf(element);
  if (!text) return !element.children.length && !!element.id;
  if (element.matches(textBlocks)) {
    return !Array.from(element.children).some((child) => child.matches(textBlocks))
      || Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  }
  return !element.children.length || Array.from(element.children).every((child) => inlineTags.has(child.tagName.toLowerCase()));
}

function intersectRectangles(a: Rectangle, b: Rectangle): Rectangle | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function paddingBounds(element: Element): Rectangle {
  const bounds = viewportRectOf(element), local = element.getBoundingClientRect();
  const width = 'offsetWidth' in element ? Number(element.offsetWidth) : local.width;
  const height = 'offsetHeight' in element ? Number(element.offsetHeight) : local.height;
  const scaleX = width ? bounds.width / width : 1, scaleY = height ? bounds.height / height : 1;
  return { x: bounds.x + element.clientLeft * scaleX, y: bounds.y + element.clientTop * scaleY,
    width: element.clientWidth * scaleX, height: element.clientHeight * scaleY };
}

function hasContainmentBox(element: Element, style: CSSStyleDeclaration): boolean {
  return style.display !== 'contents' && (style.display !== 'inline' || element.matches(`${media},input,textarea,select,object,embed`));
}

function paintContained(element: Element, style: CSSStyleDeclaration): boolean {
  return hasContainmentBox(element, style) && (style.contain.split(/\s+/).some((value) => ['paint', 'strict', 'content'].includes(value)) || style.contentVisibility === 'auto');
}

function fixedContainingBlock(element: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'contents') return false;
  const box = hasContainmentBox(element, style), filter = element !== element.ownerDocument.documentElement;
  const changed = style.willChange.split(',').map((value) => value.trim());
  return box && ([style.transform, style.translate, style.rotate, style.scale, style.perspective].some((value) => !!value && value !== 'none')
    || style.contain.split(/\s+/).some((value) => ['layout', 'paint', 'strict', 'content'].includes(value))
    || changed.some((value) => ['transform', 'translate', 'rotate', 'scale', 'perspective', 'contain'].includes(value)) || style.contentVisibility === 'auto')
    || filter && ([style.filter, style.backdropFilter].some((value) => !!value && value !== 'none') || changed.some((value) => ['filter', 'backdrop-filter'].includes(value)));
}

export function visibleRectOf(element: Element): Rectangle | undefined {
  if (!element.isConnected) return undefined;
  const chain: { element: Element; childDocument?: Document }[] = [];
  const roots = new Set<Document | ShadowRoot>();
  let current: Element | null = element, childDocument: Document | undefined, reachedPage = false;
  try {
    while (current && chain.length < 200) {
      const root = rootOf(current);
      if (root !== document) roots.add(root);
      if (roots.size > 8 || 'host' in root && root.host.shadowRoot !== root) return undefined;
      chain.push({ element: current, childDocument }); childDocument = undefined;
      // A slotted light-DOM node is clipped by the shadow tree it renders into, so the walk follows assignedSlot rather than parentElement.
      // スロットに割り当てられたlight DOMは描画先のシャドウツリーで切り抜かれるため、parentElementではなくassignedSlotをたどる。
      if (current.assignedSlot) current = current.assignedSlot;
      else if (current.parentElement) current = current.parentElement;
      else if ('host' in root) current = root.host;
      else {
        if (root === document) { reachedPage = true; break; }
        const frame = frameOf(root) as HTMLIFrameElement | null;
        if (!frame || frame.localName !== 'iframe' || frame.contentDocument !== root || root.defaultView?.document !== root) return undefined;
        childDocument = root; current = frame;
      }
    }
    const view = document.defaultView;
    if (!reachedPage || !view) return undefined;
    let clip: Rectangle | undefined = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
    let absoluteClip: Rectangle | undefined = clip, fixedClip: Rectangle | undefined = clip;
    const clipped = new Set(['hidden', 'clip', 'auto', 'scroll']);
    for (const entry of chain.reverse()) {
      const node = entry.element, ownerView = node.ownerDocument.defaultView;
      if (!ownerView) return undefined;
      const style = ownerView.getComputedStyle(node);
      const hidden = style.visibility === 'hidden' || style.visibility === 'collapse';
      if (style.display === 'none' || style.opacity === '0' || hidden && (node === element || node.localName === 'iframe')
        || node !== element && style.contentVisibility === 'hidden') return undefined;
      if (style.position === 'fixed') clip = fixedClip;
      else if (style.position === 'absolute') clip = absoluteClip;
      if (node === element) return clip && intersectRectangles(viewportRectOf(element), clip);
      let descendantClip: Rectangle | undefined = clip;
      if (clip && style.display !== 'contents' && style.display !== 'inline') {
        const paint = paintContained(node, style), root = node.ownerDocument.documentElement;
        const rootStyle = node === node.ownerDocument.body ? ownerView.getComputedStyle(root) : undefined;
        const viewportOverflow = node === root || rootStyle?.overflowX === 'visible' && rootStyle.overflowY === 'visible';
        const horizontal = paint || !viewportOverflow && clipped.has(style.overflowX), vertical = paint || !viewportOverflow && clipped.has(style.overflowY);
        if (horizontal || vertical) {
          const padding = paddingBounds(node);
          descendantClip = intersectRectangles(clip, { x: horizontal ? padding.x : clip.x, y: vertical ? padding.y : clip.y,
            width: horizontal ? padding.width : clip.width, height: vertical ? padding.height : clip.height });
        }
      }
      const fixedBlock = fixedContainingBlock(node, style);
      if (style.display !== 'contents' && (style.position !== 'static' || fixedBlock)) absoluteClip = descendantClip;
      if (fixedBlock) fixedClip = descendantClip;
      clip = descendantClip;
      if (entry.childDocument) {
        const childView = entry.childDocument.defaultView;
        if (!childView || childView.document !== entry.childDocument) return undefined;
        const childViewport = rectInTopViewport({ x: 0, y: 0, width: childView.innerWidth, height: childView.innerHeight }, entry.childDocument);
        clip = clip && intersectRectangles(clip, paddingBounds(node));
        clip = clip && intersectRectangles(clip, childViewport);
        absoluteClip = fixedClip = clip;
      }
    }
  } catch { return undefined; }
  return undefined;
}

// One bounded walker serves area sampling and marquee selection so both respect the same node and root limits on large pages.
// 範囲の抽出と囲み選択で1つの上限付き走査を共有し、大きなページでも同じノード数・ルート数の制限を守るため。
function visitPageElements(host: Element | undefined, visit: (element: Element, clip?: Rectangle) => boolean, marquee = false): boolean {
  const stack: { element: Element; clip?: Rectangle; absoluteClip?: Rectangle; fixedClip?: Rectangle; rootDepth: number }[] = [];
  const clipped = new Set(['hidden', 'clip', 'auto', 'scroll']);
  let omitted = false;
  function append(children: ArrayLike<Element>, clip?: Rectangle, absoluteClip?: Rectangle, fixedClip?: Rectangle, rootDepth = 0) {
    if (marquee && rootDepth > 8) { omitted ||= children.length > 0; return; }
    if (marquee && !clip && !absoluteClip && !fixedClip) return;
    const limit = Math.min(children.length, 5001 - stack.length);
    if (limit < children.length) omitted = true;
    for (let index = limit - 1; index >= 0; index--) stack.push({ element: children[index]!, clip, absoluteClip, fixedClip, rootDepth });
  }
  if (marquee) { const viewport = { x: 0, y: 0, width: innerWidth, height: innerHeight }; append([document.documentElement], viewport, viewport, viewport); }
  else append(document.body.children);
  let scanned = 0;
  while (stack.length && scanned < 5000) {
    let { element, clip, absoluteClip, fixedClip, rootDepth } = stack.pop()!; scanned++;
    if (belongsTo(element, host) || omittedTags.has(element.tagName.toLowerCase()) || marquee && element.matches('[data-needmark]')) continue;
    const style = marquee ? element.ownerDocument.defaultView!.getComputedStyle(element) : undefined;
    const hidden = style?.visibility === 'hidden' || style?.visibility === 'collapse';
    if (style?.display === 'none' || style?.opacity === '0' || hidden && element.localName === 'iframe') continue;
    if (style?.position === 'fixed') clip = fixedClip;
    else if (style?.position === 'absolute') clip = absoluteClip;
    let descendantClip = clip;
    if (clip && style && style.display !== 'contents' && style.display !== 'inline') {
      const paint = paintContained(element, style), root = element.ownerDocument.documentElement;
      const rootStyle = element === element.ownerDocument.body ? element.ownerDocument.defaultView!.getComputedStyle(root) : undefined;
      const viewportOverflow = element === root || rootStyle?.overflowX === 'visible' && rootStyle.overflowY === 'visible';
      const horizontal = paint || !viewportOverflow && clipped.has(style.overflowX), vertical = paint || !viewportOverflow && clipped.has(style.overflowY);
      if (horizontal || vertical) {
        const padding = paddingBounds(element);
        descendantClip = intersectRectangles(clip, { x: horizontal ? padding.x : clip.x, y: vertical ? padding.y : clip.y,
          width: horizontal ? padding.width : clip.width, height: vertical ? padding.height : clip.height });
      }
    }
    const fixedBlock = style && fixedContainingBlock(element, style);
    if (style && style.display !== 'contents' && (style.position !== 'static' || fixedBlock)) absoluteClip = descendantClip;
    if (fixedBlock) fixedClip = descendantClip;
    if (style?.contentVisibility !== 'hidden') {
      append(element.children, descendantClip, absoluteClip, fixedClip, rootDepth);
      if (element.shadowRoot) append(element.shadowRoot.children, descendantClip, absoluteClip, fixedClip, rootDepth + 1);
      if (element.tagName.toLowerCase() === 'iframe') {
        try {
          const body = (element as HTMLIFrameElement).contentDocument?.body;
          if (body) {
            if (marquee) {
              const view = body.ownerDocument.defaultView!;
              const viewport = rectInTopViewport({ x: 0, y: 0, width: view.innerWidth, height: view.innerHeight }, body.ownerDocument);
              const frameClip = clip && intersectRectangles(clip, viewport);
              append([body.ownerDocument.documentElement], frameClip, frameClip, frameClip, rootDepth + 1);
            } else append(body.children);
            continue;
          }
        } catch { /* A cross-origin document throws on access; its iframe element stays selectable. / 別オリジンの文書はアクセス時に例外を投げるため、iframe要素として選べる状態にとどめる。 */ }
      }
    }
    if (!hidden && (!marquee || clip) && !visit(element, clip)) break;
  }
  return omitted || (scanned >= 5000 && stack.length > 0);
}

export function contextForArea(rect: Rectangle, host?: Element): CodeContext {
  const matched: Element[] = [];
  const omitted = visitPageElements(host, (element) => {
    if (!meaningful(element)) return true;
    if (matched.some((parent) => belongsTo(element, parent) && (!element.matches(`${controls},${media}`) || parent.matches(controls)))) return true;
    const bounds = viewportRectOf(element);
    const width = Math.max(0, Math.min(rect.x + rect.width, bounds.x + bounds.width) - Math.max(rect.x, bounds.x));
    const height = Math.max(0, Math.min(rect.y + rect.height, bounds.y + bounds.height) - Math.max(rect.y, bounds.y));
    if (!width || !height || width * height < bounds.width * bounds.height / 2) return true;
    const visible = visibleRectOf(element);
    const overlap = visible && intersectRectangles(rect, visible);
    if (!overlap || overlap.width * overlap.height < bounds.width * bounds.height / 2) return true;
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return true;
    matched.push(element); return matched.length <= 12;
  });
  if (!matched.length) {
    const element = elementAtPoint(rect.x + rect.width / 2, rect.y + rect.height / 2, host);
    if (element) matched.push(element);
  }
  return contextForElements(matched.slice(0, 12), omitted || matched.length > 12);
}

function marqueeOwner(element: Element): Element {
  let mediaOwner: Element | undefined, textOwner: Element | undefined;
  const inline = inlineTags.has(element.localName);
  for (let owner: Element | null = element, depth = 0; owner && depth < 40; owner = owner.parentElement, depth++) {
    if (owner.matches(controls)) return owner;
    if (!mediaOwner && owner.matches(media)) mediaOwner = owner;
    if (inline && !textOwner && owner.matches(textBlocks)) textOwner = owner;
  }
  return mediaOwner ?? textOwner ?? element;
}

export function elementsForMarquee(rect: Rectangle, host?: Element): { elements: Element[]; truncated: boolean } {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return { elements: [], truncated: false };
  const candidates = new Set<Element>();
  const omitted = visitPageElements(host, (element, clip) => {
    if (!meaningful(element)) return true;
    let owner = marqueeOwner(element);
    if (candidates.has(owner)) return true;
    const style = owner.ownerDocument.defaultView!.getComputedStyle(owner);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') owner = element;
    if (!candidates.has(owner)) {
      const visible = intersectRectangles(viewportRectOf(owner), clip!);
      if (visible && intersectRectangles(rect, visible)) candidates.add(owner);
    }
    return true;
  }, true);
  const ancestors = new Set<Element>();
  for (const element of candidates) {
    for (let owner = parentOf(element), depth = 0; owner && depth < 40; owner = parentOf(owner), depth++) {
      if (candidates.has(owner)) ancestors.add(owner);
    }
  }
  const elements = [...candidates].filter((element) => !ancestors.has(element));
  return { elements, truncated: omitted };
}

// Only the owners of the selection are recorded, so saving a text range never copies the surrounding page content.
// 選択範囲を含む要素だけを記録し、テキスト範囲を保存しても周囲のページ内容を写し取らないようにする。
export function contextForRange(range: Range): CodeContext {
  const elements: Element[] = [];
  const document = range.startContainer.ownerDocument!;
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let node: Node | null = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer : walker.nextNode();
  let scanned = 0;
  while (node && scanned++ < 5000) {
    if (node.textContent?.trim() && range.intersectsNode(node)) {
      const parent = node.parentElement;
      if (parent) elements.push(parent.closest(`${controls},${textBlocks}`) ?? parent);
    }
    if (new Set(elements).size > 12) break;
    node = walker.nextNode();
  }
  const unique = [...new Set(elements)];
  return contextForElements(unique.slice(0, 12), unique.length > 12 || scanned >= 5000 && !!node);
}
