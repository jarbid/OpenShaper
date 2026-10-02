// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Thin adapter over `clipper-lib` (the Angus Johnson Clipper 1 JS port) for our
 * 2D closed-polygon offsetting and boolean ops. We pick this over `clipper2-js`
 * because the latter's `InflatePaths` ships broken in 1.2.x — even a 100×100
 * square offset by ±10 produced a self-intersecting six-point salad in our
 * smoke tests; clipper-lib's `ClipperOffset` returns the expected square.
 *
 * Open-polyline offsets stay in `geom.ts` (naive averaged-normal) — the rib
 * half-profile takes a closed-mirror trip through this adapter instead, so we
 * don't need a robust open-polyline offset here.
 *
 * Clipper operates on integer coordinates; we scale cm → int by {@link SCALE}
 * (0.1 µm precision) on the way in and back out, well below the 0.2 mm sample
 * tolerance the builders use.
 */
// clipper-lib has no published types.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- runtime-only JS module
import ClipperLib from 'clipper-lib';
import type { Pt } from './types';

interface IntPt {
  X: number;
  Y: number;
}
type IntPath = IntPt[];

const SCALE = 1e4;

export const JoinType = {
  Miter: ClipperLib.JoinType.jtMiter,
  Round: ClipperLib.JoinType.jtRound,
  Square: ClipperLib.JoinType.jtSquare,
} as const;
export type JoinTypeValue = (typeof JoinType)[keyof typeof JoinType];

const FILL_NONZERO = ClipperLib.PolyFillType.pftNonZero;

const toPath = (pts: readonly Pt[]): IntPath =>
  pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));

const fromPath = (path: IntPath): Pt[] => path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));

const fromPaths = (paths: IntPath[]): Pt[][] => paths.map(fromPath);

const pickLargest = (paths: IntPath[]): Pt[] => {
  if (paths.length === 0) return [];
  let bestIdx = 0;
  let bestArea = -1;
  for (let i = 0; i < paths.length; i++) {
    const a = Math.abs(ClipperLib.Clipper.Area(paths[i]!));
    if (a > bestArea) {
      bestArea = a;
      bestIdx = i;
    }
  }
  return fromPath(paths[bestIdx]!);
};

export interface OffsetOpts {
  /** Corner style. Default `Miter` so slot corners stay sharp. */
  joinType?: JoinTypeValue;
  /** Miter cutoff before falling back to bevel. Default 2 (sharp 90° stays sharp). */
  miterLimit?: number;
}

const offsetRaw = (pts: readonly Pt[], dist: number, opts: OffsetOpts): IntPath[] => {
  const co = new ClipperLib.ClipperOffset(opts.miterLimit ?? 2, 0.25);
  co.AddPaths([toPath(pts)], opts.joinType ?? JoinType.Miter, ClipperLib.EndType.etClosedPolygon);
  const sol: IntPath[] = [];
  co.Execute(sol, dist * SCALE);
  return sol;
};

/**
 * Offset a closed polygon by `dist` (cm); positive grows, negative insets.
 * Backed by Clipper so concave corners and tight curvature get cleaned up
 * instead of self-intersecting. Returns the largest result loop; callers
 * wanting every piece can use {@link offsetClosedAll}.
 */
export const offsetClosedClipper = (
  pts: readonly Pt[],
  dist: number,
  opts: OffsetOpts = {},
): Pt[] => {
  if (pts.length < 3 || dist === 0) return [...pts];
  return pickLargest(offsetRaw(pts, dist, opts));
};

/** Same as {@link offsetClosedClipper} but returns ALL result loops. */
export const offsetClosedAll = (
  pts: readonly Pt[],
  dist: number,
  opts: OffsetOpts = {},
): Pt[][] => {
  if (pts.length < 3 || dist === 0) return [[...pts]];
  return fromPaths(offsetRaw(pts, dist, opts));
};

const runBool = (clipType: number, subject: readonly Pt[], clip: readonly Pt[]): IntPath[] => {
  const c = new ClipperLib.Clipper();
  c.AddPaths([toPath(subject)], ClipperLib.PolyType.ptSubject, true);
  c.AddPaths([toPath(clip)], ClipperLib.PolyType.ptClip, true);
  const sol: IntPath[] = [];
  c.Execute(clipType, sol, FILL_NONZERO, FILL_NONZERO);
  return sol;
};

/** Polygon difference of one subject minus MANY clip loops at once. */
export const differenceMulti = (
  subject: readonly Pt[],
  clips: readonly (readonly Pt[])[],
): Pt[][] => {
  if (clips.length === 0) return [[...subject]];
  const c = new ClipperLib.Clipper();
  c.AddPaths([toPath(subject)], ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(
    clips.map((cl) => toPath(cl)),
    ClipperLib.PolyType.ptClip,
    true,
  );
  const sol: IntPath[] = [];
  c.Execute(ClipperLib.ClipType.ctDifference, sol, FILL_NONZERO, FILL_NONZERO);
  return fromPaths(sol);
};

/**
 * Thicken an OPEN polyline into a closed band of total width `2 * halfWidth`
 * (cm), rounded at joins and ends. Used to turn truss-web centrelines into
 * solid struts before differencing them from a rib region.
 */
export const offsetOpenBand = (pts: readonly Pt[], halfWidth: number): Pt[][] => {
  if (pts.length < 2 || halfWidth <= 0) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPaths([toPath(pts)], JoinType.Round, ClipperLib.EndType.etOpenRound);
  const sol: IntPath[] = [];
  co.Execute(sol, halfWidth * SCALE);
  return fromPaths(sol);
};

/** Closed circle approximation, sampled to ≤ `tol` chord deviation. */
export const sampleCircle = (cx: number, cy: number, r: number, tol: number): Pt[] => {
  if (r <= 0) return [];
  const ratio = Math.min(0.999, tol / r);
  const n = Math.max(16, Math.ceil(Math.PI / Math.acos(1 - ratio)));
  const out: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out[i] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  return out;
};

const intPathArea = (p: IntPath): number => Math.abs(ClipperLib.Clipper.Area(p));

/**
 * True iff a disc of radius `r` centred at (cx, cy) lies fully inside `region`.
 * Implemented by intersecting the disc with the region and checking the result's
 * area equals the disc's area within ~0.1 %.
 */
export const discFitsInRegion = (
  region: readonly Pt[],
  cx: number,
  cy: number,
  r: number,
): boolean => {
  if (region.length < 3 || r <= 0) return false;
  const disc = sampleCircle(cx, cy, r, Math.max(r * 0.02, 0.02));
  const discInt = toPath(disc);
  const inter = runBool(ClipperLib.ClipType.ctIntersection, disc, region);
  if (inter.length !== 1) return false;
  return intPathArea(inter[0]!) >= intPathArea(discInt) * 0.999;
};
