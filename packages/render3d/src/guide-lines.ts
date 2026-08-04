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
  let activeKey: string | null = null;
  for (const cs of realSections) {
    const ring = crossSectionRing(board, cs.position, ringSteps);
    // One degenerate station must not blank the whole overlay.
    if (!ring || ring.length < 3) continue;
    const key = `s${cs.position}`;
    sections.push({ key, points: closed(toPoints(ring)) });
    if (activeX !== null && Math.abs(cs.position - activeX) < 1e-6) activeKey = key;
  }

  return { stringer, sections, activeKey };
}
