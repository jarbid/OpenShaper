// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared board-curve samplers used by the DXF and 1:1-PDF exporters, so both draw
 * **identical** geometry from the same board. All coordinates are in centimetres
 * (the kernel's internal unit); plan coords are x = length, y = lateral (rail).
 */
import {
  getInterpolatedCrossSection,
  getLength,
  pointByTT,
  valueAt,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Vertical extent of a set of points. */
export const ySpan = (pts: readonly Pt[]): { lo: number; hi: number } => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return Number.isFinite(hi - lo) ? { lo, hi } : { lo: 0, hi: 0 };
};

/** Horizontal extent of a set of points. */
export const ySpanX = (pts: readonly Pt[]): { lo: number; hi: number } => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.x < lo) lo = p.x;
    if (p.x > hi) hi = p.x;
  }
  return Number.isFinite(hi - lo) ? { lo, hi } : { lo: 0, hi: 0 };
};

/** Axis-aligned bounding box of a set of points. */
export const bbox = (
  pts: readonly Pt[],
): { minX: number; minY: number; maxX: number; maxY: number } => {
  const x = ySpanX(pts);
  const y = ySpan(pts);
  return { minX: x.lo, minY: y.lo, maxX: x.hi, maxY: y.hi };
};

/** Sample a spline's y(x) over [x0, x1] into a polyline. */
export const sampleProfile = (s: Spline, x0: number, x1: number, steps: number): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    pts.push({ x, y: valueAt(s, x) });
  }
  return pts;
};

/** Closed plan-view outline loop (both rails) of a board, sampled at `steps`. */
export const planOutlineLoop = (b: BezierBoard, steps: number): Pt[] => {
  const len = getLength(b);
  const e = Math.min(0.01, len / (steps * 4));
  const top: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = e + ((len - 2 * e) * i) / steps;
    top.push({ x, y: valueAt(b.outline, x) });
  }
  return [...top, ...[...top].reverse().map((p) => ({ x: p.x, y: -p.y }))];
};

/**
 * Closed cross-section ring at `pos` (a full lateral profile: the +x rail mirrored
 * across the stringer to -x). Coordinates are local section coords (x = lateral,
 * y = thickness). Returns `null` if no section interpolates at `pos`.
 */
export const crossSectionRing = (
  board: BezierBoard,
  pos: number,
  ringSteps: number,
): Pt[] | null => {
  const cs = getInterpolatedCrossSection(board, pos);
  if (!cs) return null;
  const ring: Pt[] = [];
  for (let r = ringSteps; r >= 0; r--) {
    const p = pointByTT(cs.spline, r / ringSteps);
    ring.push({ x: -p.x, y: p.y });
  }
  for (let r = 0; r <= ringSteps; r++) {
    const p = pointByTT(cs.spline, r / ringSteps);
    ring.push({ x: p.x, y: p.y });
  }
  return ring;
};
