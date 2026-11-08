// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import {
  boundsToView,
  dragTo,
  guidePointAt,
  guideValueAt,
  pickGuide,
  fromView,
  layersBounds,
  pickCurve,
  pickHandle,
  splineToView,
  toView,
  type FinCurveGuide,
  type FinCurveLayer,
  type ViewMap,
} from './fin-curve-view';
import { worldToScreen, type Viewport } from './viewport';

// A straight line (0,0) → (10,0) with handles at thirds, and an arch above it.
const line = splineFromKnots([
  knot(vec2(0, 0), vec2(0, 0), vec2(10 / 3, 0), false),
  knot(vec2(10, 0), vec2(20 / 3, 0), vec2(10, 0), false),
]);
const arch = splineFromKnots([
  knot(vec2(0, 0), vec2(0, 0), vec2(2, 4), false),
  knot(vec2(10, 0), vec2(8, 4), vec2(10, 0), false),
]);
const vp: Viewport = { scale: 20, originX: 50, originY: 300 };
const at = (p: { x: number; y: number }, yScale = 1) => worldToScreen(vp, toView(p, yScale));

const layers = (over: Partial<FinCurveLayer> = {}): FinCurveLayer[] => [
  { id: 'line', spline: line, editable: true },
  { id: 'arch', spline: arch, editable: true, ...over },
];

describe('view space', () => {
  it('stretches y and back', () => {
    const p = vec2(3, 0.25);
    expect(fromView(toView(p, 4), 4)).toEqual(p);
    expect(splineToView(line, 1)).toBe(line); // no copy when unstretched
    expect(splineToView(arch, 3).knots[0]!.tangentToNext).toEqual(vec2(2, 12));
  });

  // The taper's map: data (fraction of depth, thickness) to view (thickness × 4 across,
  // fraction × 10 up).
  const upright: ViewMap = { a: 0, b: 4, c: 10, d: 0 };

  it('swaps the axes and back', () => {
    const p = vec2(0.3, 0.6);
    expect(toView(p, upright)).toEqual(vec2(2.4, 3));
    const back = fromView(toView(p, upright), upright);
    expect(back.x).toBeCloseTo(p.x, 15);
    expect(back.y).toBeCloseTo(p.y, 15);
  });

  it('maps bounds through a swap', () => {
    expect(boundsToView({ minX: 0, maxX: 1, minY: -0.1, maxY: 0.8 }, upright)).toEqual({
      minX: -0.4,
      maxX: 3.2,
      minY: 0,
      maxY: 10,
    });
  });

  it('picks and drags a handle through a swap, in data space', () => {
    // The arch's first forward handle (2, 4) is drawn at view (16, 20).
    const s = worldToScreen(vp, toView(vec2(2, 4), upright));
    expect(pickHandle(layers(), vp, s, upright, 8)).toEqual({
      layer: 'arch',
      index: 0,
      kind: 'next',
    });
    const to = fromView(dragTo(vec2(16, 20), vec2(16, 20), vec2(18, 25)), upright);
    expect(to.x).toBeCloseTo(2.5, 12); // 5 view units up is 0.5 of the fraction axis
    expect(to.y).toBeCloseTo(4.5, 12); // 2 across is 0.5 of thickness
  });
});

describe('pickHandle', () => {
  it('finds the handle under the pointer, within the radius', () => {
    const s = at(vec2(10, 0));
    expect(pickHandle(layers(), vp, { x: s.x + 5, y: s.y }, 1, 8)).toEqual({
      layer: 'arch', // on top, and its end is at the same spot as the line's
      index: 1,
      kind: 'end',
    });
    expect(pickHandle(layers(), vp, { x: s.x + 12, y: s.y }, 1, 8)).toBeNull();
    expect(pickHandle(layers(), vp, { x: s.x + 12, y: s.y }, 1, 22)).not.toBeNull();
  });

  it('ignores layers that are not editable', () => {
    const s = at(vec2(2, 4));
    expect(pickHandle(layers({ editable: false }), vp, s, 1, 8)).toBeNull();
    expect(pickHandle(layers(), vp, s, 1, 8)).toEqual({ layer: 'arch', index: 0, kind: 'next' });
  });

  it('works in stretched view space', () => {
    const s = at(vec2(2, 4), 3);
    expect(pickHandle(layers(), vp, s, 3, 8)).toEqual({ layer: 'arch', index: 0, kind: 'next' });
  });

  it('prefers the current selection where handles overlap', () => {
    const s = at(vec2(0, 0));
    const line0 = { layer: 'line', index: 0, kind: 'end' as const };
    expect(pickHandle(layers(), vp, s, 1, 8, line0)).toEqual(line0);
  });
});

describe('pickCurve', () => {
  it('returns the nearest point on a curve, in data space', () => {
    const s = at(vec2(5, 0));
    const hit = pickCurve([layers()[0]!], vp, { x: s.x, y: s.y - 3 }, 1, 8)!;
    expect(hit.layer).toBe('line');
    expect(hit.point.x).toBeCloseTo(5, 6);
    expect(hit.point.y).toBeCloseTo(0, 9);
  });

  it('misses beyond the radius', () => {
    const s = at(vec2(5, 0));
    expect(pickCurve([layers()[0]!], vp, { x: s.x, y: s.y - 30 }, 1, 8)).toBeNull();
  });
});

describe('dragTo', () => {
  it('moves by the pointer’s travel, not to the pointer', () => {
    // Grabbed 0.3 off-centre; the pointer travels (1, 2).
    const to = dragTo(vec2(5, 5), vec2(5.3, 4.8), vec2(6.3, 6.8));
    expect(to.x).toBeCloseTo(6, 12);
    expect(to.y).toBeCloseTo(7, 12);
  });
});

describe('layersBounds', () => {
  it('covers every layer, stretched, plus any extra', () => {
    const b = layersBounds(layers(), 2, { minX: -1, minY: -5, maxX: 1, maxY: 0 })!;
    expect(b.minX).toBe(-1);
    expect(b.maxX).toBe(10);
    expect(b.minY).toBe(-5);
    expect(b.maxY).toBeCloseTo(6, 6); // the arch peaks at 3, stretched ×2
  });
});

describe('guides', () => {
  const level: FinCurveGuide = { id: 'a', axis: 'y', at: 2 };
  const upright: ViewMap = { a: 0, b: 4, c: 10, d: 0 };
  const across: FinCurveGuide = { id: 'b', axis: 'x', at: 0.5 }; // taper: fraction 0.5

  it('picks a level guide anywhere along it, within the tolerance', () => {
    const s = at(vec2(7, 2));
    expect(pickGuide([level], vp, { x: s.x, y: s.y + 5 }, 1, 8)).toBe(level);
    expect(pickGuide([level], vp, { x: s.x + 300, y: s.y - 5 }, 1, 8)).toBe(level);
    expect(pickGuide([level], vp, { x: s.x, y: s.y + 12 }, 1, 8)).toBeNull();
  });

  it('reads a dragged guide back in data space, through a stretch or a swap', () => {
    expect(guideValueAt(level, vp, at(vec2(3, 2.5)), 1)).toBeCloseTo(2.5, 12);
    expect(guideValueAt(level, vp, at(vec2(3, 2.5), 4), 4)).toBeCloseTo(2.5, 12);
    // Upright taper: the fraction runs up the view, so a guide on it is level on screen.
    const s = worldToScreen(vp, toView(vec2(0.7, 0.2), upright));
    expect(guideValueAt(across, vp, s, upright)).toBeCloseTo(0.7, 12);
    const on = worldToScreen(vp, toView(vec2(0.5, 0.3), upright));
    expect(pickGuide([across], vp, { x: on.x + 200, y: on.y + 3 }, upright, 8)).toBe(across);
  });

  it('picks a curved guide along its line only, and reads where it is dragged to', () => {
    const arc: FinCurveGuide = {
      id: '2',
      axis: 'y',
      at: 0,
      path: [vec2(0, 1), vec2(2, 2), vec2(4, 2.5), vec2(6, 2)],
    };
    const on = at(vec2(3, 2.25));
    expect(pickGuide([arc], vp, { x: on.x, y: on.y + 3 }, 1, 8)).toBe(arc);
    // Level with it but far beyond its end: not on it, unlike a level guide.
    const off = at(vec2(9, 2));
    expect(pickGuide([arc], vp, off, 1, 8)).toBeNull();
    const p = guidePointAt(vp, at(vec2(3.5, 1.25)), 1);
    expect(p.x).toBeCloseTo(3.5, 12);
    expect(p.y).toBeCloseTo(1.25, 12);
  });
});
