// A modal <dialog> makes everything outside it inert, so the review host moves inside the active dialog instead of using a higher z-index,
// and a manual popover keeps it in the top layer without a second UI instance.
// モーダルの<dialog>は外側をすべて操作不能にするため、z-indexではなくレビューのホストをアクティブなダイアログ内へ移す。manualのpopoverでUIを複製せずにtop layerに置ける。
export function attachReviewLayer(host: HTMLElement, onChange?: () => void): () => void {
  const document = host.ownerDocument;
  const popover = typeof host.showPopover === 'function';
  if (popover) host.setAttribute('popover', 'manual');
  Object.assign(host.style, {
    position: 'fixed', inset: '0', margin: '0', padding: '0', border: '0',
    width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none',
    background: 'transparent', overflow: 'visible', pointerEvents: 'none',
  });
  const backdropStyle = document.createElement('style');
  backdropStyle.textContent = ':host::backdrop{background:transparent;pointer-events:none}';
  host.shadowRoot?.append(backdropStyle);

  function sync() {
    // Focus identifies the modal the user is actually in when dialogs nest; searching shadow trees was left out because
    // custom focus traps there cannot be detected reliably.
    // ダイアログが入れ子のとき、利用者が操作中のモーダルはフォーカスで特定できる。Shadow DOM内の独自のフォーカストラップは確実に検出できないため対象外にしている。
    const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog:modal')).reverse();
    const active = document.activeElement;
    const modal = dialogs.find((dialog) => active && dialog.contains(active)) ?? dialogs[0];
    const parent = modal ?? document.documentElement;
    const focused = host.shadowRoot?.activeElement;
    if (host.parentElement !== parent) {
      if (popover && host.matches(':popover-open')) host.hidePopover();
      parent.append(host);
      if (popover) host.showPopover();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
      onChange?.();
    } else if (popover && !host.matches(':popover-open')) host.showPopover();
  }
  sync();
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some((node) =>
      node === host || node instanceof Element && (node.matches('dialog') || node.contains(host) || !!node.querySelector('dialog'))))) sync();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  document.addEventListener('focusin', sync, true);
  return () => {
    observer.disconnect(); document.removeEventListener('focusin', sync, true); backdropStyle.remove();
    if (popover && host.matches(':popover-open')) host.hidePopover();
  };
}
