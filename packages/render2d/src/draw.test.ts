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
import { clear, defaultStyle, drawControlPoints, drawCurvatureComb, drawSpline } from './draw';
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
