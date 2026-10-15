// Pausing patches the page's timer globals, so NeedMark captures the originals first; its own polling, capture and UI must keep running while the page is frozen.
// 一時停止はページのタイマーを差し替えるため、先に元の関数を確保する。ページを止めている間もNeedMark自身のポーリング・撮影・UIは動かす必要がある。
const nativeHost = typeof window === 'undefined' ? globalThis : window;
export const nativeSetTimeout = nativeHost.setTimeout.bind(nativeHost) as Window['setTimeout'];
export const nativeClearTimeout = nativeHost.clearTimeout.bind(nativeHost) as Window['clearTimeout'];
export const nativeSetInterval = nativeHost.setInterval.bind(nativeHost) as Window['setInterval'];
export const nativeClearInterval = nativeHost.clearInterval.bind(nativeHost) as Window['clearInterval'];
export const nativeRequestAnimationFrame = typeof window === 'undefined'
  ? ((callback: FrameRequestCallback) => nativeSetTimeout(() => callback(performance.now()), 16))
  : window.requestAnimationFrame.bind(window);
export const nativeCancelAnimationFrame = typeof window === 'undefined' ? nativeClearTimeout : window.cancelAnimationFrame.bind(window);

export interface TimerSurface {
  setTimeout: Window['setTimeout']; clearTimeout: Window['clearTimeout'];
  setInterval: Window['setInterval']; clearInterval: Window['clearInterval'];
  requestAnimationFrame: Window['requestAnimationFrame']; cancelAnimationFrame: Window['cancelAnimationFrame'];
}

// Wrapping the globals is the only way to pause callbacks the page schedules without changing its code. String handlers stay native
// because re-evaluating code strings ourselves would be an eval path.
// ページのコードを変えずに登録済みのコールバックを止めるには、グローバル関数を包むしかない。文字列のハンドラーを自前で評価するとeval経路になるため、そのまま元の関数に渡す。
export function installTimerFreeze(surface: TimerSurface) {
  const original = {
    setTimeout: surface.setTimeout.bind(surface), clearTimeout: surface.clearTimeout.bind(surface),
    setInterval: surface.setInterval.bind(surface), clearInterval: surface.clearInterval.bind(surface),
    requestAnimationFrame: surface.requestAnimationFrame.bind(surface), cancelAnimationFrame: surface.cancelAnimationFrame.bind(surface),
  };
  let paused = false, drainTicket: number | undefined;
  const timeouts = new Map<number, { callback: Function; args: unknown[] }>();
  const waiting = new Set<number>();
  const frames = new Map<number, { callback: FrameRequestCallback; ticket?: number; waiting: boolean }>();

  function scheduleDrain() {
    if (!paused && waiting.size && drainTicket === undefined) drainTicket = original.setTimeout(drain, 16);
  }
  function drain() {
    drainTicket = undefined;
    if (paused) return;
    const id = waiting.values().next().value as number | undefined;
    if (id === undefined) return;
    waiting.delete(id);
    const timeout = timeouts.get(id); timeouts.delete(id);
    // Removing first and rescheduling in finally means a throwing application callback cannot stall the rest of the queue.
    // 実行前に取り出してfinallyで次を予約することで、アプリのコールバックが例外を投げても残りの待ち行列が止まらない。
    try { if (timeout) Reflect.apply(timeout.callback, surface, timeout.args); }
    finally { scheduleDrain(); }
  }
  surface.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== 'function') return original.setTimeout(handler, timeout, ...args);
    let id: number;
    id = original.setTimeout(() => {
      const record = timeouts.get(id); if (!record) return;
      if (paused) { waiting.add(id); return; }
      timeouts.delete(id); Reflect.apply(record.callback, surface, record.args);
    }, timeout);
    timeouts.set(id, { callback: handler, args }); return id;
  }) as Window['setTimeout'];
  surface.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== 'function') return original.setInterval(handler, timeout, ...args);
    return original.setInterval(() => { if (!paused) Reflect.apply(handler, surface, args); }, timeout);
  }) as Window['setInterval'];
  const cancelTimer = (id: number | undefined) => {
    if (id !== undefined) { timeouts.delete(id); waiting.delete(id); }
    if (!waiting.size && drainTicket !== undefined) { original.clearTimeout(drainTicket); drainTicket = undefined; }
  };
  surface.clearTimeout = (id) => { const handle = Number(id) >>> 0; cancelTimer(handle); original.clearTimeout(handle); };
  surface.clearInterval = (id) => { const handle = Number(id) >>> 0; cancelTimer(handle); original.clearInterval(handle); };
  function runFrame(id: number, record: { callback: FrameRequestCallback; ticket?: number; waiting: boolean }, timestamp: number) {
    if (frames.get(id) !== record) return;
    record.ticket = undefined;
    if (paused) { record.waiting = true; return; }
    frames.delete(id); record.callback(timestamp);
  }
  surface.requestAnimationFrame = (callback) => {
    if (typeof callback !== 'function') return original.requestAnimationFrame(callback);
    const record = { callback, ticket: undefined as number | undefined, waiting: false };
    const id = original.requestAnimationFrame((timestamp) => runFrame(id, record, timestamp));
    record.ticket = id; frames.set(id, record); return id;
  };
  surface.cancelAnimationFrame = (id) => {
    const handle = Number(id) >>> 0, record = frames.get(handle);
    original.cancelAnimationFrame(record?.ticket ?? handle); frames.delete(handle);
  };
  return {
    pause() {
      paused = true;
      if (drainTicket !== undefined) { original.clearTimeout(drainTicket); drainTicket = undefined; }
    },
    resume() {
      if (!paused) return;
      paused = false; scheduleDrain();
      for (const [id, record] of frames) if (record.waiting) {
        record.waiting = false;
        record.ticket = original.requestAnimationFrame((timestamp) => runFrame(id, record, timestamp));
      }
    },
  };
}

// A stylesheet that excludes the widget host pauses CSS animation without touching each element, and the review UI keeps its own motion.
// ウィジェットのホストを除外するスタイルシートなら、要素を1つずつ触らずにCSSアニメーションを止められ、レビューUI自体の動きも保てる。
export function installAnimationFreeze(host: HTMLElement) {
  const document = host.ownerDocument, window = document.defaultView!;
  const timers = installTimerFreeze(window);
  const style = document.createElement('style');
  style.dataset.needmarkFreeze = '';
  const page = '*:not([data-needmark]):not([data-needmark] *)';
  style.textContent = `${page},${page}::before,${page}::after{animation-play-state:paused!important;transition:none!important}`;
  let paused = false;
  let animations: Animation[] = [], videos: HTMLVideoElement[] = [];
  const belongsToWidget = (target: Element | null): boolean => {
    let element = target;
    while (element) {
      if (element === host || host.contains(element)) return true;
      const root = element.getRootNode(); element = root instanceof ShadowRoot ? root.host : null;
    }
    return false;
  };
  return {
    pause() {
      if (paused) return; paused = true; timers.pause();
      animations = document.getAnimations().filter((animation) => animation.playState === 'running' && !belongsToWidget((animation.effect as KeyframeEffect | null)?.target as Element | null));
      animations.forEach((animation) => animation.pause());
      videos = Array.from(document.querySelectorAll('video')).filter((video) => !video.paused);
      videos.forEach((video) => video.pause());
      document.head.append(style);
    },
    resume() {
      if (!paused) return; paused = false;
      animations.forEach((animation) => { if (animation.playState === 'paused') { try { animation.play(); } catch { /* The page may cancel the animation while paused, and play() then throws. / 一時停止中にページがアニメーションを破棄するとplay()が例外を投げるため。 */ } } });
      style.remove();
      videos.forEach((video) => { if (video.isConnected && video.paused && !video.ended) void video.play().catch(() => {}); /* Autoplay policies may reject play(); the page simply stays paused. / 自動再生の制限でplay()が拒否されることがあり、その場合は停止したままにする。 */ });
      animations = []; videos = []; timers.resume();
    },
    // The timer wrappers are not removed, because timers queued during a pause still hold wrapper IDs that the page may cancel later.
    // 一時停止中に予約されたタイマーは包んだ側のIDを持ち、後でページが取り消す可能性があるため、ラッパーは外さない。
    dispose() { this.resume(); style.remove(); },
  };
}
