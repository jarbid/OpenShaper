// SPDX-License-Identifier: GPL-3.0-or-later
import {
  crossSectionRing,
  stringerLoop,
  tessellationSteps,
  type BezierBoard,
  type GuidePoint,
} from '@openshaper/kernel';

/** A polyline to draw over the hull, in board cm. */
export interface GuideLine {
  /** Stable React key. Rings key by station position so an insert does not remount the rest. */
  key: string;
  points: [number, number, number][];
}

export interface GuideLines {
  stringer: GuideLine | null;
  sections: GuideLine[];
  /** Key of the ring at `activeX`, or null when no station matches. */
  activeKey: string | null;
}

const toPoints = (ring: readonly GuidePoint[]): [number, number, number][] =>
  ring.map((v) => [v.x, v.y, v.z]);

/** Rings are loops but a polyline is not, so repeat the first point to close it. */
const closed = (pts: [number, number, number][]): [number, number, number][] =>
  pts.length > 1 ? [...pts, pts[0]!] : pts;

/**
 * Guide polylines for the 3D overlay.
 *
 * Rings are drawn only at REAL cross-sections — `crossSections.slice(1, -1)`, the
 * same slice the 2D panes mark — because index 0 and the last index are the
 * nose/tail dummies, which are degenerate and would render as dots.
 *
 * The kernel is immutable and swaps the board reference on every edit, so callers
 * can memoise on `board` and get correct results across added and deleted
 * stations for free.
 */
export function guideLines(
  board: BezierBoard,
  targetFaceSize: number,
  activeX: number | null,
): GuideLines {
  const realSections = board.crossSections.slice(1, -1);
  // No real station at all: `getInterpolatedCrossSection` has nothing to interpolate
  // between, so skip the kernel calls entirely rather than let them fault.
  if (realSections.length === 0) return { stringer: null, sections: [], activeKey: null };

  const { lengthSteps, ringSteps } = tessellationSteps(board, targetFaceSize);

  const loop = stringerLoop(board, lengthSteps, ringSteps);
  const stringer =
    loop && loop.length > 1 ? { key: 'stringer', points: closed(toPoints(loop)) } : null;

  const sections: GuideLine[] = [];
  for (const cs of realSections) {
    const ring = crossSectionRing(board, cs.position, ringSteps);
    // One degenerate station must not blank the whole overlay.
    if (!ring || ring.length < 3) continue;
    sections.push({ key: ringKey(cs.position), points: closed(toPoints(ring)) });
  }

  return { stringer, sections, activeKey: activeGuideKey(sections, activeX) };
}

const ringKey = (position: number): string => `s${position}`;

/**
 * Key of the ring drawn at station `activeX`, or null when no drawn ring is there.
 *
 * Split out of {@link guideLines} so a caller can memoise the (expensive) lines on
 * the board alone and pick the highlighted ring separately: changing the active
 * station then recolours one ring instead of re-lofting all of them.
 */
export function activeGuideKey(
  sections: readonly GuideLine[],
  activeX: number | null,
): string | null {
  if (activeX === null) return null;
  let key: string | null = null;
  for (const s of sections) {
    if (Math.abs(Number(s.key.slice(1)) - activeX) < 1e-6) key = s.key;
  }
  return key;
}
