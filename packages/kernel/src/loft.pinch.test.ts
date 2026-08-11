// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Does the loft INVENT shape that neither neighbouring station has?
 *
 * The reported bug: two control points close together on a cross-section — which
 * is exactly what the `80-20-hard` rail preset produces — pinch the mesh between
 * that station and its neighbour. Confirmed both in the 3D view and in an
 * exported STL opened in external software, and it survived three rounds of
 * fixing the ring SAMPLER, because the sampler was never the problem.
 *
 * This is the oracle those rounds were missing. Everything else in the suite
 * checks one of two things:
 *
 *   - golden fixtures: agreement with legacy BoardCAD-LE, but only on UNEDITED
 *     boards, where every station has the same knot count and the knot-matching
 *     path never runs at all;
 *   - mesh tests: structural validity (no NaN, watertight, outward, volume in
 *     the right ballpark), all of which a pinched surface passes happily.
 *
 * Neither asks "is this surface fair?", which is the only question a shaper
 * actually asks of a rail. A blend can move a section's area by well under a
 * percent — invisible to every tolerance we have — while putting a clearly
 * visible ridge down the board.
 *
 * Fairness here is peak curvature. A ring between two stations must not be MORE
 * curved than the sharper of the two: interpolating a soft rail toward a hard
 * one should pass through intermediate rails, never through something sharper
 * than either end. Extra curvature is a feature belonging to no station, and it
 * reads on screen as a dent.
 *
 * Measured on the tessellated mesh rather than on an interpolated section, so
 * what is pinned is the thing the user actually sees and exports.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arcLengthTable, pointAtArcFraction } from './bezier-spline';
import {
  getInterpolatedCrossSection,
  getLength,
  getRockerAtPos,
  type BezierBoard,
} from './board';
import { crossSection } from './cross-section';
import { loftRing, ringFractions, ringHalf } from './loft';
import { applyRailProfile, RAIL_PRESETS } from './rail-profile';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { vec2, type Vec2 } from './vec2';

const here = dirname(fileURLToPath(import.meta.url));

/** The app's own sample board — the one a user actually starts from. */
const sampleBoard = (): BezierBoard =>
  parseBrdGeometry(
    readFileSync(resolve(here, '../../../docs/specs/golden/shortboard.brd'), 'utf8'),
  );

/** Insert a station at `pos`, built by interpolating the existing surface there. */
const insertStation = (b: BezierBoard, pos: number): { board: BezierBoard; index: number } => {
  const cs = getInterpolatedCrossSection(b, pos);
  if (!cs) throw new Error(`no section at ${pos}`);
  const list = [...b.crossSections];
  let i = list.findIndex((c) => c.position > pos);
  if (i < 0) i = list.length - 1;
  list.splice(i, 0, crossSection(pos, cs.spline));
  return { board: { ...b, crossSections: list }, index: i };
};

const withPreset = (b: BezierBoard, index: number, id: string): BezierBoard => {
  const preset = RAIL_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no preset ${id}`);
  const list = [...b.crossSections];
  list[index] = applyRailProfile(list[index]!, preset.params);
  return { ...b, crossSections: list };
};

/** Discrete curvature: turn angle per unit arc length along a resampled polyline. */
const peakCurvature = (pts: readonly Vec2[]): number => {
  let peak = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    let turn = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    const len = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
    if (len > 1e-9) peak = Math.max(peak, Math.abs(turn) / len);
  }
  return peak;
};

const RING_STEPS = 400;
const LENGTH_STEPS = 240;

/** The +Y half of a ring, as (lateral, height) — the profile in its own plane. */
const halfProfile = (ring: readonly { y: number; z: number }[]): Vec2[] => {
  // ring = half + (half - 2), so the +Y sweep is the first (length + 2) / 2.
  const half = (ring.length + 2) / 2;
  return ring.slice(0, half).map((p) => vec2(p.y, p.z));
};

/** One ring off the loft at exactly `x`, sampled the way the mesh samples. */
const ringAt = (b: BezierBoard, x: number): Vec2[] => {
  const ring = loftRing(b, x, RING_STEPS);
  expect(ring).not.toBeNull();
  return halfProfile(ring!);
};

/**
 * Every mesh ring as (station x, +Y half profile in the section plane).
 *
 * Only the +Y half is taken: the -Y half is an exact mirror, and including the
 * fold would register the centreline as a curvature spike on every ring.
 */
const meshRings = (b: BezierBoard): { x: number; profile: Vec2[] }[] => {
  const mesh = tessellateBoard(b, { lengthSteps: LENGTH_STEPS, ringSteps: RING_STEPS });
  const verts = mesh.positions.length / 3;
  const ringLen = (verts - 2) / LENGTH_STEPS; // minus the two tip-cap vertices
  expect(Number.isInteger(ringLen)).toBe(true);
  const half = (ringLen + 2) / 2; // ring = half + (half - 2)
  expect(Number.isInteger(half)).toBe(true);

  const out: { x: number; profile: Vec2[] }[] = [];
  for (let r = 0; r < LENGTH_STEPS; r++) {
    const base = r * ringLen * 3;
    const profile: Vec2[] = [];
    for (let i = 0; i < half; i++) {
      const p = base + i * 3;
      // (lateral, height) — rocker is a rigid translation of the whole ring and
      // does not affect in-plane curvature, so it is left in.
      profile.push(vec2(mesh.positions[p + 1]!, mesh.positions[p + 2]!));
    }
    out.push({ x: mesh.positions[base]!, profile });
  }
  return out;
};

/**
 * How much sharper than its own endpoints a blend may get.
 *
 * Not zero: a discrete curvature estimate has its own noise, and a ring between
 * two stations is measured at a slightly different board width and thickness
 * than either endpoint. 5% is comfortably above both, and far below the 45% the
 * control-point blend produces (pinned at the bottom of this file).
 */
const TOLERANCE = 1.05;

/**
 * The reported reproduction: start from the sample board, add a station, then
 * give it and its neighbour different rail presets.
 *
 * Note the first two pairs leave both stations with the SAME knot count (six),
 * so no knot insertion runs at all — and they are the two that failed. The
 * defect is the blend pairing knots by array index, which misaligns them
 * whatever the counts are. Boards where the counts also differ are covered by
 * `tessellate.continuity.test.ts`.
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['80-20-hard', '50-50-soft'],
  ['50-50-soft', '80-20-hard'],
  ['boxy', 'egg'],
  ['knifey', '50-50-soft'],
  ['70-30-tucked', 'boxy'],
];

const railBoard = (idA: string, idB: string): { board: BezierBoard; xA: number; xB: number } => {
  const base = sampleBoard();
  const added = insertStation(base, getLength(base) * 0.45);
  let board = withPreset(added.board, added.index, idA);
  board = withPreset(board, added.index + 1, idB);
  return {
    board,
    xA: board.crossSections[added.index]!.position,
    xB: board.crossSections[added.index + 1]!.position,
  };
};

/**
 * Endpoint sharpness: the two stations' own profiles, sampled exactly as the
 * rings between them are.
 *
 * It has to be the same sampling on both sides of the comparison. Measuring the
 * endpoints on a uniform arc-length resample while the rings come off the
 * curvature-biased ladder inflates the ratio by ~5% on its own — closer spacing
 * at the apex resolves the true curvature peak better, so the ring looks sharper
 * than a coarser estimate of the identical shape. That artifact showed up as the
 * control case failing at 1.05 with nothing wrong.
 *
 * Using `ringAt` at exactly `xA` / `xB` also makes the endpoints real: there the
 * blend weight is 0 or 1, so the loft returns that station's profile untouched.
 */
const envelopeAt = (b: BezierBoard, xA: number, xB: number): number =>
  Math.max(peakCurvature(ringAt(b, xA)), peakCurvature(ringAt(b, xB)));

describe('the loft invents no curvature between stations', () => {
  it.each(PAIRS)('lofting %s into %s stays within its endpoints', (idA, idB) => {
    const { board, xA, xB } = railBoard(idA, idB);
    const envelope = envelopeAt(board, xA, xB);
    expect(envelope).toBeGreaterThan(0);

    let worst = 0;
    let worstX = xA;
    for (const ring of meshRings(board)) {
      if (ring.x <= xA || ring.x >= xB) continue;
      const k = peakCurvature(ring.profile);
      if (k > worst) {
        worst = k;
        worstX = ring.x;
      }
    }
    expect(worst).toBeGreaterThan(0);

    expect(
      worst / envelope,
      `ring peaked at ${worst.toFixed(3)} vs endpoint max ${envelope.toFixed(3)} ` +
        `(x${(worst / envelope).toFixed(2)}) at x=${worstX.toFixed(1)}`,
    ).toBeLessThan(TOLERANCE);
  });

  it('a station lofted to an identical neighbour is exactly as sharp as it', () => {
    // Control: with both stations the same shape there is nothing to invent, so
    // excess here would mean the metric is broken rather than the loft.
    const { board, xA, xB } = railBoard('boxy', 'boxy');
    const envelope = envelopeAt(board, xA, xB);

    let worst = 0;
    for (const ring of meshRings(board)) {
      if (ring.x <= xA || ring.x >= xB) continue;
      worst = Math.max(worst, peakCurvature(ring.profile));
    }
    expect(worst / envelope).toBeLessThan(TOLERANCE);
  });
});

/**
 * The defect itself, kept executable.
 *
 * Without this, the test above only says the current code is fine — it could
 * pass just as happily against a metric that had quietly stopped measuring
 * anything, which is exactly how the previous rounds of this bug slipped
 * through. So measure the OLD surface definition with the SAME metric and
 * require it to fail.
 *
 * `interpolateCrossSection` is still live (the 2D preview, `insertCrossSection`,
 * DXF, HWS ribs and the volume integrand all use it), so this is not a museum
 * piece: it is the standing reason the mesh must not go back to it.
 */
const controlPointRing = (b: BezierBoard, x: number): Vec2[] => {
  const cs = getInterpolatedCrossSection(b, x);
  expect(cs).not.toBeNull();
  const rocker = getRockerAtPos(b, x);
  const table = arcLengthTable(cs!.spline);
  // Sampled through the same ladder as the real rings, so the only difference
  // between this and `ringAt` is control-point blending vs point blending.
  return ringFractions(b, ringHalf(RING_STEPS)).map((f) => {
    const p = pointAtArcFraction(table, f);
    return vec2(p.x, p.y + rocker);
  });
};

describe('blending control points is what invented the curvature', () => {
  it.each([
    ['80-20-hard', '50-50-soft'],
    ['50-50-soft', '80-20-hard'],
  ])('%s into %s peaks well outside its endpoints the old way', (idA, idB) => {
    const { board, xA, xB } = railBoard(idA, idB);
    const envelope = Math.max(
      peakCurvature(controlPointRing(board, xA)),
      peakCurvature(controlPointRing(board, xB)),
    );

    let worst = 0;
    for (let i = 1; i < 40; i++) {
      const x = xA + ((xB - xA) * i) / 40;
      worst = Math.max(worst, peakCurvature(controlPointRing(board, x)));
    }

    // Measured 1.45x and 1.47x. Bounded well below those so this stays a
    // statement about a real defect rather than a pin on a specific number.
    expect(worst / envelope).toBeGreaterThan(1.2);
  });
});
