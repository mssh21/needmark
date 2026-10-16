import { resolveElement } from './context/code-context.js';

// Observing only the roots that saved pins live in keeps MutationObserver cost proportional to the feedback, not to the size of the app.
// 保存済みピンがあるルートだけを監視し、MutationObserverの負荷をアプリの大きさではなくコメントの数に比例させる。
export function installPageChanges(host: HTMLElement, onChange: (contentOnly: boolean) => void): { sync(paths: readonly (readonly string[])[]): void; dispose(): void } {
  type Root = Document | ShadowRoot;
  const observed = new Map<Root, () => void>(), frames = new Map<HTMLIFrameElement, () => void>();
  let paths: readonly (readonly string[])[] = [], disposed = false;
  const isWidget = (node: Node) => !!(node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-needmark]');
  const changed = () => { if (!disposed) onChange(false); };

  function observeHistory(view: Window): () => void {
    let active = true;
    const changedRoute = () => { if (active) changed(); }; /* The caller batches refreshes per animation frame, so this only signals. / 呼び出し側がフレーム単位でまとめて更新するため、ここでは通知だけを行う。 */
    const restore: (() => void)[] = [];
    try {
      view.addEventListener('hashchange', changedRoute); view.addEventListener('popstate', changedRoute);
      const history = view.history;
      for (const name of ['pushState', 'replaceState'] as const) {
        const original = history[name];
        const wrapped = function(this: History, ...args: Parameters<History['pushState']>) {
          const result = original.apply(this, args); changedRoute(); return result;
        };
        try { history[name] = wrapped; restore.push(() => { if (history[name] === wrapped) history[name] = original; }); } catch { /* Some pages freeze history; hashchange and popstate still report navigation. / historyを凍結するページもあるが、hashchangeとpopstateで移動は検出できるため。 */ }
      }
    } catch { /* A frame can navigate cross-origin before we attach, which makes its document inaccessible. / 監視を付ける前にフレームが別オリジンへ移動し、文書にアクセスできなくなることがあるため。 */ }
    return () => {
      active = false;
      try { view.removeEventListener('hashchange', changedRoute); view.removeEventListener('popstate', changedRoute); } catch { /* The child window may have become cross-origin, and its listeners died with it. / 子ウィンドウが別オリジンになっている場合があり、その時点でリスナーも無効になっているため。 */ }
      for (const detach of restore) try { detach(); } catch { /* Restoring must never overwrite a wrapper the page installed later or touch an inaccessible history. / 後からページが入れたラッパーを上書きしたり、アクセスできないhistoryに触れたりしないため。 */ }
    };
  }

  function sync(nextPaths: readonly (readonly string[])[]) {
    if (disposed) return;
    paths = nextPaths.map((path) => [...path]);
    const wantedRoots = new Set<Root>([host.ownerDocument]), wantedFrames = new Set<HTMLIFrameElement>();
    for (const path of paths) {
      if (path.length > 8) continue;
      const prefix: string[] = [];
      for (const entry of path) {
        const separator = entry.indexOf(': '), kind = entry.slice(0, separator);
        const element = resolveElement(entry.slice(separator + 2), prefix);
        if (!element || isWidget(element)) break;
        if (kind === 'shadow' && element.shadowRoot) wantedRoots.add(element.shadowRoot);
        else if (kind === 'iframe' && element.localName === 'iframe') {
          const frame = element as HTMLIFrameElement; wantedFrames.add(frame);
          try {
            const content = frame.contentDocument;
            if (!content) break;
            wantedRoots.add(content);
          } catch { break; }
        } else break;
        prefix.push(entry);
      }
    }
    for (const [frame, detach] of frames) if (!wantedFrames.has(frame)) { detach(); frames.delete(frame); }
    for (const frame of wantedFrames) if (!frames.has(frame)) {
      const loaded = () => { if (!disposed) { sync(paths); changed(); } };
      frame.addEventListener('load', loaded);
      frames.set(frame, () => frame.removeEventListener('load', loaded));
    }
    for (const [root, detach] of observed) if (!wantedRoots.has(root)) { detach(); observed.delete(root); }
    for (const root of wantedRoots) if (!observed.has(root)) {
      const observer = new MutationObserver((records) => { if (!disposed && records.some((record) => !isWidget(record.target))) onChange(true); });
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      root.addEventListener('scroll', changed, true);
      const view = root.nodeType === 9 ? (root as Document).defaultView : null;
      view?.addEventListener('resize', changed);
      const detachHistory = view && root !== host.ownerDocument ? observeHistory(view) : () => {};
      observed.set(root, () => {
        observer.disconnect(); root.removeEventListener('scroll', changed, true); detachHistory();
        try { view?.removeEventListener('resize', changed); } catch { /* The child window may have become cross-origin, and its listeners died with it. / 子ウィンドウが別オリジンになっている場合があり、その時点でリスナーも無効になっているため。 */ }
      });
    }
  }

  return { sync, dispose() {
    disposed = true;
    for (const detach of observed.values()) detach();
    for (const detach of frames.values()) detach();
    observed.clear(); frames.clear(); paths = [];
  } };
}
