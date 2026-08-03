// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reference geometry for the 3D overlay: a ring around the hull at a station,
 * and the stringer plane's silhouette.
 *
 * Deliberately built on the PUBLIC surface definition — `getInterpolatedCrossSection`
 * plus `getRockerAtPos` — rather than by reaching into the tessellator. The loft
 * surface is continuous, so a ring computed at any x lies on it; the mesh is just
 * a faceted sample of that same surface. Keeping this separate means overlays can
 * never destabilise mesh generation.
 *
 * What IS shared with the tessellator is the sampling convention: fractional ARC
 * LENGTH, not fractional segment index. Adjacent stations can interpolate against
 * splines with different knot counts, and a segment-index parametrisation would
 * then land on different physical points for "the same" tt (the crease bug fixed
 * in PR #24). `guides.test.ts` pins guide rings to the mesh so the two conventions
 * cannot silently diverge.
 */
import { pointByCurveLengthAt, splineLength } from './bezier-spline';
import { getInterpolatedCrossSection, getLength, getRockerAtPos, type BezierBoard } from './board';
import { CUTOUT_EPS, cachedOutlineSegments, hasTailCutout, yInOut } from './outline-cutout';

/** A point on the board surface, in board cm: x = length, y = width, z = height. */
export interface GuidePoint {
  x: number;
  y: number;
  z: number;
}

const isFinite3 = (x: number, y: number, z: number): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

/** Points sampled up one rail; the ring mirrors all but the two shared centreline points. */
const ringHalf = (steps: number): number =>
  Math.max(2, Math.floor(Math.max(4, Math.floor(steps)) / 2));

/**
 * A closed ring around the hull at station `x`.
 *
 * The profile spline runs (distance from centreline, height) and describes the
 * +Y rail half, so we walk it once by arc length and mirror it back.
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

  const cs = getInterpolatedCrossSection(board, x);
  if (!cs) return null;

  const rocker = getRockerAtPos(board, x);
  if (!Number.isFinite(rocker)) return null;

  const total = splineLength(cs.spline);
  if (!Number.isFinite(total) || total <= 0) return null;

  const half = ringHalf(steps);
  const ring: GuidePoint[] = [];

  const push = (tt: number, mirror: boolean): boolean => {
    const p = pointByCurveLengthAt(cs.spline, tt * total, total);
    const y = mirror ? -p.x : p.x;
    const z = p.y + rocker;
    if (!isFinite3(x, y, z)) return false;
    ring.push({ x, y, z });
    return true;
  };

  // +Y rail: tt 0 (bottom centreline) -> tt 1 (deck centreline).
  for (let i = 0; i < half; i++) if (!push(i / (half - 1), false)) return null;
  // -Y rail: back down, skipping the two shared centreline endpoints.
  for (let i = half - 2; i >= 1; i--) if (!push(i / (half - 1), true)) return null;

  return ring.length >= 3 ? ring : null;
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
