// esbuild injects these bindings into NeedMark's bundle so html2canvas and our code keep native timers while the page's own bundles see the paused globals.
// esbuildでNeedMarkのバンドルにだけ注入し、html2canvasと自前のコードは元のタイマーを使い、ページ側のバンドルは一時停止用のグローバルを使うようにする。
export { nativeSetTimeout as setTimeout, nativeClearTimeout as clearTimeout,
  nativeSetInterval as setInterval, nativeClearInterval as clearInterval,
  nativeRequestAnimationFrame as requestAnimationFrame, nativeCancelAnimationFrame as cancelAnimationFrame } from './animation-freeze.js';
