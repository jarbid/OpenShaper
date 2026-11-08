// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The smooth blade: the fin's new surface engine (docs/design/fin-designer.md, "A new
 * surface engine"). The same design as the sweep (blade.ts, swept-loft.ts) — outline,
 * base and tip foils, thickness curve and path, minimum thickness, cant and toe — built
 * as **one smooth surface** laid along the fin, so blending them can't crease it.
 *
 * ## The layout: (s, u)
 *
 * The profile is one four-sided region: the **base** (the root, and a raised rear's
 * underside), the **leading edge** on past the tip line and round the tip, a short
 * **last row** about the middle of the tip edge, and the **trailing edge** likewise. The
 * **tip line** is one row, exactly straight (owner testing: as a row bulging toward the
 * tip, the straight tip line cut across rows, and its ends were thinned far below the
 * tip foil drawn, even concave). It is laid out as an elliptic grid (smooth-map.ts,
 * Winslow), which can't fold, even on a hook, and read through bicubic splines, so every
 * point of the profile has a place (s, u) that changes smoothly across it:
 *
 * - s runs from the base (0) up the fin to the tip edge (1), following its curve: on a
 *   hook, along the arm;
 * - u runs across, from the leading edge (0) to the trailing edge (1). Each row (s
 *   fixed) is a section of the fin from edge to edge.
 *
 * ## The shape on it
 *
 * Every attribute is a smooth function of (s, u), and the faces are put together from
 * them by sums and products only, never a clamp, a table read straight or a switch:
 *
 * - **Along the row**, `along(s, u)`: the fraction of the row's length from the leading
 *   edge, so a foil is laid along a row by length.
 * - **Thickness path**, p(s): where each row is thickest (the design's base, middle and
 *   tip line values, the same quadratic as the sweep's, over the whole fin).
 * - **Foil**: the base foil and the tip foil, each laid so its thickest point is on the
 *   path, read where the row is, as fractions of their thickest; blended from the base to
 *   the tip line by `smootherstep`, flat at both ends. The warp from the row to the foil,
 *   x/(x + λ(1 − x)), leaves the edges' slope finite, so a round nose stays round (the
 *   sweep's power curve made it sharper or blunter).
 * - **Thickness**: the thickness curve read by how far along the fin the row's thickest
 *   point is, η(s), the thickness path's length from the base: on an upright fin about
 *   its height, as the curve is drawn; on a swept one, along the sweep.
 * - **The tip**: the tip line is a row, so the tip foil lies along it as drawn, at one
 *   thickness. Beyond it the rows shorten toward the middle of the tip edge, the outline
 *   round the tip being their edges, so the tip thins as a foil's nose does. The short
 *   last row closes to the minimum as √(1 − t³) over the outer half of those rows.
 * - **Minimum**: the foil scaled to the thickness less the minimum, then the minimum
 *   added all over (symmetric foils half each side): the edges and the tip edge end at it
 *   exactly, with no clamp.
 *
 * - **Control sections**: each a row, its height the fraction of the way from the base
 *   to the tip line along the fin, its foil drawn for that row. Kept as its
 *   difference to the fin without sections on its row, along the row, laid in full there
 *   and easing out over FIN_SLICE_REACH either side, gone by the tip line, or blended into the next section's where they are closer.
 *   So a section's row is its foil exactly, and one added as the foil already there
 *   changes nothing (smoothFoilAt).
 *
 * Then cant and toe: the fin's lean (a shear, as the sweep's) and toe (a turn about the
 * root's thickest point). A section's cant (blade.ts twistAt, by s) leans the blade more
 * from its row up, each point sliding out by the lean summed up its column from the base,
 * so the blade bends; its toe turns each row about the row's own thickest point.
 */
import type { Vert3 } from '../loft';
import { yAtX } from './curve-shape';
import {
  cosineStations,
  FIN_SLICE_REACH,
  fitFoil,
  hasTwist,
  NO_LAMINATE,
  prepareBlade,
  sectionShapeAt,
  sectionThickest,
  thicknessPathOf,
  tipFoilOf,
  toeTurn,
  twistAt,
  type FinLaminate,
  type PreparedBlade,
} from './blade';
import { DEG_TO_RAD } from '../constants';
import { FIN_MIN_THICKNESS, type FinDesign, type FinSection } from './fin-design';
import { spline1, spline2, winslowGrid, type P2, type Sides, type Spline2 } from './smooth-map';
import { findRaisedRear } from './raised-rear';
import { sweepFrame, thicknessPathAt } from './swept-loft';

/** The elliptic grid's size: rows up the fin, columns across it. */
export const SMOOTH_MAP = { rows: 64, cols: 48 } as const;

/** Sub-steps per grid cell when measuring a row's length. */
const ROW_STEPS = 8;

/** Rows the thickness path's length is measured over (η). */
const SPINE_SAMPLES = 256;

/** A polyline read by fraction of its length. */
interface Polyline {
  readonly pts: readonly P2[];
  readonly cum: ArrayLike<number>;
}

const alongPath = (p: Polyline, f: number): P2 => {
  const n = p.pts.length - 1;
  const total = p.cum[n]!;
  if (!(total > 0)) return p.pts[0]!;
  const target = Math.min(1, Math.max(0, f)) * total;
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid]! <= target) lo = mid;
    else hi = mid;
  }
  const span = p.cum[hi]! - p.cum[lo]!;
  const t = span > 0 ? (target - p.cum[lo]!) / span : 0;
  const a = p.pts[lo]!;
  const b = p.pts[hi]!;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
};

/**
 * The base at fraction `u` of its run back from the leading-edge root, by x along the
 * root as the sweep reads it: a raised rear's steep underside takes little of it.
 */
const acrossBase = (p: Polyline, u: number): P2 => {
  const pts = p.pts;
  const x0 = pts[0]!.x;
  const x1 = pts[pts.length - 1]!.x;
  const target = x0 + (x1 - x0) * Math.min(1, Math.max(0, u));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if ((target - a.x) * (target - b.x) <= 0 && a.x !== b.x) {
      const t = (target - a.x) / (b.x - a.x);
      return { x: target, y: a.y + (b.y - a.y) * t };
    }
  }
  return u <= 0 ? pts[0]! : pts[pts.length - 1]!;
};

/** The profile's layout: (s, u) → (x, z), and how far along its row each point is. */
export interface SmoothMap {
  readonly x: Spline2;
  readonly z: Spline2;
  /** Fraction of the row's length from the leading edge. */
  readonly along: Spline2;
  /** The tip line's ends (tab frame, cm). */
  readonly tipStart: P2;
  readonly tipEnd: P2;
  /** The row (s) that is the tip line, straight from end to end. */
  readonly sTip: number;
}

/** Passes of smoothing up the fin over the fraction-along table; rows a correction eases over. */
const ALONG_SMOOTHING = 8;
const ALONG_EASE = 8;
/** Rows above the base a raised rear's fin eases that smoothing in over. */
const ALONG_BASE = 16;

/** How much of the tip edge, about its middle, the last row is: the rows close up to it. */
const TIP_TOP = 0.1;

/** A polyline through `pts`, with its running length. */
const polyline = (pts: readonly P2[]): Polyline => {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return { pts, cum };
};

/** The points of `p` from fraction `a` to `b` of its length (either way round). */
const stretch = (p: Polyline, a: number, b: number): P2[] => {
  const n = p.pts.length - 1;
  const total = p.cum[n]!;
  const [lo, hi] = [Math.min(a, b) * total, Math.max(a, b) * total];
  const mid = p.pts.filter((_, i) => p.cum[i]! > lo && p.cum[i]! < hi);
  const pts = [alongPath(p, Math.min(a, b)), ...mid, alongPath(p, Math.max(a, b))];
  return a <= b ? pts : pts.reverse();
};

const mapCache = new WeakMap<object, Map<string, SmoothMap>>();

/** The design's layout, cached per outline and tip line (the elliptic solve is the cost). */
export const smoothMap = (d: FinDesign): SmoothMap => {
  const key = d.tipLine ? `${d.tipLine.start},${d.tipLine.end}` : 'default';
  let byLine = mapCache.get(d.outline);
  if (!byLine) mapCache.set(d.outline, (byLine = new Map()));
  const hit = byLine.get(key);
  if (hit) return hit;
  const f = sweepFrame(d);
  const { rows, cols } = SMOOTH_MAP;
  // Each edge runs on past the tip line round the tip, up to the short last row.
  const half = (1 - TIP_TOP) / 2;
  const left = polyline([...f.leading.pts, ...stretch(f.tipEdge, 0, half).slice(1)]);
  const right = polyline([...f.trailing.pts, ...stretch(f.tipEdge, 1, 1 - half).slice(1)]);
  const fraction = (edge: Polyline, part: Polyline) =>
    part.cum[part.pts.length - 1]! / (edge.cum[edge.pts.length - 1]! || 1);
  const fL = fraction(left, f.leading);
  const fR = fraction(right, f.trailing);
  // The tip line is one row, so both edges must reach its ends on it: each is read through
  // a smooth warp putting that row at the tip line's end.
  const tipRow = Math.min(rows - 4, Math.max(8, Math.round(((fL + fR) / 2) * rows)));
  const sTip = tipRow / rows;
  const sides: Sides = {
    bottom: (t) => acrossBase(f.base, t),
    top: (t) => alongPath(f.tipEdge, half + TIP_TOP * t),
    left: (t) => alongPath(left, foilWarp(t, sTip, fL)),
    right: (t) => alongPath(right, foilWarp(t, sTip, fR)),
  };
  const g = winslowGrid(sides, rows, cols);
  // The tip line's row made exactly straight: its points moved square to where they lie by
  // length along it, the move eased out over the rows either side, flat at the row and
  // at both ends, so the layout stays smooth through it.
  const w = cols + 1;
  const base = tipRow * w;
  const run = new Float64Array(w);
  for (let j = 1; j <= cols; j++) {
    run[j] =
      run[j - 1]! +
      Math.hypot(g.x[base + j]! - g.x[base + j - 1]!, g.y[base + j]! - g.y[base + j - 1]!);
  }
  const len = run[cols]! || 1;
  const moveX = new Float64Array(w);
  const moveZ = new Float64Array(w);
  for (let j = 1; j < cols; j++) {
    const t = run[j]! / len;
    moveX[j] = f.tipStart.x + (f.tipEnd.x - f.tipStart.x) * t - g.x[base + j]!;
    moveZ[j] = f.tipStart.y + (f.tipEnd.y - f.tipStart.y) * t - g.y[base + j]!;
  }
  for (let i = 1; i < rows; i++) {
    const b = smootherstep(i <= tipRow ? i / tipRow : (rows - i) / (rows - tipRow));
    for (let j = 1; j < cols; j++) {
      g.x[i * w + j] = g.x[i * w + j]! + moveX[j]! * b;
      g.y[i * w + j] = g.y[i * w + j]! + moveZ[j]! * b;
    }
  }
  const x = spline2(g.x, rows, cols);
  const z = spline2(g.y, rows, cols);
  // Each row's length from the leading edge, measured along the splines.
  const along = new Float64Array((rows + 1) * w);
  for (let i = 0; i <= rows; i++) {
    let length = 0;
    let px = x.at(i, 0);
    let pz = z.at(i, 0);
    for (let j = 1; j <= cols; j++) {
      for (let k = 1; k <= ROW_STEPS; k++) {
        const c = j - 1 + k / ROW_STEPS;
        const qx = x.at(i, c);
        const qz = z.at(i, c);
        length += Math.hypot(qx - px, qz - pz);
        px = qx;
        pz = qz;
      }
      along[i * w + j] = length;
    }
    for (let j = 1; j <= cols; j++) {
      along[i * w + j] = length > 0 ? along[i * w + j]! / length : j / cols;
    }
  }
  // Each column of it smoothed up the fin, a few rows' worth: a row's fraction hangs on its
  // whole length, so a corner in an edge (the starting fins' at the tip's rear) stepped it
  // right across the blade. The base and tip line rows stay as they are, so their foils
  // lie along them as drawn.
  const raw = along.slice();
  for (let j = 1; j < cols; j++) {
    const true0 = along[tipRow * w + j]!;
    for (let pass = 0; pass < ALONG_SMOOTHING; pass++) {
      let last = along[j]!;
      for (let i = 1; i < rows; i++) {
        const here = along[i * w + j]!;
        along[i * w + j] = (last + 2 * here + along[(i + 1) * w + j]!) / 4;
        last = here;
      }
    }
    const off = true0 - along[tipRow * w + j]!;
    for (let i = 1; i < rows; i++) {
      const away = Math.abs(i - tipRow) / ALONG_EASE;
      if (away < 1) along[i * w + j] = along[i * w + j]! + off * (1 - smootherstep(away));
    }
  }
  // Not at a raised rear: its base row is meant to step where the underside begins.
  if (findRaisedRear(d.outline)) {
    for (let i = 1; i < ALONG_BASE; i++) {
      const b = smootherstep(i / ALONG_BASE);
      for (let j = 1; j < cols; j++) {
        along[i * w + j] = raw[i * w + j]! + (along[i * w + j]! - raw[i * w + j]!) * b;
      }
    }
  }
  const m = {
    x,
    z,
    along: spline2(along, rows, cols),
    tipStart: f.tipStart,
    tipEnd: f.tipEnd,
    sTip,
  };
  byLine.set(key, m);
  return m;
};

/** 0 → 1 with flat ends: 6t⁵ − 15t⁴ + 10t³, its first two derivatives 0 at both. */
const smootherstep = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
};

/**
 * The foil fraction read at fraction `x` along a row thickest at `p`, for a foil
 * thickest at `a`: x / (x + λ(1 − x)), with λ putting a at p. Rising, smooth, 0 and 1 at
 * the ends, with a finite slope there (1/λ and λ), so a round nose stays round.
 */
export const foilWarp = (x: number, p: number, a: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lam = (p * (1 - a)) / (a * (1 - p));
  return x / (x + lam * (1 - x));
};

/** A foil read as fractions of its thickest, and its share of the minimum on the outside. */
interface EndFoil {
  readonly sec: FinSection;
  readonly at: number;
  readonly thickness: number;
  readonly share: number;
}

const endFoil = (sec: FinSection): EndFoil => {
  const t = sectionThickest(sec);
  return { sec, at: t.at, thickness: t.thickness, share: sec.inside === null ? 0.5 : 1 };
};

/** The smooth blade of a design (see the file comment). */
export interface SmoothBlade {
  readonly blade: PreparedBlade;
  readonly map: SmoothMap;
  /** The row (s) that is the tip line. */
  readonly sTip: number;
  /** The profile point at (s, u) (tab frame, cm). */
  point(s: number, u: number): P2;
  /** The faces' offsets from the blade's middle plane at (s, u) (cm, + outward), before cant and toe. */
  offsets(s: number, u: number): [number, number];
  /** The two faces at (s, u), in the fin frame (blade.ts), cant and toe applied. */
  faces(s: number, u: number): { outside: Vert3; inside: Vert3 };
  /**
   * The foil on row s, `along` of the way along it: its faces as fractions of the row's
   * thickest, control sections included; and its share of the minimum on the outside.
   */
  foil(s: number, along: number): [number, number, number];
  /** How thick (cm) row s is at its thickest, less the minimum. */
  scale(s: number): number;
  /** How far along the fin row s is, by the thickness path's length: 0 base, 1 tip edge. */
  eta(s: number): number;
}

const bladeCache = new WeakMap<PreparedBlade, SmoothBlade>();

const designCache = new WeakMap<FinDesign, SmoothBlade>();

/**
 * The smooth blade of a design. The finished blade (no laminate, the design minimum) is
 * kept per design: the editor's guides and readouts ask for it after every edit.
 */
export const smoothBlade = (
  d: FinDesign,
  laminate: FinLaminate = NO_LAMINATE,
  minThickness: number = FIN_MIN_THICKNESS,
): SmoothBlade => {
  const plain = laminate === NO_LAMINATE && minThickness === FIN_MIN_THICKNESS;
  const hit = plain ? designCache.get(d) : undefined;
  if (hit) return hit;
  const sb = smoothBladeOf(prepareBlade(d, laminate, minThickness));
  if (plain) designCache.set(d, sb);
  return sb;
};

export const smoothBladeOf = (b: PreparedBlade): SmoothBlade => {
  const hit = bladeCache.get(b);
  if (hit) return hit;
  const d = b.design;
  const map = smoothMap(d);
  const { rows, cols } = SMOOTH_MAP;
  const point = (s: number, u: number): P2 => ({
    x: map.x.at(s * rows, u * cols),
    y: map.z.at(s * rows, u * cols),
  });
  const alongAt = (s: number, u: number) =>
    Math.min(1, Math.max(0, map.along.at(s * rows, u * cols)));
  const { sTip } = map;
  const way = thicknessPathOf(d);
  // The path, ending exactly on the tip foil's thickest point at the tip line, so the tip
  // foil lies along it as drawn; beyond, carried on.
  const pathEnd = way[2] - thicknessPathAt(way, sTip);
  const pathAt = (s: number) => thicknessPathAt(way, s) + pathEnd * smootherstep(s / sTip);
  /** The u on row s whose fraction along it is `f`. */
  const uAlong = (s: number, f: number): number => {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (alongAt(s, mid) < f) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  // The thickness path on the profile: its length from the base (η).
  const spine = Array.from({ length: SPINE_SAMPLES + 1 }, (_, k) => {
    const s = k / SPINE_SAMPLES;
    return point(s, uAlong(s, pathAt(s)));
  });
  const run = new Float64Array(SPINE_SAMPLES + 1);
  for (let k = 1; k <= SPINE_SAMPLES; k++) {
    run[k] = run[k - 1]! + Math.hypot(spine[k]!.x - spine[k - 1]!.x, spine[k]!.y - spine[k - 1]!.y);
  }
  const total = run[SPINE_SAMPLES]! || 1;
  const eta = spline1(Array.from(run, (r) => r / total));
  const base = endFoil(d.section);
  const tip = endFoil(tipFoilOf(d));
  const m = b.minThickness;
  const read = (f: EndFoil, along: number, p: number): [number, number] => {
    if (!(f.thickness > 0)) return [0, 0];
    const [o, n] = sectionShapeAt(f.sec, foilWarp(along, p, f.at));
    return [o / f.thickness, n / f.thickness];
  };
  /**
   * The fin without control sections at row s, `along` of the way along it: its faces as
   * fractions of the row's thickest, and its share of the minimum on the outside.
   */
  const bare = (s: number, along: number): [number, number, number] => {
    const p = pathAt(s);
    const w = smootherstep(s / sTip);
    const [oa, na] = read(base, along, p);
    const share = base.share + (tip.share - base.share) * w;
    if (tip.sec === base.sec || !(w > 0)) return [oa, na, share];
    const [ob, nb] = read(tip, along, p);
    return [oa + (ob - oa) * w, na + (nb - na) * w, share];
  };
  // Control sections (stage 3): each a row, its height the fraction of the way to the tip line. Kept as
  // its difference to the bare fin on its row, along the row, laid in full on its row and
  // eased out over FIN_SLICE_REACH either side, or blended into the next section's where
  // they are closer: so its row is its foil exactly, and one added as the fin's own foil
  // there changes nothing.
  const sections = d.slices.map((sl) => {
    const t = sectionThickest(sl.section);
    return {
      s: sl.height * sTip,
      sec: sl.section,
      thickness: t.thickness,
      share: sl.section.inside === null ? 0.5 : 1,
    };
  });
  /** Section k's difference to the bare fin on its row at `along`, and to its share. */
  const diff = (k: number, along: number): [number, number, number] => {
    const c = sections[k]!;
    if (!(c.thickness > 0)) return [0, 0, 0];
    const [o, n] = sectionShapeAt(c.sec, along);
    const [bo, bn, bs] = bare(c.s, along);
    return [o / c.thickness - bo, n / c.thickness - bn, c.share - bs];
  };
  /** The sections that shape row s, and how much each: as blade.ts's sliceWeight, by s. */
  const weights = (s: number): [number, number][] => {
    const n = sections.length;
    if (n === 0) return [];
    let k = 0;
    while (k < n - 1 && s >= sections[k + 1]!.s) k++;
    const sk = sections[k]!.s;
    const parts: [number, number][] =
      k === n - 1 || s <= sk
        ? [[k, 1]]
        : (() => {
            const w = smootherstep((s - sk) / (sections[k + 1]!.s - sk));
            return [
              [k, 1 - w],
              [k + 1, w],
            ];
          })();
    // How much the sections count here: all of it between two close enough for their
    // reaches to meet, else easing out over the reach (to the base below, the tip line above).
    let j = -1;
    while (j < n - 1 && sections[j + 1]!.s <= s) j++;
    const lo = j >= 0 ? sections[j]!.s : null;
    const hi = j < n - 1 ? sections[j + 1]!.s : null;
    let all = 0;
    if (lo !== null && hi !== null && hi - lo <= 2 * FIN_SLICE_REACH) all = 1;
    else {
      if (lo !== null) {
        // Gone by the tip line, so the tip foil lies along it as drawn.
        const reach = Math.min(FIN_SLICE_REACH, sTip - lo);
        all = Math.max(all, 1 - smootherstep((s - lo) / reach));
      }
      if (hi !== null) {
        const reach = Math.min(FIN_SLICE_REACH, hi);
        all = Math.max(all, smootherstep(1 - (hi - s) / reach));
      }
    }
    return all > 0 ? parts.map(([i, w]) => [i, w * all]) : [];
  };
  const taperAt = (e: number) => yAtX(d.taper, Math.min(1, Math.max(0, e)));
  // Past the tip line the edges thin the foil as a nose does; only the short last row
  // needs closing to the minimum, over the outer half of the rows beyond the tip line.
  const sClose = (sTip + 1) / 2;
  const round = (s: number) => {
    if (s <= sClose) return 1;
    const t = Math.min(1, (s - sClose) / (1 - sClose));
    return Math.sqrt(Math.max(0, 1 - t * t * t));
  };
  const foil = (s: number, along: number): [number, number, number] => {
    let [o, n, share] = bare(s, along);
    for (const [k, w] of weights(s)) {
      const [dO, dN, dS] = diff(k, along);
      o += dO * w;
      n += dN * w;
      share += dS * w;
    }
    return [o, n, share];
  };
  const etaAt = (s: number) => eta.at(s * SPINE_SAMPLES);
  const scale = (s: number) => Math.max(0, taperAt(etaAt(s)) - m) * round(s);
  const offsets = (s: number, u: number): [number, number] => {
    const [o, n, share] = foil(s, alongAt(s, u));
    const k = scale(s);
    let out = o * k + m * share;
    let ins = n * k - m * (1 - share);
    const { outside: lamOut, inside: lamIn } = b.laminate;
    const lam = lamOut + lamIn;
    if (lam > 0) {
      // The core, as blade.ts builds it: each face in by its laminate, the face with less
      // laminate making up any shortfall under the minimum.
      const short = Math.max(0, m - (out - ins - lam));
      out += short * (lamIn / lam) - lamOut;
      ins += lamIn - short * (lamOut / lam);
    }
    return [out, ins];
  };
  // Cant and toe. A section's cant leans the blade more (or less) from its row up, easing in
  // below it (blade.ts twistAt, by s): each point slides out by the lean summed up its
  // column from the base, so the blade bends rather than shears. A section's toe turns
  // each row about its own thickest point, on the thickness path.
  const twisted = hasTwist(d);
  const twist = (s: number) => twistAt(d, Math.min(1, s / sTip));
  let slide = (s: number, u: number) => point(s, u).y * b.lean;
  let widen = (_s: number) => b.widen;
  if (twisted) {
    const w = cols + 1;
    const table = new Float64Array((rows + 1) * w);
    const lean = (s: number) => Math.tan(twist(s).cant * DEG_TO_RAD);
    const STEPS = 4;
    for (let j = 0; j <= cols; j++) {
      let run = 0;
      for (let i = 1; i <= rows; i++) {
        // Simpson's rule over each grid row, in a few steps, of tan(cant)·dz.
        for (let q = 0; q < STEPS; q++) {
          const s0 = (i - 1 + q / STEPS) / rows;
          const s1 = (i - 1 + (q + 1) / STEPS) / rows;
          const sm = (s0 + s1) / 2;
          const z = (t: number) => map.z.at(t * rows, j);
          const dz = (t: number) => (z(t + 1e-6) - z(t - 1e-6)) / 2e-6;
          run += ((s1 - s0) / 6) * (lean(s0) * dz(s0) + 4 * lean(sm) * dz(sm) + lean(s1) * dz(s1));
        }
        table[i * w + j] = run;
      }
    }
    const spl = spline2(table, rows, cols);
    slide = (s, u) => spl.at(s * rows, u * cols);
    widen = (s) => 1 / Math.cos(twist(s).cant * DEG_TO_RAD);
  }
  const spineX = spline1(spine.map((q) => q.x));
  const spineU = spline1(
    Array.from({ length: SPINE_SAMPLES + 1 }, (_, k) => {
      const s = k / SPINE_SAMPLES;
      return uAlong(s, pathAt(s));
    }),
  );
  const finToe = d.toe ?? 0;
  const turn = toeTurn(b);
  const place = (s: number, u: number, x0: number, z: number, offset: number): Vert3 => {
    let x = x0;
    let y = b.outward * (slide(s, u) + offset * widen(s));
    const own = twisted ? twist(s).toe - finToe : 0;
    if (own) {
      const px = spineX.at(s * SPINE_SAMPLES);
      const py = b.outward * slide(s, spineU.at(s * SPINE_SAMPLES));
      const a = -b.outward * own * DEG_TO_RAD;
      const dx = x - px;
      const dy = y - py;
      x = px + dx * Math.cos(a) - dy * Math.sin(a);
      y = py + dx * Math.sin(a) + dy * Math.cos(a);
    }
    if (!turn) return { x, y, z };
    const dx = x - turn.x;
    const dy = y - turn.y;
    return {
      x: turn.x + dx * turn.cos - dy * turn.sin,
      y: turn.y + dx * turn.sin + dy * turn.cos,
      z,
    };
  };
  const smooth: SmoothBlade = {
    blade: b,
    map,
    sTip,
    point,
    offsets,
    foil,
    scale,
    eta: etaAt,
    faces: (s, u) => {
      const p = point(s, u);
      const [o, n] = offsets(s, u);
      return { outside: place(s, u, p.x, p.y, o), inside: place(s, u, p.x, p.y, n) };
    },
  };
  bladeCache.set(b, smooth);
  return smooth;
};

/** Row s of the design's smooth blade on the profile (tab frame, cm), `n` + 1 points edge to edge. */
export const smoothRowLine = (d: FinDesign, s: number, n = 64): P2[] => {
  const map = smoothMap(d);
  const { rows, cols } = SMOOTH_MAP;
  return Array.from({ length: n + 1 }, (_, j) => ({
    x: map.x.at(s * rows, (j / n) * cols),
    y: map.z.at(s * rows, (j / n) * cols),
  }));
};

/**
 * Where on the smooth blade's layout a profile point is, (s, u); null off the blade. A
 * search over the grid, then Newton's method on the splines.
 */
export const smoothLocate = (
  d: FinDesign,
  x: number,
  z: number,
): { s: number; u: number } | null => {
  const sb = smoothBlade(d);
  const { rows, cols } = SMOOTH_MAP;
  let best = { s: 0, u: 0, d: Infinity };
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const p = sb.point(i / rows, j / cols);
      const dd = Math.hypot(p.x - x, p.y - z);
      if (dd < best.d) best = { s: i / rows, u: j / cols, d: dd };
    }
  }
  let { s, u } = best;
  const e = 1e-6;
  for (let it = 0; it < 30; it++) {
    const p = sb.point(s, u);
    const ps = sb.point(s + e, u);
    const pu = sb.point(s, u + e);
    const a = (ps.x - p.x) / e;
    const b = (pu.x - p.x) / e;
    const c = (ps.y - p.y) / e;
    const dd = (pu.y - p.y) / e;
    const det = a * dd - b * c;
    if (!(Math.abs(det) > 1e-18)) break;
    const fx = p.x - x;
    const fz = p.y - z;
    const ds = (dd * fx - b * fz) / det;
    const du = (a * fz - c * fx) / det;
    s = Math.min(1, Math.max(0, s - ds));
    u = Math.min(1, Math.max(0, u - du));
    if (Math.abs(ds) + Math.abs(du) < 1e-12) break;
  }
  const p = sb.point(s, u);
  // Further than a millimetre off the blade is off it.
  return Math.hypot(p.x - x, p.y - z) <= 0.1 ? { s, u } : null;
};

/** The row (s) of a control section at `height`, the fraction of the way to the tip line. */
export const smoothSectionRow = (d: FinDesign, height: number): number =>
  height * smoothMap(d).sTip;

/** The control-section height of row s: above 1 past the tip line. */
export const smoothSectionHeight = (d: FinDesign, s: number): number => s / smoothMap(d).sTip;

/** How far along the fin row s is (smoothBlade's eta), and back: the row at η. */
export const smoothEta = (d: FinDesign, s: number): number => smoothBlade(d).eta(s);

export const smoothRowAtEta = (d: FinDesign, eta: number): number => {
  const sb = smoothBlade(d);
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 50; k++) {
    const mid = (lo + hi) / 2;
    if (sb.eta(mid) < eta) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Chord stations a row's foil is sampled at to fit it (smoothFoilAt). */
const ROW_FOIL_STATIONS = cosineStations(200);

/**
 * The foil on the row of a control section at `height` of the way to the tip line, as one there starts (owner's rules:
 * adding one changes nothing until it is edited): its faces in chords of the row's length,
 * less the minimum thickness, fitted with as few points as follow them (blade.ts fitFoil).
 */
export const smoothFoilAt = (d: FinDesign, height: number): FinSection => {
  const sb = smoothBlade(d);
  const s = height * sb.sTip;
  let length = 0;
  let prev = sb.point(s, 0);
  for (let k = 1; k <= 400; k++) {
    const q = sb.point(s, k / 400);
    length += Math.hypot(q.x - prev.x, q.y - prev.y);
    prev = q;
  }
  const k = sb.scale(s) / (length || 1);
  const out: number[] = [];
  const ins: number[] = [];
  for (const x of ROW_FOIL_STATIONS) {
    const [o, n] = sb.foil(s, x);
    out.push(o * k);
    ins.push(n * k);
  }
  const symmetric = [d.section, tipFoilOf(d), ...d.slices.map((sl) => sl.section)].every(
    (sec) => sec.inside === null,
  );
  return fitFoil(ROW_FOIL_STATIONS, out, ins, symmetric);
};

/** How far in from each side (s and u) the smoothness gate's sampler starts: the edges left out. */
const GATE_EDGE = 0.06;
const GATE_TOP = 0.03;

/**
 * The smooth blade's sampler for the smoothness gate (fairness.ts): rows evenly up the fin
 * to just short of the tip edge, columns evenly across short of the edges.
 */
export const smoothSampler =
  (d: FinDesign) =>
  (rows: number, cols: number): { outside: Vert3[][]; inside: Vert3[][] } => {
    const sb = smoothBlade(d);
    const outside: Vert3[][] = [];
    const inside: Vert3[][] = [];
    for (let i = 0; i <= rows; i++) {
      const s = ((1 - GATE_TOP) * i) / rows;
      const o: Vert3[] = [];
      const n: Vert3[] = [];
      for (let j = 0; j <= cols; j++) {
        const f = sb.faces(s, GATE_EDGE + ((1 - 2 * GATE_EDGE) * j) / cols);
        o.push(f.outside);
        n.push(f.inside);
      }
      outside.push(o);
      inside.push(n);
    }
    return { outside, inside };
  };
