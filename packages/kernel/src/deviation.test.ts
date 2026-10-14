// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deviation map against a ghost board (Phase 0, item 0.8): the signed distance,
 * in each point's station plane, from a board's surface to the ghost's section at
 * the same x.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getLength, getMaxWidthPos, type BezierBoard } from './board';
import { scaleSpline, splineFromKnots, type Spline } from './bezier-spline';
import { crossSection } from './cross-section';
import { DEVIATION_END_TOLERANCE, ghostDeviation, signedDistanceToLoops } from './deviation';
import { crossSectionLoops, crossSectionRing, type GuidePoint } from './guides';
import { knot, knotFromArray } from './knot';
import { ringHalf } from './loft';
import { CUTOUT_EPS, cachedOutlineSegments, hasTailCutout, yInOut } from './outline-cutout';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { boxBoard } from './test-support/synthetic-boards';
import { vec2 } from './vec2';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

const shortboard = loadBoard('shortboard');
const LENGTH = getLength(shortboard);

/** One point, measured on its own: x, y, z in board cm. */
const at = (ghost: BezierBoard, x: number, y: number, z: number): number =>
  ghostDeviation(ghost, [x, y, z])[0]!;

const withParts = (
  b: BezierBoard,
  parts: Partial<Pick<BezierBoard, 'outline' | 'bottom' | 'deck' | 'crossSections'>>,
): BezierBoard =>
  board(
    parts.outline ?? b.outline,
    parts.bottom ?? b.bottom,
    parts.deck ?? b.deck,
    parts.crossSections ?? b.crossSections,
    b.interpolationType,
    b.fins,
  );

/** The spline moved up by `dy`: every point on it rises by exactly `dy`. */
const raised = (s: Spline, dy: number): Spline =>
  splineFromKnots(
    s.knots.map((k) =>
      knot(
        vec2(k.end.x, k.end.y + dy),
        vec2(k.tangentToPrev.x, k.tangentToPrev.y + dy),
        vec2(k.tangentToNext.x, k.tangentToNext.y + dy),
        k.continuous,
        k.other,
      ),
    ),
  );

/** The board stretched along its length by `f` (the tail stays at x = 0). */
const stretched = (b: BezierBoard, f: number): BezierBoard =>
  withParts(b, {
    outline: scaleSpline(b.outline, 1, f),
    bottom: scaleSpline(b.bottom, 1, f),
    deck: scaleSpline(b.deck, 1, f),
    crossSections: b.crossSections.map((cs) => crossSection(cs.position * f, cs.spline)),
  });

/** Every vertex of the board's mesh except the two end-cap hubs, which it appends last. */
const ringVertices = (b: BezierBoard, targetFaceSize: number): Float32Array => {
  const { positions } = tessellateBoard(b, { targetFaceSize });
  const hubs = positions.subarray(positions.length - 6);
  // The hubs sit on the stringer: a sanity check that these really are them.
  expect([hubs[1], hubs[4]]).toEqual([0, 0]);
  return positions.subarray(0, positions.length - 6);
};

// --- an independent reference ------------------------------------------------

/** Brute force: nearest point over every edge, and the textbook even-odd ray test. */
const reference = (loops: readonly (readonly GuidePoint[])[], y: number, z: number): number => {
  let best = Infinity;
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[j]!;
      const b = loop[i]!;
      const ey = b.y - a.y;
      const ez = b.z - a.z;
      const len2 = ey * ey + ez * ez;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((y - a.y) * ey + (z - a.z) * ez) / len2)) : 0;
      best = Math.min(best, Math.hypot(a.y + t * ey - y, a.z + t * ez - z));
      if (a.z > z !== b.z > z && y < ((b.y - a.y) * (z - a.z)) / (b.z - a.z) + a.y) {
        inside = !inside;
      }
    }
  }
  return inside ? -best : best;
};

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// --- the swallow tail of guides.cutout.test.ts --------------------------------

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

/** Rail and nose shared by the swallow and its filled-in twin. */
const railAndNose = [
  knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, LENGTH, 0)], false, false),
  knotFromArray([LENGTH, 0, ...third(LENGTH, 0, 90, 23.5), LENGTH, 0], false, false),
];

/** Notch bottom (18, 0), tail tips (0, ±9). */
const swallow = withParts(shortboard, {
  outline: splineFromKnots([
    knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
    knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
    ...railAndNose,
  ]),
});

/** The same outline with the notch filled in: a square tail 18 cm wide. */
const filled = withParts(shortboard, {
  outline: splineFromKnots([
    knotFromArray([0, 9, 0, 9, ...third(0, 9, 90, 23.5)], false, false),
    ...railAndNose,
  ]),
});

// --- the measure itself ------------------------------------------------------

describe('signedDistanceToLoops', () => {
  /** A 2 × 1 rectangle in the station plane, y across and z up. */
  const rect = (y0: number, y1: number): GuidePoint[] => [
    { x: 0, y: y0, z: 0 },
    { x: 0, y: y1, z: 0 },
    { x: 0, y: y1, z: 1 },
    { x: 0, y: y0, z: 1 },
  ];

  it('is negative inside, positive outside and zero on the edge', () => {
    const loops = [rect(0, 2)];
    expect(signedDistanceToLoops(loops, 1, 0.5)).toBeCloseTo(-0.5, 12);
    expect(signedDistanceToLoops(loops, 1.9, 0.5)).toBeCloseTo(-0.1, 12);
    expect(signedDistanceToLoops(loops, 3, 0.5)).toBeCloseTo(1, 12);
    expect(signedDistanceToLoops(loops, 1, 1.25)).toBeCloseTo(0.25, 12);
    expect(signedDistanceToLoops(loops, 3, 2)).toBeCloseTo(Math.SQRT2, 12);
    expect(signedDistanceToLoops(loops, 2, 0.5)).toBe(0);
    expect(signedDistanceToLoops(loops, 0, 0)).toBe(0);
  });

  it('takes two lobes as two separate solids, with nothing between them', () => {
    const lobes = [rect(1, 2), rect(-2, -1)];
    expect(signedDistanceToLoops(lobes, 1.5, 0.5)).toBeCloseTo(-0.5, 12);
    expect(signedDistanceToLoops(lobes, -1.5, 0.5)).toBeCloseTo(-0.5, 12);
    // On the stringer, in the gap: outside both, a full unit from either wall.
    expect(signedDistanceToLoops(lobes, 0, 0.5)).toBeCloseTo(1, 12);
  });

  it('has no answer without a loop', () => {
    expect(signedDistanceToLoops([], 0, 0)).toBeNaN();
  });

  it('matches a brute-force reference on real sections, inside and out', () => {
    // The pruned search must find exactly what visiting every edge finds.
    const next = random(8);
    const cases: [BezierBoard, number][] = [
      [shortboard, 3],
      [shortboard, LENGTH / 2],
      [shortboard, LENGTH - 4],
      [swallow, 8], // two lobes
      [swallow, 40],
    ];
    for (const [b, x] of cases) {
      const loops = crossSectionLoops(b, x, 400)!;
      let lo = Infinity;
      let hi = -Infinity;
      let bottom = Infinity;
      let top = -Infinity;
      for (const p of loops.flat()) {
        lo = Math.min(lo, p.y);
        hi = Math.max(hi, p.y);
        bottom = Math.min(bottom, p.z);
        top = Math.max(top, p.z);
      }
      const points: number[] = [];
      for (let i = 0; i < 1500; i++) {
        points.push(x, lo - 3 + (hi - lo + 6) * next(), bottom - 3 + (top - bottom + 6) * next());
      }
      // Plus every ring point itself, where the answer is a hair either side of zero.
      for (const p of loops.flat()) points.push(x, p.y, p.z);
      const got = ghostDeviation(b, points, { ringSteps: 400 });
      let inside = 0;
      for (let i = 0; i < got.length; i++) {
        const want = reference(loops, points[i * 3 + 1]!, points[i * 3 + 2]!);
        expect(Math.abs(got[i]! - want)).toBeLessThan(1e-12);
        if (want < -1e-9) inside++;
      }
      // The sample really did land on both sides.
      expect(inside).toBeGreaterThan(50);
      expect(inside).toBeLessThan(1450);
    }
  });
});

describe('ghostDeviation on boards with a closed-form answer', () => {
  // Rectangular sections: every surface point away from a corner has an exact answer.
  const current = boxBoard({ length: 100, halfWidth: 20, thickness: 5 });

  it('reads the change of width on the rail and of thickness on the deck', () => {
    const ghost = boxBoard({ length: 100, halfWidth: 19.6, thickness: 4.7 });
    // Rail: 4 mm wider than the ghost.
    expect(at(ghost, 50, 20, 2.5)).toBeCloseTo(0.4, 9);
    expect(at(ghost, 50, -20, 2.5)).toBeCloseTo(0.4, 9);
    // Deck: 3 mm thicker.
    expect(at(ghost, 50, 0, 5)).toBeCloseTo(0.3, 9);
    expect(at(ghost, 50, 10, 5)).toBeCloseTo(0.3, 9);
    // Bottom: unchanged.
    expect(at(ghost, 50, 0, 0)).toBe(0);
    expect(at(ghost, 50, 10, 0)).toBe(0);
  });

  it('turns negative where the board has less foam than the ghost', () => {
    const ghost = boxBoard({ length: 100, halfWidth: 20.5, thickness: 5.2 });
    expect(at(ghost, 30, 20, 2.5)).toBeCloseTo(-0.5, 9);
    expect(at(ghost, 30, 0, 5)).toBeCloseTo(-0.2, 9);
    expect(at(ghost, 30, 0, 0)).toBe(0);
  });

  it('is zero everywhere against itself', () => {
    const d = ghostDeviation(current, tessellateBoard(current, { targetFaceSize: 2 }).positions);
    // The two end caps are flat, so their hubs lie in the transom: skip them.
    for (let i = 0; i < d.length - 2; i++) expect(Math.abs(d[i]!)).toBeLessThan(1e-6);
  });

  it('has no data past the ghost’s end, and allows a float’s rounding at it', () => {
    const ghost = boxBoard({ length: 80, halfWidth: 19.6, thickness: 5 });
    expect(at(ghost, 79, 20, 2.5)).toBeCloseTo(0.4, 9);
    expect(at(ghost, 80, 20, 2.5)).toBeCloseTo(0.4, 9);
    expect(at(ghost, 80 + DEVIATION_END_TOLERANCE / 2, 20, 2.5)).toBeCloseTo(0.4, 9);
    expect(at(ghost, 80.01, 20, 2.5)).toBeNaN();
    expect(at(ghost, 90, 20, 2.5)).toBeNaN();
    expect(at(ghost, -0.01, 20, 2.5)).toBeNaN();
  });

  it('reads Float32 positions, the way a mesh hands them over', () => {
    const ghost = boxBoard({ length: 100, halfWidth: 19.6, thickness: 4.7 });
    const d = ghostDeviation(ghost, new Float32Array([50, 20, 2.5, 50, 0, 5]));
    expect(d[0]).toBeCloseTo(0.4, 6);
    expect(d[1]).toBeCloseTo(0.3, 6);
  });
});

describe('ghostDeviation on the golden boards', () => {
  it('is zero to within a tenth of a millimetre against the board itself', () => {
    // The fine mesh is the worst case (see DEVIATION_RING_SPACING's table).
    for (const name of ['shortboard', 'funboard', 'longboard']) {
      const b = loadBoard(name);
      const d = ghostDeviation(b, ringVertices(b, 0.5));
      let worst = 0;
      for (const v of d) {
        expect(Number.isNaN(v)).toBe(false);
        worst = Math.max(worst, Math.abs(v));
      }
      expect(worst, name).toBeLessThan(0.01);
    }
  });

  it('reads a narrower ghost as more foam at the widest point, by half the difference', () => {
    const x = getMaxWidthPos(shortboard);
    // The widest point of a fine ring there: where the rail faces straight out.
    const ring = crossSectionRing(shortboard, x, 4000)!;
    const apex = ring.reduce((a, p) => (p.y > a.y ? p : a));
    for (const k of [0.97, 1.03]) {
      // Every station is rescaled to the outline's width, so the ghost's section is
      // the board's own, scaled across by k: its rail sits (1 - k)·y further in.
      const ghost = withParts(shortboard, { outline: scaleSpline(shortboard.outline, k, 1) });
      const want = (1 - k) * apex.y;
      expect(Math.abs(want)).toBeGreaterThan(0.6); // about 7 mm either way
      // To 0.02 mm: the loft blends its two stations at equal arc-length fractions,
      // which a sideways scale does not quite preserve.
      expect(Math.abs(at(ghost, x, apex.y, apex.z) - want)).toBeLessThan(0.002);
      // Mirror-symmetric.
      expect(Math.abs(at(ghost, x, -apex.y, apex.z) - want)).toBeLessThan(0.002);
    }
  });

  it('reads a thinner ghost as more foam on the deck at the centre, by the difference', () => {
    const x = LENGTH / 2;
    const ring = crossSectionRing(shortboard, x, 200)!;
    const bottomCentre = ring[0]!;
    const deckCentre = ring[ringHalf(200) - 1]!;
    expect(deckCentre.y).toBeCloseTo(0, 9);
    for (const dz of [-0.4, 0.4]) {
      // Raising the deck curve raises the deck at every x by exactly dz.
      const ghost = withParts(shortboard, { deck: raised(shortboard.deck, dz) });
      // The deck is domed, so straight down (or up) is the nearest way to the ghost's.
      // (To a micron: the deck height is found by solving the curve for x.)
      expect(at(ghost, x, deckCentre.y, deckCentre.z)).toBeCloseTo(-dz, 5);
      // The bottom has not moved.
      expect(at(ghost, x, bottomCentre.y, bottomCentre.z)).toBe(0);
    }
  });

  it('has no data past the ghost’s nose, and data everywhere before it', () => {
    const ghost = stretched(shortboard, 0.95);
    const ghostLength = getLength(ghost);
    const { positions } = tessellateBoard(shortboard, { targetFaceSize: 1.5 });
    const d = ghostDeviation(ghost, positions);
    let beyond = 0;
    for (let i = 0; i < d.length; i++) {
      const x = positions[i * 3]!;
      if (x > ghostLength + DEVIATION_END_TOLERANCE) {
        beyond++;
        expect(d[i]).toBeNaN();
      } else {
        expect(Number.isFinite(d[i])).toBe(true);
      }
    }
    expect(beyond).toBeGreaterThan(100);
  });
});

describe('ghostDeviation against a concave (swallow) tail', () => {
  it('is zero on both lobes against itself', () => {
    const x = 8;
    const loops = crossSectionLoops(swallow, x, 160)!;
    expect(loops).toHaveLength(2); // the premise: x is inside the notch
    const points = loops.flat().flatMap((p) => [p.x, p.y, p.z]);
    for (const v of ghostDeviation(swallow, points)) expect(Math.abs(v)).toBeLessThan(0.01);
  });

  it('reads the foam a filled tail keeps in the notch as more, by the notch’s half-width', () => {
    expect(hasTailCutout(swallow.outline)).toBe(true);
    expect(hasTailCutout(filled.outline)).toBe(false);
    for (const x of [4, 8, 12]) {
      const { yIn } = yInOut(cachedOutlineSegments(swallow.outline), x);
      expect(yIn).toBeGreaterThan(CUTOUT_EPS);
      const ring = crossSectionRing(filled, x, 200)!;
      const deckCentre = ring[ringHalf(200) - 1]!;
      // The ghost's nearest foam is its notch wall, yIn across the gap: the wall's top
      // is the lobe's deck-centre point, level with this one.
      expect(at(swallow, x, deckCentre.y, deckCentre.z)).toBeCloseTo(yIn, 6);
    }
  });

  it('reads the notch wall as less foam than a filled ghost', () => {
    const x = 8;
    const [right] = crossSectionLoops(swallow, x, 160)!;
    const bottom = right![0]!;
    const top = right![right!.length - 1]!;
    // Halfway up the notch wall: inside the filled tail's foam.
    expect(at(filled, x, bottom.y, (bottom.z + top.z) / 2)).toBeLessThan(-0.5);
  });
});
