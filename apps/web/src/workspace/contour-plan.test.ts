// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The plan from below, with no React: the fit, the mapping between the board and the drawing (the plus side is
 * the lower one), the outline and the bands of each kind of contour, the shading along a run, and what a drag
 * of an end or the middle asks for. A tap's place on the board lands on the band drawn there on a board whose
 * sides differ.
 */
import type { BottomFeature, RailsBoard } from '@openshaper/board2';
import { addContour, contourAt, halfWidthFn, setSymmetry } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { sampleRailsBoard } from '../test/rails-board';
import {
  PLAN_GAP,
  PLAN_RULER,
  SHADE_MAX,
  SHADE_MIN,
  bandPaths,
  channelLines,
  depthStops,
  fitPlan,
  grabbedExtent,
  outlinePath,
  planNudge,
  planX,
  planXAt,
  planY,
  planYAt,
  runSamples,
  type HalfWidths,
} from './contour-plan';
import { MAP_PAD } from './rail-map';

const numbers = (d: string): number[] =>
  [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const ys = (d: string): number[] => numbers(d).filter((_, i) => i % 2 === 1);

const kindsOf = async (): Promise<RailsBoard> => {
  let doc = await sampleRailsBoard();
  for (const kind of ['vee', 'single-concave', 'double-concave', 'channels'] as const) {
    doc = addContour(doc, kind);
  }
  return doc;
};
const halves = (doc: RailsBoard): HalfWidths => ({
  plus: halfWidthFn(doc.outline),
  minus: halfWidthFn(doc.outline, 'minus'),
});

describe('the fit', () => {
  it('takes its scale from the width, the rail map’s, and its height from the board', () => {
    const fit = fitPlan(560, 188, 23.5);
    expect(fit.scale).toBeCloseTo((560 - 2 * MAP_PAD) / 188, 9);
    expect(fit.cy).toBeCloseTo(PLAN_RULER + PLAN_GAP + 23.5 * fit.scale, 9);
    expect(fit.height).toBeCloseTo(fit.cy + 23.5 * fit.scale + PLAN_GAP, 9);
    expect(planX(fit, 0)).toBe(MAP_PAD);
    expect(planX(fit, 188)).toBeCloseTo(560 - MAP_PAD, 9);
  });

  it('maps the board to the drawing and back, with the plus side below the stringer', () => {
    const fit = fitPlan(640, 200, 25);
    for (const x of [0, 17.5, 100, 200]) expect(planXAt(fit, planX(fit, x))).toBeCloseTo(x, 9);
    for (const y of [-20, -3, 0, 3, 20]) expect(planYAt(fit, planY(fit, y))).toBeCloseTo(y, 9);
    expect(planY(fit, 5)).toBeGreaterThan(fit.cy);
    expect(planY(fit, -5)).toBeLessThan(fit.cy);
    // a board of no length or no width still has a fit
    expect(fitPlan(10, 0, 0).scale).toBeGreaterThan(0);
  });
});

describe('the outline', () => {
  it('is one closed path: the plus side tail to nose, the minus side back', () => {
    const fit = fitPlan(560, 100, 20);
    const d = outlinePath(fit, [0, 0, 50, 20, 100, 0], [0, 0, 50, 20, 100, 0]);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect((d.match(/L/g) ?? []).length).toBe(5);
    const all = ys(d);
    expect(Math.max(...all)).toBeCloseTo(planY(fit, 20), 0);
    expect(Math.min(...all)).toBeCloseTo(planY(fit, -20), 0);
    expect(outlinePath(fit, [], [])).toBe('');
  });
});

describe('the bands', () => {
  it('are one for each stretch a contour acts over, on each side of the stringer', async () => {
    const doc = await kindsOf();
    const fit = fitPlan(560, 188, 24);
    const half = halves(doc);
    const [vee, single, double, channels] = doc.features as BottomFeature[];
    expect(bandPaths(fit, vee!, half)).toHaveLength(2);
    expect(bandPaths(fit, single!, half)).toHaveLength(2);
    expect(bandPaths(fit, double!, half)).toHaveLength(2);
    expect(bandPaths(fit, channels!, half)).toHaveLength(4); // two channels each side
    for (const f of doc.features) {
      for (const d of bandPaths(fit, f, half)) {
        expect(d.startsWith('M') && d.endsWith('Z')).toBe(true);
        expect(numbers(d).every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('run along the contour’s run and across the stretch it acts over, the plus side below the stringer', async () => {
    const doc = await kindsOf();
    const fit = fitPlan(560, 188, 24);
    const half = halves(doc);
    const single = doc.features[1]!;
    const [plusBand, minusBand] = bandPaths(fit, single, half);
    const keys = single.depth.keys;
    const xsOf = (d: string) => numbers(d).filter((_, i) => i % 2 === 0);
    expect(Math.min(...xsOf(plusBand!))).toBeCloseTo(planX(fit, keys[0]!.s), 0);
    expect(Math.max(...xsOf(plusBand!))).toBeCloseTo(planX(fit, keys[keys.length - 1]!.s), 0);
    // a concave of width 0.7 reaches 0.7 of the half width out on each side
    const mid = (keys[0]!.s + keys[keys.length - 1]!.s) / 2;
    expect(Math.max(...ys(plusBand!))).toBeGreaterThan(planY(fit, 0.6 * half.plus(mid)));
    expect(Math.min(...ys(plusBand!))).toBeGreaterThanOrEqual(fit.cy - 1);
    expect(Math.max(...ys(minusBand!))).toBeLessThanOrEqual(fit.cy + 1);
    expect(Math.min(...ys(minusBand!))).toBeLessThan(planY(fit, -0.6 * half.minus(mid)));
  });

  it('are lines for channels, one for each channel on each side, as thick as they are wide', async () => {
    const doc = await kindsOf();
    const fit = fitPlan(560, 188, 24);
    const half = halves(doc);
    const lines = channelLines(fit, doc.features[3]!, half);
    expect(lines).toHaveLength(4);
    const f = doc.features[3]!;
    expect(lines[0]!.width).toBeCloseTo(
      Math.max(1.5, (f.kind === 'channels' ? f.width : 0) * fit.scale),
      9,
    );
    expect(channelLines(fit, doc.features[0]!, half)).toEqual([]);
    // a channel follows the rail: nearer the stringer where the board is narrower
    const keys = f.depth.keys;
    const first = numbers(lines[0]!.d);
    const xA = keys[0]!.s;
    const xB = (keys[0]!.s + keys[keys.length - 1]!.s) / 2;
    expect(half.plus(xA)).not.toBeCloseTo(half.plus(xB), 1);
    expect(first.length).toBeGreaterThan(50);
  });

  it('lands a tap’s place on the band drawn there, on each side of a board whose sides differ', async () => {
    const base = await sampleRailsBoard();
    const mirror = setSymmetry(base, 'asymmetric');
    // narrow the minus side to four fifths, so the two sides are not the same
    const minus = mirror.outline.minus!;
    const narrow = {
      ...minus,
      knots: minus.knots.map((k) => ({
        ...k,
        p: [k.p[0], k.p[1] * 0.8] as [number, number],
        in: [k.in[0], k.in[1] * 0.8] as [number, number],
        out: [k.out[0], k.out[1] * 0.8] as [number, number],
      })),
    };
    const doc = addContour(
      { ...mirror, outline: { ...mirror.outline, minus: narrow } },
      'single-concave',
    );
    const f = doc.features[0]!;
    const half = halves(doc);
    const keys = f.depth.keys;
    const x = (keys[1]!.s + keys[2]!.s) / 2;
    expect(half.plus(x)).toBeGreaterThan(half.minus(x) + 1);
    const fit = fitPlan(560, 188, half.plus(x));
    const [plusBand, minusBand] = bandPaths(fit, f, half);
    const id = f.id;
    for (const [side, band, other] of [
      ['plus', plusBand!, minusBand!],
      ['minus', minusBand!, plusBand!],
    ] as const) {
      const w = side === 'plus' ? half.plus(x) : half.minus(x);
      const y = (side === 'plus' ? 1 : -1) * 0.6 * w;
      // the tap (x, y, side) is over the contour, and the point it is drawn at is inside that side's band
      expect(contourAt(doc, x, y, side)).toBe(id);
      const py = planY(fit, y);
      expect(py).toBeGreaterThanOrEqual(Math.min(...ys(band)) - 0.5);
      expect(py).toBeLessThanOrEqual(Math.max(...ys(band)) + 0.5);
      // and not inside the other side's
      const outside = py < Math.min(...ys(other)) - 0.5 || py > Math.max(...ys(other)) + 0.5;
      expect(outside, side).toBe(true);
    }
  });
});

describe('the shading', () => {
  it('is the contour’s law along the board: faintest at the ends, strongest where it is deepest', async () => {
    const doc = await kindsOf();
    const stops = depthStops(doc.features[1]!, 16);
    expect(stops).toHaveLength(17);
    expect(stops[0]!.offset).toBe(0);
    expect(stops[16]!.offset).toBe(1);
    expect(stops[0]!.opacity).toBeCloseTo(SHADE_MIN, 6);
    expect(stops[16]!.opacity).toBeCloseTo(SHADE_MIN, 6);
    expect(stops[8]!.opacity).toBeCloseTo(SHADE_MAX, 2);
    for (const s of stops) {
      expect(s.opacity).toBeGreaterThanOrEqual(SHADE_MIN - 1e-9);
      expect(s.opacity).toBeLessThanOrEqual(SHADE_MAX + 1e-9);
    }
    // a contour of no depth is shaded no more than its ends
    const flat = {
      ...doc.features[1]!,
      depth: { keys: doc.features[1]!.depth.keys.map((k) => ({ ...k, value: 0 })) },
    };
    expect(depthStops(flat, 4).every((s) => s.opacity === SHADE_MIN)).toBe(true);
  });

  it('samples a run at even places with both ends in', () => {
    expect(runSamples(10, 20, 5)).toEqual([10, 12, 14, 16, 18, 20]);
  });
});

describe('a drag', () => {
  const start = { from: 40, to: 120, at: 120 };

  it('of an end asks for that end where the pointer is, less how far past it the pointer took hold', () => {
    expect(grabbedExtent('to', 130, { ...start, at: 121 })).toEqual({ to: 129 });
    expect(grabbedExtent('from', 30, { from: 40, to: 120, at: 40 })).toEqual({ from: 30 });
  });

  it('of the middle asks for the run to slide by how far the pointer has gone', () => {
    expect(grabbedExtent('move', 75, { from: 40, to: 120, at: 80 })).toEqual({ from: 35 });
    expect(grabbedExtent('move', 80, { from: 40, to: 120, at: 80 })).toEqual({ from: 40 });
  });

  it('steps by an arrow key a centimetre, ten with Shift', () => {
    expect([planNudge(false), planNudge(true)]).toEqual([1, 10]);
  });
});
