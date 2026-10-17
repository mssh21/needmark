import { test, expect } from './support/review.js';
import { resolve } from 'node:path';

const moduleUrl = `/@fs/${resolve('src/client/capture/screenshot.ts')}`;

test('cancelling a pending sharing request stops its late stream instead of activating capture', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { ScreenshotCapture } = await import(moduleUrl);
    const devices = navigator.mediaDevices;
    const descriptor = Object.getOwnPropertyDescriptor(devices, 'getDisplayMedia');
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const stream = canvas.captureStream();
    let deliver!: (stream: MediaStream) => void;
    Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: () => new Promise<MediaStream>((resolve) => { deliver = resolve; }) });
    const capture = new ScreenshotCapture();
    try {
      const started = capture.start().then(() => false, () => true);
      capture.stop();
      deliver(stream);
      return { rejected: await started, active: capture.active, states: stream.getTracks().map((track) => track.readyState) };
    } finally {
      capture.stop();
      if (descriptor) Object.defineProperty(devices, 'getDisplayMedia', descriptor);
      else Reflect.deleteProperty(devices, 'getDisplayMedia');
    }
  }, moduleUrl);
  expect(result.rejected).toBe(true);
  expect(result.active).toBe(false);
  expect(result.states).toEqual(['ended']);
});

test('video playback failure releases the acquired stream and lets a subsequent attempt start', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { ScreenshotCapture } = await import(moduleUrl);
    const devices = navigator.mediaDevices;
    const descriptor = Object.getOwnPropertyDescriptor(devices, 'getDisplayMedia');
    const play = HTMLMediaElement.prototype.play;
    const streams: MediaStream[] = [];
    Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
      const stream = canvas.captureStream();
      const track = stream.getVideoTracks()[0]!;
      Object.defineProperty(track, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
      streams.push(stream);
      return stream;
    } });
    const capture = new ScreenshotCapture();
    try {
      HTMLMediaElement.prototype.play = () => Promise.reject(new Error('Playback failed'));
      const rejected = await capture.start().then(() => false, () => true);
      const activeAfterFailure = capture.active;
      const failedTrackState = streams[0]!.getVideoTracks()[0]!.readyState;
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      await capture.start();
      const activeAfterRetry = capture.active;
      capture.stop();
      return { rejected, activeAfterFailure, failedTrackState, activeAfterRetry,
        finalStates: streams.flatMap((stream) => stream.getTracks().map((track) => track.readyState)) };
    } finally {
      capture.stop(); HTMLMediaElement.prototype.play = play;
      if (descriptor) Object.defineProperty(devices, 'getDisplayMedia', descriptor);
      else Reflect.deleteProperty(devices, 'getDisplayMedia');
    }
  }, moduleUrl);
  expect(result).toEqual({ rejected: true, activeAfterFailure: false, failedTrackState: 'ended', activeAfterRetry: true,
    finalStates: ['ended', 'ended'] });
});

test('native bitmap frames are closed after success and after stop during a pending frame', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { ScreenshotCapture } = await import(moduleUrl);
    const devices = navigator.mediaDevices;
    const descriptor = Object.getOwnPropertyDescriptor(devices, 'getDisplayMedia');
    const imageCaptureDescriptor = Object.getOwnPropertyDescriptor(window, 'ImageCapture');
    const play = HTMLMediaElement.prototype.play;
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const stream = canvas.captureStream();
    Object.defineProperty(stream.getVideoTracks()[0]!, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
    Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: async () => stream });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    let closed = 0;
    const bitmap = async () => {
      const frame = await createImageBitmap(canvas);
      const close = frame.close.bind(frame);
      Object.defineProperty(frame, 'close', { value: () => { closed++; close(); } });
      return frame;
    };
    const capture = new ScreenshotCapture();
    const host = document.querySelector<HTMLElement>('[data-needmark]')!;
    try {
      Object.defineProperty(window, 'ImageCapture', { configurable: true, value: class { grabFrame() { return bitmap(); } } });
      await capture.start();
      const successful = await capture.capture('tab', { x: 300, y: 300, width: 30, height: 30 }, host);
      const closedAfterSuccess = closed;
      let delivered!: (frame: ImageBitmap) => void;
      let frameRequested!: () => void;
      const requested = new Promise<void>((resolve) => { frameRequested = resolve; });
      Object.defineProperty(window, 'ImageCapture', { configurable: true, value: class {
        grabFrame() { frameRequested(); return new Promise<ImageBitmap>((resolve) => { delivered = resolve; }); }
      } });
      const pending = capture.capture('tab', { x: 300, y: 300, width: 30, height: 30 }, host).then(() => false, () => true);
      await requested;
      capture.stop();
      delivered(await bitmap());
      const rejected = await pending;
      return { closedAfterSuccess, closedAfterCancellation: closed, rejected,
        dimensions: successful.capture, png: successful.screenshot.startsWith('data:image/png;base64,'),
        trackState: stream.getVideoTracks()[0]!.readyState };
    } finally {
      capture.stop(); HTMLMediaElement.prototype.play = play;
      if (descriptor) Object.defineProperty(devices, 'getDisplayMedia', descriptor);
      else Reflect.deleteProperty(devices, 'getDisplayMedia');
      if (imageCaptureDescriptor) Object.defineProperty(window, 'ImageCapture', imageCaptureDescriptor);
      else Reflect.deleteProperty(window, 'ImageCapture');
    }
  }, moduleUrl);
  expect(result).toEqual({ closedAfterSuccess: 1, closedAfterCancellation: 2, rejected: true,
    dimensions: { method: 'tab', width: 64, height: 48 }, png: true, trackState: 'ended' });
});

test('DOM capture masks passwords and explicit redaction including open shadows and same-origin frames without altering layout', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { ScreenshotCapture } = await import(moduleUrl);
    const fixture = document.createElement('div');
    fixture.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;height:420px;background:white;z-index:100000';
    const password = document.createElement('input'); password.type = 'password'; password.value = 'private-password';
    password.style.cssText = 'display:block;width:160px;height:60px;padding:0;margin:0;border:0;background:rgb(220,30,60)';
    const redacted = document.createElement('div'); redacted.dataset.needmarkRedact = ''; redacted.textContent = 'Private customer';
    redacted.style.cssText = 'width:160px;height:60px;background:rgb(220,30,60)';
    const visible = document.createElement('div'); visible.style.cssText = 'width:160px;height:60px;background:rgb(12,174,93)';
    const shadowHost = document.createElement('div'); shadowHost.style.cssText = 'width:160px;height:60px';
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const shadowPrivate = document.createElement('div'); shadowPrivate.dataset.needbackRedact = '';
    shadowPrivate.style.cssText = 'width:160px;height:60px;background:rgb(220,30,60)'; shadow.append(shadowPrivate);
    const iframe = document.createElement('iframe'); iframe.style.cssText = 'display:block;width:160px;height:120px;border:0';
    iframe.srcdoc = '<style>html,body{margin:0}input{display:block;width:160px;height:60px;padding:0;border:0;background:rgb(220,30,60)}</style><input type="password" value="frame-private">';
    const loaded = new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
    fixture.append(password, redacted, visible, shadowHost, iframe); document.body.append(fixture); await loaded;
    const nestedFrame = iframe.contentDocument!.createElement('iframe');
    nestedFrame.style.cssText = 'display:block;width:160px;height:60px;border:0';
    nestedFrame.srcdoc = '<style>html,body{margin:0}input{display:block;width:160px;height:60px;padding:0;border:0;background:rgb(220,30,60)}</style><input type="password" value="nested-private">';
    const nestedLoaded = new Promise<void>((resolve) => nestedFrame.addEventListener('load', () => resolve(), { once: true }));
    iframe.contentDocument!.body.append(nestedFrame); await nestedLoaded;
    const snapshot = () => [password, redacted, visible, shadowPrivate, iframe, nestedFrame].map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visibility: getComputedStyle(element).visibility };
    });
    const before = snapshot();
    const capture = new ScreenshotCapture();
    try {
      const captured = await capture.capture('dom', { x: 600, y: 600, width: 40, height: 30 }, document.querySelector<HTMLElement>('[data-needmark]')!);
      const image = new Image(); image.src = captured.screenshot; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const samples = before.slice(0, 4).map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
      const frameBounds = before[4]!;
      samples.push({ x: frameBounds.x + 80, y: frameBounds.y + 30 }, { x: frameBounds.x + 80, y: frameBounds.y + 90 });
      const colors = samples.map((point) => Array.from(context.getImageData(
        point.x * image.width / innerWidth, point.y * image.height / innerHeight, 1, 1).data));
      return { colors, before, after: snapshot(), passwordValue: password.value,
        frameValue: (iframe.contentDocument!.querySelector('input') as HTMLInputElement).value,
        nestedFrameValue: (nestedFrame.contentDocument!.querySelector('input') as HTMLInputElement).value };
    } finally { capture.stop(); fixture.remove(); }
  }, moduleUrl);
  expect(result.colors).toEqual([[46, 49, 52, 255], [46, 49, 52, 255], [12, 174, 93, 255], [46, 49, 52, 255], [46, 49, 52, 255], [46, 49, 52, 255]]);
  expect(result.after).toEqual(result.before);
  expect(result.passwordValue).toBe('private-password');
  expect(result.frameValue).toBe('frame-private');
  expect(result.nestedFrameValue).toBe('nested-private');
});

test('DOM capture keeps an inline iframe that fills a stretched flex item by percentage', { tag: '@cross-engine' }, async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { ScreenshotCapture } = await import(moduleUrl);
    const row = document.createElement('div');
    row.style.cssText = 'position:fixed;left:20px;top:20px;width:600px;display:flex;gap:20px;background:white;z-index:100000';
    const text = document.createElement('div'); text.style.cssText = 'flex:1;height:281.6px;background:rgb(12,174,93)';
    const map = document.createElement('div'); map.style.cssText = 'flex:1;overflow:hidden;line-height:26.4px';
    const iframe = document.createElement('iframe'); iframe.width = '100%'; iframe.height = '100%'; iframe.style.border = '0';
    iframe.srcdoc = '<style>html,body{margin:0;height:100%;background:rgb(25,101,227)}</style>';
    const loaded = new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
    map.append(iframe); row.append(text, map); document.body.append(row); await loaded;
    const capture = new ScreenshotCapture();
    try {
      const captured = await capture.capture('dom', { x: 600, y: 600, width: 40, height: 30 }, document.querySelector<HTMLElement>('[data-needmark]')!);
      return { method: captured.capture.method };
    } catch (error) { return { error: String(error) }; } finally { capture.stop(); row.remove(); }
  }, moduleUrl);
  expect(result).toEqual({ method: 'dom' });
});

test.describe('scrolled high-DPI capture geometry', { tag: '@cross-engine' }, () => {
  test.use({ deviceScaleFactor: 2 });
  test('saved selection outline and redaction use viewport pixels after DOM renderer transforms', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async (moduleUrl) => {
      const { ScreenshotCapture } = await import(moduleUrl);
      window.scrollTo(0, 200);
      const privateArea = document.createElement('div'); privateArea.setAttribute('data-needmark-redact', '');
      privateArea.style.cssText = 'position:fixed;left:20px;top:180px;width:70px;height:30px;background:#ff0000'; document.body.append(privateArea);
      const selected = document.querySelector('#purchase-button')!; const bounds = selected.getBoundingClientRect();
      const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      const host = document.querySelector('[data-needmark]') as HTMLElement;
      const result = await new ScreenshotCapture().capture('dom', rect, host);
      const image = new Image(); image.src = result.screenshot; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(image,0,0);
      const scaleX = image.width / innerWidth, scaleY = image.height / innerHeight;
      const color = (x:number,y:number) => Array.from(ctx.getImageData(Math.round(x * scaleX),Math.round(y * scaleY),1,1).data);
      const mask = color(50,195), outline = color(rect.x,rect.y + rect.height/2);
      privateArea.remove(); return { scrollY, dpr: devicePixelRatio, width:image.width, viewportWidth:innerWidth, mask, outline };
    }, `/@fs/${resolve('src/client/capture/screenshot.ts')}`);
    expect(result.scrollY).toBeGreaterThan(0); expect(result.dpr).toBe(2); expect(result.width).toBeGreaterThan(result.viewportWidth);
    expect(result.mask.slice(0,3)).toEqual([46,49,52]); expect(result.outline.slice(0,3)).toEqual([25, 101, 227]);
  });
});
