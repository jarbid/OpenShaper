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
 * underside), the **leading edge** up to the tip line, the **tip edge** (the outline
 * round the tip, from the tip line's leading-edge end to its trailing-edge end) and the
 * **trailing edge** back down. It is laid out as an elliptic grid (smooth-map.ts,
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
 * - **The tip**: from the tip line (where the thickness path crosses it) to the tip edge,
 *   the thickness rounds down as √(1 − t³), level where it starts (no step in curvature)
 *   and meeting the tip edge square, as a foil's nose meets its leading edge.
 * - **Minimum**: the foil scaled to the thickness less the minimum, then the minimum
 *   added all over (symmetric foils half each side): the edges and the tip edge end at it
 *   exactly, with no clamp.
 *
 * Then cant (the lean, a shear, as the sweep's) and toe (a turn about the root's thickest
 * point). Control sections, and their cant and toe, come in stage 3: this engine leaves
 * them out for now.
 */
import type { Vert3 } from '../loft';
import { yAtX } from './curve-shape';
import {
  NO_LAMINATE,
  prepareBlade,
  sectionShapeAt,
  sectionThickest,
  thicknessPathOf,
  tipFoilOf,
  toeTurn,
  type FinLaminate,
  type PreparedBlade,
} from './blade';
import { FIN_MIN_THICKNESS, type FinDesign, type FinSection } from './fin-design';
import { spline1, spline2, winslowGrid, type P2, type Sides, type Spline2 } from './smooth-map';
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
}

const mapCache = new WeakMap<object, Map<string, SmoothMap>>();

/** The design's layout, cached per outline and tip line (the elliptic solve is the cost). */
export const smoothMap = (d: FinDesign): SmoothMap => {
  const key = d.tipLine ? `${d.tipLine.start},${d.tipLine.end}` : 'default';
  let byLine = mapCache.get(d.outline);
  if (!byLine) mapCache.set(d.outline, (byLine = new Map()));
  const hit = byLine.get(key);
  if (hit) return hit;
  const f = sweepFrame(d);
  const sides: Sides = {
    bottom: (t) => acrossBase(f.base, t),
    top: (t) => alongPath(f.tipEdge, t),
    left: (t) => alongPath(f.leading, t),
    right: (t) => alongPath(f.trailing, t),
  };
  const { rows, cols } = SMOOTH_MAP;
  const g = winslowGrid(sides, rows, cols);
  const x = spline2(g.x, rows, cols);
  const z = spline2(g.y, rows, cols);
  // Each row's length from the leading edge, measured along the splines.
  const w = cols + 1;
  const along = new Float64Array((rows + 1) * w);
  for (let i = 0; i <= rows; i++) {
    let run = 0;
    let px = x.at(i, 0);
    let pz = z.at(i, 0);
    for (let j = 1; j <= cols; j++) {
      for (let k = 1; k <= ROW_STEPS; k++) {
        const c = j - 1 + k / ROW_STEPS;
        const qx = x.at(i, c);
        const qz = z.at(i, c);
        run += Math.hypot(qx - px, qz - pz);
        px = qx;
        pz = qz;
      }
      along[i * w + j] = run;
    }
    for (let j = 1; j <= cols; j++) along[i * w + j] = run > 0 ? along[i * w + j]! / run : j / cols;
  }
  const m = { x, z, along: spline2(along, rows, cols), tipStart: f.tipStart, tipEnd: f.tipEnd };
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
  /** Where the tip's rounding starts (s): where the thickness path crosses the tip line. */
  readonly sTip: number;
  /** The profile point at (s, u) (tab frame, cm). */
  point(s: number, u: number): P2;
  /** The faces' offsets from the blade's middle plane at (s, u) (cm, + outward), before cant and toe. */
  offsets(s: number, u: number): [number, number];
  /** The two faces at (s, u), in the fin frame (blade.ts), cant and toe applied. */
  faces(s: number, u: number): { outside: Vert3; inside: Vert3 };
}

const bladeCache = new WeakMap<PreparedBlade, SmoothBlade>();

export const smoothBlade = (
  d: FinDesign,
  laminate: FinLaminate = NO_LAMINATE,
  minThickness: number = FIN_MIN_THICKNESS,
): SmoothBlade => {
  const b = prepareBlade(d, laminate, minThickness);
  return smoothBladeOf(b);
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
  const way = thicknessPathOf(d);
  const pathAt = (s: number) => thicknessPathAt(way, s);
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
  // The thickness path on the profile: its length from the base (η), and where it
  // crosses the tip line.
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
  const { tipStart: ts, tipEnd: te } = map;
  const side = (p: P2) => (te.x - ts.x) * (p.y - ts.y) - (te.y - ts.y) * (p.x - ts.x);
  let sTip = 0.85;
  for (let k = 1; k <= SPINE_SAMPLES; k++) {
    const a = side(spine[k - 1]!);
    const c = side(spine[k]!);
    if (a === 0 || a * c < 0) {
      sTip = (k - 1 + (a === 0 ? 0 : a / (a - c))) / SPINE_SAMPLES;
      break;
    }
  }
  sTip = Math.min(0.97, Math.max(0.3, sTip));
  const base = endFoil(d.section);
  const tip = endFoil(tipFoilOf(d));
  const m = b.minThickness;
  const read = (f: EndFoil, along: number, p: number): [number, number] => {
    if (!(f.thickness > 0)) return [0, 0];
    const [o, n] = sectionShapeAt(f.sec, foilWarp(along, p, f.at));
    return [o / f.thickness, n / f.thickness];
  };
  const taperAt = (e: number) => yAtX(d.taper, Math.min(1, Math.max(0, e)));
  const round = (s: number) => {
    if (s <= sTip) return 1;
    const t = Math.min(1, (s - sTip) / (1 - sTip));
    return Math.sqrt(Math.max(0, 1 - t * t * t));
  };
  const offsets = (s: number, u: number): [number, number] => {
    const along = alongAt(s, u);
    const p = pathAt(s);
    const w = smootherstep(s / sTip);
    const [oa, na] = read(base, along, p);
    const [o, n] =
      tip.sec === base.sec || !(w > 0)
        ? [oa, na]
        : (([ob, nb]) => [oa + (ob - oa) * w, na + (nb - na) * w])(read(tip, along, p));
    const share = base.share + (tip.share - base.share) * w;
    const k = Math.max(0, taperAt(eta.at(s * SPINE_SAMPLES)) - m) * round(s);
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
  const turn = toeTurn(b);
  const place = (x0: number, z: number, offset: number): Vert3 => {
    const x = x0;
    const y = b.outward * (z * b.lean + offset * b.widen);
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
    faces: (s, u) => {
      const p = point(s, u);
      const [o, n] = offsets(s, u);
      return { outside: place(p.x, p.y, o), inside: place(p.x, p.y, n) };
    },
  };
  bladeCache.set(b, smooth);
  return smooth;
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
