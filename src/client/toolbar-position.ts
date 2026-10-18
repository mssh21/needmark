import { nativeSetTimeout } from './animation-freeze.js';

export type ToolbarAnchor = 'start' | 'center' | 'end';
export interface ToolbarPosition { x: number; y: number; anchor?: ToolbarAnchor }
const storageKey = 'needmark-toolbar-position';

export function readToolbarPosition(storage: Pick<Storage, 'getItem'>): ToolbarPosition | undefined {
  try {
    const raw = storage.getItem(storageKey) ?? storage.getItem('needback-kit-toolbar-position'); if (!raw || raw.length > 1000) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const { x, y, anchor } = value as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    return anchor === 'start' || anchor === 'center' || anchor === 'end' ? { x, y, anchor } : { x, y };
  } catch { /* Storage can be blocked or hold old data; the CSS default position always works. / ストレージは無効化されていたり古い値を持っていたりするが、CSSの既定位置は常に使えるため。 */ }
}

// Clamping the visible position without rewriting the saved one restores the user's choice when the viewport grows again.
// 保存値は書き換えずに表示位置だけを画面内へ収めることで、画面が再び広がったときに利用者の位置へ戻せる。
export function clampToolbarPosition(position: ToolbarPosition, size: { width: number; height: number }, viewport: { width: number; height: number }): ToolbarPosition {
  const axis = (value: number, size: number, extent: number): number => {
    const margin = Math.min(4, Math.max(0, extent) / 2);
    return Math.max(margin, Math.min(Math.max(margin, extent - size - margin), value));
  };
  return { x: axis(position.x, size.width, viewport.width), y: axis(position.y, size.height, viewport.height) };
}

// The edge nearest the viewport side stays put when the toolbar collapses or expands, so a toolbar parked against a side stays against it instead of drifting into the page. Thirds leave a toolbar placed near the middle shrinking evenly around its centre.
// たたむ・広げるときは画面の端に近い側の辺を固定し、端に寄せたツールバーが端から離れてページ内へずれないようにする。三等分にして、中央付近に置いたものは中心を保って左右均等に縮める。
export function toolbarAnchor(left: number, width: number, viewportWidth: number): ToolbarAnchor {
  const center = left + width / 2;
  return center < viewportWidth / 3 ? 'start' : center > viewportWidth * 2 / 3 ? 'end' : 'center';
}

export function installToolbarPosition(dock: HTMLElement, storage: Pick<Storage, 'getItem' | 'setItem'>, onChange?: () => void): { detach: () => void; refresh: () => void } {
  const view = dock.ownerDocument.defaultView; if (!view) return { detach: () => {}, refresh: () => {} };
  // The user's choice stays separate from the clamped coordinates on screen, so a temporarily wider toolbar or smaller viewport
  // does not move it for the rest of the session.
  // 画面に出す補正済みの座標と利用者が選んだ位置を分けて持つことで、一時的にツールバーが広がったり画面が狭まったりしても、その後ずっとずれたままにならない。
  let preferred = readToolbarPosition(storage), suppressClick = false;
  let drag: { pointer: number; x: number; y: number; origin: ToolbarPosition; target: Element; viewport: string; position?: ToolbarPosition; styles: [string, string, string][] } | undefined;
  const place = (next: ToolbarPosition): void => {
    dock.style.setProperty('right', 'auto'); dock.style.setProperty('bottom', 'auto'); dock.style.setProperty('transform', 'none');
    dock.style.setProperty('left', `${next.x}px`); dock.style.setProperty('top', `${next.y}px`); onChange?.();
  };
  // `--nm-shift` is a visual offset that keeps the `--nm-anchor` edge fixed while the toolbar is collapsed, so saved coordinates are those of the expanded toolbar and the visible left is x + shift.
  // The anchor is saved with the position because it is chosen from where the toolbar was shown when dropped; deriving it again from the expanded coordinates could pick another edge and move a collapsed toolbar after a reload.
  // `--nm-shift` は最小化中に `--nm-anchor` の辺を動かさないための見た目だけのずれで、保存する座標は広げた状態のもの。見えている左端は x + shift になる。
  // 基準の辺は置いたときに見えていた位置から決めるため、座標と一緒に保存する。広げた状態の座標から決め直すと別の辺が選ばれ、再読み込み後にたたんだツールバーがずれることがある。
  const shift = (): number => Number.parseFloat(dock.style.getPropertyValue('--nm-shift')) || 0;
  const clampVisible = (next: ToolbarPosition): ToolbarPosition => clampToolbarPosition(next, dock.getBoundingClientRect(), { width: view.innerWidth, height: view.innerHeight });
  const clamp = (next: ToolbarPosition): ToolbarPosition => { const offset = shift(), visible = clampVisible({ x: next.x + offset, y: next.y }); return { x: visible.x - offset, y: visible.y }; };
  const visible = (): boolean => { const rect = dock.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  const release = (current: NonNullable<typeof drag>): void => { dock.classList.remove('dragging'); if (current.target.hasPointerCapture(current.pointer)) current.target.releasePointerCapture(current.pointer); };
  const cancel = (): void => {
    const previous = drag; if (!previous) return; drag = undefined;
    for (const [property, value, priority] of previous.styles) { if (value) dock.style.setProperty(property, value, priority); else dock.style.removeProperty(property); }
    release(previous); onChange?.();
  };
  const anchor = (value?: ToolbarAnchor): void => { if (value) dock.style.setProperty('--nm-anchor', value); else dock.style.removeProperty('--nm-anchor'); };
  // While the width animates the observed size is a passing frame, and clamping to it pushed a toolbar at the right edge off screen and back; the caller refreshes once the animation ends.
  // 幅のアニメーション中に観測される大きさは途中のフレームにすぎず、それに合わせて画面内へ収めると右端のツールバーが画面外へ跳ねて戻っていた。アニメーション終了後に呼び出し側が refresh する。
  const resizing = (): boolean => !!dock.getAnimations?.().some((animation) => (animation.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => 'width' in frame));
  const resize = (): void => { if (!visible()) { cancel(); return; } if (!drag && preferred && !resizing()) { anchor(preferred.anchor); place(clamp(preferred)); } };
  const down = (event: PointerEvent): void => {
    if (drag || !event.isPrimary || event.button !== 0 || !visible()) return;
    // The whole toolbar is a grip, not only the narrow handle. Capturing on the pressed button or link keeps its click when the pointer
    // does not travel; elsewhere the default is prevented so the press does not start a page text selection.
    // 細い持ち手だけでなくツールバー全体を掴めるようにする。押したボタンやリンク自身でキャプチャすれば動かさなかったときのクリックが残り、
    // それ以外の場所では既定動作を止めてページの文字選択が始まらないようにする。
    const button = (event.target as Element).closest('button, a'), target = button ?? dock, rect = dock.getBoundingClientRect();
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: rect.left, y: rect.top }, target, viewport: `${view.innerWidth}x${view.innerHeight}`,
      styles: ['left', 'top', 'right', 'bottom', 'transform', '--nm-shift', '--nm-anchor'].map((property) => [property, dock.style.getPropertyValue(property), dock.style.getPropertyPriority(property)]) };
    try { target.setPointerCapture(event.pointerId); } catch { drag = undefined; return; }
    if (!button) event.preventDefault();
  };
  const move = (event: PointerEvent): void => {
    const current = drag; if (!current || event.pointerId !== current.pointer) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.position && Math.hypot(dx, dy) < 3) return;
    event.preventDefault(); dock.classList.add('dragging');
    if (visible()) {
      // The shift depends on the anchoring mode, which `place` changes from centered to absolute, so it is read again after placing.
      // ずれの大きさは中央寄せから座標指定へ切り替わると変わるため、配置した後でもう一度読む。
      const target = clampVisible({ x: current.origin.x + dx, y: current.origin.y + dy }), side = toolbarAnchor(target.x, dock.getBoundingClientRect().width, view.innerWidth);
      anchor(side); place(target);
      const offset = shift(); current.position = { x: target.x - offset, y: target.y, anchor: side }; if (offset) place(current.position);
    }
  };
  const up = (event: PointerEvent): void => {
    const current = drag; if (!current || event.pointerId !== current.pointer) return;
    if (!visible()) { cancel(); return; }
    move(event); finish(current);
  };
  const finish = (current: NonNullable<typeof drag>): void => {
    drag = undefined; release(current);
    if (!current.position) return;
    // The click from this release arrives in the same task; clearing the flag afterwards keeps a later keyboard click working.
    // このリリースによるクリックは同じタスク内で届くため、その後でフラグを戻し、後から来るキーボードでのクリックを妨げない。
    preferred = current.position; suppressClick = true; nativeSetTimeout(() => { suppressClick = false; }, 0);
    try { storage.setItem(storageKey, JSON.stringify(preferred)); } catch { /* Failing to persist must not undo a move the user just made. / 保存に失敗しても、利用者が今動かした位置を戻さないため。 */ }
  };
  // A drag that started on a button must not also run that button's action when it is released.
  // ボタンから始めたドラッグを離したときに、そのボタンの操作まで実行しないため。
  const click = (event: MouseEvent): void => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } };
  // A lost capture or cancel keeps the toolbar where it was last shown, because pages that swallow pointerup still let the capture end and a cancel there threw the toolbar back to where the drag began. Chromium can end the capture before the resize event, so a changed viewport still cancels like a resize does.
  // キャプチャの喪失やキャンセルでは最後に表示した位置で確定する。pointerupを握りつぶすページでもキャプチャの終了は届き、そこで取り消すとドラッグ前の位置へ戻っていたため。Chromiumはresizeイベントより先にキャプチャを終えることがあるので、画面の大きさが変わっていればresizeと同じく取り消す。
  const lost = (event: PointerEvent): void => {
    const current = drag; if (current?.pointer !== event.pointerId) return;
    if (visible() && current.viewport === `${view.innerWidth}x${view.innerHeight}`) finish(current); else cancel();
  };
  const escape = (event: KeyboardEvent): void => { if (drag && !event.isComposing && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } };
  const viewportResize = (): void => { cancel(); resize(); };
  // Moves and the release are read on the window in the capture phase, before page handlers can stop their propagation; captured events still pass through it.
  // 移動と離す操作は、ページのハンドラーが伝播を止める前にウィンドウのキャプチャ段階で読む。キャプチャ中のイベントもここを通る。
  dock.addEventListener('pointerdown', down); view.addEventListener('pointermove', move, true); view.addEventListener('pointerup', up, true); dock.addEventListener('click', click, true);
  view.addEventListener('pointercancel', lost, true); dock.addEventListener('lostpointercapture', lost);
  view.addEventListener('keydown', escape, true); view.addEventListener('resize', viewportResize);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize); observer?.observe(dock); resize();
  const detach = (): void => {
    cancel(); observer?.disconnect();
    dock.removeEventListener('pointerdown', down); view.removeEventListener('pointermove', move, true); view.removeEventListener('pointerup', up, true); dock.removeEventListener('click', click, true);
    view.removeEventListener('pointercancel', lost, true); dock.removeEventListener('lostpointercapture', lost);
    view.removeEventListener('keydown', escape, true); view.removeEventListener('resize', viewportResize);
  };
  return { detach, refresh: resize };
}
