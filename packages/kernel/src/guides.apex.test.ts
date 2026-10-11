// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail apex line (Phase 0, item 0.6): each station's widest point, found on the
 * ring the mesh draws there.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  board,
  getLength,
  getRockerAtPos,
  getThicknessAtPos,
  getWidthAtPos,
  type BezierBoard,
} from './board';
import { splineFromKnots } from './bezier-spline';
import { crossSection } from './cross-section';
import {
  APEX_PLATEAU,
  apexLine,
  crossSectionLoops,
  crossSectionRing,
  railApex,
  type GuidePoint,
} from './guides';
import { knotFromArray } from './knot';
import { ringHalf } from './loft';
import { CUTOUT_EPS, cachedOutlineSegments, yInOut } from './outline-cutout';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { domedDeckSection } from './test-support/rail-sections';
import { polylineSpline } from './test-support/synthetic-boards';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

const shortboard = loadBoard('shortboard');

const LENGTH_STEPS = 40;
const RING_STEPS = 24;
/** Points per mesh ring at RING_STEPS — see the matching note in `guides.test.ts`. */
const RING_LEN = 22;

/** Shortest distance from `p` to the polyline through `pts` (closed when asked). */
const distToPolyline = (p: GuidePoint, pts: readonly GuidePoint[], closed = false): number => {
  let best = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
    const t =
      len2 > 0
        ? Math.max(
            0,
            Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / len2),
          )
        : 0;
    best = Math.min(
      best,
      Math.hypot(p.x - a.x - ab.x * t, p.y - a.y - ab.y * t, p.z - a.z - ab.z * t),
    );
  }
  return best;
};

const widestIndex = (rail: readonly GuidePoint[]): number => {
  let best = 0;
  for (let i = 1; i < rail.length; i++) if (rail[i]!.y > rail[best]!.y) best = i;
  return best;
};

/** A straight-railed board carrying the same section `profile` at every station. */
const prismBoard = (
  halfWidth: number,
  thickness: number,
  rockerSlope: number,
  profile: ReturnType<typeof polylineSpline>,
): BezierBoard =>
  // prettier-ignore
  board(
    polylineSpline([
      [0, halfWidth],
      [100, halfWidth],
    ]),
    polylineSpline([
      [0, 0],
      [100, rockerSlope * 100],
    ]),
    polylineSpline([
      [0, thickness],
      [100, rockerSlope * 100 + thickness],
    ]),
    [crossSection(0, profile), crossSection(50, profile), crossSection(100, profile)],
    'controlPoint',
  );

describe('railApex', () => {
  /**
   * The no-drift pin, as `guides.test.ts` has it for rings: the station is read out of
   * the mesh, and the apex must lie on that mesh ring's own polyline to a micron — on
   * the faceted hull the viewer actually sees, not merely near the smooth surface.
   */
  it('lies on the tessellated mesh ring at a station read from the mesh', () => {
    const mesh = tessellateBoard(shortboard, { lengthSteps: LENGTH_STEPS, ringSteps: RING_STEPS });
    for (const r of [3, 12, 20, 31, 37]) {
      const base = r * RING_LEN * 3;
      const ring: GuidePoint[] = [];
      for (let i = 0; i < RING_LEN; i++) {
        const o = base + i * 3;
        ring.push({ x: mesh.positions[o]!, y: mesh.positions[o + 1]!, z: mesh.positions[o + 2]! });
      }
      const apex = railApex(shortboard, ring[0]!.x, RING_STEPS);
      expect(apex).not.toBeNull();
      // 4 decimal places = 1 micron; the mesh buffer is float32.
      expect(distToPolyline(apex!, ring, true)).toBeLessThan(1e-4);
    }
  });

  it('is the widest point of the ring: on an edge of its widest vertex, never wider', () => {
    for (const ringSteps of [RING_STEPS, 120]) {
      const half = ringHalf(ringSteps);
      for (const x of [20, 60, 95, 140, 170]) {
        const rail = crossSectionRing(shortboard, x, ringSteps)!.slice(0, half);
        const i = widestIndex(rail);
        const apex = railApex(shortboard, x, ringSteps)!;
        const edges = rail.slice(Math.max(0, i - 1), Math.min(half, i + 2));
        expect(distToPolyline(apex, edges)).toBeLessThan(1e-9);
        expect(apex.y).toBeLessThanOrEqual(rail[i]!.y + 1e-9);
      }
    }
    // On a fine ring that leaves it within a few microns of the widest vertex.
    const rail = crossSectionRing(shortboard, 95, 400)!.slice(0, ringHalf(400));
    expect(railApex(shortboard, 95, 400)!.y).toBeGreaterThan(rail[widestIndex(rail)]!.y - 1e-3);
  });

  it('finds a round rail’s apex between vertices rather than snapping to one', () => {
    // A circular rail of radius 3 under a domed deck: the apex is exactly (20, 3), and
    // the dome makes the ring's vertices asymmetric about it, so no vertex lands there.
    const W = 20;
    const R = 3;
    const b = prismBoard(W, 2 * R + 2, 0, domedDeckSection(W, R, 2).spline);
    const ringSteps = 48;
    const rail = crossSectionRing(b, 40, ringSteps)!.slice(0, ringHalf(ringSteps));
    // The premise: the nearest vertex is a long way off the apex height.
    expect(Math.abs(rail[widestIndex(rail)]!.z - R)).toBeGreaterThan(0.2);

    const apex = railApex(b, 40, ringSteps)!;
    expect(apex.z).toBeCloseTo(R, 2);
    expect(apex.y).toBeLessThanOrEqual(W);
  });

  it('takes the middle of a vertical rail face instead of whichever end rounding favours', () => {
    // A squared rail whose face leans in by 2 nm over its 5 cm height: vertical for any
    // practical purpose, but its bottom vertex is strictly the widest.
    const W = 20;
    const T = 5;
    const slope = 0.02;
    const squared = polylineSpline([
      [0, 0],
      [W, 0],
      [W - 2e-7, T],
      [0, T],
    ]);
    const b = prismBoard(W, T, slope, squared);
    const x = 30;
    const mid = slope * x + T / 2;

    const apex = railApex(b, x, 113)!;
    expect(apex.y).toBeCloseTo(W, 6);
    expect(apex.z).toBeCloseTo(mid, 3);
    expect(APEX_PLATEAU).toBeGreaterThan(2e-7);
    // Without the plateau rule the lean decides, and the line drops to the chine.
    expect(Math.abs(railApex(b, x, 113, 0)!.z - mid)).toBeGreaterThan(1);
  });

  it('returns null for a degenerate board instead of throwing', () => {
    const flat = polylineSpline([
      [0, 0],
      [0, 0],
    ]);
    const empty = board(flat, flat, flat, [crossSection(0, flat), crossSection(0, flat)]);
    expect(railApex(empty, 0, RING_STEPS)).toBeNull();
    expect(apexLine(empty)).toBeNull();
  });
});

describe('apexLine', () => {
  const length = getLength(shortboard);
  const line = apexLine(shortboard, { lengthSteps: LENGTH_STEPS, ringSteps: RING_STEPS })!;

  it('runs tail to nose, one apex per station on each rail', () => {
    expect(line.right).toHaveLength(LENGTH_STEPS);
    expect(line.left).toHaveLength(LENGTH_STEPS);
    for (let i = 1; i < LENGTH_STEPS; i++) {
      expect(line.right[i]!.x).toBeGreaterThan(line.right[i - 1]!.x);
    }
    expect(line.right[0]!.x).toBeLessThan(1);
    expect(line.right[LENGTH_STEPS - 1]!.x).toBeGreaterThan(length - 1);
  });

  it('is symmetric: the left rail is the right one mirrored, and lies on its ring', () => {
    line.right.forEach((p, i) => {
      expect(line.left[i]).toEqual({ x: p.x, y: -p.y, z: p.z });
      expect(p.y).toBeGreaterThan(0);
      const ring = crossSectionRing(shortboard, p.x, RING_STEPS)!;
      expect(distToPolyline(line.left[i]!, ring, true)).toBeLessThan(1e-9);
    });
  });

  it('parts the deck from the bottom at the outline’s width', () => {
    const fine = apexLine(shortboard)!;
    for (const p of fine.right) {
      const rocker = getRockerAtPos(shortboard, p.x);
      expect(p.z).toBeGreaterThan(rocker);
      expect(p.z).toBeLessThan(rocker + getThicknessAtPos(shortboard, p.x));
      // The outline is the plan view of the apex. Away from the tips, where the loft
      // floors the section at MIN_DIM, the two agree to the ring's sampling.
      if (p.x > 5 && p.x < length - 5) {
        expect(p.y).toBeCloseTo(getWidthAtPos(shortboard, p.x) / 2, 2);
      }
    }
  });

  it('samples about once per centimetre on a fine ring by default', () => {
    const fine = apexLine(shortboard)!;
    expect(fine.right).toHaveLength(Math.ceil(length) + 1);
    // The default ring is close to converged: a 1600-point ring moves it by well under
    // half a millimetre (the measured table is on APEX_RING_SPACING).
    for (const i of [20, 60, 100, 150]) {
      const p = fine.right[i]!;
      expect(Math.abs(railApex(shortboard, p.x, 1600)!.z - p.z)).toBeLessThan(0.05);
    }
  });
});

describe('the apex in a tail notch', () => {
  const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
    ax + (bx - ax) / 3,
    ay + (by - ay) / 3,
  ];
  const L = getLength(shortboard);
  /** Same swallow as guides.cutout.test.ts: notch bottom (18,0), tail tips (0,±9). */
  const swallow = board(
    splineFromKnots([
      knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
      knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
      knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, L, 0)], false, false),
      knotFromArray([L, 0, ...third(L, 0, 90, 23.5), L, 0], false, false),
    ]),
    shortboard.bottom,
    shortboard.deck,
    shortboard.crossSections,
    shortboard.interpolationType,
    shortboard.fins,
  );
  const segments = cachedOutlineSegments(swallow.outline);

  it('takes the outer lobe’s rail, on the lobe the mesh draws', () => {
    const x = 8;
    const { yIn, yOut } = yInOut(segments, x);
    expect(yIn).toBeGreaterThan(CUTOUT_EPS); // the premise: x is inside the notch

    const [right] = crossSectionLoops(swallow, x, RING_STEPS)!;
    const apex = railApex(swallow, x, RING_STEPS)!;
    expect(distToPolyline(apex, right!, true)).toBeLessThan(1e-9);
    // Out on the rail, not on the notch wall at yIn.
    expect(apex.y).toBeGreaterThan((yIn + yOut) / 2);
    expect(apex.y).toBeLessThanOrEqual(yOut + 1e-9);
  });

  it('runs on through the notch without a gap', () => {
    const notched = apexLine(swallow, { lengthSteps: 200, ringSteps: RING_STEPS })!;
    const inside = notched.right.filter((p) => yInOut(segments, p.x).yIn > CUTOUT_EPS);
    expect(inside.length).toBeGreaterThan(10);
    for (const p of inside) expect(p.y).toBeGreaterThan(yInOut(segments, p.x).yIn);
  });
});
