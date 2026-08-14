// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board hull as fitted B-spline surfaces — the geometry a CAD system wants.
 *
 * Two patches, mirrored about the stringer, plus a plane at each end. That is the
 * whole model; `@openshaper/export`'s STEP writer turns it into a solid without
 * doing any geometry of its own.
 *
 * ## Where the points come from
 *
 * Straight out of `loft.ts`, and deliberately nothing else. `loftSection` /
 * `loftPoint` is "the one place that answers 'where is the hull at station x?'",
 * shared by the tessellator, the STL exporter and the 3D overlays so they cannot
 * drift apart; a second derivation here would be a fourth answer to the same
 * question. So this samples the same surface the viewport shows and fits a control
 * net through it.
 *
 * ## Why the ring correspondence is already solved
 *
 * A tensor-product fit needs column `j` to mean the same thing at every row, or
 * the surface shears. {@link ringFractions} gives exactly that: a curvature-biased
 * ladder of arc-length fractions built ONCE PER BOARD from the pointwise maximum
 * across all stations, so ring index `j` is the same fractional arc position
 * everywhere. Its endpoints are anchored too — every profile runs
 * bottom-centreline to deck-centreline with both ends on x = 0 — which is the seam
 * alignment a skinning pipeline normally has to arrange by hand.
 *
 * ## Rows, and the creases between them
 *
 * `loftSection` blends adjacent stations with a weight that is piecewise linear in
 * x, so the hull has a tangent break at every real cross-section. Rows are placed
 * so that every station falls exactly on one, and those row indices are handed to
 * {@link interpolateSurface} as `uBreaks`, which reproduces the breaks instead of
 * smoothing them away. Rows are also forced at every knot of the outline, rocker
 * and deck splines: those are C1-but-not-C2 joins, and a node there keeps the
 * interpolation error fourth-order instead of degrading locally.
 *
 * ## Known limits
 *
 * - **Concave tails.** A swallow or fish tail is a different topology (two pods
 *   joined by a notch wall) and is not modelled here. Callers must check
 *   `hasTailCutout(board.outline)` first; the export layer refuses.
 * - **Tips carry a small flat.** `loftSection` floors width and thickness at
 *   `MIN_DIM`, so an end that truly comes to a point is sampled as a ring up to
 *   `MIN_DIM` across and gets a planar cap that size. The mesh instead fans such
 *   an end to a true apex. The two therefore differ over the last few millimetres
 *   of a pointed tip — inside the kernel's own floor, and below the tolerance of
 *   any blank — in exchange for a cap face every CAD importer accepts.
 */
import { getLength, getThicknessAtPos, getWidthAtPos, type BezierBoard } from './board';
import {
  CHORD,
  CENTRIPETAL,
  evalSurface,
  interpolateSurface,
  type BSplineSurface,
} from './bspline-surface';
import { MIN_DIM, loftPoint, loftSection, ringFractions, type Vert3 } from './loft';

/** Profile samples per half-section. Sized by the rail apex; see the module notes. */
export const DEFAULT_RING_COLS = 64;

/** Target spacing between stations (cm) when `lengthRows` is not given. */
const DEFAULT_ROW_SPACING = 3.5;
const MIN_ROWS = 24;
const MAX_ROWS = 400;

/** A strip between two creases needs at least this many rows to carry a cubic. */
const MIN_STRIP_ROWS = 4;

/**
 * Sub-intervals in the segment abutting a pointed tip, and how hard they cluster
 * toward it.
 *
 * A tip is where the outline turns over: half-width goes to zero with a near
 * vertical tangent, so the last centimetre changes shape faster than the rest of
 * the board put together — on the shortboard the width runs 0 to 4.7 cm within
 * half a millimetre of the nose. Spacing stations evenly there leaves the first
 * cubic span spanning that whole turn, and the fit misses the true surface by ~3 mm
 * even though it is within 40 µm everywhere else.
 *
 * Clustering quadratically (t²) concentrates rows where the curvature is, which is
 * also what limits the damage from the one genuinely wrong row: `loftSection`
 * floors width at `MIN_DIM`, so the sample AT a pointed tip reports 5 mm of width
 * where the board has none, and the shorter its span the less it can drag.
 */
const TIP_STEPS = 12;

/**
 * Deviation from the loft (cm) the fit refines itself to. See the module notes on
 * why this is a measured guarantee rather than a density heuristic.
 */
export const DEFAULT_TOLERANCE = 0.005;

/** Refinement stops here however much deviation is left. */
const MAX_REFINE_PASSES = 8;
const MAX_REFINED_ROWS = 900;
/** Never bisect an interval below this (cm) — past it the loft's own noise dominates. */
const MIN_INTERVAL = 0.005;
/** Profile samples per probe when measuring deviation, and per reference polyline. */
const PROBE_V = 17;
const PROBE_REF_SAMPLES = 400;
/** Half-width of the forward window used when walking the reference polyline. */
const PROBE_WINDOW = 96;

export interface BoardSurfaceOptions {
  /** Stations sampled along the length before refinement. Default ~one per 3.5 cm. */
  readonly lengthRows?: number;
  /** Profile samples per half-section. Default {@link DEFAULT_RING_COLS}. */
  readonly ringCols?: number;
  /**
   * Max deviation from the loft, in cm. The fit subdivides until it holds or it
   * runs out of passes. Pass 0 to skip refinement and take the base density.
   */
  readonly tolerance?: number;
}

/** A flat end of the board, closing the two hull patches. */
export interface BoardCap {
  /** Position of the plane along the length axis. */
  readonly x: number;
  /** Outward axis direction: -1 at x = 0, +1 at x = length. */
  readonly dir: -1 | 1;
  /**
   * Whether the board truly comes to a point here (width below `MIN_DIM`), in
   * which case the cap is the small artefact of that floor rather than a real
   * transom.
   */
  readonly pointed: boolean;
}

export interface BoardSurfaceModel {
  /** The +Y half of the hull. u runs 0..1 along the length, v bottom to deck. */
  readonly plus: BSplineSurface;
  /** The -Y half: `plus` with y negated, so the stringer seam matches exactly. */
  readonly minus: BSplineSurface;
  /** The x = 0 end. */
  readonly end0: BoardCap;
  /** The x = length end. */
  readonly end1: BoardCap;
  readonly length: number;
  /** The x of every fitted row, ascending, spanning the full length. */
  readonly stations: readonly number[];
  /** Row indices carrying a tangent break (the real cross-sections). */
  readonly breaks: readonly number[];
  /**
   * Worst deviation from the loft (cm) seen at the refiner's probe grid.
   *
   * A sampled estimate, not a bound: a finer sweep finds worse (about 3x on the
   * golden funboard). The guaranteed bound is asserted in `board-surface.test.ts`.
   */
  readonly deviation: number;
  /** Refinement passes actually used. */
  readonly passes: number;
}

/**
 * The span of the board that `loftSection` reports truthfully.
 *
 * `loftSection` floors width and thickness at `MIN_DIM`, so at a pointed tip it
 * hands back a 5 mm ring where the board has none. Feeding that row to an
 * interpolating fit is fatal in a way extra density cannot repair: the surface
 * passes through the bad point *exactly*, and every probe near the tip inherits
 * the error. (Measured on the golden longboard: 2.9 mm out at the nose, and
 * unmoved by tripling the row count.)
 *
 * So the fit starts where the floor stops biting — the first x at which both true
 * dimensions reach `MIN_DIM` — and the end cap closes it there. That trims the
 * board by the length over which it is thinner than half a centimetre, which on a
 * real outline is microns: the golden boards lose under 20 µm, four orders below
 * the 1 mm a blank varies by. In exchange every fitted point is true geometry and
 * the cap is a genuine planar face rather than a degenerate one.
 */
const solidSpan = (board: BezierBoard, length: number): [number, number] => {
  const solid = (x: number) =>
    getWidthAtPos(board, x) >= MIN_DIM && getThicknessAtPos(board, x) >= MIN_DIM;
  const search = (from: number, to: number): number => {
    if (solid(from)) return from;
    if (!solid(to)) return from; // nothing solid to find; leave the span alone
    let lo = from;
    let hi = to;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (solid(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  return [search(0, length * 0.25), search(length, length * 0.75)];
};

/** Ascending, de-duplicated values from `xs`, keeping only those inside (0, length). */
const interiorSorted = (xs: readonly number[], length: number): number[] => {
  const tol = Math.max(1e-9, length * 1e-9);
  const out: number[] = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    if (!(x > tol) || !(x < length - tol)) continue;
    if (out.length > 0 && Math.abs(x - out[out.length - 1]!) <= tol) continue;
    out.push(x);
  }
  return out;
};

/**
 * Station positions, and which of them are creases.
 *
 * Every real cross-section becomes a row (and a crease); every spline knot becomes
 * a row; the gaps between are filled to roughly `spacing`, and every strip between
 * creases is padded to at least {@link MIN_STRIP_ROWS} so it can carry a cubic.
 */
export const surfaceStations = (
  board: BezierBoard,
  lengthRows?: number,
): { stations: number[]; breaks: number[]; span: [number, number] } => {
  const length = getLength(board);
  const span = solidSpan(board, length);
  const [xLo, xHi] = span;
  const pointedLo = getWidthAtPos(board, 0) < MIN_DIM;
  const pointedHi = getWidthAtPos(board, length) < MIN_DIM;
  const inSpan = (xs: readonly number[]) =>
    interiorSorted(
      xs.map((x) => x - xLo),
      xHi - xLo,
    ).map((x) => x + xLo);

  const creases = inSpan(board.crossSections.slice(1, -1).map((cs) => cs.position));
  const knotXs = inSpan(
    [board.outline, board.bottom, board.deck].flatMap((s) => s.knots.map((k) => k.end.x)),
  );

  const targetRows = Math.min(
    MAX_ROWS,
    Math.max(MIN_ROWS, lengthRows ?? Math.ceil(length / DEFAULT_ROW_SPACING)),
  );
  const spacing = (xHi - xLo) / targetRows;

  // Forced positions: the span ends, the creases, and the spline knots.
  const forced = inSpan([...creases, ...knotXs]);
  const anchors = [xLo, ...forced, xHi];

  const stations: number[] = [xLo];
  const breaks: number[] = [];
  const creaseSet = new Set(creases);

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    // Cluster toward a pointed tip; see TIP_STEPS.
    const clusterLo = i === 0 && pointedLo;
    const clusterHi = i === anchors.length - 2 && pointedHi;
    const steps = Math.max(1, clusterLo || clusterHi ? TIP_STEPS : Math.round((b - a) / spacing));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const warped = clusterLo ? t * t : clusterHi ? 1 - (1 - t) * (1 - t) : t;
      stations.push(a + (b - a) * warped);
    }
    if (creaseSet.has(b)) breaks.push(stations.length - 1);
  }

  // Pad any strip too short for a cubic by bisecting its widest gap.
  const bounds = () => [0, ...breaks, stations.length - 1];
  for (let guard = 0; guard < 64; guard++) {
    const bs = bounds();
    let shortAt = -1;
    for (let s = 0; s < bs.length - 1; s++) {
      if (bs[s + 1]! - bs[s]! + 1 < MIN_STRIP_ROWS) {
        shortAt = s;
        break;
      }
    }
    if (shortAt < 0) break;
    const lo = bs[shortAt]!;
    const hi = bs[shortAt + 1]!;
    let widest = lo;
    let widestGap = -1;
    for (let r = lo; r < hi; r++) {
      const gap = stations[r + 1]! - stations[r]!;
      if (gap > widestGap) {
        widestGap = gap;
        widest = r;
      }
    }
    stations.splice(widest + 1, 0, (stations[widest]! + stations[widest + 1]!) / 2);
    for (let i = 0; i < breaks.length; i++) {
      if (breaks[i]! > widest) breaks[i] = breaks[i]! + 1;
    }
  }

  return { stations, breaks, span };
};

/**
 * One station's +Y half-ring, in board space (cm).
 *
 * `v = 0` is the bottom centreline and `v = 1` the deck centreline; both are
 * snapped onto the stringer plane so the two hull patches share the seam exactly
 * rather than to within a rounding error.
 */
export const sampleHalfRing = (board: BezierBoard, x: number, cols: number): Vert3[] | null => {
  const section = loftSection(board, x);
  if (!section) return null;
  const fs = ringFractions(board, cols);
  const out: Vert3[] = [];
  for (let j = 0; j < cols; j++) {
    const p = loftPoint(section, fs[j]!);
    const z = p.y + section.rocker;
    if (!Number.isFinite(p.x) || !Number.isFinite(z)) return null;
    // The profile's own endpoints are pinned to the stringer (JC-4); an imported
    // board can carry a rounding crumb there, and the seam has to be exact.
    const onSeam = j === 0 || j === cols - 1;
    out.push({ x, y: onSeam ? 0 : p.x, z });
  }
  return out;
};

/**
 * Distance from a point to the lofted hull, measured in the point's own station
 * plane.
 *
 * The fitted surface's x depends only on u — every data row is planar at constant
 * x, and interpolation preserves that — so a fitted point always lands exactly on
 * some station plane and the comparison reduces to point-to-curve in 2D. That
 * removes both kinds of parameterization slip, along the length and around the
 * ring, which a naive `|S(u,v) - loftPoint(x,v)|` would report as geometric error
 * and inflate by an order of magnitude.
 */
const ringDistance = (
  ref: readonly [number, number][],
  y: number,
  z: number,
  from = 1,
  to = Number.MAX_SAFE_INTEGER,
): { d: number; at: number } => {
  const lat = Math.abs(y); // the reference is the +Y half
  let best = Infinity;
  let at = from;
  const hi = Math.min(ref.length, to);
  for (let i = Math.max(1, from); i < hi; i++) {
    const [ax, az] = ref[i - 1]!;
    const [bx, bz] = ref[i]!;
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((lat - ax) * dx + (z - az) * dz) / len2)) : 0;
    const d = Math.hypot(lat - (ax + t * dx), z - (az + t * dz));
    if (d < best) {
      best = d;
      at = i;
    }
  }
  return { d: best, at };
};

/** The lofted profile at `x` as a dense polyline in (lateral, height). */
const refPolyline = (board: BezierBoard, x: number): [number, number][] | null => {
  const section = loftSection(board, x);
  if (!section) return null;
  const out: [number, number][] = [];
  for (let i = 0; i <= PROBE_REF_SAMPLES; i++) {
    const p = loftPoint(section, i / PROBE_REF_SAMPLES);
    out.push([p.x, p.y + section.rocker]);
  }
  return out;
};

/**
 * Worst deviation within each station interval, by probing the fitted surface
 * between the rows it interpolates.
 *
 * Probing in u and reading x back off the surface — rather than picking an x and
 * solving for u — keeps this free of any inverse mapping.
 */
const measureIntervals = (
  board: BezierBoard,
  s: BSplineSurface,
  stations: readonly number[],
): number[] => {
  const perInterval = new Array<number>(Math.max(0, stations.length - 1)).fill(0);
  const probes = Math.max(64, (stations.length - 1) * 3);
  for (let k = 0; k < probes; k++) {
    const u = (k + 0.5) / probes;
    const x = evalSurface(s, u, 0).x;
    const ref = refPolyline(board, x);
    if (!ref) continue;
    let worst = 0;
    // v increases monotonically along the ring, so the nearest reference segment
    // only ever moves forward. Walking a window around the previous hit turns the
    // inner search from O(|ref|) into O(1) and is what keeps a refinement pass in
    // milliseconds; the first probe scans the whole polyline to anchor it. A miss
    // could only over-estimate the distance, which is the safe direction for a
    // tolerance check.
    let anchor = 1;
    for (let j = 0; j < PROBE_V; j++) {
      const p = evalSurface(s, u, (j + 0.5) / PROBE_V);
      const { d, at } =
        j === 0
          ? ringDistance(ref, p.y, p.z)
          : ringDistance(ref, p.y, p.z, anchor - PROBE_WINDOW, anchor + PROBE_WINDOW);
      anchor = at;
      if (d > worst) worst = d;
    }
    // Locate the interval this probe fell in.
    let lo = 0;
    let hi = stations.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (stations[mid]! <= x) lo = mid;
      else hi = mid;
    }
    if (worst > perInterval[lo]!) perInterval[lo] = worst;
  }
  return perInterval;
};

/** `s` with y negated — the other half of the hull, exact by construction. */
export const mirrorSurface = (s: BSplineSurface): BSplineSurface => ({
  uDegree: s.uDegree,
  vDegree: s.vDegree,
  uKnots: s.uKnots,
  vKnots: s.vKnots,
  ctrl: s.ctrl.map((row) => row.map((p) => ({ x: p.x, y: -p.y, z: p.z }))),
});

/**
 * Fit the board hull.
 *
 * Throws if the board is too degenerate to sample. Callers must rule out concave
 * tails first (see the module notes).
 */
export const fitBoardSurface = (
  board: BezierBoard,
  opts: BoardSurfaceOptions = {},
): BoardSurfaceModel => {
  const length = getLength(board);
  if (!Number.isFinite(length) || length <= 0) throw new Error('fitBoardSurface: bad length');

  const cols = Math.max(8, Math.floor(opts.ringCols ?? DEFAULT_RING_COLS));
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const base = surfaceStations(board, opts.lengthRows);

  let stations: readonly number[] = base.stations;
  // Track creases by position, not index: refinement inserts rows and shifts them.
  const creaseXs = base.breaks.map((i) => base.stations[i]!);

  const fitAt = (xs: readonly number[]): BSplineSurface => {
    const grid: Vert3[][] = [];
    for (const x of xs) {
      const ring = sampleHalfRing(board, x, cols);
      if (!ring) throw new Error(`fitBoardSurface: no section at x=${x}`);
      grid.push(ring);
    }
    const breaks = creaseXs.map((x) => xs.findIndex((s) => Math.abs(s - x) < 1e-9));
    return interpolateSurface(grid, {
      uBreaks: breaks.filter((i) => i > 0),
      // Chord length along the length (the data is already near-uniform there);
      // centripetal around the profile, where the rail apex is a sharp turn and
      // chord-length parameterization lets a cubic overshoot.
      uExponent: CHORD,
      vExponent: CENTRIPETAL,
    });
  };

  let plus = fitAt(stations);
  let deviation = Infinity;
  let passes = 0;
  // Refinement is a heuristic, and not a monotone one: subdividing only the
  // failing intervals makes the chord parameterization sharply non-uniform, and a
  // cubic interpolant conditions badly across that — a later pass can come back
  // WORSE than an earlier one even though it has more rows (measured on the golden
  // shortboard: 0.0103 cm at pass 2, 0.0221 at pass 3). Grading the subdivision
  // did not fix it. So keep the best fit seen rather than the last one, which makes
  // the result at least as good as the base density by construction.
  let best: { plus: BSplineSurface; stations: readonly number[]; deviation: number } | null = null;

  // Refine where it is actually wrong. A surfboard's nose and tail turn through
  // ninety degrees of outline in a few centimetres while the middle is nearly
  // ruled, so no single density serves both: a uniform grid fine enough for the
  // tips is enormous, and one sized for the middle misses the tips by millimetres.
  // Subdividing against a measured deviation makes the tolerance a guarantee
  // rather than a hope.
  //
  // Cost, measured on the golden boards (Node 22): 34 ms for a 100 cm box board
  // with no refinement, 0.5-0.9 s for a 188-274 cm board over 3-5 passes. That is
  // the same order as the STL exporter already on the main thread, so it stays
  // synchronous — but it is the strongest argument yet for the shared export
  // worker sketched in docs/design/step-export.md.
  if (tolerance > 0) {
    for (; passes < MAX_REFINE_PASSES; passes++) {
      const perInterval = measureIntervals(board, plus, stations);
      deviation = perInterval.reduce((a, b) => Math.max(a, b), 0);
      if (best === null || deviation < best.deviation) best = { plus, stations, deviation };
      if (deviation <= tolerance || stations.length >= MAX_REFINED_ROWS) break;

      const n = stations.length - 1;
      const next: number[] = [stations[0]!];
      let split = 0;
      for (let i = 0; i < n; i++) {
        const a = stations[i]!;
        const b = stations[i + 1]!;
        if (perInterval[i]! > tolerance && b - a > MIN_INTERVAL) {
          // Cubic interpolation error goes as h^4, so an interval that is F times
          // over tolerance needs its spacing cut by about F^(1/4). Halving every
          // time would need a pass per factor of sixteen, and the tips start three
          // orders out — that is the difference between three passes and eight.
          const over = perInterval[i]! / tolerance;
          const parts = Math.max(2, Math.min(4, Math.round(Math.pow(over, 0.25))));
          const usable = Math.max(2, Math.min(parts, Math.floor((b - a) / MIN_INTERVAL)));
          for (let k = 1; k < usable; k++) next.push(a + ((b - a) * k) / usable);
          split++;
        }
        next.push(b);
      }
      if (split === 0) break; // everything left is at the floor; stop rather than spin
      stations = next;
      plus = fitAt(stations);
    }
    if (best !== null) {
      plus = best.plus;
      stations = best.stations;
      deviation = best.deviation;
    }
    if (!Number.isFinite(deviation)) deviation = 0;
  } else {
    deviation = 0;
  }

  const breaks = creaseXs
    .map((x) => stations.findIndex((s) => Math.abs(s - x) < 1e-9))
    .filter((i) => i > 0);

  return {
    plus,
    minus: mirrorSurface(plus),
    end0: { x: base.span[0], dir: -1, pointed: getWidthAtPos(board, 0) < MIN_DIM },
    end1: { x: base.span[1], dir: 1, pointed: getWidthAtPos(board, length) < MIN_DIM },
    length,
    stations,
    breaks,
    deviation,
    passes,
  };
};
