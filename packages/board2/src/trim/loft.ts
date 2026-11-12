// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The lofted panels of a rails board (docs/design/trim-blend-engine.md, "The panels are lofted
 * at fixed u"): deck and bottom as height fields z(x, y).
 *
 * Each station carries, per side and panel, a curve in normalised (u, v): u from the stringer
 * (0) to the wall (1), v the height above the rocker over the thickness. A panel is
 * v(x, u): each station curve is read on an even u grid, each grid value is blended along x by
 * the quintic of `along.ts`, and across u a Catmull-Rom cubic runs through the grid, extended
 * evenly across the stringer (v(−u) = v(u), so the panel is C1 there) and linearly past the
 * wall. The physical panel is z = R(x) + T(x)·v(x, |y| / w(x)), with R the rocker, T the deck
 * less the rocker on the stringer and w the half width of the side y is on. R, T and w are read
 * from tables built once, because a chain evaluation costs more than the rest of a call.
 *
 * Evaluation allocates nothing and keeps the last station interval as its starting guess, so
 * the many calls of one mesh, which move a little at a time, find their interval at once.
 */
import { compileChain, funcEval, segEval } from '../chain';
import { TRIM } from '../params';
import type { Chain } from '../types';
import { alongPolynomials, quinticAlong, stationSpan } from './along';
import type { Along } from './along';
import type { Panels } from './solid';

/** A station's curve for one panel of one side, normalised (u, v). */
export interface CurveAt {
  readonly x: number;
  readonly curve: Chain;
}

/** v(x, u) of one panel of one side. */
export interface PanelLoft {
  /** Grid cells across u: the grid is `samples + 1` even values of u in [0, 1]. */
  readonly samples: number;
  /** The grid values blended along x: `samples + 1` scalars per station. */
  readonly along: Along;
  /**
   * The blend packed for evaluation: per station interval, `samples + 2` columns (the mirror of
   * grid column 1 across the stringer, then columns 0 … samples), each the six coefficients of
   * its quintic in t (`alongPolynomials`).
   */
  readonly poly: Float64Array;
  /** One over each station interval's length (0 for a single station). */
  readonly invH: Float64Array;
  /** Evaluation state: the last station interval, the first guess for the next call. */
  readonly hint: Int32Array;
}

/**
 * A station curve read as v at `samples + 1` even u in [0, 1], into `out[o …]`. The chain is
 * sampled densely; samples that do not rise in u (a vertical end, rounding) are dropped, as
 * `makeHalf` in station.ts drops them, and the grid is read by straight lines between the kept
 * samples. Below the curve's first u and above its last the end value is held.
 */
function curveOnGrid(curve: Chain, samples: number, out: Float64Array, o: number): void {
  const ch = compileChain(curve);
  const c = ch.c;
  const pt = new Float64Array(2);
  const us: number[] = [];
  const vs: number[] = [];
  const keep = (u: number, v: number): void => {
    if (us.length > 0 && u <= us[us.length - 1]!) return;
    us.push(u);
    vs.push(v);
  };
  for (let k = 0; k < ch.segments; k++) {
    const b = 8 * k;
    const extent = Math.abs(c[b + 6]! - c[b]!);
    const m = Math.max(TRIM.loftSegmentSamples, Math.ceil(TRIM.loftOversample * samples * extent));
    for (let i = k === 0 ? 0 : 1; i <= m; i++) {
      segEval(c, b, i / m, 0, pt, 0);
      keep(pt[0]!, pt[1]!);
    }
  }
  if (us.length === 0) throw new RangeError('buildLoft: a station curve has no knots');
  let s = 0;
  const last = us.length - 1;
  for (let j = 0; j <= samples; j++) {
    const u = j / samples;
    if (u <= us[0]!) out[o + j] = vs[0]!;
    else if (u >= us[last]!) out[o + j] = vs[last]!;
    else {
      while (us[s + 1]! < u) s++;
      const f = (u - us[s]!) / (us[s + 1]! - us[s]!);
      out[o + j] = vs[s]! + f * (vs[s + 1]! - vs[s]!);
    }
  }
}

/** The panel through the station curves (any order; distinct x), read on a grid of `samples` cells across u. */
export function buildLoft(curves: readonly CurveAt[], samples: number): PanelLoft {
  if (!(samples >= 2) || !Number.isInteger(samples)) {
    throw new RangeError('buildLoft: samples must be an integer of at least 2');
  }
  const sorted = [...curves].sort((a, b) => a.x - b.x);
  const n = sorted.length;
  const width = samples + 1;
  const xs = Float64Array.from(sorted, (c) => c.x);
  const q = new Float64Array(n * width);
  sorted.forEach((c, k) => curveOnGrid(c.curve, samples, q, k * width));
  const along = quinticAlong(xs, q, width);
  const src = alongPolynomials(along);
  const spans = Math.max(n - 1, 1);
  const cols = samples + 2;
  const poly = new Float64Array(spans * cols * 6);
  for (let i = 0; i < spans; i++) {
    for (let p = 0; p < cols; p++) {
      const from = (i * width + (p === 0 ? 1 : p - 1)) * 6;
      poly.set(src.subarray(from, from + 6), (i * cols + p) * 6);
    }
  }
  const invH = new Float64Array(spans);
  for (let i = 0; i + 1 < n; i++) invH[i] = 1 / (xs[i + 1]! - xs[i]!);
  return Object.freeze({ samples, along, poly, invH, hint: new Int32Array(1) });
}

/**
 * The evaluation's real-valued arguments, passed through this array rather than as arguments:
 * V8 boxes a double passed to a function it does not inline, and that is an allocation a call.
 * `ARG[0]` t in the station interval, `[1]` 1 when x is held at an end station (else 0),
 * `[2]` u, `[3]` x.
 */
const ARG = new Float64Array(4);

/** The station interval holding x = `ARG[3]`, with t and whether x is held into `ARG`. */
function locate(L: PanelLoft): number {
  const x = ARG[3]!;
  const xs = L.along.xs;
  const n = xs.length;
  if (n === 1 || x <= xs[0]!) {
    ARG[0] = 0;
    ARG[1] = 1;
    return 0;
  }
  if (x >= xs[n - 1]!) {
    ARG[0] = 1;
    ARG[1] = 1;
    return n - 2;
  }
  const lo = stationSpan(xs, x, L.hint[0]!);
  L.hint[0] = lo;
  ARG[0] = (x - xs[lo]!) * L.invH[lo]!;
  ARG[1] = 0;
  return lo;
}

/** Scratch of `columns`: up to four columns' values, then their derivatives in t. */
const COL = new Float64Array(8);

/** `m` consecutive columns' quintics at t = `ARG[0]`, from coefficients at `c[b …]`, into `COL`. */
function columns(c: Float64Array, b: number, m: number, grad: boolean): void {
  const t = ARG[0]!;
  for (let k = 0; k < m; k++, b += 6) {
    const k1 = c[b + 1]!;
    const k2 = c[b + 2]!;
    const k3 = c[b + 3]!;
    const k4 = c[b + 4]!;
    const k5 = c[b + 5]!;
    COL[k] = c[b]! + t * (k1 + t * (k2 + t * (k3 + t * (k4 + t * k5))));
    if (grad) COL[4 + k] = k1 + t * (2 * k2 + t * (3 * k3 + t * (4 * k4 + t * 5 * k5)));
  }
}

/**
 * v, and with `grad` dv/dx and dv/du, at u = `ARG[2]` (at least 0) into `out[o …]`, for station
 * interval `lo` at t = `ARG[0]`; `held` gives dv/dx = 0.
 */
function panelAt(
  L: PanelLoft,
  lo: number,
  held: boolean,
  grad: boolean,
  out: Float64Array,
  o: number,
): void {
  const u = ARG[2]!;
  const S = L.samples;
  const base = lo * (S + 2) * 6;
  const g = u * S;
  const dx = grad && !held;
  if (g >= S) {
    // past the wall: the straight line through the last two grid values (padded columns S, S + 1)
    columns(L.poly, base + S * 6, 2, dx);
    const a = COL[0]!;
    const z = COL[1]!;
    const slope = (z - a) * S;
    out[o] = z + (u - 1) * slope;
    if (grad) {
      out[o + 1] = dx ? (COL[5]! + (u - 1) * (COL[5]! - COL[4]!) * S) * L.invH[lo]! : 0;
      out[o + 2] = slope;
    }
    return;
  }
  const j = Math.floor(g);
  const s = g - j;
  // grid columns j − 1 … j + 2 are padded columns j … j + 3; column S + 1 is the line past the wall
  const inside = j + 1 < S;
  columns(L.poly, base + j * 6, inside ? 4 : 3, dx);
  const c0 = COL[0]!;
  const c1 = COL[1]!;
  const c2 = COL[2]!;
  const c3 = inside ? COL[3]! : 2 * c2 - c1;
  const s2 = s * s;
  const s3 = s2 * s;
  const a0 = 0.5 * (-s + 2 * s2 - s3);
  const a1 = 0.5 * (2 - 5 * s2 + 3 * s3);
  const a2 = 0.5 * (s + 4 * s2 - 3 * s3);
  const a3 = 0.5 * (s3 - s2);
  out[o] = a0 * c0 + a1 * c1 + a2 * c2 + a3 * c3;
  if (!grad) return;
  if (dx) {
    const x2 = COL[6]!;
    const x3 = inside ? COL[7]! : 2 * x2 - COL[5]!;
    out[o + 1] = (a0 * COL[4]! + a1 * COL[5]! + a2 * x2 + a3 * x3) * L.invH[lo]!;
  } else out[o + 1] = 0;
  const b0 = 0.5 * (-1 + 4 * s - 3 * s2);
  const b1 = 0.5 * (-10 * s + 9 * s2);
  const b2 = 0.5 * (1 + 8 * s - 9 * s2);
  const b3 = 0.5 * (3 * s2 - 2 * s);
  out[o + 2] = (b0 * c0 + b1 * c1 + b2 * c2 + b3 * c3) * S;
}

/** v, dv/dx, dv/du at (x, u) into `out[0 … 3)`. Negative u reads the mirror across the stringer. */
export function loftAt(loft: PanelLoft, x: number, u: number, out: Float64Array): void {
  ARG[3] = x;
  const lo = locate(loft);
  ARG[2] = Math.abs(u);
  panelAt(loft, lo, ARG[1] === 1, true, out, 0);
  if (u < 0) out[2] = -out[2]!;
}

/** What a board's panels are lofted from. */
export interface LoftParts {
  /** z(x) on the stringer of the bottom and of the deck. */
  readonly rocker: Chain;
  readonly deck: Chain;
  /** Half width of the plus side (y ≥ 0) and of the minus side. */
  readonly halfWidth: readonly [(x: number) => number, (x: number) => number];
  /** Plus side, minus side (the same object twice on a symmetric board). */
  readonly bottom: readonly [PanelLoft, PanelLoft];
  readonly top: readonly [PanelLoft, PanelLoft];
  /** The board's ends in x. */
  readonly from: number;
  readonly to: number;
}

/** Panels with one call for both heights and their gradients. */
export interface LoftPanels extends Panels {
  /** Into `out[0 … 6)`: deck z, dz/dx, dz/dy, then bottom z, dz/dx, dz/dy. */
  both(x: number, y: number, out: Float64Array): void;
}

const sameStations = (a: PanelLoft, b: PanelLoft): boolean => {
  const p = a.along.xs;
  const q = b.along.xs;
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
};

/** The physical panels of a board: z = R + T·v(x, |y| / w), each side its own loft and half width. */
export function loftPanels(parts: LoftParts): LoftPanels {
  const { from, to } = parts;
  if (!(to > from)) throw new RangeError('loftPanels: the board must have length');
  // tables along x: per node R, Δ·R', T, Δ·T', w+, Δ·w+', w−, Δ·w−' (Δ the node spacing)
  const N = Math.max(2, Math.ceil((to - from) / TRIM.loftTableStep) + 1);
  const step = (to - from) / (N - 1);
  const inv = 1 / step;
  const tb = new Float64Array(8 * N);
  const rocker = compileChain(parts.rocker);
  const deck = compileChain(parts.deck);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  for (let i = 0; i < N; i++) {
    const x = i === N - 1 ? to : from + i * step;
    funcEval(rocker, x, r, 0);
    funcEval(deck, x, d, 0);
    tb[8 * i] = r[0]!;
    tb[8 * i + 1] = step * r[1]!;
    tb[8 * i + 2] = d[0]! - r[0]!;
    tb[8 * i + 3] = step * (d[1]! - r[1]!);
    tb[8 * i + 4] = parts.halfWidth[0](x);
    tb[8 * i + 6] = parts.halfWidth[1](x);
  }
  // the half width's slope: central differences of the node values, one-sided at the ends
  for (let i = 0; i < N; i++) {
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, N - 1);
    tb[8 * i + 5] = (tb[8 * b + 4]! - tb[8 * a + 4]!) / (b - a);
    tb[8 * i + 7] = (tb[8 * b + 6]! - tb[8 * a + 6]!) / (b - a);
  }
  const tops = parts.top;
  const bots = parts.bottom;
  const shared = [sameStations(tops[0], bots[0]), sameStations(tops[1], bots[1])];
  const tip = TRIM.loftTipWidth;
  // scratch: the tables at x (R, T, w, then their slopes), and the two panels' v, v_x, v_u
  const tab = new Float64Array(6);
  const V = new Float64Array(6);

  /** The tables at x = `ARG[3]` on side `k` (4 plus, 6 minus) into `tab`; slopes when `grad` (0 when held). */
  const tables = (k: number, grad: boolean, held: boolean): void => {
    const x = ARG[3]!;
    const gx = (x - from) * inv;
    let i = Math.floor(gx);
    if (i > N - 2) i = N - 2;
    const t = gx - i;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = 1 - h00;
    const h11 = t3 - t2;
    const b = 8 * i;
    const e = b + 8;
    tab[0] = h00 * tb[b]! + h10 * tb[b + 1]! + h01 * tb[e]! + h11 * tb[e + 1]!;
    tab[1] = h00 * tb[b + 2]! + h10 * tb[b + 3]! + h01 * tb[e + 2]! + h11 * tb[e + 3]!;
    tab[2] = h00 * tb[b + k]! + h10 * tb[b + k + 1]! + h01 * tb[e + k]! + h11 * tb[e + k + 1]!;
    if (!grad) return;
    if (held) {
      tab[3] = 0;
      tab[4] = 0;
      tab[5] = 0;
      return;
    }
    const g00 = (6 * t2 - 6 * t) * inv;
    const g10 = (3 * t2 - 4 * t + 1) * inv;
    const g11 = (3 * t2 - 2 * t) * inv;
    tab[3] = g00 * (tb[b]! - tb[e]!) + g10 * tb[b + 1]! + g11 * tb[e + 1]!;
    tab[4] = g00 * (tb[b + 2]! - tb[e + 2]!) + g10 * tb[b + 3]! + g11 * tb[e + 3]!;
    tab[5] = g00 * (tb[b + k]! - tb[e + k]!) + g10 * tb[b + k + 1]! + g11 * tb[e + k + 1]!;
  };

  const height = (L: PanelLoft, x: number, y: number): number => {
    ARG[3] = x < from ? from : x > to ? to : x;
    tables(y >= 0 ? 4 : 6, false, false);
    const w = tab[2]!;
    ARG[2] = w > tip ? Math.abs(y) / w : 0;
    panelAt(L, locate(L), true, false, V, 0);
    return tab[0]! + tab[1]! * V[0]!;
  };

  return {
    deck: (x, y) => height(tops[y >= 0 ? 0 : 1], x, y),
    bottom: (x, y) => height(bots[y >= 0 ? 0 : 1], x, y),
    both: (x, y, out) => {
      const side = y >= 0 ? 0 : 1;
      const xc = x < from ? from : x > to ? to : x;
      const outside = xc !== x;
      ARG[3] = xc;
      tables(side === 0 ? 4 : 6, true, outside);
      const R = tab[0]!;
      const T = tab[1]!;
      const w = tab[2]!;
      const top = tops[side]!;
      const bot = bots[side]!;
      const onStringer = !(w > tip);
      const u = onStringer ? 0 : Math.abs(y) / w;
      ARG[2] = u;
      const lo = locate(top);
      const held = outside || ARG[1] === 1;
      panelAt(top, lo, held, true, V, 0);
      if (shared[side]) panelAt(bot, lo, held, true, V, 3);
      else {
        const blo = locate(bot);
        panelAt(bot, blo, outside || ARG[1] === 1, true, V, 3);
      }
      // the chain rule through u = |y| / w(x)
      const across = onStringer ? 0 : (u * tab[5]!) / w;
      const slope = onStringer ? 0 : ((side === 0 ? 1 : -1) * T) / w;
      const Rx = tab[3]!;
      const Tx = tab[4]!;
      for (let k = 0; k < 6; k += 3) {
        const v = V[k]!;
        const vu = V[k + 2]!;
        out[k] = R + T * v;
        out[k + 1] = Rx + Tx * v + T * (V[k + 1]! - vu * across);
        out[k + 2] = slope * vu;
      }
    },
  };
}
