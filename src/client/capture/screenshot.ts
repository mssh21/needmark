import { nativeSetTimeout, nativeClearTimeout } from '../animation-freeze.js';
import html2canvas from 'html2canvas-pro';
import { viewportRectOf } from '../context/code-context.js';
import type { Rectangle } from '../../shared/types.js';
import { captureViewport, rectanglesMatch, type CaptureGuard, type CaptureSnapshot } from './identity.js';
import { captureFramePlan, removeFailedCaptureClone, type FrameCapturePlan } from './frames.js';

interface CaptureTrack extends MediaStreamTrack { getCaptureHandle?: () => { handle?: string } | null }
interface CaptureDevices extends MediaDevices {
  setCaptureHandleConfig?: (config: { handle: string; permittedOrigins: string[] }) => void;
}

export class ScreenshotCapture {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private handle = crypto.randomUUID();
  private generation = 0;

  constructor() {
    (navigator.mediaDevices as CaptureDevices | undefined)?.setCaptureHandleConfig?.({
      handle: this.handle, permittedOrigins: [location.origin],
    });
  }

  get active(): boolean { return this.stream?.getVideoTracks()[0]?.readyState === 'live'; }

  async start(): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('このブラウザではタブ撮影を開始できません。簡易キャプチャを選んでください。');
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', width: { ideal: Math.min(4096, innerWidth * devicePixelRatio) },
        height: { ideal: Math.min(4096, innerHeight * devicePixelRatio) } }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions);
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('撮影の開始をキャンセルしました。');
    }
    const track = stream.getVideoTracks()[0] as CaptureTrack;
    const handle = track.getCaptureHandle?.();
    if (track.getSettings().displaySurface !== 'browser' || (handle && handle.handle !== this.handle)) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('レビュー中のこのタブを選択してください。');
    }
    this.stream = stream;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    const video = this.video;
    try { await video.play(); }
    catch (error) { if (generation === this.generation && this.stream === stream) this.stop(); throw error; }
    if (generation !== this.generation) throw new Error('撮影の開始をキャンセルしました。');
  }

  stop() {
    this.generation++;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video = null;
  }

  async capture(method: 'tab' | 'dom', rect: Rectangle, host: HTMLElement, guard?: CaptureGuard) {
    const prepare = () => {
      const snapshot: CaptureSnapshot = guard?.prepare() ?? {
        rect: { ...rect }, viewport: captureViewport(), capturedAt: new Date().toISOString(), url: location.href, geometry: [],
      };
      const sensitive = sensitiveElements(document).map((element) => ({ element, rect: viewportRectOf(element) }));
      return { snapshot, sensitive };
    };
    let prepared: ReturnType<typeof prepare>, canvas: HTMLCanvasElement, frames: FrameCapturePlan | undefined, region: Rectangle | undefined;
    if (method === 'tab') {
      if (!this.active || !this.video) throw new Error('撮影が停止しています。高精度キャプチャを開始し直してください。');
      const generation = this.generation, track = this.stream!.getVideoTracks()[0]!, video = this.video;
      // The tab stream lags the DOM by a few frames, so wait several 60 Hz frames for the hidden controls to leave the video.
      // タブの映像はDOMより数フレーム遅れるため、60Hzで数フレーム待って操作UIが映像から消えるのを待つ。
      await new Promise((resolve) => nativeSetTimeout(resolve, 100));
      if (generation !== this.generation) throw new Error('撮影が停止しました。');
      prepared = prepare();
      const ImageCapture = (window as unknown as { ImageCapture?: new (track: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
      let frame: ImageBitmap | null = null;
      try {
        if (ImageCapture) {
          frame = await new Promise<ImageBitmap>((resolve, reject) => {
            let timedOut = false;
            const deadline = nativeSetTimeout(() => { timedOut = true; reject(new Error('タブ映像の取得がタイムアウトしました。')); }, 3000);
            try {
              new ImageCapture(track).grabFrame().then((frame) => {
                nativeClearTimeout(deadline); if (timedOut) frame.close(); else resolve(frame);
              }, (error) => { nativeClearTimeout(deadline); reject(error); });
            } catch (error) { nativeClearTimeout(deadline); reject(error); }
          });
        }
        if (generation !== this.generation) throw new Error('撮影が停止しました。');
        const width = frame?.width ?? video.videoWidth;
        const height = frame?.height ?? video.videoHeight;
        if (!width || !height) throw new Error('タブ映像が取得できませんでした。');
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(frame ?? video, 0, 0);
      } finally { frame?.close(); }
    } else {
      const prepareClone = domCloneOptions(document);
      prepared = prepare();
      const viewport = prepared.snapshot.viewport;
      region = captureRegion(prepared.snapshot.rect, viewport,
        { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
      const scale = captureScale(region, viewport.devicePixelRatio);
      frames = await captureFramePlan(document, scale, domCloneOptions);
      canvas = await html2canvas(document.documentElement, {
        x: viewport.scrollX + region.x, y: viewport.scrollY + region.y, width: region.width, height: region.height,
        windowWidth: viewport.width, windowHeight: viewport.height, scrollX: viewport.scrollX, scrollY: viewport.scrollY,
        scale,
        useCORS: true, logging: false, backgroundColor: '#ffffff',
        ignoreElements: (element) => element === host || element.matches('[data-needmark],iframe'),
        onclone: async (clone) => {
          try { await frames!.restore(clone); prepareClone(clone); }
          catch (error) { removeFailedCaptureClone(clone); throw error; }
        },
      });
    }
    const { snapshot, sensitive } = prepared, current = captureViewport();
    if (location.href !== snapshot.url || current.width !== snapshot.viewport.width || current.height !== snapshot.viewport.height
      || current.scrollX !== snapshot.viewport.scrollX || current.scrollY !== snapshot.viewport.scrollY || current.devicePixelRatio !== snapshot.viewport.devicePixelRatio) {
      throw new Error('撮影中に画面の位置が変わりました。画像なしで保存するか、場所を選び直してください。');
    }
    guard?.validate(snapshot);
    frames?.validate();
    const currentSensitive = new Set(sensitiveElements(document));
    if (currentSensitive.size !== sensitive.length || sensitive.some((record) => !currentSensitive.has(record.element)
      || !rectanglesMatch(record.rect, viewportRectOf(record.element)))) {
      throw new Error('撮影中に伏せる領域が変わりました。画像なしで保存するか、場所を選び直してください。');
    }
    const context = canvas.getContext('2d')!;
    // html2canvas leaves its scale/scroll transform on the canvas, which would offset the masks and outline drawn next.
    // html2canvasはキャンバスに拡大・スクロールの変換を残すため、そのままだと次に描く伏せ字と枠がずれる。
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    context.shadowColor = 'transparent'; context.shadowBlur = 0; context.setLineDash([]);
    const area = region ?? { x: 0, y: 0, width: snapshot.viewport.width, height: snapshot.viewport.height };
    const scaleX = canvas.width / area.width;
    const scaleY = canvas.height / area.height;
    // Masks use the regions recorded before the pixels were taken; a later position could leave the old pixels exposed.
    // A solid fill is used instead of blur, which can be partially reversed.
    // 伏せ字は画素を取得する前に記録した領域に描く。後の位置を使うと古い画素が露出し得る。ぼかしは一部復元され得るため塗りつぶしにする。
    sensitive.forEach(({ rect }) => {
      if (!rect.width || !rect.height) return;
      context.fillStyle = '#2e3134';
      // Geometry checks accept 0.5 px drift, which can move an edge by one CSS pixel, so the mask grows by one pixel and rounds outward.
      // 形状の確認は0.5pxのずれを許容し、端が1CSSピクセル動き得るため、伏せ字を1px広げて外側へ丸める。
      const left = Math.floor((rect.x - area.x - 1) * scaleX), top = Math.floor((rect.y - area.y - 1) * scaleY);
      const right = Math.ceil((rect.x - area.x + rect.width + 1) * scaleX), bottom = Math.ceil((rect.y - area.y + rect.height + 1) * scaleY);
      context.fillRect(left, top, right - left, bottom - top);
    });
    const map = (rect: Rectangle) => ({ x: (rect.x - area.x) * scaleX, y: (rect.y - area.y) * scaleY, width: rect.width * scaleX, height: rect.height * scaleY });
    if (snapshot.lines?.length) {
      context.fillStyle = 'rgba(25, 101, 227, 0.3)';
      snapshot.lines.map(map).forEach((line) => context.fillRect(line.x, line.y, line.width, line.height));
    } else {
      // A white halo under the blue line keeps the outline visible on both dark and light pages.
      // 青い線の下に白い縁を敷くことで、暗いページでも明るいページでも枠が見えるようにする。
      const outline = map(snapshot.rect);
      context.strokeStyle = '#ffffff';
      context.lineWidth = 5 * scaleX;
      context.strokeRect(outline.x, outline.y, outline.width, outline.height);
      context.strokeStyle = '#1965e3';
      context.lineWidth = 2 * scaleX;
      context.strokeRect(outline.x, outline.y, outline.width, outline.height);
    }
    return { screenshot: canvas.toDataURL('image/png'), capture: { method, width: canvas.width, height: canvas.height }, snapshot };
  }
}

const regionMargin = 48;

export function captureRegion(rect: Rectangle, viewport: { width: number; height: number; scrollX: number; scrollY: number },
  page: { width: number; height: number }): Rectangle {
  if (rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  // Without the page bounds a target near the document edge would centre the region on blank space past the last scrollable pixel.
  // ページの範囲で抑えないと、文書の端にある対象では、スクロールできる最後の画素より外の空白が中心になってしまう。
  const axis = (start: number, size: number, view: number, scroll: number, pageSize: number) => {
    const length = Math.min(Math.max(view, size + regionMargin * 2), Math.max(view, pageSize));
    const min = 0 - scroll, max = Math.max(view, pageSize) - scroll - length;
    return { start: Math.min(Math.max(start + size / 2 - length / 2, min), max), length };
  };
  const x = axis(rect.x, rect.width, viewport.width, viewport.scrollX, page.width);
  const y = axis(rect.y, rect.height, viewport.height, viewport.scrollY, page.height);
  return { x: x.start, y: y.start, width: x.length, height: y.length };
}

export function captureScale(region: Rectangle, devicePixelRatio: number): number {
  // Canvas backing stores fail silently beyond about 16 million pixels in WebKit, and larger PNGs approach the server's 5 MB image limit,
  // so a tall page region lowers its resolution rather than losing the image.
  // WebKitのキャンバスは約1600万画素を超えると黙って描画に失敗し、大きなPNGはサーバーの5MB上限に近づくため、縦長の範囲は画像を失う代わりに解像度を下げる。
  return Math.min(devicePixelRatio, 8192 / region.width, 8192 / region.height, Math.sqrt(2560 * 2560 / (region.width * region.height)));
}

function domCloneOptions(source: Document): (clone: Document) => void {
  const modalDialogs = Array.from(source.querySelectorAll('dialog')).map((dialog, index) => ({ dialog, index }))
    .filter(({ dialog }) => dialog.matches(':modal')).map(({ dialog, index }) => ({ index, rect: dialog.getBoundingClientRect() }));
  return (clone) => {
    // A cloned dialog keeps `open` but loses the native top layer and centering, so it is reopened as modal at its recorded box.
    // 複製したdialogはopenを保つがネイティブのtop layerと中央配置を失うため、記録した位置でモーダルとして開き直す。
    const dialogs = clone.querySelectorAll<HTMLDialogElement>('dialog');
    modalDialogs.forEach(({ index, rect }, order) => {
      const dialog = dialogs[index]; if (!dialog) return;
      dialog.close(); dialog.showModal();
      Object.assign(dialog.style, { position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`, right: 'auto', bottom: 'auto', margin: '0', width: `${rect.width}px`, height: `${rect.height}px`, maxWidth: 'none', maxHeight: 'none', boxSizing: 'border-box', transform: 'none', zIndex: String(2147483000 + order) });
    });
    sensitiveElements(clone).forEach((element) => { (element as HTMLElement).style.visibility = 'hidden'; });
    clone.querySelectorAll('img[loading="lazy"]').forEach((image) => image.setAttribute('loading', 'eager'));
    clone.querySelectorAll<HTMLElement>('*').forEach((element) => element.style.setProperty('scroll-behavior', 'auto'));
  };
}

function sensitiveElements(root: Document | ShadowRoot): Element[] {
  const elements = Array.from(root.querySelectorAll('input[type="password"], [data-needmark-redact], [data-needback-redact]'));
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) elements.push(...sensitiveElements(element.shadowRoot));
    if (element.localName === 'iframe') {
      const frame = element as HTMLIFrameElement;
      try { if (frame.contentDocument) elements.push(...sensitiveElements(frame.contentDocument)); } catch { /* Cross-origin interiors cannot be inspected; marking the iframe itself is the only way to mask them. / 別オリジンの中身は調べられないため、iframe自体に印を付ける方法でしか伏せられない。 */ }
    }
  }
  return elements;
}
