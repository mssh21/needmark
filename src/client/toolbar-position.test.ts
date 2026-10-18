import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampToolbarPosition, installToolbarPosition, readToolbarPosition, toolbarAnchor } from './toolbar-position.js';

const key = 'needmark-toolbar-position';
class Style {
  entries = new Map<string, { value: string; priority: string }>();
  getPropertyValue(name: string): string { return this.entries.get(name)?.value ?? ''; }
  getPropertyPriority(name: string): string { return this.entries.get(name)?.priority ?? ''; }
  setProperty(name: string, value: string, priority = ''): void { this.entries.set(name, { value, priority }); }
  removeProperty(name: string): string { const value = this.getPropertyValue(name); this.entries.delete(name); return value; }
}
class Surface extends EventTarget {
  style = new Style(); classes = new Set<string>(); classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) }; width = 300; height = 50; left = 600; top = 700; captures = new Set<number>();
  ownerDocument: { defaultView: EventTarget & { innerWidth: number; innerHeight: number } };
  constructor(view: EventTarget & { innerWidth: number; innerHeight: number }) { super(); this.ownerDocument = { defaultView: view }; }
  getBoundingClientRect(): DOMRect {
    const left = (Number.parseFloat(this.style.getPropertyValue('left')) || this.left) + (Number.parseFloat(this.style.getPropertyValue('--nm-shift')) || 0);
    const top = Number.parseFloat(this.style.getPropertyValue('top')) || this.top;
    return { x: left, y: top, left, top, right: left + this.width, bottom: top + this.height, width: this.width, height: this.height, toJSON: () => ({}) };
  }
  closest(): null { return null; }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
}
class Observer {
  static current: Observer; disconnected = false;
  constructor(private callback: () => void) { Observer.current = this; }
  observe(): void {}
  disconnect(): void { this.disconnected = true; }
  notify(): void { if (!this.disconnected) this.callback(); }
}
function fixture(raw?: string) {
  vi.stubGlobal('ResizeObserver', Observer);
  const view = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
  const dock = new Surface(view), saved = new Map<string, string>();
  if (raw !== undefined) saved.set(key, raw);
  const storage = { getItem: vi.fn((name: string) => saved.get(name) ?? null), setItem: vi.fn((name: string, value: string) => { saved.set(name, value); }) };
  const install = (onChange?: () => void) => installToolbarPosition(dock as unknown as HTMLElement, storage, onChange).detach;
  return { view, dock, saved, storage, install };
}
function pointer(surface: Surface, type: string, x = 10, y = 10, overrides = {}, target?: Surface) {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...overrides });
  if (target) Object.defineProperty(event, 'target', { value: target });
  // Moves, releases and cancels are listened for on the window, which the real events reach while bubbling or captured.
  (['pointermove', 'pointerup', 'pointercancel'].includes(type) ? surface.ownerDocument.defaultView : surface).dispatchEvent(event); return event;
}
const coordinates = (dock: Surface) => ({ x: Number.parseFloat(dock.style.getPropertyValue('left')), y: Number.parseFloat(dock.style.getPropertyValue('top')) });
afterEach(() => { vi.unstubAllGlobals(); });

describe('toolbar position validation and bounds', () => {
  it('restores legacy coordinates without writing and prefers the canonical position when both exist', () => {
    const saved = new Map([['needback-kit-toolbar-position', '{"x":120,"y":240}']]);
    const storage = { getItem: (name: string) => saved.get(name) ?? null };
    expect(readToolbarPosition(storage)).toEqual({ x: 120, y: 240 });
    saved.set(key, '{"x":180,"y":360}');
    expect(readToolbarPosition(storage)).toEqual({ x: 180, y: 360 });
    expect(saved.get('needback-kit-toolbar-position')).toBe('{"x":120,"y":240}');
  });
  it.each([null, '{broken', 'null', '[]', '{"x":"1","y":2}', '{"x":1,"y":null}', '{"x":1e999,"y":2}', '{"x":1}', 'x'.repeat(1001)])('ignores corrupt or nonnumeric saved coordinates', (raw) => {
    expect(readToolbarPosition({ getItem: () => raw })).toBeUndefined();
  });
  it('reads only finite coordinates and tolerates inaccessible storage', () => {
    expect(readToolbarPosition({ getItem: () => '{"x":-12.5,"y":1e100,"unknown":"ignored","anchor":"left"}' })).toStrictEqual({ x: -12.5, y: 1e100 });
    expect(readToolbarPosition({ getItem: () => '{"x":4,"y":8,"anchor":"start"}' })).toEqual({ x: 4, y: 8, anchor: 'start' });
    expect(readToolbarPosition({ getItem: () => { throw new Error('denied'); } })).toBeUndefined();
  });
  it('anchors the edge of the viewport third the toolbar centre falls in', () => {
    expect([toolbarAnchor(4, 300, 1200), toolbarAnchor(240, 300, 1200), toolbarAnchor(450, 300, 1200), toolbarAnchor(660, 300, 1200), toolbarAnchor(896, 300, 1200)]).toEqual(['start', 'start', 'center', 'end', 'end']);
  });
  it('keeps a four-pixel margin without rounding valid fractional positions or mutating inputs', () => {
    const position = Object.freeze({ x: 850.5, y: -1 });
    expect(clampToolbarPosition(position, { width: 300, height: 50 }, { width: 1000, height: 800 })).toEqual({ x: 696, y: 4 });
    expect(clampToolbarPosition({ x: 12.25, y: 35.75 }, { width: 300, height: 50 }, { width: 1000, height: 800 })).toEqual({ x: 12.25, y: 35.75 });
    expect(position).toEqual({ x: 850.5, y: -1 });
  });
  it('keeps oversized toolbars at a visible origin and handles viewports smaller than both margins', () => {
    expect(clampToolbarPosition({ x: 80, y: 80 }, { width: 900, height: 900 }, { width: 200, height: 100 })).toEqual({ x: 4, y: 4 });
    expect(clampToolbarPosition({ x: -100, y: 100 }, { width: 10, height: 10 }, { width: 2, height: 0 })).toEqual({ x: 1, y: 0 });
  });
});

describe('toolbar drag lifecycle', () => {
  it('retains the CSS default for clicks, subthreshold movement and nonprimary/right-button pointers', () => {
    const { dock, storage, install } = fixture(); const cleanup = install();
    pointer(dock, 'pointerdown', 10, 10, { isPrimary: false });
    pointer(dock, 'pointermove', 30, 30); pointer(dock, 'pointerup', 30, 30);
    pointer(dock, 'pointerdown', 10, 10, { button: 2 });
    pointer(dock, 'pointermove', 30, 30); pointer(dock, 'pointerup', 30, 30);
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 12, 10); pointer(dock, 'pointerup', 12, 10);
    expect(dock.style.entries.size).toBe(0); expect(storage.setItem).not.toHaveBeenCalled(); expect(dock.captures.size).toBe(0); cleanup();
  });
  it('ignores competing pointers and writes the final bounded position only after the primary drag completes', () => {
    const { dock, storage, saved, install } = fixture(); const cleanup = install();
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 10, 10, { pointerId: 2 });
    pointer(dock, 'pointerdown', 500, 500, { pointerId: 2, isPrimary: false });
    pointer(dock, 'pointercancel', 10, 10, { pointerId: 2 }); pointer(dock, 'pointerup', 1000, 1000, { pointerId: 2 });
    expect(dock.captures.has(1)).toBe(true); expect(storage.setItem).not.toHaveBeenCalled();
    pointer(dock, 'pointermove', 1000, 1000); expect(coordinates(dock)).toEqual({ x: 696, y: 746 }); expect(storage.setItem).not.toHaveBeenCalled();
    pointer(dock, 'pointerup', 110, -90); expect(coordinates(dock)).toEqual({ x: 696, y: 600 });
    expect(saved.get(key)).toBe('{"x":696,"y":600,"anchor":"end"}'); expect(storage.setItem).toHaveBeenCalledOnce(); expect(dock.captures.size).toBe(0); cleanup();
  });
  it('restores original inline styles and releases capture on Escape without saving', () => {
    const { dock, view, storage, install } = fixture();
    dock.style.setProperty('right', '22px', 'important'); dock.style.setProperty('bottom', '19px');
    const original = [...dock.style.entries]; const cleanup = install();
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 80, 80); expect(dock.style.getPropertyValue('left')).not.toBe('');
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing: false }); view.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    pointer(dock, 'pointerup', 80, 80); expect([...dock.style.entries]).toEqual(original); expect(storage.setItem).not.toHaveBeenCalled(); expect(dock.captures.size).toBe(0); cleanup();
  });
  it.each(['pointercancel', 'lostpointercapture'])('keeps and saves the last shown position when %s ends the drag before a release arrives', (kind) => {
    const { dock, saved, install } = fixture(); const cleanup = install();
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 80, 80); pointer(dock, kind);
    expect(coordinates(dock)).toEqual({ x: 670, y: 746 }); expect(saved.get(key)).toBe('{"x":670,"y":746,"anchor":"end"}'); expect(dock.captures.size).toBe(0);
    pointer(dock, 'pointermove', 200, 200); expect(coordinates(dock)).toEqual({ x: 670, y: 746 }); cleanup();
  });
  it('cancels an active drag before adapting a saved position to a viewport resize', () => {
    const { dock, view, storage, install } = fixture('{"x":600,"y":700}'); const cleanup = install();
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 70, 40);
    view.innerWidth = 400; view.innerHeight = 300; view.dispatchEvent(new Event('resize'));
    expect(coordinates(dock)).toEqual({ x: 96, y: 246 }); expect(dock.captures.size).toBe(0);
    pointer(dock, 'pointerup', 70, 40); expect(storage.setItem).not.toHaveBeenCalled(); cleanup();
  });
  it('defers hidden positioning and adapts on reappearance and width changes without rewriting saved coordinates', () => {
    const { dock, view, storage, saved, install } = fixture('{"x":650,"y":700}'); dock.width = dock.height = 0; const cleanup = install();
    expect(dock.style.entries.size).toBe(0); view.innerWidth = 400; view.dispatchEvent(new Event('resize')); Observer.current.notify();
    expect(dock.style.entries.size).toBe(0); dock.width = 300; dock.height = 50; Observer.current.notify(); expect(coordinates(dock)).toEqual({ x: 96, y: 700 });
    dock.width = 350; Observer.current.notify(); expect(coordinates(dock)).toEqual({ x: 46, y: 700 });
    dock.width = dock.height = 0; view.innerWidth = 100; view.dispatchEvent(new Event('resize')); expect(coordinates(dock)).toEqual({ x: 46, y: 700 });
    expect(saved.get(key)).toBe('{"x":650,"y":700}'); expect(storage.setItem).not.toHaveBeenCalled(); cleanup();
  });
  it('keeps the chosen position when a temporary width change or smaller viewport clamps it', () => {
    const { dock, view, storage, install } = fixture('{"x":650,"y":700}'); const cleanup = install(); expect(coordinates(dock)).toEqual({ x: 650, y: 700 });
    dock.width = 350; Observer.current.notify(); expect(coordinates(dock)).toEqual({ x: 646, y: 700 });
    dock.width = 300; Observer.current.notify(); expect(coordinates(dock)).toEqual({ x: 650, y: 700 });
    view.innerWidth = 500; view.dispatchEvent(new Event('resize')); expect(coordinates(dock)).toEqual({ x: 196, y: 700 });
    view.innerWidth = 1000; view.dispatchEvent(new Event('resize')); expect(coordinates(dock)).toEqual({ x: 650, y: 700 });
    expect(storage.setItem).not.toHaveBeenCalled(); cleanup();
  });
  it('saves the anchor of the spot the collapsed toolbar was dropped on and expanded coordinates that keep that edge', () => {
    const { dock, saved, install } = fixture(); dock.width = 40; const changed = () => {
      // Mirrors the client: a collapsed 40 px toolbar that expands to 300 px keeps its anchored edge.
      const ratio = { start: 0, center: 0.5, end: 1 }[dock.style.getPropertyValue('--nm-anchor')] ?? 0.5; dock.style.setProperty('--nm-shift', `${260 * ratio}px`);
    };
    const cleanup = install(changed);
    pointer(dock, 'pointerdown', 620, 720); pointer(dock, 'pointermove', 20, 720); pointer(dock, 'pointerup', 20, 720);
    expect(saved.get(key)).toBe('{"x":4,"y":700,"anchor":"start"}');
    pointer(dock, 'pointerdown', 20, 720); pointer(dock, 'pointermove', 1000, 720); pointer(dock, 'pointerup', 1000, 720);
    expect(saved.get(key)).toBe('{"x":696,"y":700,"anchor":"end"}');
    pointer(dock, 'pointerdown', 1000, 720); pointer(dock, 'pointermove', 500, 720); pointer(dock, 'pointerup', 500, 720);
    expect(JSON.parse(saved.get(key)!)).toEqual({ x: 326, y: 700, anchor: 'center' }); cleanup();
  });
  it('waits for a running width animation before clamping and places the toolbar when refreshed', () => {
    const { dock, view } = fixture('{"x":650,"y":700,"anchor":"end"}'); let running = true;
    Object.assign(dock, { getAnimations: () => [{ effect: { getKeyframes: () => [running ? { width: '40px' } : { opacity: 1 }] } }] });
    const position = installToolbarPosition(dock as unknown as HTMLElement, { getItem: () => '{"x":650,"y":700,"anchor":"end"}', setItem: () => {} });
    expect(dock.style.entries.size).toBe(0); dock.width = 500; Observer.current.notify(); expect(dock.style.entries.size).toBe(0);
    running = false; position.refresh(); expect(coordinates(dock)).toEqual({ x: 496, y: 700 }); expect(dock.style.getPropertyValue('--nm-anchor')).toBe('end');
    view.dispatchEvent(new Event('resize')); position.detach();
  });
  it('drags from a button by capturing on it and swallows only the click that ends the drag', async () => {
    const { dock, view, saved, install } = fixture(), button = new Surface(view); button.closest = () => button as never; const cleanup = install();
    const click = () => { const event = new Event('click', { cancelable: true }); dock.dispatchEvent(event); return event.defaultPrevented; };
    pointer(dock, 'pointerdown', 10, 10, {}, button); expect(button.captures.has(1)).toBe(true);
    pointer(dock, 'pointerup', 11, 10); expect(click()).toBe(false); expect(dock.style.entries.size).toBe(0);
    const down = pointer(dock, 'pointerdown', 10, 10, {}, button); expect(down.defaultPrevented).toBe(false);
    pointer(dock, 'pointermove', 60, 10); expect(dock.classes.has('dragging')).toBe(true);
    pointer(dock, 'pointerup', 60, 10); expect(dock.classes.has('dragging')).toBe(false); expect(button.captures.size).toBe(0);
    expect(saved.get(key)).toBe('{"x":650,"y":700,"anchor":"end"}'); expect(click()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(click()).toBe(false); cleanup();
  });
  it('does not let denied storage or quota failure stop a completed drag', () => {
    const { dock, storage, install } = fixture(); storage.getItem.mockImplementation(() => { throw new Error('denied'); }); storage.setItem.mockImplementation(() => { throw new Error('quota'); });
    const cleanup = install(); pointer(dock, 'pointerdown'); pointer(dock, 'pointerup', 13, 10);
    expect(coordinates(dock)).toEqual({ x: 603, y: 700 }); expect(storage.setItem).toHaveBeenCalledOnce(); expect(dock.captures.size).toBe(0); cleanup();
  });
  it('cleans up an unfinished gesture, observer and event listeners without persisting it', () => {
    const { dock, view, storage, install } = fixture(); const cleanup = install(); pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 80, 80);
    cleanup(); expect(dock.style.entries.size).toBe(0); expect(dock.captures.size).toBe(0); expect(Observer.current.disconnected).toBe(true);
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 100, 100); pointer(dock, 'pointerup', 100, 100); view.dispatchEvent(new Event('resize')); Observer.current.notify();
    expect(dock.style.entries.size).toBe(0); expect(storage.setItem).not.toHaveBeenCalled();
  });
});


describe('toolbar style position notifications', () => {
  it('notifies after saved placement, live drag and viewport adaptation without changing persistence', () => {
    const { dock, view, storage, install } = fixture('{"x":600,"y":700}');
    const observed: { x: number; y: number }[] = [], changed = vi.fn(() => observed.push(coordinates(dock)));
    const cleanup = install(changed); expect(observed).toEqual([{ x: 600, y: 700 }]);
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 50, -10);
    expect(observed.at(-1)).toEqual({ x: 640, y: 680 }); expect(storage.setItem).not.toHaveBeenCalled();
    pointer(dock, 'pointerup', 50, -10); expect(storage.setItem).toHaveBeenCalledOnce();
    view.innerWidth = 400; view.innerHeight = 300; view.dispatchEvent(new Event('resize'));
    expect(observed.at(-1)).toEqual({ x: 96, y: 246 }); expect(storage.setItem).toHaveBeenCalledOnce(); cleanup();
  });
  it('notifies when cancel restores CSS defaults and stops notifications after cleanup', () => {
    const { dock, view, storage, install } = fixture(), changed = vi.fn(() => dock.style.getPropertyValue('left'));
    const cleanup = install(changed); expect(changed).not.toHaveBeenCalled();
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 80, 80); expect(changed.mock.results.at(-1)?.value).toBe('670px');
    view.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing: false })); expect(changed.mock.results.at(-1)?.value).toBe(''); expect(storage.setItem).not.toHaveBeenCalled();
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 80, 80); cleanup();
    expect(changed.mock.results.at(-1)?.value).toBe(''); const count = changed.mock.calls.length;
    pointer(dock, 'pointerdown'); pointer(dock, 'pointermove', 90, 90); pointer(dock, 'pointerup', 90, 90);
    view.dispatchEvent(new Event('resize')); Observer.current.notify(); expect(changed).toHaveBeenCalledTimes(count);
  });
});
