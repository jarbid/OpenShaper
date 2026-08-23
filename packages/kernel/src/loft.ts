// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board surface between two cross-sections, as points rather than curves.
 *
 * This is the one place that answers "where is the hull at station x?", shared by
 * the tessellator, the STL exporter and the 3D guide overlays so they cannot
 * drift apart.
 *
 * ## Why points and not control points
 *
 * The obvious way to loft is to blend the two stations' bezier CONTROL POINTS
 * and evaluate the resulting curve — that is what `interpolateCrossSection`
 * does, and the mesh used it for a long time. It has a defect that cannot be
 * sampled away: the blend pairs knots BY ARRAY INDEX. Index pairing puts a
 * station's knot next to whichever knot happens to share its position in the
 * list, which may sit somewhere else entirely on the profile — and `lerpKnot`
 * lerps the TANGENT HANDLES too. Handles lerped between mismatched partners can
 * collapse or cross, and the blended cubic then carries a near-cusp that neither
 * station has.
 *
 * That is the pinch users hit by putting two control points close together (the
 * `80-20-hard` rail preset does exactly this). It is a malformed curve, not a
 * malformed sampling of a good curve, which is why three rounds of fixing the
 * ring SAMPLER each helped and none of them fixed it.
 *
 * Worth being precise about, because it misled the earlier attempts: the knot
 * COUNTS need not differ. The reported reproduction pairs `80-20-hard` against
 * `50-50-soft` and both come out with six knots, so `matchControlPointCounts`
 * never runs — and the mesh still pinches at 1.45x the endpoint curvature. It is
 * index pairing itself that is wrong, not the insertion heuristic that feeds it.
 * Normalising every station to a common knot count (the previous fix) therefore
 * could not have worked: it makes the counts agree without making the paired
 * knots correspond.
 *
 * So: never build a blended curve. Sample each station's own profile at equal
 * fractional arc length and lerp the two POINTS. A linear morph between two
 * well-formed profiles under a monotone correspondence cannot invent a cusp, and
 * knot topology stops being an input to the mesh at all. Pinned by
 * `loft.pinch.test.ts`.
 *
 * This is not a departure from BoardCAD-LE — it is a return to it. The legacy
 * shipped two surface models and the GUI defaulted to this one
 * (`BezierBoardSLinearInterpolationSurfaceModel.getPointAt`, reached via
 * `MenuBar.getCrossSectionInterpolationType`); both its STL exporter and its 3D
 * viewer went through it. We had ported the other one.
 *
 * ## Why correspondence works out
 *
 * Fractional arc length needs its endpoints to mean the same thing at both
 * stations, or the whole ring shears. They do, by construction: every profile
 * runs bottom-centreline -> rail -> deck-centreline with both ends on x = 0. So
 * f = 0 and f = 1 are anchored for free — the seam alignment a skinning pipeline
 * normally has to arrange by hand.
 *
 * ## Why it stays smooth along the board
 *
 * `f` is fixed per ring index, so the two sampled points are constants; only the
 * scale and the blend weight vary with x, both smoothly, through the board's
 * thickness/width/rocker curves. And the sampler is {@link arcLengthTable},
 * whose fixed resolution makes it a continuous function of the control points —
 * deliberately not `pointByS` / `pointByCurveLengthAt`, whose threshold-triggered
 * recursion steps discontinuously and lands in the mesh as jitter.
 */
import { arcLengthTable, pointAtArcFraction, splineFromKnots, type ArcTable } from './bezier-spline';
import {
  getLength,
  getNearestCrossSectionIndex,
  getRockerAtPos,
  getThicknessAtPos,
  getWidthAtPos,
  type BezierBoard,
} from './board';
import { crossSection, scaleCrossSection, type CrossSection } from './cross-section';
import { knot } from './knot';
import { vec2, type Vec2 } from './vec2';

/** A point in board space (cm): X along the length, Y across, Z up. */
export interface Vert3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The two bracketing station profiles at some x, ready to sample.
 *
 * Both are already scaled to the board's thickness and width at that x, so a
 * blend of the two needs no further correction.
 */
export interface LoftedSection {
  /** Arc-length table of the preceding station's scaled profile. */
  readonly prev: ArcTable;
  /** Arc-length table of the following station's scaled profile. */
  readonly next: ArcTable;
  /** Blend weight: 0 at `prev`, 1 at `next`. */
  readonly d: number;
  /** Height of the bottom centreline at this station. */
  readonly rocker: number;
}

const isFinite3 = (x: number, y: number, z: number): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

/**
 * Below this (cm) a scaled dimension is treated as degenerate — legacy floor.
 *
 * Exported because it is the threshold at which a station stops describing real
 * geometry: an end whose true width is under `MIN_DIM` is a point that the floor
 * inflates into a small ring, and consumers that care about the shape of the tip
 * (the mesh's end caps, the STEP exporter's cap faces) have to branch on that.
 */
export const MIN_DIM = 0.5;

/**
 * Prepare the surface at station `x` for sampling, or null where there is none.
 *
 * Station bracketing is deliberately identical to `getInterpolatedCrossSection`
 * (`board.ts`), including the order in which `d` is computed relative to the
 * index clamps: the mesh must keep pairing the same stations it always did, so
 * that the only thing this change alters is how the two are blended.
 */
export const loftSection = (b: BezierBoard, x: number): LoftedSection | null => {
  const cs = b.crossSections;
  if (cs.length === 0 || x < 0 || x > getLength(b)) return null;

  let index = getNearestCrossSectionIndex(b, x);
  if (index < 0) return null;
  if (cs[index]!.position > x) index -= 1;
  let nextIndex = index + 1;

  // Computed before the clamps, as the legacy does: outside the real-station
  // span this extrapolates, and the clamps below then collapse the pair.
  const firstPos = cs[index]!.position;
  const secondPos = cs[nextIndex]!.position;
  let d = (x - firstPos) / (secondPos - firstPos);
  if (!Number.isFinite(d)) d = 0;

  if (index < 1) index = 1;
  if (nextIndex > cs.length - 2) {
    index = cs.length - 2;
    nextIndex = index;
  }
  // Past the outermost real station both ends are the same profile, so the
  // weight is irrelevant — pin it rather than let an extrapolated value show up
  // in a debugger.
  if (index === nextIndex) d = 0;
  if (index < 1) return null;

  const rocker = getRockerAtPos(b, x);
  if (!Number.isFinite(rocker)) return null;

  let thickness = getThicknessAtPos(b, x);
  if (thickness < MIN_DIM) thickness = MIN_DIM;
  let width = getWidthAtPos(b, x);
  if (width < MIN_DIM) width = MIN_DIM;

  // Scale BEFORE building the tables: fractional arc length is not invariant
  // under a non-uniform scale, so sampling an unscaled profile and scaling the
  // result would put the two stations' points at different places on the rail.
  const prevTable = arcLengthTable(scaleCrossSection(cs[index]!, thickness, width).spline);
  const nextTable =
    nextIndex === index
      ? prevTable
      : arcLengthTable(scaleCrossSection(cs[nextIndex]!, thickness, width).spline);

  return { prev: prevTable, next: nextTable, d, rocker };
};

/**
 * The profile point at fractional arc length `f` ∈ [0,1], as
 * (x = distance from centreline, y = height above rocker).
 *
 * `f = 0` is the bottom centreline, `f = 1` the deck centreline.
 */
export const loftPoint = (s: LoftedSection, f: number): Vec2 => {
  const a = pointAtArcFraction(s.prev, f);
  const b = pointAtArcFraction(s.next, f);
  return vec2(a.x + (b.x - a.x) * s.d, a.y + (b.y - a.y) * s.d);
};

/** Points per rail for a ring of `ringSteps`; both rails share the two centreline points. */
export const ringHalf = (ringSteps: number): number => Math.max(2, Math.floor(ringSteps / 2));

// --- where the ring's points go ---

/**
 * How hard point density follows curvature. See {@link ringFractions}.
 *
 * Measured on an `80-20-hard` rail at the default viewport quality (48 ring
 * points): worst chord deviation anywhere on the profile, the same on the flat
 * bottom alone, and the ratio of the longest to the shortest gap between
 * neighbouring ring points.
 *
 *   β     worst      bottom     gap ratio   longest gap
 *   0     0.2531     0.0011     1.1         2.05 cm
 *   0.5   0.0645     0.0024     5.7         3.37 cm
 *   1     0.0767     0.0038     9.8         4.51 cm
 *   2     0.0436     0.0061     16.6        6.36 cm
 *   3     0.0262     0.0081     20.2        7.32 cm
 *
 * 0.5 takes the rail error down 4x for the smallest distortion of the rest of
 * the ring. Past it the returns are both small and unreliable — β=1 measures
 * WORSE than β=0.5, because at this point count the figure depends on whether a
 * sample happens to land on the apex, so the curve is not smooth enough to pick
 * a finer optimum from. Meanwhile the cost is real: by β=2 a single quad edge
 * spans 6.4 cm of the flat bottom, which shades badly however small its chord
 * error is. The bottom's own error stays negligible throughout — it is flat, so
 * taking points away from it costs almost nothing geometrically.
 *
 * Pinned by `loft.ladder.test.ts`.
 */
export const CURVATURE_BIAS = 0.5;

/** Resolution of the monitor / ladder tables. Fixed, so the ladder stays smooth in the board. */
const LADDER_SAMPLES = 128;

/** Half-width of the box filter applied to the monitor before integrating it. */
const LADDER_SMOOTH = 2;

const LADDER_CACHE = new WeakMap<BezierBoard, Map<number, readonly number[]>>();

/** |κ| at each of `LADDER_SAMPLES + 1` equal-arc stops along one profile, times its length. */
const curvatureProfile = (table: ArcTable): number[] => {
  const n = LADDER_SAMPLES;
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) pts.push(pointAtArcFraction(table, i / n));
  const out = new Array<number>(n + 1).fill(0);
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    let turn = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    const ds = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
    // |κ| · L, dimensionless: total turning per unit of the profile's own length.
    out[i] = ds > 1e-9 ? (Math.abs(turn) / ds) * table.total : 0;
  }
  out[0] = out[1]!;
  out[n] = out[n - 1]!;
  return out;
};

/**
 * Where to put a ring's `n` points along the profile, as fractional arc lengths.
 *
 * Uniform arc length spreads points evenly, which under-resolves a hard rail: at
 * the default quality a ring spends ~1.5 cm between points against an apex whose
 * radius is a few millimetres, so the tightest part of the shape — the part a
 * shaper is actually looking at — is the worst-sampled.
 *
 * A CAD tessellator would answer with a chord-height tolerance and a variable
 * point count. A lofted quad mesh cannot: every station needs the SAME count in
 * the SAME order or the correspondence that makes the loft work is gone. So use
 * the equidistribution form of the same idea — for a fixed point budget, chord
 * error is minimised when points are spread evenly in ∫|κ|^(1/2) ds. Pure
 * κ^(1/2) starves the flat bottom, so the monitor keeps a uniform floor:
 *
 *     m(f) = 1 + β·sqrt(|κ(f)|·L)
 *
 * Two properties make this safe to put inside a loft:
 *
 *   - The ladder is built ONCE PER BOARD from the pointwise MAX of `m` across
 *     every station. A rail that is sharp anywhere gets points everywhere, so
 *     every station uses the identical ladder and correspondence is untouched.
 *   - It only decides WHERE samples sit on a surface it does not otherwise
 *     change. A board edit that moves the ladder cannot move the shape, and
 *     since the ladder is constant across x it cannot affect smoothness along
 *     the board either.
 *
 * Memoised per (board, n); boards are immutable, so a stale entry can't be seen.
 */
export const ringFractions = (b: BezierBoard, n: number): readonly number[] => {
  const count = Math.max(2, Math.floor(n));
  let perBoard = LADDER_CACHE.get(b);
  if (!perBoard) {
    perBoard = new Map();
    LADDER_CACHE.set(b, perBoard);
  }
  const hit = perBoard.get(count);
  if (hit) return hit;

  const out = buildLadder(b, count);
  perBoard.set(count, out);
  return out;
};

const uniformLadder = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => i / (count - 1));

const buildLadder = (b: BezierBoard, count: number): readonly number[] => {
  if (CURVATURE_BIAS <= 0) return uniformLadder(count);

  // Interior stations only — index 0 and the last are the degenerate nose/tail
  // dummies, whose collapsed profiles would report meaningless curvature.
  const stations = b.crossSections.slice(1, -1);
  const monitor = new Array<number>(LADDER_SAMPLES + 1).fill(0);
  let any = false;
  for (const cs of stations) {
    if (cs.spline.knots.length < 2) continue;
    const kl = curvatureProfile(arcLengthTable(cs.spline));
    for (let i = 0; i < monitor.length; i++) monitor[i] = Math.max(monitor[i]!, kl[i]!);
    any = true;
  }
  if (!any) return uniformLadder(count);

  // Box-smooth, so one sample's curvature spike can't claim a disproportionate
  // share of the points, then turn it into a density.
  const density = monitor.map((_, i) => {
    let sum = 0;
    let seen = 0;
    for (let j = i - LADDER_SMOOTH; j <= i + LADDER_SMOOTH; j++) {
      const v = monitor[j];
      if (v === undefined) continue;
      sum += v;
      seen++;
    }
    return 1 + CURVATURE_BIAS * Math.sqrt(Math.max(0, sum / Math.max(1, seen)));
  });

  // Cumulative density, normalised: cum[i] is the share of the points that
  // should have been used by arc fraction i / LADDER_SAMPLES.
  const cum = new Array<number>(density.length).fill(0);
  for (let i = 1; i < density.length; i++) {
    cum[i] = cum[i - 1]! + (density[i - 1]! + density[i]!) / 2;
  }
  const total = cum[cum.length - 1]!;
  if (!(total > 0)) return uniformLadder(count);
  for (let i = 0; i < cum.length; i++) cum[i]! /= total;

  // Invert it: ring point k wants share k/(count-1), so find the arc fraction
  // where the cumulative density reaches that.
  const out = new Array<number>(count);
  out[0] = 0;
  out[count - 1] = 1;
  let j = 0;
  for (let k = 1; k < count - 1; k++) {
    const target = k / (count - 1);
    while (j + 1 < cum.length && cum[j + 1]! < target) j++;
    const lo = cum[j]!;
    const hi = cum[j + 1] ?? 1;
    const t = hi > lo ? (target - lo) / (hi - lo) : 0;
    out[k] = (j + t) / LADDER_SAMPLES;
  }
  return out;
};

/**
 * A full closed cross-section ring at station `x`, as `2 * ringHalf - 2` points.
 *
 * Walks the +Y rail from the bottom centreline up to the deck centreline, then
 * mirrors the sweep back down the -Y rail, skipping the two shared centreline
 * points so they appear exactly once. The ring is symmetric about y = 0 by
 * construction. Returns null if the section is missing or degenerate.
 */
export const loftRing = (b: BezierBoard, x: number, ringSteps: number): Vert3[] | null => {
  const section = loftSection(b, x);
  if (!section) return null;

  const half = ringHalf(ringSteps);
  const fs = ringFractions(b, half);
  const ring: Vert3[] = [];

  const push = (f: number, mirror: boolean): boolean => {
    const p = loftPoint(section, f);
    const vy = mirror ? -p.x : p.x;
    const vz = p.y + section.rocker;
    if (!isFinite3(x, vy, vz)) return false;
    ring.push({ x, y: vy, z: vz });
    return true;
  };

  for (let i = 0; i < half; i++) if (!push(fs[i]!, false)) return null;
  for (let i = half - 2; i >= 1; i--) if (!push(fs[i]!, true)) return null;

  if (ring.length < 3) return null;
  return ring;
};

// --- the same surface, as a curve ----------------------------------------------

/**
 * Knots used to rebuild a lofted profile as a curve. See {@link loftCrossSection}.
 *
 * Measured against the exact blend (arc-length sampling with no table, every station
 * of the golden boards carrying a different rail preset), worst deviation of the
 * rebuilt curve:
 *
 *   knots   shortboard   longboard
 *   48        60.4 um      82.4 um
 *   64        59.0 um      75.6 um
 *   96        58.7 um      75.2 um
 *   128       58.7 um      74.9 um
 *
 * against 59.3 / 68.0 um for the loft's own polyline — so past 64 the residual is
 * the sampled surface itself, not the rebuild, and the rebuild adds under 10 um to
 * it. 96 sits comfortably inside that floor and is still cheap: this runs a few
 * dozen times per export, not per frame.
 */
export const LOFT_SECTION_KNOTS = 96;

/** Points closer than this (cm) are the same point, and one knot is enough for both. */
const COINCIDENT = 1e-7;

/**
 * The lofted surface at station `x` as a **cross-section curve**, for the callers that
 * need tangents rather than points.
 *
 * `getInterpolatedCrossSection` (board.ts) answers the same question by blending the
 * two stations' CONTROL POINTS, and carries the defect this module exists to avoid:
 * index pairing lerps mismatched tangent handles, which can put a near-cusp in the
 * blended curve that neither station has. Sampling cannot remove it, because the curve
 * itself is malformed. Anything reading SLOPE off a section — the rail-band tangent fit
 * above all, which picks a facet by where the section's own slope reaches an angle —
 * reads that invented curvature as real shape. Measured on a longboard carrying a
 * different rail preset at each station, the blended section stood 4.96 mm off the
 * surface the mesh and the STL show, and the fitted first band came out 17 deg, 65.5
 * deg, 41.5 deg at three consecutive stations of a rail that is 21 deg all the way
 * along.
 *
 * So the curve is rebuilt from the surface rather than blended into existence: sample
 * {@link loftPoint} on the {@link ringFractions} ladder and interpolate those points
 * with a C1 cubic Hermite spline (handles one third of the neighbouring chord, tangent
 * directions by central difference — exact on a circular arc, which is what a rail zone
 * nearly is). Because the ladder is the mesh's own, the knots land exactly where the
 * rendered ring points land: the printed section and the rendered surface are the same
 * curve by construction rather than by coincidence.
 *
 * Returns null wherever {@link loftSection} does.
 */
export const loftCrossSection = (
  b: BezierBoard,
  x: number,
  knotCount = LOFT_SECTION_KNOTS,
): CrossSection | null => {
  const section = loftSection(b, x);
  if (!section) return null;

  // Drop repeats before anything else: a profile that collapses toward a tip can put
  // two ladder stops on one point, and a zero-length segment has no tangent for
  // `normalByTT` to find.
  const pts: Vec2[] = [];
  for (const f of ringFractions(b, Math.max(4, Math.floor(knotCount)))) {
    const p = loftPoint(section, f);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < COINCIDENT) continue;
    pts.push(p);
  }
  if (pts.length < 3) return null;

  const n = pts.length;
  const knots = pts.map((p, i) => {
    // Central difference; one-sided at the two ends, where there is no other choice.
    const a = pts[Math.max(0, i - 1)]!;
    const c = pts[Math.min(n - 1, i + 1)]!;
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    const ux = len > 0 ? (c.x - a.x) / len : 1;
    const uy = len > 0 ? (c.y - a.y) / len : 0;
    const back = i > 0 ? Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) / 3 : 0;
    const fwd = i < n - 1 ? Math.hypot(pts[i + 1]!.x - p.x, pts[i + 1]!.y - p.y) / 3 : 0;
    return knot(
      p,
      vec2(p.x - ux * back, p.y - uy * back),
      vec2(p.x + ux * fwd, p.y + uy * fwd),
      true,
      false,
    );
  });

  return crossSection(x, splineFromKnots(knots));
};
