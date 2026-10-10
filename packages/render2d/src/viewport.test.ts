import { vec2, type Vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  CSS_PX_PER_CM,
  fitToBounds,
  lifeSizeViewport,
  pan,
  paneToTurnedCanvas,
  reframeForSize,
  screenToWorld,
  turnedCanvasToPane,
  turnFitsLarger,
  viewportCenter,
  viewportFromCenter,
  worldToScreen,
  zoomAt,
  type ScreenPoint,
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

describe('viewportFromCenter / viewportCenter', () => {
  it('places the world center point at the canvas center', () => {
    const vp = viewportFromCenter({ cx: 80, cy: -3, scale: 4 }, 600, 400);
    expect(vp.scale).toBe(4);
    const atCenter = screenToWorld(vp, { x: 300, y: 200 });
    expect(atCenter.x).toBeCloseTo(80, 9);
    expect(atCenter.y).toBeCloseTo(-3, 9);
  });

  it('viewportCenter reports the world point under the canvas center', () => {
    const vp = { scale: 2, originX: 100, originY: 200 };
    const c = viewportCenter(vp, 400, 300);
    expect(c.scale).toBe(2);
    expect(c.cx).toBeCloseTo(50, 9); // (200-100)/2
    expect(c.cy).toBeCloseTo(25, 9); // (200-150)/2
  });

  it('round-trips through a different canvas size (size-independent framing)', () => {
    const original = { scale: 3.5, originX: 42, originY: 77 };
    const c = viewportCenter(original, 800, 600);
    const restored = viewportFromCenter(c, 1024, 512);
    // The same world point sits under the (new) canvas center at the same zoom.
    const atCenter = screenToWorld(restored, { x: 512, y: 256 });
    expect(restored.scale).toBeCloseTo(original.scale, 9);
    expect(atCenter.x).toBeCloseTo(c.cx, 9);
    expect(atCenter.y).toBeCloseTo(c.cy, 9);
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

describe('reframeForSize', () => {
  const vp = { scale: 4, originX: 120, originY: 340 };

  it('holds the world point at the canvas centre and the zoom', () => {
    const before = viewportCenter(vp, 600, 400);
    const after = reframeForSize(vp, 600, 400, 600, 356);
    expect(after.scale).toBe(vp.scale);
    const moved = viewportCenter(after, 600, 356);
    expect(moved.cx).toBeCloseTo(before.cx, 9);
    expect(moved.cy).toBeCloseTo(before.cy, 9);
  });

  it('is a no-op when the size has not changed', () => {
    const after = reframeForSize(vp, 600, 400, 600, 400);
    expect(after.scale).toBeCloseTo(vp.scale, 9);
    expect(after.originX).toBeCloseTo(vp.originX, 9);
    expect(after.originY).toBeCloseTo(vp.originY, 9);
  });

  it('shifts the origin by half the size delta, never re-fitting', () => {
    // Losing a 44px header row moves the centre up by 22px, so everything the
    // viewport draws moves with it by exactly that — no change of zoom.
    const after = reframeForSize(vp, 600, 400, 600, 356);
    expect(after.originX).toBeCloseTo(vp.originX, 9);
    expect(after.originY).toBeCloseTo(vp.originY - 22, 9);
  });
});

describe('turnFitsLarger', () => {
  // A surfboard: 187.96 x 46.99 cm, the sample board the app opens on.
  const board = { minX: 0, minY: -23.495, maxX: 187.96, maxY: 23.495 };

  it('says yes for the phone pane the turn was built for', () => {
    // 334x451, measured off the maximized outline pane at 360x780.
    expect(turnFitsLarger(board, 334, 451)).toBe(true);
  });

  it('says no for a landscape phone pane, where turning costs a factor of three', () => {
    // 818x263. This is the answer that makes the feature safe without a breakpoint:
    // a wide pane already fits the board by its height, so there is nothing to win
    // and a great deal to lose.
    expect(turnFitsLarger(board, 818, 263)).toBe(false);
  });

  it('says no for a desktop pane', () => {
    expect(turnFitsLarger(board, 1200, 600)).toBe(false);
  });

  it('never claims a gain it cannot deliver', () => {
    // The predicate's whole contract: acting on `true` must raise the scale, and
    // acting on `false` must not be leaving one on the table.
    for (const [w, h] of [
      [334, 451],
      [818, 263],
      [400, 400],
      [200, 900],
      [900, 200],
    ] as const) {
      const upright = fitToBounds(board, w, h).scale;
      const turned = fitToBounds(board, h, w).scale;
      expect(turnFitsLarger(board, w, h)).toBe(turned > upright);
    }
  });
});

describe('the turned-pane pointer mapping', () => {
  // `canvasW` is the canvas's own width, which is the pane's height.
  const canvasW = 451;

  it('round-trips', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 334, y: 451 },
      { x: 17, y: 409 },
      { x: 333.5, y: 0.25 },
    ]) {
      const back = turnedCanvasToPane(paneToTurnedCanvas(p, canvasW), canvasW);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('sends the top of the pane to the far end of the canvas', () => {
    // The nose is drawn at the canvas's +x end and must appear at the TOP of the
    // pane, which is what makes the board read nose-up.
    expect(paneToTurnedCanvas({ x: 0, y: 0 }, canvasW)).toEqual({ x: canvasW, y: 0 });
    expect(paneToTurnedCanvas({ x: 0, y: canvasW }, canvasW)).toEqual({ x: 0, y: 0 });
  });

  // Hold R + arrows turns a handle counter-clockwise for ← and ↑ as seen on screen,
  // and does it as a positive angle in board coordinates, with no per-view case. That
  // is one rule for every pane only while no pane shows the board mirrored: board →
  // screen must keep its orientation, turned or not. (The outline's and the section's
  // mirrored halves carry no control points, so they cannot hold a selected handle.)
  it('is a quarter turn, never a reflection: counter-clockwise stays counter-clockwise', () => {
    const vp = { scale: 2, originX: 30, originY: 300 };
    /** Cross product of the screen triangle o-a-b, with y flipped to point up as seen. */
    const seenTurn = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) =>
      (a.x - o.x) * -(b.y - o.y) - -(a.y - o.y) * (b.x - o.x);
    const [o, a, b] = [vec2(0, 0), vec2(1, 0), vec2(0, 1)]; // counter-clockwise in the board
    const upright = (p: Vec2) => worldToScreen(vp, p);
    const turned = (p: Vec2) => turnedCanvasToPane(worldToScreen(vp, p), canvasW);
    expect(seenTurn(upright(o), upright(a), upright(b))).toBeGreaterThan(0);
    expect(seenTurn(turned(o), turned(a), turned(b))).toBeGreaterThan(0);
    // And the turn is the one the docs describe: the board's +x (the nose) points up.
    expect(turned(a).y).toBeLessThan(turned(o).y);
  });

  it('keeps every pane point inside the canvas', () => {
    const paneW = 334;
    for (let x = 0; x <= paneW; x += 37) {
      for (let y = 0; y <= canvasW; y += 41) {
        const c = paneToTurnedCanvas({ x, y }, canvasW);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThanOrEqual(canvasW);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThanOrEqual(paneW);
      }
    }
  });
});
