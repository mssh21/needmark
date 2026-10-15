import { describe, expect, it } from 'vitest';
import { captureRegion, captureScale } from './screenshot.js';

const viewport = { width: 1000, height: 800, scrollX: 0, scrollY: 400 };
const page = { width: 1000, height: 5000 };

describe('captureRegion', () => {
  it('keeps the visible viewport when the target fits inside it', () => {
    expect(captureRegion({ x: 10, y: 20, width: 300, height: 200 }, viewport, page)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('covers a target taller than the viewport with a margin', () => {
    expect(captureRegion({ x: 100, y: -300, width: 700, height: 2000 }, viewport, page)).toEqual({ x: 0, y: -348, width: 1000, height: 2096 });
  });

  it('centres a partly scrolled-away target and clamps it to the top of the document', () => {
    expect(captureRegion({ x: 100, y: -380, width: 200, height: 100 }, viewport, page)).toEqual({ x: 0, y: -400, width: 1000, height: 800 });
  });

  it('clamps to the bottom of the document', () => {
    const bottom = { ...viewport, scrollY: 4200 };
    expect(captureRegion({ x: 0, y: 700, width: 200, height: 300 }, bottom, page)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(captureRegion({ x: 0, y: -600, width: 200, height: 1400 }, bottom, page)).toEqual({ x: 0, y: -696, width: 1000, height: 1496 });
  });
});

describe('captureScale', () => {
  it('uses the device pixel ratio for a viewport-sized region', () => {
    expect(captureScale({ x: 0, y: 0, width: 1000, height: 800 }, 2)).toBe(2);
  });

  it('keeps a tall region within the pixel budget', () => {
    const region = { x: 0, y: 0, width: 1280, height: 6000 }, scale = captureScale(region, 2);
    expect(region.width * scale * region.height * scale).toBeLessThanOrEqual(2560 * 2560 + 1);
    expect(region.height * scale).toBeLessThanOrEqual(8192);
  });
});
