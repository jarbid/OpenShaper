// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reference geometry for the 3D overlay: a ring around the hull at a station,
 * and the stringer plane's silhouette.
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
