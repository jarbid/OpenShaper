// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared board-curve samplers used by the DXF and 1:1-PDF exporters, so both draw
 * **identical** geometry from the same board. All coordinates are in centimetres
 * (the kernel's internal unit); plan coords are x = length, y = lateral (rail).
 */
import {
  getInterpolatedCrossSection,
  getLength,
  hasTailCutout,
  pointByTT,
  valueAt,
  type BezierBoard,
  type Spline,
} from '@openshaper/kernel';

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** One cubic-bezier segment in export coords (cm): start, two controls, end. */
export interface CurveSeg {
  readonly p0: Pt;
  readonly c1: Pt;
  readonly c2: Pt;
  readonly p3: Pt;
}

/**
 * A spline's segments as cubic-bezier control points — the *exact* designed curve,
 * not a flattened polyline. `map` lets callers transform into plan/section coords
 * (e.g. mirror across an axis). This is what keeps the PDF curves smooth and true
 * to the editor (which renders the same beziers), instead of faceting under the
 * value-at-x sampling used for extents.
 */
export const splineSegments = (
  s: Spline,
  map: (p: { x: number; y: number }) => Pt = (p) => ({ x: p.x, y: p.y }),
): CurveSeg[] =>
  s.curves.map((c) => ({ p0: map(c.p0), c1: map(c.c1), c2: map(c.c2), p3: map(c.p3) }));

/** Reverse a segment's direction (p0↔p3, c1↔c2) and mirror its y (for the far rail). */
const reverseMirrorY = (s: CurveSeg): CurveSeg => ({
  p0: { x: s.p3.x, y: -s.p3.y },
  c1: { x: s.c2.x, y: -s.c2.y },
  c2: { x: s.c1.x, y: -s.c1.y },
  p3: { x: s.p0.x, y: -s.p0.y },
});

/** Reverse a segment's direction and mirror its x (for the −x half of a section). */
const reverseMirrorX = (s: CurveSeg): CurveSeg => ({
  p0: { x: -s.p3.x, y: s.p3.y },
  c1: { x: -s.c2.x, y: s.c2.y },
  c2: { x: -s.c1.x, y: s.c1.y },
  p3: { x: -s.p0.x, y: s.p0.y },
});

/** Closed plan outline (both rails) as exact bezier segments: nose→tail, then mirrored back. */
export const planOutlineBeziers = (b: BezierBoard): CurveSeg[] => {
  const top = splineSegments(b.outline);
  const bottom = [...top].reverse().map(reverseMirrorY);
  return [...top, ...bottom];
};

/** Point on a cubic-bezier segment at parameter t∈[0,1]. */
const cubicPt = (s: CurveSeg, t: number): Pt => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p3.x,
    y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p3.y,
  };
};

/**
 * Flatten exact bezier segments to a polyline by sampling each segment along its
 * **parameter** (`perSeg` points per segment) — like the editor's `sampleSpline`. This
 * distributes points along the curve, not along x, so high-curvature regions (the tail)
 * stay smooth instead of faceting. Shared knots are de-duplicated; a discontinuity
 * between segments (a tail/nose cut edge) is preserved as a straight join.
 */
export const flattenBeziers = (segs: readonly CurveSeg[], perSeg: number): Pt[] => {
  const steps = Math.max(2, Math.floor(perSeg));
  const pts: Pt[] = [];
  let prev: Pt | null = null;
  for (const s of segs) {
    const continuous = prev !== null && prev.x === s.p0.x && prev.y === s.p0.y;
    for (let i = continuous ? 1 : 0; i <= steps; i++) pts.push(cubicPt(s, i / steps));
    prev = s.p3;
  }
  return pts;
};

/** Transform every control point of a segment (translate/mirror — affine, curve-preserving). */
export const mapSeg = (s: CurveSeg, f: (p: Pt) => Pt): CurveSeg => ({
  p0: f(s.p0),
  c1: f(s.c1),
  c2: f(s.c2),
  p3: f(s.p3),
});

/** A straight edge as a degenerate cubic (collinear controls) — exact line in a bezier chain. */
const linearSeg = (a: Pt, b: Pt): CurveSeg => ({
  p0: a,
  c1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
  c2: { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 },
  p3: b,
});

/**
 * Make `segs` a single continuous chain by bridging any gaps (and, if `closed`, the
 * loop closure) with straight linear-bezier segments. The result has every
 * `seg[i].p3 === seg[i+1].p0`, so it can be emitted as one DXF SPLINE / one closed
 * contour for CAM.
 */
export const chainSegs = (segs: readonly CurveSeg[], closed: boolean): CurveSeg[] => {
  const out: CurveSeg[] = [];
  for (const s of segs) {
    const prev = out.length ? out[out.length - 1]!.p3 : null;
    if (prev && (prev.x !== s.p0.x || prev.y !== s.p0.y)) out.push(linearSeg(prev, s.p0));
    out.push(s);
  }
  if (closed && out.length) {
    const last = out[out.length - 1]!.p3;
    const first = out[0]!.p0;
    if (last.x !== first.x || last.y !== first.y) out.push(linearSeg(last, first));
  }
  return out;
};

/** Closed cross-section ring at `pos` as exact bezier segments (−x half mirrored + +x half). */
export const crossSectionBeziers = (board: BezierBoard, pos: number): CurveSeg[] | null => {
  const cs = getInterpolatedCrossSection(board, pos);
  if (!cs) return null;
  const half = splineSegments(cs.spline);
  const mirrored = [...half].reverse().map(reverseMirrorX);
  return [...mirrored, ...half];
};

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
  // A concave tail (swallow / fish) is non-monotonic in x, so an x-sampled y(x)
  // would collapse the notch. Trace the outline PARAMETRICALLY instead (following
  // the fold), then mirror. Normal (single-valued) boards keep the exact x-sampled
  // path so existing diagram / PDF output is unchanged.
  if (hasTailCutout(b.outline)) {
    const segs = splineSegments(b.outline);
    const perSeg = Math.max(2, Math.ceil(steps / Math.max(1, segs.length)));
    const top = flattenBeziers(segs, perSeg);
    return [...top, ...[...top].reverse().map((p) => ({ x: p.x, y: -p.y }))];
  }
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
