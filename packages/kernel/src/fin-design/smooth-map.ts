// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The smooth blade's building blocks (smooth-blade.ts): cubic splines through evenly
 * spaced values, in one direction and over a grid, and the elliptic grid that lays a
 * four-sided region out without folding.
 *
 * ## Splines
 *
 * Interpolating cubic splines with not-a-knot ends, through values at whole-number
 * parameters 0, 1, … n. Through every value exactly, and twice continuously
 * differentiable everywhere: no step in slope or curvature between samples, so a surface
 * built from them has no crease and no kink in its zebra stripes. Not-a-knot rather than
 * natural ends: a natural spline forces the curvature to nothing at its ends, bending a
 * curved edge out of shape between its last samples; not-a-knot follows it to fourth order.
 * Over a grid, the tensor product: a spline along each row, then down the columns, so
 * read anywhere it needs only the four corners of the cell (values and second
 * derivatives).
 *
 * ## The elliptic grid (Winslow)
 *
 * A four-sided region (the fin's profile: base, leading edge, tip edge, trailing edge) is
 * laid out as a grid by solving Winslow's equations for the grid's positions, the sides
 * held. Its rows and columns are then the level lines of two harmonic functions on the
 * region, which can't cross: the grid doesn't fold, even on a hooked fin's concave
 * outline, where the plain average of neighbours (the sweep's relaxation, swept-loft.ts)
 * folds and had to stop short.
 */

/**
 * Second derivatives of the not-a-knot cubic spline through `y` at 0, 1, … n (n ≥ 1).
 * Two points: a line; three: the parabola through them.
 */
export const splineSecond = (y: ArrayLike<number>): Float64Array => {
  const n = y.length - 1;
  const m = new Float64Array(n + 1);
  if (n < 2) return m;
  const r = (i: number) => 6 * (y[i - 1]! - 2 * y[i]! + y[i + 1]!);
  if (n === 2) {
    // The parabola: the same second derivative throughout.
    m.fill(r(1) / 6);
    return m;
  }
  if (n === 3) {
    // The one cubic through all four: m0 = 2m1 − m2 and m3 = 2m2 − m1 turn the two rows
    // into 6m1 = r1 and 6m2 = r2.
    m[1] = r(1) / 6;
    m[2] = r(2) / 6;
    m[0] = 2 * m[1] - m[2];
    m[3] = 2 * m[2] - m[1];
    return m;
  }
  // Not-a-knot: the third derivative doesn't jump at 1 or n − 1, so m0 = 2m1 − m2, and
  // the first row m0 + 4m1 + m2 = r1 becomes 6m1 = r1; likewise at the other end.
  m[1] = r(1) / 6;
  m[n - 1] = r(n - 1) / 6;
  // Rows 2 … n − 2: m[i−1] + 4m[i] + m[i+1] = r(i), m1 and m[n−1] known (Thomas).
  const k = n - 3; // unknowns m2 … m[n−2]
  const c = new Float64Array(k);
  const d = new Float64Array(k);
  for (let t = 0; t < k; t++) {
    const i = t + 2;
    let rhs = r(i);
    if (t === 0) rhs -= m[1]!;
    if (t === k - 1) rhs -= m[n - 1]!;
    const denom = 4 - (t > 0 ? c[t - 1]! : 0);
    c[t] = 1 / denom;
    d[t] = (rhs - (t > 0 ? d[t - 1]! : 0)) / denom;
  }
  for (let t = k - 1; t >= 0; t--) {
    m[t + 2] = d[t]! - (t < k - 1 ? c[t]! * m[t + 3]! : 0);
  }
  m[0] = 2 * m[1]! - m[2]!;
  m[n] = 2 * m[n - 1]! - m[n - 2]!;
  return m;
};

/** The cubic between samples a and b (second derivatives ma, mb), t of the way (0–1). */
const piece = (a: number, b: number, ma: number, mb: number, t: number): number => {
  const s = 1 - t;
  return s * a + t * b + ((s * s * s - s) * ma + (t * t * t - t) * mb) / 6;
};

/** Its slope (per unit of parameter). */
const pieceSlope = (a: number, b: number, ma: number, mb: number, t: number): number => {
  const s = 1 - t;
  return b - a + ((1 - 3 * s * s) * ma + (3 * t * t - 1) * mb) / 6;
};

/** The cell a parameter falls in (0 … n − 1), and how far into it. */
const cell = (x: number, n: number): [number, number] => {
  const i = Math.min(n - 1, Math.max(0, Math.floor(x)));
  return [i, x - i];
};

/** A not-a-knot cubic spline through values at 0, 1, … n, read at any parameter. */
export interface Spline1 {
  readonly n: number;
  /** The value at parameter x (0 … n); beyond the ends, the end pieces carried on. */
  at(x: number): number;
  /** Its slope there. */
  slope(x: number): number;
}

export const spline1 = (y: ArrayLike<number>): Spline1 => {
  const v = Float64Array.from(y as ArrayLike<number>);
  const m = splineSecond(v);
  const n = v.length - 1;
  return {
    n,
    at: (x) => {
      if (n === 0) return v[0]!;
      const [i, t] = cell(x, n);
      return piece(v[i]!, v[i + 1]!, m[i]!, m[i + 1]!, t);
    },
    slope: (x) => {
      if (n === 0) return 0;
      const [i, t] = cell(x, n);
      return pieceSlope(v[i]!, v[i + 1]!, m[i]!, m[i + 1]!, t);
    },
  };
};

/**
 * The tensor-product not-a-knot bicubic spline through a grid of values: `rows` + 1 rows
 * of `cols` + 1, row by row. Read at (r, c) in row and column units.
 */
export interface Spline2 {
  readonly rows: number;
  readonly cols: number;
  at(r: number, c: number): number;
}

export const spline2 = (values: ArrayLike<number>, rows: number, cols: number): Spline2 => {
  const w = cols + 1;
  const f = Float64Array.from(values as ArrayLike<number>);
  const line = (src: Float64Array, start: number, step: number, count: number) =>
    Float64Array.from({ length: count }, (_, k) => src[start + k * step]!);
  const put = (dst: Float64Array, start: number, step: number, src: Float64Array) =>
    src.forEach((v, k) => (dst[start + k * step] = v));
  // Second derivatives along each row (fuu), down each column (fss), and both (fssuu).
  const fuu = new Float64Array(f.length);
  for (let i = 0; i <= rows; i++) put(fuu, i * w, 1, splineSecond(line(f, i * w, 1, w)));
  const fss = new Float64Array(f.length);
  const fssuu = new Float64Array(f.length);
  for (let j = 0; j <= cols; j++) {
    put(fss, j, w, splineSecond(line(f, j, w, rows + 1)));
    put(fssuu, j, w, splineSecond(line(fuu, j, w, rows + 1)));
  }
  return {
    rows,
    cols,
    at: (r, c) => {
      const [i, a] = cell(r, rows);
      const [j, b] = cell(c, cols);
      const k0 = i * w + j;
      const k1 = k0 + w;
      const g0 = piece(f[k0]!, f[k0 + 1]!, fuu[k0]!, fuu[k0 + 1]!, b);
      const g1 = piece(f[k1]!, f[k1 + 1]!, fuu[k1]!, fuu[k1 + 1]!, b);
      const h0 = piece(fss[k0]!, fss[k0 + 1]!, fssuu[k0]!, fssuu[k0 + 1]!, b);
      const h1 = piece(fss[k1]!, fss[k1 + 1]!, fssuu[k1]!, fssuu[k1 + 1]!, b);
      return piece(g0, g1, h0, h1, a);
    },
  };
};

/** A point on the profile (tab frame, cm). */
export interface P2 {
  readonly x: number;
  readonly y: number;
}

/** The four sides of a region, each a function of 0 → 1 along it. */
export interface Sides {
  /** Row 0: from the corner it shares with `left` to the one it shares with `right`. */
  readonly bottom: (t: number) => P2;
  /** The last row, likewise. */
  readonly top: (t: number) => P2;
  /** Column 0: from `bottom`'s start to `top`'s start. */
  readonly left: (t: number) => P2;
  /** The last column: from `bottom`'s end to `top`'s end. */
  readonly right: (t: number) => P2;
}

/** A grid of points over a region: `rows` + 1 rows of `cols` + 1, row by row. */
export interface Grid {
  readonly rows: number;
  readonly cols: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
}

/** The transfinite (Coons) grid over four sides: where the elliptic solve starts. */
export const coonsGrid = (s: Sides, rows: number, cols: number): Grid => {
  const w = cols + 1;
  const x = new Float64Array((rows + 1) * w);
  const y = new Float64Array((rows + 1) * w);
  const b = Array.from({ length: w }, (_, j) => s.bottom(j / cols));
  const t = Array.from({ length: w }, (_, j) => s.top(j / cols));
  const l = Array.from({ length: rows + 1 }, (_, i) => s.left(i / rows));
  const r = Array.from({ length: rows + 1 }, (_, i) => s.right(i / rows));
  const [b0, b1, t0, t1] = [b[0]!, b[cols]!, t[0]!, t[cols]!];
  for (let i = 0; i <= rows; i++) {
    const v = i / rows;
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const k = i * w + j;
      const c = (a: 'x' | 'y') =>
        (1 - v) * b[j]![a] +
        v * t[j]![a] +
        (1 - u) * l[i]![a] +
        u * r[i]![a] -
        ((1 - u) * (1 - v) * b0[a] + u * (1 - v) * b1[a] + (1 - u) * v * t0[a] + u * v * t1[a]);
      x[k] = c('x');
      y[k] = c('y');
    }
  }
  return { rows, cols, x, y };
};

/** Whether any cell of the grid turns the other way round to the rest (a fold). */
export const gridFolds = (g: Grid): boolean => {
  const w = g.cols + 1;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < g.rows; i++) {
    for (let j = 0; j < g.cols; j++) {
      const k = i * w + j;
      // Twice the signed area of the cell, by its diagonals.
      const ax = g.x[k + w + 1]! - g.x[k]!;
      const ay = g.y[k + w + 1]! - g.y[k]!;
      const bx = g.x[k + w]! - g.x[k + 1]!;
      const by = g.y[k + w]! - g.y[k + 1]!;
      const a = ax * by - ay * bx;
      if (a > 0) pos++;
      else if (a < 0) neg++;
    }
  }
  return pos > 0 && neg > 0;
};

/** How the elliptic solve goes: passes at most, and when it has settled (cm). */
export const WINSLOW = { passes: 4000, settled: 1e-7, over: 1.4 } as const;

/**
 * The elliptic (Winslow) grid over four sides: Coons to start, then each interior point
 * moved to where Winslow's equations put it given its neighbours, over and over
 * (Gauss–Seidel, a little over-relaxed), the sides held, until no point moves more than
 * {@link WINSLOW}.settled. In grid units the equations, for x and y alike, are
 * α·x_uu − 2β·x_uv + γ·x_vv = 0, with α = |P_v|², β = P_u·P_v, γ = |P_u|².
 */
export const winslowGrid = (s: Sides, rows: number, cols: number): Grid => {
  const g = coonsGrid(s, rows, cols);
  const { x, y } = g;
  const w = cols + 1;
  for (let pass = 0; pass < WINSLOW.passes; pass++) {
    let moved = 0;
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        const k = i * w + j;
        const xu = (x[k + 1]! - x[k - 1]!) / 2;
        const yu = (y[k + 1]! - y[k - 1]!) / 2;
        const xv = (x[k + w]! - x[k - w]!) / 2;
        const yv = (y[k + w]! - y[k - w]!) / 2;
        const a = xv * xv + yv * yv;
        const b = xu * xv + yu * yv;
        const c = xu * xu + yu * yu;
        const den = 2 * (a + c);
        if (!(den > 0)) continue;
        const xuv = (x[k + w + 1]! - x[k + w - 1]! - x[k - w + 1]! + x[k - w - 1]!) / 4;
        const yuv = (y[k + w + 1]! - y[k + w - 1]! - y[k - w + 1]! + y[k - w - 1]!) / 4;
        const nx = (a * (x[k + 1]! + x[k - 1]!) + c * (x[k + w]! + x[k - w]!) - 2 * b * xuv) / den;
        const ny = (a * (y[k + 1]! + y[k - 1]!) + c * (y[k + w]! + y[k - w]!) - 2 * b * yuv) / den;
        const dx = (nx - x[k]!) * WINSLOW.over;
        const dy = (ny - y[k]!) * WINSLOW.over;
        x[k] = x[k]! + dx;
        y[k] = y[k]! + dy;
        moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
      }
    }
    if (moved < WINSLOW.settled) break;
  }
  return g;
};
