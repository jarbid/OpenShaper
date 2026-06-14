import { describe, expect, it } from 'vitest';
import {
  CSS_PX_PER_CM,
  fitToBounds,
  lifeSizeViewport,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './viewport';

describe('viewport', () => {
  const vp = { scale: 2, originX: 100, originY: 200 };

  it('round-trips world<->screen (y inverted)', () => {
    const p = { x: 30, y: 15 };
    const s = worldToScreen(vp, p);
    expect(s).toEqual({ x: 160, y: 170 });
    const back = screenToWorld(vp, s);
    expect(back.x).toBeCloseTo(30, 9);
    expect(back.y).toBeCloseTo(15, 9);
  });

  it('zoomAt keeps the anchor point fixed', () => {
    const anchor = { x: 160, y: 170 };
    const before = screenToWorld(vp, anchor);
    const z = zoomAt(vp, anchor, 1.5);
    const after = screenToWorld(z, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(z.scale).toBeCloseTo(3, 9);
  });

  it('fitToBounds centers and scales to fit', () => {
    const f = fitToBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 520, 320, 10);
    // width-limited: (520-20)/100 = 5 ; height allows (320-20)/50=6 -> min = 5
    expect(f.scale).toBeCloseTo(5, 9);
    const center = screenToWorld(f, { x: 260, y: 160 });
    expect(center.x).toBeCloseTo(50, 6);
    expect(center.y).toBeCloseTo(25, 6);
  });

  it('pan shifts the origin', () => {
    expect(pan(vp, 10, -5)).toEqual({ scale: 2, originX: 110, originY: 195 });
  });
});

describe('CSS_PX_PER_CM', () => {
  it('equals 96/2.54 (CSS reference pixel density)', () => {
    // CSS defines 1in = 96px; 1in = 2.54cm; therefore 1cm = 96/2.54 px.
    // Physical size accuracy depends on the monitor's actual PPI and is not
    // guaranteed — this is the CSS anchor, not a calibrated physical measurement.
    expect(CSS_PX_PER_CM).toBeCloseTo(96 / 2.54, 9);
  });
});

describe('lifeSizeViewport', () => {
  it('sets scale to CSS_PX_PER_CM', () => {
    const current = { scale: 5, originX: 50, originY: 80 };
    const result = lifeSizeViewport(current, 800, 600);
    expect(result.scale).toBeCloseTo(CSS_PX_PER_CM, 9);
  });

  it('anchors about canvas center: the world point at the canvas center is preserved', () => {
    const canvasW = 800;
    const canvasH = 600;
    const current = { scale: 5, originX: 50, originY: 80 };
    const center = { x: canvasW / 2, y: canvasH / 2 };
    // The world point under the canvas center before the call.
    const worldBefore = screenToWorld(current, center);
    const result = lifeSizeViewport(current, canvasW, canvasH);
    // After the call, the same world point should still project to the canvas center.
    const screenAfter = worldToScreen(result, worldBefore);
    expect(screenAfter.x).toBeCloseTo(center.x, 9);
    expect(screenAfter.y).toBeCloseTo(center.y, 9);
  });

  it('produces the correct origin from a simple starting viewport', () => {
    // vp with world origin (0,0) at screen (100, 200), scale 2.
    const current = { scale: 2, originX: 100, originY: 200 };
    const canvasW = 400;
    const canvasH = 300;
    // Canvas center in screen coords.
    const cx = canvasW / 2; // 200
    const cy = canvasH / 2; // 150
    // World point under canvas center (before zoom).
    const wx = (cx - current.originX) / current.scale; // (200-100)/2 = 50
    const wy = (current.originY - cy) / current.scale; // (200-150)/2 = 25
    // After zoom, that world point should still map to (cx, cy):
    //   cx = originX' + wx * CSS_PX_PER_CM  =>  originX' = cx - wx * CSS_PX_PER_CM
    //   cy = originY' - wy * CSS_PX_PER_CM  =>  originY' = cy + wy * CSS_PX_PER_CM
    const s = CSS_PX_PER_CM;
    const result = lifeSizeViewport(current, canvasW, canvasH);
    expect(result.originX).toBeCloseTo(cx - wx * s, 9);
    expect(result.originY).toBeCloseTo(cy + wy * s, 9);
  });

  it('does not scale by devicePixelRatio — viewport scale is in CSS px', () => {
    // The viewport scale is always in CSS pixels per cm, independent of DPR.
    // The canvas backing-store handles DPR separately (ctx.setTransform(dpr,...)).
    const result = lifeSizeViewport({ scale: 1, originX: 0, originY: 0 }, 640, 480);
    expect(result.scale).toBeCloseTo(CSS_PX_PER_CM, 9);
    // The scale is NOT affected by window.devicePixelRatio (which may be 1, 2, etc.)
    // We can verify it's simply the CSS constant, not CSS_PX_PER_CM * some multiplier.
    expect(result.scale).toBeLessThan(CSS_PX_PER_CM * 1.001);
    expect(result.scale).toBeGreaterThan(CSS_PX_PER_CM * 0.999);
  });
});
