import type { Rectangle } from '../shared/types.js';
import { nativeRequestAnimationFrame, nativeCancelAnimationFrame } from './animation-freeze.js';

type Size = { width: number; height: number };
export interface PanelPosition { x: number; y: number; maxHeight: number; obscureDock: boolean }

// Placing the panel in the larger strip above or below the toolbar keeps both visible without measuring every page element.
// ツールバーの上下で広い方にパネルを置けば、ページの要素を測らずに両方を見える状態に保てる。
export function calculatePanelPosition(size: Size, dock: Rectangle, viewport: Size, anchor?: Rectangle, button?: Rectangle): PanelPosition {
  const marginX = Math.min(10, Math.max(0, viewport.width) / 2), marginY = Math.min(10, Math.max(0, viewport.height) / 2);
  const clamp = (value: number, start: number, end: number) => Math.max(start, Math.min(Math.max(start, end), value));
  const spaceAbove = dock.y - 12 - marginY, spaceBelow = viewport.height - marginY - (dock.y + dock.height + 12);
  if (button && button.width > 0 && button.height > 0 && dock.height > 0 && Math.max(spaceAbove, spaceBelow) >= 120) {
    // Opening over the button that was pressed keeps the eye on the control, like a menu; the larger side wins only when the
    // space above is too short to be useful.
    // 押したボタンの真上に開くことで、メニューのように視線をボタンの近くに保つ。上側が狭すぎる場合だけ広い側を使う。
    const x = clamp(button.x + button.width / 2 - size.width / 2, marginX, viewport.width - size.width - marginX);
    if (spaceAbove >= 120 || spaceAbove >= spaceBelow) { const maxHeight = Math.max(0, spaceAbove), height = Math.min(size.height, maxHeight); return { x, y: dock.y - 12 - height, maxHeight, obscureDock: false }; }
    return { x, y: dock.y + dock.height + 12, maxHeight: Math.max(0, spaceBelow), obscureDock: false };
  }
  let preferredX = viewport.width - size.width - 18;
  if (anchor) { preferredX = anchor.x + anchor.width + 12; if (preferredX + size.width > viewport.width - marginX) preferredX = anchor.x - size.width - 12; }
  const x = clamp(preferredX, marginX, viewport.width - size.width - marginX);
  let top = marginY, bottom = Math.max(top, viewport.height - marginY), obscureDock = false;
  if (dock.width > 0 && dock.height > 0 && x < dock.x + dock.width && x + size.width > dock.x) {
    const above = clamp(dock.y - 12, top, bottom), below = clamp(dock.y + dock.height + 12, top, bottom);
    if (above - top >= bottom - below) bottom = above; else top = below;
    if (bottom - top < 120) { obscureDock = true; top = marginY; bottom = Math.max(top, viewport.height - marginY); }
  }
  const maxHeight = bottom - top, height = Math.min(size.height, maxHeight);
  const preferredY = anchor?.y ?? viewport.height - size.height - 18;
  return { x, y: clamp(preferredY, top, bottom - height), maxHeight, obscureDock };
}

// A panel the user dragged keeps its chosen point and is only pushed back inside the viewport, so growing content or a smaller window never hides it while the choice itself is kept for when there is room again.
// 利用者がドラッグしたパネルは選んだ位置を保ち、画面内へ押し戻すだけにする。内容が伸びたり画面が狭まったりしても隠れず、余裕が戻れば選んだ位置に戻る。
export function clampPanelPosition(point: { x: number; y: number }, size: Size, viewport: Size): PanelPosition {
  const marginX = Math.min(10, Math.max(0, viewport.width) / 2), marginY = Math.min(10, Math.max(0, viewport.height) / 2);
  const clamp = (value: number, start: number, end: number) => Math.max(start, Math.min(Math.max(start, end), value));
  const maxHeight = Math.max(0, viewport.height - marginY * 2), height = Math.min(size.height, maxHeight);
  return { x: clamp(point.x, marginX, viewport.width - size.width - marginX), y: clamp(point.y, marginY, viewport.height - height - marginY), maxHeight, obscureDock: false };
}

// Only inline styles change here, never the panel's DOM, so typed text, caret, focus and scroll survive every reposition.
// ここではパネルのDOMを作り直さずインラインスタイルだけを変えるため、入力中の文字・キャレット・フォーカス・スクロールが位置調整のたびに失われない。
export function installPanelPosition(panel: HTMLElement, dock: HTMLElement, onDragStart?: () => void): { place(anchor?: Rectangle, button?: HTMLElement): void; refresh(): void; hold(active: boolean): void; close(): void; dispose(): void } {
  const view = panel.ownerDocument.defaultView;
  let anchor: Rectangle | undefined, button: HTMLElement | undefined, frame = 0, disposed = false, held = false;
  // `moved` is the point the user dropped the panel at; it lasts until the panel closes, so switching between the list and a comment does not throw it back to its automatic spot.
  // `moved` は利用者がパネルを置いた位置。パネルを閉じるまで保つため、一覧とコメントを行き来しても自動の位置へ戻らない。
  let moved: { x: number; y: number } | undefined, drag: { pointer: number; x: number; y: number; origin: { x: number; y: number }; previous?: { x: number; y: number }; started: boolean } | undefined;
  const endDrag = (restore: boolean) => { const current = drag; if (!current) return; drag = undefined; panel.classList.remove('dragging'); if (panel.hasPointerCapture(current.pointer)) panel.releasePointerCapture(current.pointer); if (restore) { moved = current.previous; refresh(); } };
  const close = () => { endDrag(false); anchor = undefined; button = undefined; moved = undefined; held = false; nativeCancelAnimationFrame(frame); frame = 0; dock.classList.remove('panel-obscured'); };
  function update() {
    frame = 0;
    if (disposed || !view || panel.hidden) { dock.classList.remove('panel-obscured'); return; }
    // While the panel morphs between screens its height changes every frame; placing it from those frames would re-anchor it mid-flight, so placement waits for the morph unless the user drags.
    // 画面の切り替えでパネルが変形している間は高さが毎フレーム変わる。その途中の大きさで位置を決めると動きの途中で基準が変わるため、ドラッグ中を除き変形の終了まで待つ。
    if (held && !drag) return;
    // The entry animation scales the panel and ResizeObserver ignores transforms, so a transformed bounding box would leave the clamp computed for a narrower panel.
    // 登場アニメーションはパネルを縮小し、ResizeObserverは変形を検知しないため、変形後の外接矩形で測ると狭いパネルとして位置を決めたまま残る。
    const size = { width: panel.offsetWidth, height: panel.scrollHeight + panel.offsetHeight - panel.clientHeight }, viewport = { width: view.innerWidth, height: view.innerHeight };
    const pressed = button?.isConnected && !dock.hidden ? button.getBoundingClientRect() : undefined;
    const position = moved ? clampPanelPosition(moved, size, viewport) : calculatePanelPosition(size, dock.getBoundingClientRect(), viewport, anchor, pressed);
    // Opening and closing scale from where the panel came from, the pressed button or the target it opens beside, so the motion points back at it.
    // 開閉のアニメーションは、押したボタンや横に開いた対象といったパネルの出どころを基点に拡大・縮小し、動きがそこを指すようにする。
    const height = Math.min(size.height, position.maxHeight), within = (value: number, end: number) => Math.round(Math.max(0, Math.min(end, value)));
    const origin = moved ? 'center' : pressed && pressed.width > 0 ? `${within(pressed.x + pressed.width / 2 - position.x, size.width)}px ${pressed.y >= position.y + height / 2 ? '100%' : '0%'}`
      : anchor ? `${within(anchor.x + anchor.width / 2 - position.x, size.width)}px ${within(anchor.y + anchor.height / 2 - position.y, height)}px` : '100% 100%';
    for (const [property, value] of Object.entries({ right: 'auto', bottom: 'auto', left: `${position.x}px`, top: `${position.y}px`, 'max-height': `${position.maxHeight}px`, 'transform-origin': origin })) {
      if (panel.style.getPropertyValue(property) !== value) panel.style.setProperty(property, value);
    }
    dock.classList.toggle('panel-obscured', position.obscureDock);
  }
  const refresh = () => { if (!disposed && !frame) frame = nativeRequestAnimationFrame(update); };
  // The header is the grip, like a dialog title bar; its buttons keep their clicks because a press on a control never starts a drag.
  // ダイアログのタイトルバーのようにヘッダーを持ち手にする。操作部品の上で押したときはドラッグを始めないため、ヘッダーのボタンはそのままクリックできる。
  const down = (event: PointerEvent) => {
    const target = event.target as Element, grip = target.closest?.('header');
    if (drag || !event.isPrimary || event.button !== 0 || !grip || grip.parentElement !== panel || target.closest('button,a,input,select,textarea,label,[role="menu"]')) return;
    // The inline left and top are the untransformed spot; the bounding box would be scaled while the entry animation runs.
    // インラインのleftとtopは変形前の位置。登場アニメーション中は外接矩形が縮小されているため使わない。
    const rect = panel.getBoundingClientRect(), left = Number.parseFloat(panel.style.left), top = Number.parseFloat(panel.style.top);
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: Number.isFinite(left) ? left : rect.left, y: Number.isFinite(top) ? top : rect.top }, previous: moved, started: false };
    // The capture is on the panel, not the header, because a list refresh can replace the header mid-drag and would release a capture held by it.
    // 一覧の更新でドラッグ中にヘッダーが作り直されることがあり、ヘッダーで持ったキャプチャは外れてしまうため、パネル自身でキャプチャする。
    try { panel.setPointerCapture(event.pointerId); } catch { drag = undefined; return; }
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    const current = drag; if (!current || event.pointerId !== current.pointer) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.started && Math.hypot(dx, dy) < 3) return;
    if (!current.started) onDragStart?.();
    current.started = true; panel.classList.add('dragging'); event.preventDefault();
    moved = { x: current.origin.x + dx, y: current.origin.y + dy }; nativeCancelAnimationFrame(frame); update();
    // Storing the clamped point means a later small move starts from where the panel is seen, not from a point off screen.
    // 画面内へ補正した位置を保存することで、次に少し動かしたときに画面外の位置からではなく見えている位置から動き出す。
    moved = { x: Number.parseFloat(panel.style.left) || 0, y: Number.parseFloat(panel.style.top) || 0 };
  };
  const up = (event: PointerEvent) => { if (drag?.pointer === event.pointerId) { move(event); endDrag(false); } };
  // A lost capture or cancel keeps the spot the panel was last shown at. Pages that swallow pointerup (gesture and outside-click libraries) still let the capture end, and treating that as a cancel threw the panel back to where the drag began.
  // キャプチャの喪失やキャンセルでは、最後に表示した位置で確定する。pointerupを握りつぶすページ（ジェスチャーや外側クリックのライブラリ）でもキャプチャの終了は届くため、これを取り消しとして扱うとドラッグ前の位置へ戻っていた。
  const lost = (event: PointerEvent) => { if (drag?.pointer === event.pointerId) endDrag(false); };
  // Escape during a drag puts the panel back instead of also closing it.
  // ドラッグ中のEscapeはパネルを閉じずに元の位置へ戻すだけにする。
  const escape = (event: KeyboardEvent) => { if (drag?.started && !event.isComposing && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); endDrag(true); } };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh);
  observer?.observe(panel); observer?.observe(dock); view?.addEventListener('resize', refresh);
  // Moves and the release are read on the window in the capture phase, before page handlers can stop their propagation; captured events still pass through it.
  // 移動と離す操作は、ページのハンドラーが伝播を止める前にウィンドウのキャプチャ段階で読む。キャプチャ中のイベントもここを通る。
  panel.addEventListener('pointerdown', down); view?.addEventListener('pointermove', move, true); view?.addEventListener('pointerup', up, true);
  view?.addEventListener('pointercancel', lost, true); panel.addEventListener('lostpointercapture', lost); view?.addEventListener('keydown', escape, true);
  return { place(nextAnchor, nextButton) { if (disposed) return; anchor = nextAnchor ? { ...nextAnchor } : undefined; button = nextButton; nativeCancelAnimationFrame(frame); update(); }, refresh,
    hold(active) { held = active; if (!active && !disposed) { nativeCancelAnimationFrame(frame); update(); } }, close, dispose() {
    disposed = true; close(); observer?.disconnect(); view?.removeEventListener('resize', refresh); view?.removeEventListener('keydown', escape, true);
    panel.removeEventListener('pointerdown', down); view?.removeEventListener('pointermove', move, true); view?.removeEventListener('pointerup', up, true);
    view?.removeEventListener('pointercancel', lost, true); panel.removeEventListener('lostpointercapture', lost);
  } };
}
