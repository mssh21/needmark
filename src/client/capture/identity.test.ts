import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCaptureSnapshot, captureViewport, createCaptureGuard, rectanglesMatch, type CaptureSnapshot } from './identity.js';
import type { ElementContext, FeedbackInput, Rectangle } from '../../shared/types.js';

const rect = { x: 20.25, y: 30.75, width: 100, height: 80 };
const viewport = { width: 1000, height: 800, devicePixelRatio: 2, scrollX: 15.25, scrollY: 80.75 };
const url = 'http://localhost:4192/?review=1#details';
const error = '選択した対象が変わりました。画像なしで保存するか、場所を選び直してください。';
function browser() {
  const view = { innerWidth: viewport.width, innerHeight: viewport.height, devicePixelRatio: viewport.devicePixelRatio, scrollX: viewport.scrollX, scrollY: viewport.scrollY };
  const location = { href: url }; vi.stubGlobal('window', view); vi.stubGlobal('location', location);
  return { view, location };
}
function context(selector: string): ElementContext {
  return { tag: 'button', selector, text: 'Review item', rect: { ...rect }, attributes: { id: selector.slice(1) }, styles: { color: 'rgb(0, 0, 0)' }, headings: ['Review'], components: ['ProductCard'], rootPath: ['shadow: #content'] };
}
const target = (extra: Partial<FeedbackInput['target']> = {}): FeedbackInput['target'] => ({ kind: 'area', text: '', selector: '', rect: { ...rect }, ...extra });
afterEach(() => { vi.unstubAllGlobals(); });

describe('capture geometry tolerance', () => {
  it.each(['x', 'y', 'width', 'height'] as const)('accepts half-pixel %s drift and rejects larger drift symmetrically', (key) => {
    for (const delta of [-0.5, 0.5]) {
      const nearby = { ...rect, [key]: rect[key] + delta };
      expect(rectanglesMatch(rect, nearby)).toBe(true); expect(rectanglesMatch(nearby, rect)).toBe(true);
    }
    for (const delta of [-0.50001, 0.50001]) expect(rectanglesMatch(rect, { ...rect, [key]: rect[key] + delta })).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite coordinates even when both snapshots contain them', (value) => {
    expect(rectanglesMatch({ ...rect, x: value }, { ...rect, x: value })).toBe(false);
    expect(rectanglesMatch(rect, { ...rect, height: value })).toBe(false);
  });
  it('keeps fractional viewport and scroll coordinates without integer coercion', () => {
    browser(); expect(captureViewport()).toEqual(viewport);
  });
});

describe('snapshot commit', () => {
  it('updates target and every original context rectangle while preserving enriched source objects', () => {
    const first = context('#first'), later = context('#thirteenth');
    const source = { file: 'src/ProductCard.tsx', line: 12, column: 4, component: 'ProductCard' };
    const code = { elements: [first, later], truncated: true };
    const input = target({ kind: 'multi', code });
    const capturedRect: Rectangle = { x: 50, y: 60, width: 300, height: 200 };
    const snapshot: CaptureSnapshot = { rect: capturedRect, viewport: { ...viewport }, capturedAt: '2026-10-06T10:00:00.000Z', url,
      geometry: [{ context: first, rect: { ...rect, x: 60 } }, { context: later, rect: { ...rect, x: 90 } }] };
    // An asynchronous source lookup may enrich the same context after sampling.
    first.source = source; first.sourceOrigin = 'runtime'; first.sourceRelation = 'self';
    const styles = first.styles, attributes = first.attributes, roots = first.rootPath;
    applyCaptureSnapshot(input, snapshot);
    expect(input.rect).toEqual(capturedRect); expect(first.rect.x).toBe(60); expect(later.rect.x).toBe(90);
    expect(input.code).toBe(code); expect(code.elements).toEqual([first, later]);
    expect(first.source).toBe(source); expect(first.sourceOrigin).toBe('runtime'); expect(first.sourceRelation).toBe('self');
    expect(first.styles).toBe(styles); expect(first.attributes).toBe(attributes); expect(first.rootPath).toBe(roots);
    capturedRect.x = 999; snapshot.geometry[0]!.rect.x = 999;
    expect(input.rect.x).toBe(50); expect(first.rect.x).toBe(60);
  });
});

describe('geometric region guards', () => {
  it('allows an empty fixed region without retargeting it or changing evidence before image acceptance', () => {
    browser(); const input = target({ code: { elements: [], truncated: false } }), guard = createCaptureGuard(input);
    const initial = input.rect; const snapshot = guard.prepare(); guard.validate(snapshot);
    expect(snapshot.rect).toEqual(rect); expect(snapshot.rect).not.toBe(initial); expect(snapshot.geometry).toEqual([]);
    expect(snapshot.viewport).toEqual(viewport); expect(snapshot.url).toBe(url); expect(Number.isNaN(Date.parse(snapshot.capturedAt))).toBe(false);
    expect(input.rect).toBe(initial);
  });
  it.each(['innerWidth', 'innerHeight', 'devicePixelRatio', 'scrollX', 'scrollY'] as const)('rejects %s drift without allowing an explicit fixed region to rebase', (key) => {
    const { view } = browser(), guard = createCaptureGuard(target()), snapshot = guard.prepare(); view[key] += 1;
    expect(() => guard.validate(snapshot)).toThrow(error); expect(() => guard.prepare()).toThrow(error);
  });
  it('rejects route drift before or after acquisition while preserving the selected rectangle', () => {
    const { location } = browser(), input = target(), guard = createCaptureGuard(input), snapshot = guard.prepare();
    location.href = 'http://localhost:4192/?review=2#details';
    expect(() => guard.validate(snapshot)).toThrow(error); expect(() => guard.prepare()).toThrow(error); expect(input.rect).toEqual(rect);
  });
  it.each(['element', 'multi', 'text'] as const)('keeps a missing %s live anchor as a recoverable prepare failure rather than a composer creation failure', (kind) => {
    browser(); let guard: ReturnType<typeof createCaptureGuard> | undefined;
    expect(() => { guard = createCaptureGuard(target({ kind })); }).not.toThrow(); expect(() => guard!.prepare()).toThrow(error);
  });
});
