// SPDX-License-Identifier: GPL-3.0-or-later
/** Small 2D polyline utilities for the construction-template builders/writers. */
import type { Label, Loop, Part, Pt } from './types';

export interface Bbox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const EMPTY_BBOX: Bbox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export const bboxOfPts = (pts: readonly Pt[]): Bbox => {
  if (pts.length === 0) return EMPTY_BBOX;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};

export const partBbox = (part: Part): Bbox => {
  const all: Pt[] = [];
  for (const l of part.loops) all.push(...l.pts);
  for (const lbl of part.labels ?? []) all.push(lbl.at);
  return bboxOfPts(all);
};

export const bboxWidth = (b: Bbox): number => b.maxX - b.minX;
export const bboxHeight = (b: Bbox): number => b.maxY - b.minY;

const translatePt = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy });
const translateLabel = (l: Label, dx: number, dy: number): Label => ({
  ...l,
  at: translatePt(l.at, dx, dy),
});

export const translatePart = (part: Part, dx: number, dy: number): Part => ({
  ...part,
  loops: part.loops.map((l) => ({ ...l, pts: l.pts.map((p) => translatePt(p, dx, dy)) })),
  labels: part.labels?.map((l) => translateLabel(l, dx, dy)),
});

/**
 * Arrange a sheet's parts left-to-right with `gap` between them, each part dropped
 * into the positive quadrant (minX/minY → gap). Used by the multi-part writers
 * (DXF/SVG); PDF places one part per page and ignores this.
 */
export const rowLayout = (parts: readonly Part[], gap: number): Part[] => {
  let cursorX = gap;
  const out: Part[] = [];
  for (const part of parts) {
    const b = partBbox(part);
    out.push(translatePart(part, cursorX - b.minX, gap - b.minY));
    cursorX += bboxWidth(b) + gap;
  }
  return out;
};

/** Signed area (shoelace); >0 for counter-clockwise winding. */
export const signedArea = (pts: readonly Pt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

const norm = (x: number, y: number): Pt => {
  const len = Math.hypot(x, y);
  return len < 1e-12 ? { x: 0, y: 0 } : { x: x / len, y: y / len };
};

/**
 * Offset a closed polygon by `dist` (cm) along per-vertex averaged edge normals:
 * `dist > 0` grows the contour outward, `dist < 0` insets it. Naive (no
 * self-intersection cleanup) — fine for the smooth, convex-ish board sections at
 * our scales. Concave vertices (e.g. slot mouths) are offset consistently because
 * the averaged outward normal points the right way.
 */
export const offsetClosed = (pts: readonly Pt[], dist: number): Pt[] => {
  const n = pts.length;
  if (n < 3 || dist === 0) return [...pts];
  const s = signedArea(pts) >= 0 ? 1 : -1; // +1 CCW
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    // Outward normal of an edge for CCW winding is (dy, -dx); flip for CW via `s`.
    const e1 = norm(s * (cur.y - prev.y), s * -(cur.x - prev.x));
    const e2 = norm(s * (next.y - cur.y), s * -(next.x - cur.x));
    const nx = e1.x + e2.x;
    const ny = e1.y + e2.y;
    const m = norm(nx, ny);
    out.push({ x: cur.x + m.x * dist, y: cur.y + m.y * dist });
  }
  return out;
};

/**
 * Offset an OPEN polyline by `dist` (cm) along its left-hand normals (rotate the
 * travel tangent +90°: `(-dy, dx)`). Endpoints use their single adjacent edge.
 * For a board half-profile sampled bottom-center → rail → deck-center, the left
 * normal points toward the board interior, so a positive `dist` insets it.
 */
export const offsetOpen = (pts: readonly Pt[], dist: number): Pt[] => {
  const n = pts.length;
  if (n < 2 || dist === 0) return [...pts];
  const edgeNormal = (a: Pt, b: Pt): Pt => norm(-(b.y - a.y), b.x - a.x);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) {
      const e = edgeNormal(pts[0]!, pts[1]!);
      nx = e.x;
      ny = e.y;
    } else if (i === n - 1) {
      const e = edgeNormal(pts[n - 2]!, pts[n - 1]!);
      nx = e.x;
      ny = e.y;
    } else {
      const e1 = edgeNormal(pts[i - 1]!, pts[i]!);
      const e2 = edgeNormal(pts[i]!, pts[i + 1]!);
      const m = norm(e1.x + e2.x, e1.y + e2.y);
      nx = m.x;
      ny = m.y;
    }
    out.push({ x: pts[i]!.x + nx * dist, y: pts[i]!.y + ny * dist });
  }
  return out;
};

/** Drop consecutive points within `eps` (cm) of each other. */
export const dedupe = (pts: readonly Pt[], eps = 1e-6): Pt[] => {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p);
  }
  return out;
};

/**
 * Adaptively sample a parametric curve `f(t)` over [t0, t1] so the polyline stays
 * within `tol` (cm) of the true curve, subdividing where the midpoint deviates from
 * the chord. Returns the interior + start points (NOT the final endpoint — append
 * `f(t1)` yourself, which lets callers chain segments without duplicate vertices).
 */
export const sampleAdaptive = (
  f: (t: number) => Pt,
  t0: number,
  t1: number,
  tol: number,
  depth = 0,
): Pt[] => {
  const a = f(t0);
  const b = f(t1);
  const tm = (t0 + t1) / 2;
  const m = f(tm);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const dev = Math.hypot(m.x - cx, m.y - cy);
  if (depth >= 16 || dev <= tol) return [a];
  return [
    ...sampleAdaptive(f, t0, tm, tol, depth + 1),
    ...sampleAdaptive(f, tm, t1, tol, depth + 1),
  ];
};

/** Adaptive samples of `f` over [t0, t1] INCLUDING the final endpoint. */
export const sampleCurve = (f: (t: number) => Pt, t0: number, t1: number, tol: number): Pt[] => [
  ...sampleAdaptive(f, t0, t1, tol),
  f(t1),
];

/** Total polyline length (open). */
export const pathLength = (pts: readonly Pt[]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return len;
};

/** Convenience constructor for a loop. */
export const loop = (
  kind: Loop['kind'],
  closed: boolean,
  pts: readonly Pt[],
  dashed = false,
): Loop => ({
  kind,
  closed,
  pts,
  dashed,
});
