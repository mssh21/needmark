import { describe, expect, it } from 'vitest';
import { calculatePanelPosition, clampPanelPosition } from './panel-position.js';
import type { Rectangle } from '../shared/types.js';

const viewport = { width: 1000, height: 800 }, size = { width: 350, height: 500 };
const dock = (x: number, y: number, width = 350, height = 50): Rectangle => ({ x, y, width, height });
const overlaps = (position: ReturnType<typeof calculatePanelPosition>, naturalHeight: number, toolbar: Rectangle) => position.x < toolbar.x + toolbar.width && position.x + size.width > toolbar.x && position.y < toolbar.y + toolbar.height && position.y + Math.min(naturalHeight, position.maxHeight) > toolbar.y;

describe('panel placement around the actual toolbar', () => {
  it('keeps the default right margin and places a bottom toolbar below the panel with a twelve-pixel gap', () => {
    const toolbar = dock(632, 732); const position = calculatePanelPosition(size, toolbar, viewport);
    expect(position).toEqual({ x: 632, y: 220, maxHeight: 710, obscureDock: false });
    expect(overlaps(position, size.height, toolbar)).toBe(false);
  });
  it('puts a tall panel below a top toolbar and caps it to the real available strip', () => {
    const toolbar = dock(632, 18), position = calculatePanelPosition({ ...size, height: 900 }, toolbar, viewport);
    expect(position).toEqual({ x: 632, y: 80, maxHeight: 710, obscureDock: false });
    expect(position.y + position.maxHeight).toBe(790);
  });
  it('chooses the larger strip for a middle toolbar and breaks equal strip ties above', () => {
    expect(calculatePanelPosition(size, dock(632, 300), viewport)).toEqual({ x: 632, y: 362, maxHeight: 428, obscureDock: false });
    expect(calculatePanelPosition(size, dock(632, 375), viewport)).toEqual({ x: 632, y: 10, maxHeight: 353, obscureDock: false });
  });
  it('leaves the full height available when the panel is horizontally separate or the toolbar is hidden', () => {
    expect(calculatePanelPosition(size, dock(20, 300), viewport)).toEqual({ x: 632, y: 282, maxHeight: 780, obscureDock: false });
    expect(calculatePanelPosition(size, dock(632, 300, 0, 0), viewport)).toEqual({ x: 632, y: 282, maxHeight: 780, obscureDock: false });
  });
  it('prefers right of an anchor, falls back to its left, and clamps oversized or offscreen anchors', () => {
    const toolbar = dock(850, 730, 140);
    expect(calculatePanelPosition(size, toolbar, viewport, dock(100, 180, 80, 40))).toMatchObject({ x: 192, y: 180 });
    expect(calculatePanelPosition(size, toolbar, viewport, dock(800, 180, 80, 40))).toMatchObject({ x: 438, y: 180 });
    expect(calculatePanelPosition(size, toolbar, viewport, dock(5, -200, 900, 40))).toMatchObject({ x: 10, y: 10 });
  });
  it('temporarily obscures only a colliding toolbar when neither short viewport strip is useful', () => {
    const smallView = { width: 375, height: 240 }, smallSize = { width: 355, height: 600 };
    expect(calculatePanelPosition(smallSize, dock(4, 75, 367, 90), smallView)).toEqual({ x: 10, y: 10, maxHeight: 220, obscureDock: true });
    expect(calculatePanelPosition({ width: 80, height: 600 }, dock(4, 75, 80, 90), smallView)).toEqual({ x: 277, y: 10, maxHeight: 220, obscureDock: false });
  });
  it('recalculates the cap for wrapped toolbars, growing content and resized viewports without mutating preferences', () => {
    const toolbar = Object.freeze(dock(850, 500, 140)), anchor = Object.freeze(dock(700, 520, 60, 40)), originalSize = Object.freeze({ width: 350, height: 200 });
    const small = calculatePanelPosition(originalSize, toolbar, viewport, anchor);
    const large = calculatePanelPosition({ ...originalSize, height: 900 }, toolbar, viewport, anchor);
    expect(small).toEqual({ x: 338, y: 520, maxHeight: 780, obscureDock: false });
    expect(large).toEqual({ x: 338, y: 10, maxHeight: 780, obscureDock: false });
    expect(calculatePanelPosition(size, { ...toolbar, height: 100 }, { width: 1000, height: 620 })).toEqual({ x: 632, y: 10, maxHeight: 478, obscureDock: false });
    expect(toolbar).toEqual(dock(850, 500, 140)); expect(anchor).toEqual(dock(700, 520, 60, 40)); expect(originalSize.height).toBe(200);
  });
  it('keeps an exactly 120px strip usable and obscures the toolbar below that boundary', () => {
    expect(calculatePanelPosition(size, dock(632, 142, 350, 18), { width: 1000, height: 302 })).toEqual({ x: 632, y: 10, maxHeight: 120, obscureDock: false });
    expect(calculatePanelPosition(size, dock(632, 141, 350, 18), { width: 1000, height: 300 })).toEqual({ x: 632, y: 10, maxHeight: 280, obscureDock: true });
  });
  it('restores the unobscured toolbar when a previously too-small viewport grows', () => {
    const toolbar = dock(4, 75, 367, 90);
    expect(calculatePanelPosition({ width: 355, height: 600 }, toolbar, { width: 375, height: 240 }).obscureDock).toBe(true);
    expect(calculatePanelPosition({ width: 355, height: 600 }, toolbar, { width: 375, height: 800 })).toEqual({ x: 10, y: 182, maxHeight: 613, obscureDock: false });
  });
  it('centres a toolbar panel over its button and only drops below when the space above is too short', () => {
    const toolbar = dock(400, 700, 200, 44), button = dock(520, 706, 32, 32);
    expect(calculatePanelPosition(size, toolbar, { width: 1000, height: 800 }, undefined, button)).toEqual({ x: 361, y: 188, maxHeight: 678, obscureDock: false });
    expect(calculatePanelPosition(size, dock(400, 10, 200, 44), { width: 1000, height: 800 }, undefined, dock(970, 16, 32, 32))).toEqual({ x: 640, y: 66, maxHeight: 724, obscureDock: false });
  });
});

describe('a panel the user moved', () => {
  it('stays where it was dropped while it fits and is pushed back inside the viewport otherwise', () => {
    expect(clampPanelPosition({ x: 120, y: 80 }, size, viewport)).toEqual({ x: 120, y: 80, maxHeight: 780, obscureDock: false });
    expect(clampPanelPosition({ x: -50, y: 600 }, size, viewport)).toEqual({ x: 10, y: 290, maxHeight: 780, obscureDock: false });
    expect(clampPanelPosition({ x: 900, y: 40 }, { ...size, height: 1200 }, viewport)).toEqual({ x: 640, y: 10, maxHeight: 780, obscureDock: false });
  });
});
