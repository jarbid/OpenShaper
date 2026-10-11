// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reference geometry for the 3D overlay: a ring around the hull at a station,
 * the stringer plane's silhouette, and the rail apex line.
 *
 * Built on the PUBLIC surface definition in `loft.ts` rather than by reaching into
 * the tessellator. The loft surface is continuous, so a ring computed at any x
 * lies on it; the mesh is just a faceted sample of that same surface. Keeping
 * this separate means overlays can never destabilise mesh generation.
 *
 * Because both go through `loftRing`, a guide ring and a mesh ring at the same x
 * are the same points in the same order. `guides.test.ts` pins that to a micron
 * so the two cannot silently diverge; it is what caught this the last time the
 * mesh's sampling convention changed.
 */
import { getLength, type BezierBoard } from './board';
import { loftRing, ringHalf } from './loft';
import { CUTOUT_EPS, cachedOutlineSegments, hasTailCutout, yInOut } from './outline-cutout';
import { tessellationSteps } from './tessellate';

/** A point on the board surface, in board cm: x = length, y = width, z = height. */
export interface GuidePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * A closed ring around the hull at station `x` — the mesh's own ring, unfaceted.
 *
 * Returns null if the section is missing or degenerate.
 */
export const crossSectionRing = (
  board: BezierBoard,
  x: number,
  steps: number,
): GuidePoint[] | null => {
  const length = getLength(board);
  if (!Number.isFinite(length) || length <= 0) return null;
  const ring = loftRing(board, x, steps);
  return ring && ring.length >= 3 ? ring : null;
};

/**
 * The outline of the foam at station `x`, as closed loops: one ring normally, and
 * two lobes inside a concave tail's notch (swallow / fish), where there is no foam
 * on the stringer to go round.
 *
 * In the notch each lobe is the mesh's own half-shell: the half-ring from bottom
 * centre to deck centre, pushed out to `[yIn, yOut]` exactly as the cutout
 * tessellator maps it, and closed across the notch wall at `y = yIn`.
 *
 * Returns null if the section is missing or degenerate.
 */
export const crossSectionLoops = (
  board: BezierBoard,
  x: number,
  steps: number,
): GuidePoint[][] | null => {
  const ring = crossSectionRing(board, x, steps);
  if (!ring) return null;
  if (!hasTailCutout(board.outline)) return [ring];
  const { yIn, yOut } = yInOut(cachedOutlineSegments(board.outline), x);
  if (yIn <= CUTOUT_EPS) return [ring];

  const half = ringHalf(steps);
  if (ring.length < half || yOut <= yIn + CUTOUT_EPS) return null;
  const scale = (yOut - yIn) / yOut;
  const right = ring.slice(0, half).map((p) => ({ x: p.x, y: yIn + p.y * scale, z: p.z }));
  const left = right.map((p) => ({ ...p, y: -p.y }));
  return [right, left];
};

/** Stations along the length, inset a hair from the tips where the section goes null. */
const stations = (length: number, steps: number): number[] => {
  const n = Math.max(2, Math.floor(steps));
  const eps = Math.min(0.5, length * 1e-3);
  const span = length - 2 * eps;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(eps + (span * i) / (n - 1));
  return out;
};

/**
 * The stringer plane's silhouette as one polyline: the deck centreline from one
 * tip to the other, then the bottom/rocker centreline back.
 *
 * Stations whose centreline has been cut away by a tail notch (swallow / fish)
 * are skipped — there is no foam at y = 0 there for a line to lie on.
 *
 * Returns null when fewer than two stations yield a usable ring.
 */
export const stringerLoop = (
  board: BezierBoard,
  steps: number,
  ringSteps: number,
): GuidePoint[] | null => {
  const length = getLength(board);
  if (!Number.isFinite(length) || length <= 0) return null;

  const half = ringHalf(ringSteps);
  const segments = hasTailCutout(board.outline) ? cachedOutlineSegments(board.outline) : null;

  const deck: GuidePoint[] = [];
  const bottom: GuidePoint[] = [];
  for (const x of stations(length, steps)) {
    if (segments && yInOut(segments, x).yIn > CUTOUT_EPS) continue;
    const ring = crossSectionRing(board, x, ringSteps);
    if (!ring || ring.length < half) continue;
    bottom.push(ring[0]!); // tt = 0: bottom centreline
    deck.push(ring[half - 1]!); // tt = 1: deck centreline
  }

  if (deck.length < 2) return null;
  return [...deck, ...bottom.reverse()];
};

// --- the rail apex -----------------------------------------------------------

/**
 * How close (cm) to the widest point a ring vertex must come to count as part of a
 * vertical plateau there. One micron: the precision the guide tests pin the mesh to.
 *
 * A rail with a truly vertical stretch (a boxy rail, a squared-off tail block) has
 * no single widest point — every vertex on the vertical face is "the" maximum to
 * within rounding, and which one wins would flip between neighbouring stations,
 * dragging the line up and down the face. Within this band the plateau's midpoint
 * is taken instead. It is deliberately tight: a rounded rail is refined without any
 * threshold (see {@link railApex}), and a looser band would only add a step where a
 * neighbour drifts across its edge.
 */
export const APEX_PLATEAU = 1e-4;

/**
 * Default spacing (cm) of {@link apexLine}'s stations along the board. The apex
 * height changes slowly with x, so the spacing that sets its accuracy is the ring's
 * (below); stations are what the line costs — each one lofts a section, ~0.2 ms at
 * the default ring, ~35 ms for a whole board.
 */
export const APEX_STATION_SPACING = 1;

/**
 * Default spacing (cm) of the points around each ring, turned into a count the way
 * the mesh sizes its own rings (`tessellationSteps`, capped where the mesh caps it).
 *
 * Measured on the golden boards against a 3200-point ring, worst apex-height error
 * away from the tips:
 *
 *   ring points   shortboard   funboard   longboard
 *   100             1.02 mm     1.61 mm     1.04 mm
 *   200             0.32 mm     0.74 mm     0.54 mm
 *   400             0.19 mm     0.25 mm     0.16 mm
 *   1600            0.12 mm     0.12 mm     0.11 mm
 *
 * Past 400 the residual barely moves: it is how well a nearly vertical rail face
 * locates its own widest point, not sampling. A quarter centimetre reaches the cap
 * of 400 on all three boards. The width at the apex is far better conditioned: under
 * 7 µm at 400.
 */
export const APEX_RING_SPACING = 0.25;

/** One apex line per rail, tail to nose, in board cm. */
export interface ApexLine {
  /** The +y rail. */
  right: GuidePoint[];
  /** The -y rail: `right` mirrored across the stringer. */
  left: GuidePoint[];
}

export interface ApexLineOptions {
  /** Stations along the board. Default: one per {@link APEX_STATION_SPACING} of length. */
  lengthSteps?: number;
  /**
   * Ring points per station, counted as the mesh counts them. Default: derived from
   * {@link APEX_RING_SPACING}. Pass the mesh's own count to land on the rings it draws.
   */
  ringSteps?: number;
  /** Plateau tolerance (cm). Default {@link APEX_PLATEAU}. */
  plateau?: number;
}

const lerp3 = (a: GuidePoint, b: GuidePoint, t: number): GuidePoint => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

const dist3 = (a: GuidePoint, b: GuidePoint): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** The point at arc length `s` along `pts[lo..hi]`, measured from `pts[lo]`. */
const pointAlong = (pts: readonly GuidePoint[], lo: number, hi: number, s: number): GuidePoint => {
  let left = s;
  for (let i = lo; i < hi; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const d = dist3(a, b);
    if (left <= d || i === hi - 1) return d > 0 ? lerp3(a, b, Math.min(1, left / d)) : a;
    left -= d;
  }
  return pts[lo]!;
};

/**
 * The widest point of one rail (largest y), as a point ON the polyline `rail`.
 *
 * - A vertical plateau — neighbours within `plateau` of the widest vertex — gives the
 *   plateau's midpoint by arc length.
 * - Otherwise the widest vertex and its two neighbours are fitted with a parabola in
 *   arc length, and its peak is taken on the polyline between them. A bare argmax would
 *   step a whole ring spacing up or down the rail whenever the widest vertex changed
 *   between stations; the peak moves continuously instead, and sits exactly halfway
 *   when two vertices tie, so the hand-over from one vertex to the next is seamless.
 *
 * Either way the result lies on the polyline, never off it.
 */
const widestOn = (rail: readonly GuidePoint[], plateau: number): GuidePoint | null => {
  if (rail.length === 0) return null;
  let best = 0;
  for (let i = 1; i < rail.length; i++) if (rail[i]!.y > rail[best]!.y) best = i;

  const floor = rail[best]!.y - Math.max(0, plateau);
  let lo = best;
  let hi = best;
  while (lo > 0 && rail[lo - 1]!.y >= floor) lo--;
  while (hi < rail.length - 1 && rail[hi + 1]!.y >= floor) hi++;
  if (hi > lo) {
    let run = 0;
    for (let i = lo; i < hi; i++) run += dist3(rail[i]!, rail[i + 1]!);
    return pointAlong(rail, lo, hi, run / 2);
  }

  // At a centreline end of the half-ring there is no neighbour on one side to fit.
  if (best === 0 || best === rail.length - 1) return rail[best]!;
  const a = rail[best - 1]!;
  const m = rail[best]!;
  const c = rail[best + 1]!;
  const h0 = dist3(a, m);
  const h1 = dist3(m, c);
  if (!(h0 > 0 && h1 > 0)) return m;
  // y(s) = m.y + slope·s + bend·s² through s = -h0, 0, h1. `m` is strictly the highest
  // of the three (a tie within `plateau` was handled above), so the parabola opens
  // downward and its peak lies between the outer two.
  const into = (m.y - a.y) / h0;
  const out = (c.y - m.y) / h1;
  const bend = (out - into) / (h0 + h1);
  if (!(bend < 0)) return m;
  const peak = -(into + bend * h0) / (2 * bend);
  const s = Math.min(h1, Math.max(-h0, peak));
  return s < 0 ? lerp3(m, a, -s / h0) : lerp3(m, c, s / h1);
};

/**
 * The rail apex at station `x`: the widest point of the +y rail, found on the same
 * ring the mesh draws there (`ringSteps` counted as the mesh counts them), so it sits
 * on the hull. The -y apex is its mirror.
 *
 * Inside a concave tail's notch this is the outer lobe's widest point — the rail a
 * shaper is looking at. The notch wall is the inside of that lobe and never the widest.
 *
 * Returns null if the section is missing or degenerate.
 */
export const railApex = (
  board: BezierBoard,
  x: number,
  ringSteps: number,
  plateau: number = APEX_PLATEAU,
): GuidePoint | null => {
  const loops = crossSectionLoops(board, x, ringSteps);
  if (!loops) return null;
  // A whole ring's first `half` points are the +y rail, bottom centre to deck centre;
  // a notch's right lobe is exactly that rail pushed outboard, `half` points long.
  return widestOn(loops[0]!.slice(0, ringHalf(ringSteps)), plateau);
};

/**
 * The rail apex line: each station's widest point, tail to nose, on both rails.
 *
 * It is the line that parts the deck from the bottom, and where a CNC flips the
 * blank. Stations are inset a hair from the tips like {@link stringerLoop}'s, and a
 * station with no usable section is skipped.
 *
 * Returns null when fewer than two stations yield an apex.
 */
export const apexLine = (board: BezierBoard, opts: ApexLineOptions = {}): ApexLine | null => {
  const length = getLength(board);
  if (!Number.isFinite(length) || length <= 0) return null;

  const lengthSteps = opts.lengthSteps ?? Math.ceil(length / APEX_STATION_SPACING) + 1;
  const ringSteps = opts.ringSteps ?? tessellationSteps(board, APEX_RING_SPACING).ringSteps;
  const plateau = opts.plateau ?? APEX_PLATEAU;

  const right: GuidePoint[] = [];
  for (const x of stations(length, lengthSteps)) {
    const p = railApex(board, x, ringSteps, plateau);
    if (p) right.push(p);
  }
  if (right.length < 2) return null;
  return { right, left: right.map((p) => ({ x: p.x, y: -p.y, z: p.z })) };
};
