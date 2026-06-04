/**
 * draw.ts exports two categories of symbols:
 *  - Pure data: `defaultStyle`, `DrawStyle` (testable without a canvas).
 *  - Canvas-bound functions: `drawSpline`, `drawControlPoints`, `clear`.
 *
 * The canvas-bound functions call CanvasRenderingContext2D methods; we test them
 * with a minimal stub that records calls, without needing a real canvas / jsdom.
 * `defaultStyle` is tested as a pure value.
 */
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { describe, expect, it, vi } from 'vitest';
import {
  clear,
  defaultStyle,
  drawControlPoints,
  drawCurvatureComb,
  drawGrid,
  drawMeasureCursor,
  drawSpline,
  gridStep,
} from './draw';
import type { Vec2 } from '@openshaper/kernel';
import type { Viewport } from './viewport';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CanvasRenderingContext2D stub that records path/draw calls. */
function makeCtx() {
  const calls: string[] = [];
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    beginPath: vi.fn(() => calls.push('beginPath')),
    moveTo: vi.fn((_x: number, _y: number) => calls.push('moveTo')),
    lineTo: vi.fn((_x: number, _y: number) => calls.push('lineTo')),
    stroke: vi.fn(() => calls.push('stroke')),
    arc: vi.fn(() => calls.push('arc')),
    fill: vi.fn(() => calls.push('fill')),
    fillRect: vi.fn(() => calls.push('fillRect')),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const VP: Viewport = { scale: 2, originX: 100, originY: 200 };

const makeSpline = () =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
    knot(vec2(50, 0), vec2(40, 0), vec2(60, 0)),
    knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
  ]);

// ---------------------------------------------------------------------------
// defaultStyle
// ---------------------------------------------------------------------------

describe('defaultStyle', () => {
  it('is a valid style object with all required fields', () => {
    expect(defaultStyle.curve).toBeTruthy();
    expect(defaultStyle.handleLine).toBeTruthy();
    expect(defaultStyle.point).toBeTruthy();
    expect(defaultStyle.pointSelected).toBeTruthy();
    expect(defaultStyle.tangent).toBeTruthy();
    expect(defaultStyle.curveWidth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('calls fillRect with the provided dimensions', () => {
    const { ctx, calls } = makeCtx();
    clear(ctx, 800, 600);
    expect(calls).toContain('fillRect');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
  });

  it('sets fillStyle to the default background', () => {
    const { ctx } = makeCtx();
    clear(ctx, 100, 100);
    expect(ctx.fillStyle).toBe('#0A1424');
  });

  it('accepts a custom background color', () => {
    const { ctx } = makeCtx();
    clear(ctx, 100, 100, '#ff0000');
    expect(ctx.fillStyle).toBe('#ff0000');
  });
});

// ---------------------------------------------------------------------------
// drawSpline
// ---------------------------------------------------------------------------

describe('drawSpline', () => {
  it('calls beginPath + moveTo + lineTo sequence for a 2-segment spline', () => {
    const { ctx, calls } = makeCtx();
    drawSpline(ctx, makeSpline(), VP, defaultStyle);
    expect(calls).toContain('beginPath');
    expect(calls).toContain('moveTo');
    expect(calls).toContain('lineTo');
    expect(calls).toContain('stroke');
  });

  it('draws two paths when mirrorY is true', () => {
    const { ctx } = makeCtx();
    drawSpline(ctx, makeSpline(), VP, defaultStyle, { mirrorY: true });
    // Two beginPath calls: one for the original, one for the mirror
    expect(ctx.beginPath).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
  });

  it('draws two paths when mirrorX is true', () => {
    const { ctx } = makeCtx();
    drawSpline(ctx, makeSpline(), VP, defaultStyle, { mirrorX: true });
    expect(ctx.beginPath).toHaveBeenCalledTimes(2);
  });

  it('draws three paths when both mirrorX and mirrorY are true (identity + one per axis)', () => {
    // reflections() = [identity, flipY?, flipX?] — there is no diagonal (-x,-y)
    // quadrant, so enabling both axes yields 3 strokes, not 4. (In the app a given
    // editor only ever enables one axis; both-true is just the documented edge case.)
    const { ctx } = makeCtx();
    drawSpline(ctx, makeSpline(), VP, defaultStyle, { mirrorX: true, mirrorY: true });
    expect(ctx.beginPath).toHaveBeenCalledTimes(3);
  });

  it('draws nothing for a zero-segment (single-knot) spline', () => {
    const { ctx, calls } = makeCtx();
    const s = splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]);
    drawSpline(ctx, s, VP, defaultStyle);
    expect(calls).not.toContain('stroke');
  });
});

// ---------------------------------------------------------------------------
// drawControlPoints
// ---------------------------------------------------------------------------

describe('drawControlPoints', () => {
  it('draws arcs for all knot endpoints and tangent handles', () => {
    const { ctx } = makeCtx();
    const s = makeSpline(); // 3 knots
    drawControlPoints(ctx, s, VP, defaultStyle, null);
    // Each knot: 2 tangent arcs + 1 endpoint arc = 3 arcs × 3 knots = 9
    expect(ctx.arc).toHaveBeenCalledTimes(9);
    expect(ctx.fill).toHaveBeenCalledTimes(9);
  });

  it('does not throw when selectedIndex is out of range', () => {
    const { ctx } = makeCtx();
    expect(() => drawControlPoints(ctx, makeSpline(), VP, defaultStyle, 99)).not.toThrow();
  });

  it('draws handle lines between tangent handles and endpoints', () => {
    const { ctx } = makeCtx();
    drawControlPoints(ctx, makeSpline(), VP, defaultStyle, null);
    // 3 knots × 1 line per knot (prev-end-next) → 3 stroke() calls
    expect(ctx.stroke).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// drawCurvatureComb
// ---------------------------------------------------------------------------

/** Records the (x,y) of every moveTo/lineTo so quill geometry can be inspected. */
function makeRecordingCtx() {
  const moves: { x: number; y: number }[] = [];
  const lines: { x: number; y: number }[] = [];
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    beginPath: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => moves.push({ x, y })),
    lineTo: vi.fn((x: number, y: number) => lines.push({ x, y })),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, moves, lines };
}

describe('drawCurvatureComb', () => {
  // An arc-like outline half (half-width vs length): the bounding-box centroid is
  // below the curve, so an outward-blooming comb puts quill tips ABOVE the curve.
  const arc = () =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 8)),
      knot(vec2(50, 20), vec2(35, 20), vec2(65, 20)),
      knot(vec2(100, 0), vec2(90, 8), vec2(100, 0)),
    ]);

  it('runs without throwing and emits quill segments', () => {
    const { ctx, moves } = makeRecordingCtx();
    expect(() => drawCurvatureComb(ctx, arc(), VP)).not.toThrow();
    expect(ctx.stroke).toHaveBeenCalled();
    expect(moves.length).toBeGreaterThan(0);
  });

  it('blooms outward: tips sit on the far side of the curve from its centroid', () => {
    // VP has y-down screen mapping, so "above the curve in world" => smaller screen y.
    // Compare each quill base (moveTo, on the curve) to its tip (lineTo): with the
    // centroid below, outward tips should be above (screen y_tip <= y_base) for the
    // vast majority of non-flat samples.
    const { ctx, moves, lines } = makeRecordingCtx();
    drawCurvatureComb(ctx, arc(), VP, '#38BDF8', 14);
    // The first pts.length moveTo/lineTo pairs are the quills (envelope adds only lineTo).
    const n = Math.min(moves.length, lines.length);
    let outward = 0;
    let counted = 0;
    for (let i = 0; i < n; i++) {
      const dy = lines[i]!.y - moves[i]!.y;
      if (Math.abs(dy) < 1e-6) continue; // flat sample, no quill
      counted++;
      if (dy <= 0) outward++; // tip above base in screen space => outward
    }
    expect(counted).toBeGreaterThan(0);
    expect(outward).toBeGreaterThan(counted * 0.8);
  });

  it('adapts sample count to on-screen length (more quills when zoomed in)', () => {
    const zoomedOut = makeRecordingCtx();
    drawCurvatureComb(zoomedOut.ctx, arc(), { scale: 0.5, originX: 0, originY: 0 });
    const zoomedIn = makeRecordingCtx();
    drawCurvatureComb(zoomedIn.ctx, arc(), { scale: 8, originX: 0, originY: 0 });
    expect(zoomedIn.moves.length).toBeGreaterThan(zoomedOut.moves.length);
  });
});

// ---------------------------------------------------------------------------
// gridStep / drawGrid
// ---------------------------------------------------------------------------

describe('gridStep', () => {
  it('rounds up to a nice 1 / 2 / 5 × 10ᵏ value', () => {
    expect(gridStep(1)).toBe(1);
    expect(gridStep(1.5)).toBe(2);
    expect(gridStep(3)).toBe(5);
    expect(gridStep(7)).toBe(10);
    expect(gridStep(0.4)).toBeCloseTo(0.5, 9);
    expect(gridStep(40)).toBe(50);
  });

  it('returns 0 for non-finite or non-positive input', () => {
    expect(gridStep(0)).toBe(0);
    expect(gridStep(-5)).toBe(0);
    expect(gridStep(Number.NaN)).toBe(0);
    expect(gridStep(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('drawGrid', () => {
  /** Grid needs save/restore in addition to the path methods. */
  function makeGridCtx() {
    const moves: { x: number; y: number }[] = [];
    const ctx = {
      strokeStyle: '',
      lineWidth: 0,
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => moves.push({ x, y })),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, moves };
  }

  it('emits grid lines spanning the canvas and balances save/restore', () => {
    const { ctx, moves } = makeGridCtx();
    drawGrid(ctx, VP, 800, 600);
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
    expect(moves.length).toBeGreaterThan(0);
  });

  it('draws more lines when zoomed in (nice-stepped, not unbounded)', () => {
    const zoomedOut = makeGridCtx();
    drawGrid(zoomedOut.ctx, { scale: 1, originX: 400, originY: 300 }, 800, 600);
    const zoomedIn = makeGridCtx();
    drawGrid(zoomedIn.ctx, { scale: 10, originX: 400, originY: 300 }, 800, 600);
    expect(zoomedIn.moves.length).toBeGreaterThanOrEqual(zoomedOut.moves.length);
    // Bounded: a 64px target cell over an 800×600 canvas can't produce hundreds of lines.
    expect(zoomedIn.moves.length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// drawMeasureCursor
// ---------------------------------------------------------------------------

describe('drawMeasureCursor', () => {
  function makeCursorCtx() {
    const moves: { x: number; y: number }[] = [];
    const dashes: number[][] = [];
    const ctx = {
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn((d: number[]) => dashes.push([...d])),
      beginPath: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => moves.push({ x, y })),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, moves, dashes };
  }

  // A 4×4 square centred on the origin (a stand-in closed cross-section outline).
  const square: Vec2[] = [
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: -2, y: 2 },
  ];

  it('emits a dashed full-extent line + a solid inside segment for each axis', () => {
    const { ctx, moves, dashes } = makeCursorCtx();
    // Cursor at the centre is inside the square, so each probe has one inside span.
    drawMeasureCursor(ctx, square, { scale: 10, originX: 100, originY: 100 }, 200, 200, {
      x: 0,
      y: 0,
    });
    // 2 dashed full lines (V + H) + 2 solid inside segments (V + H) = 4 moveTo.
    expect(moves.length).toBe(4);
    // Both a dashed pass ([4,4]) and a solid pass ([]) happened.
    expect(dashes.some((d) => d.length === 2)).toBe(true);
    expect(dashes.some((d) => d.length === 0)).toBe(true);
    // Composed of a vertical + horizontal probe, each balancing its own save/restore.
    expect(ctx.save).toHaveBeenCalledTimes(2);
    expect(ctx.restore).toHaveBeenCalledTimes(2);
  });

  it('draws only the dashed guides (no inside segment) when the cursor is outside', () => {
    const { ctx, moves } = makeCursorCtx();
    // x=10 is right of the square → the vertical probe has no crossings, so no solid
    // vertical segment; the horizontal probe at y=10 is also fully outside.
    drawMeasureCursor(ctx, square, { scale: 10, originX: 100, originY: 100 }, 200, 200, {
      x: 10,
      y: 10,
    });
    // Just the 2 dashed full-extent guides.
    expect(moves.length).toBe(2);
  });

  it('does nothing for a degenerate profile', () => {
    const { ctx, moves } = makeCursorCtx();
    drawMeasureCursor(ctx, [{ x: 0, y: 0 }], { scale: 1, originX: 0, originY: 0 }, 100, 100, {
      x: 0,
      y: 0,
    });
    expect(moves.length).toBe(0);
    expect(ctx.save).not.toHaveBeenCalled();
  });
});
