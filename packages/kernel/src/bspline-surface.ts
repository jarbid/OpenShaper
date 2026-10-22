// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cubic B-spline curve and tensor-product surface interpolation.
 *
 * Board-agnostic: this module knows nothing about boards, stations or rails. It
 * takes points and returns curves and surfaces that pass through them exactly.
 * `board-surface.ts` is what turns a {@link BezierBoard} into the point grid, and
 * `@openshaper/export`'s STEP writer is what encodes the result.
 *
 * Written because the repo has no surface representation at all. The board's own
 * curves are piecewise cubic BEZIER chains (`bezier-spline.ts`), and the lofted
 * hull is defined only pointwise (`loft.ts`) — deliberately, see the rationale
 * there. Neither can be handed to a CAD system, which wants a control net and a
 * knot vector.
 *
 * ## What it implements
 *
 * Global interpolation, Piegl & Tiller *The NURBS Book* A9.1 (curve) and A9.4
 * (surface): centripetal or chord-length parameterization, averaged clamped knot
 * vectors (eq. 9.8), and a banded-but-solved-densely collocation system. The
 * control net comes out the same size as the data grid, endpoints are
 * interpolated exactly, and no end-derivative conditions are needed.
 *
 * Evaluation goes to second order (P&T A2.3): {@link evalSurfaceDeriv2} and
 * {@link principalCurvatures}, which the 3D view's exact curvature analysis reads.
 * Both can be asked for either one-sided limit at a knot ({@link KnotSide}), which
 * is what lets the analysis show a crease as a crisp jump rather than a smear.
 *
 * ## Why the strip machinery exists
 *
 * A surface skinned through the board is NOT globally smooth along its length:
 * `loftSection` blends adjacent stations with a weight that is piecewise linear in
 * x, so the hull has a tangent break at every cross-section. Fitting one smooth
 * bicubic through it would round those breaks off, and the STEP file would then
 * describe a different board than the STL.
 *
 * {@link interpolateSurface} therefore takes `uBreaks` — row indices at which the
 * data has a genuine crease. It fits each strip between breaks independently with
 * a plain clamped knot vector and concatenates them, which lands an interior knot
 * of multiplicity `degree` at each break: C0 there, C-infinity everywhere else.
 * The join is exact rather than approximate, because both strips are clamped to
 * the same data row, so their shared control point is the same number.
 */
import type { Vert3 } from './loft';

/** A clamped B-spline curve. `knots.length === ctrl.length + degree + 1`. */
export interface BSplineCurve {
  readonly degree: number;
  readonly ctrl: readonly Vert3[];
  readonly knots: readonly number[];
}

/**
 * A clamped tensor-product B-spline surface.
 *
 * `ctrl` is U-MAJOR: `ctrl[i][j]` is the control point at u-index `i`, v-index
 * `j`. STEP's `B_SPLINE_SURFACE_WITH_KNOTS` uses the same nesting, so the writer
 * can emit the rows in order.
 */
export interface BSplineSurface {
  readonly uDegree: number;
  readonly vDegree: number;
  readonly ctrl: readonly (readonly Vert3[])[];
  readonly uKnots: readonly number[];
  readonly vKnots: readonly number[];
}

/** Which of the four natural boundaries of a surface patch. */
export type SurfaceEdge = 'u0' | 'u1' | 'v0' | 'v1';

export const CUBIC = 3;

/**
 * Parameterization exponent. 1 = chord length, 0.5 = centripetal (Lee).
 *
 * Centripetal is the right default through a sharp turn — a rail apex — where
 * chord-length parameterization lets the interpolant overshoot. Chord length is
 * better where the data is already near-uniform, as it is along the board's length.
 */
export const CENTRIPETAL = 0.5;
export const CHORD = 1;

const dist = (a: Vert3, b: Vert3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/**
 * Normalized parameters for a point sequence, in [0, 1].
 *
 * Falls back to uniform spacing if the points are coincident, so a degenerate row
 * (a collapsed tip) yields a usable — if arbitrary — parameterization instead of
 * NaN.
 */
export const pointParams = (pts: readonly Vert3[], exponent = CENTRIPETAL): number[] => {
  const n = pts.length;
  if (n < 2) return n === 1 ? [0] : [];
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.pow(dist(pts[i - 1]!, pts[i]!), exponent);
    cum.push(total);
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    return Array.from({ length: n }, (_, i) => i / (n - 1));
  }
  return cum.map((v) => v / total);
};

/** Componentwise mean of several parameter vectors — the A9.4 averaging step. */
export const averageParams = (all: readonly (readonly number[])[]): number[] => {
  const n = all[0]?.length ?? 0;
  if (n === 0) return [];
  const out = new Array<number>(n).fill(0);
  for (const p of all) for (let i = 0; i < n; i++) out[i] = out[i]! + p[i]!;
  for (let i = 0; i < n; i++) out[i] = out[i]! / all.length;
  // Averaging cannot reorder a set of increasing sequences, but it can make two
  // entries equal when the inputs disagree wildly; nudging keeps the collocation
  // matrix nonsingular (Schoenberg–Whitney needs strictly increasing sites), and
  // the rescale afterwards puts the result back on exactly [0, 1].
  for (let i = 1; i < n; i++) {
    if (out[i]! <= out[i - 1]!) out[i] = out[i - 1]! + 1e-12;
  }
  const lo = out[0]!;
  const span = out[n - 1]! - lo;
  if (!(span > 0)) return Array.from({ length: n }, (_, i) => i / Math.max(1, n - 1));
  for (let i = 0; i < n; i++) out[i] = (out[i]! - lo) / span;
  return out;
};

/**
 * Clamped knot vector by averaging (P&T eq. 9.8), spanning `params[0]..params[n]`.
 *
 * Averaging is what makes the collocation matrix totally positive and nonsingular
 * by Schoenberg–Whitney, so the interpolation always has a unique solution.
 */
export const averagedKnots = (params: readonly number[], degree: number): number[] => {
  const n = params.length - 1;
  const m = n + degree + 1;
  const U = new Array<number>(m + 1).fill(0);
  const a = params[0]!;
  const b = params[n]!;
  for (let i = 0; i <= degree; i++) U[i] = a;
  for (let i = m - degree; i <= m; i++) U[i] = b;
  for (let j = 1; j <= n - degree; j++) {
    let s = 0;
    for (let i = j; i <= j + degree - 1; i++) s += params[i]!;
    U[j + degree] = s / degree;
  }
  return U;
};

/** Knot span index containing `u` (P&T A2.1). `n` is the last control-point index. */
const findSpan = (n: number, degree: number, u: number, U: readonly number[]): number => {
  if (u >= U[n + 1]!) return n;
  if (u <= U[degree]!) return degree;
  let lo = degree;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
};

/**
 * Which one-sided limit to take when a parameter lands exactly on an interior knot.
 *
 * Inside a knot span the surface is one polynomial and the two limits agree. At a
 * knot of multiplicity `degree - 1` or more they need not: the derivatives the
 * surface lacks there (curvature at a C1 knot, the tangent too at a C0 crease) are
 * different numbers on each side. `'above'` evaluates the span starting at the knot
 * (what {@link findSpan} picks, and the default); `'below'` the span ending at it.
 */
export type KnotSide = 'below' | 'above';

/**
 * {@link findSpan}, or for `side === 'below'` the span `i` with
 * `U[i] < u <= U[i + 1]` — the one ending at `u` when `u` is a knot.
 */
const findSpanSided = (
  n: number,
  degree: number,
  u: number,
  U: readonly number[],
  side: KnotSide,
): number => {
  let span = findSpan(n, degree, u, U);
  if (side === 'below') {
    // At the last span findSpan already answers from below; elsewhere step back
    // over every copy of the knot `u` sits on.
    while (span > degree && U[span]! >= u) span--;
  }
  return span;
};

/** The `degree + 1` nonzero basis functions at `u` (P&T A2.2). */
const basisFuns = (span: number, u: number, degree: number, U: readonly number[]): number[] => {
  const N = new Array<number>(degree + 1).fill(0);
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - U[span + 1 - j]!;
    right[j] = U[span + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1]! + left[j - r]!;
      const temp = denom === 0 ? 0 : N[r]! / denom;
      N[r] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    N[j] = saved;
  }
  return N;
};

/**
 * Nonzero basis functions and their first derivatives at `u` (P&T A2.3, k = 1).
 *
 * Returned as `[N, dN]`. Analytic rather than finite-difference because the
 * surfaces here carry knots of multiplicity `degree` at every station crease, where
 * a centred difference would straddle a tangent discontinuity and report nonsense.
 */
const basisFunsDer1 = (
  span: number,
  u: number,
  degree: number,
  U: readonly number[],
): [number[], number[]] => {
  const ndu: number[][] = Array.from({ length: degree + 1 }, () =>
    new Array<number>(degree + 1).fill(0),
  );
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  ndu[0]![0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - U[span + 1 - j]!;
    right[j] = U[span + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j]![r] = right[r + 1]! + left[j - r]!;
      const temp = ndu[j]![r] === 0 ? 0 : ndu[r]![j - 1]! / ndu[j]![r]!;
      ndu[r]![j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[j]![j] = saved;
  }

  const N = new Array<number>(degree + 1).fill(0);
  for (let j = 0; j <= degree; j++) N[j] = ndu[j]![degree]!;

  // First derivative: P&T eq. 2.9 specialised to k = 1,
  //   N'_{i,p} = p N_{i,p-1} / (u_{i+p} - u_i) - p N_{i+1,p-1} / (u_{i+p+1} - u_{i+1}).
  const dN = new Array<number>(degree + 1).fill(0);
  for (let r = 0; r <= degree; r++) {
    let d = 0;
    if (r >= 1) {
      const den = ndu[degree]![r - 1]!;
      if (den !== 0) d += ndu[r - 1]![degree - 1]! / den;
    }
    if (r <= degree - 1) {
      const den = ndu[degree]![r]!;
      if (den !== 0) d -= ndu[r]![degree - 1]! / den;
    }
    dN[r] = d * degree;
  }
  return [N, dN];
};

/**
 * Nonzero basis functions and their first two derivatives at `u` (P&T A2.3, n = 2).
 *
 * Returned as `[N, dN, d2N]`. A separate routine from {@link basisFunsDer1} rather
 * than a generalisation of it, so the first-derivative path the STEP writer relies
 * on keeps its exact arithmetic. Derivatives above the degree are zero, which is
 * what a linear direction (a two-row grid) correctly reports.
 */
const basisFunsDer2 = (
  span: number,
  u: number,
  degree: number,
  U: readonly number[],
): [number[], number[], number[]] => {
  const p = degree;
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  ndu[0]![0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j]!;
    right[j] = U[span + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      // Lower triangle: knot differences. Upper triangle: basis functions.
      ndu[j]![r] = right[r + 1]! + left[j - r]!;
      const temp = ndu[j]![r] === 0 ? 0 : ndu[r]![j - 1]! / ndu[j]![r]!;
      ndu[r]![j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[j]![j] = saved;
  }

  const n = Math.min(2, p);
  const ders: number[][] = [0, 1, 2].map(() => new Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0]![j] = ndu[j]![p]!;

  // P&T A2.3: alternate between two rows of coefficients a[s][*].
  const a: number[][] = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0]![0] = 1;
    for (let k = 1; k <= n; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        const den = ndu[pk + 1]![rk]!;
        a[s2]![0] = den === 0 ? 0 : a[s1]![0]! / den;
        d = a[s2]![0]! * ndu[rk]![pk]!;
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        const den = ndu[pk + 1]![rk + j]!;
        a[s2]![j] = den === 0 ? 0 : (a[s1]![j]! - a[s1]![j - 1]!) / den;
        d += a[s2]![j]! * ndu[rk + j]![pk]!;
      }
      if (r <= pk) {
        const den = ndu[pk + 1]![r]!;
        a[s2]![k] = den === 0 ? 0 : -a[s1]![k - 1]! / den;
        d += a[s2]![k]! * ndu[r]![pk]!;
      }
      ders[k]![r] = d;
      const t = s1;
      s1 = s2;
      s2 = t;
    }
  }
  // Multiply through by p!/(p-k)!.
  let factor = p;
  for (let k = 1; k <= n; k++) {
    for (let j = 0; j <= p; j++) ders[k]![j] = ders[k]![j]! * factor;
    factor *= p - k;
  }
  return [ders[0]!, ders[1]!, ders[2]!];
};

// --- dense LU, factored once per direction and reused for every right-hand side ---

interface Lu {
  readonly n: number;
  readonly a: number[][];
  readonly piv: number[];
}

const luFactor = (m: readonly (readonly number[])[]): Lu => {
  const n = m.length;
  const a = m.map((row) => [...row]);
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n; k++) {
    let best = k;
    let bestAbs = Math.abs(a[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i]![k]!);
      if (v > bestAbs) {
        best = i;
        bestAbs = v;
      }
    }
    if (best !== k) {
      const t = a[k]!;
      a[k] = a[best]!;
      a[best] = t;
      const tp = piv[k]!;
      piv[k] = piv[best]!;
      piv[best] = tp;
    }
    const pivot = a[k]![k]!;
    if (pivot === 0) continue; // singular: leave the row alone, solve yields 0s
    const ak = a[k]!;
    for (let i = k + 1; i < n; i++) {
      const ai = a[i]!;
      const f = ai[k]! / pivot;
      ai[k] = f;
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) ai[j] = ai[j]! - f * ak[j]!;
    }
  }
  return { n, a, piv };
};

const luSolve = (lu: Lu, rhs: readonly number[]): number[] => {
  const { n, a, piv } = lu;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = rhs[piv[i]!]!;
    for (let j = 0; j < i; j++) s -= a[i]![j]! * y[j]!;
    y[i] = s;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let j = i + 1; j < n; j++) s -= a[i]![j]! * x[j]!;
    const d = a[i]![i]!;
    x[i] = d === 0 ? 0 : s / d;
  }
  return x;
};

/** Collocation matrix `A[i][j] = N_{j,degree}(params[i])`. */
const collocation = (
  params: readonly number[],
  degree: number,
  U: readonly number[],
): number[][] => {
  const n = params.length - 1;
  const A: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= n; i++) {
    const span = findSpan(n, degree, params[i]!, U);
    const N = basisFuns(span, params[i]!, degree, U);
    for (let k = 0; k <= degree; k++) A[i]![span - degree + k] = N[k]!;
  }
  return A;
};

/**
 * Solve the interpolation system for a batch of point sequences that all share
 * the same parameters and knots — the whole point of factoring the matrix once.
 */
const solveRows = (
  rows: readonly (readonly Vert3[])[],
  params: readonly number[],
  degree: number,
  U: readonly number[],
): Vert3[][] => {
  const lu = luFactor(collocation(params, degree, U));
  const n = params.length;
  return rows.map((row) => {
    const cx = luSolve(
      lu,
      row.map((p) => p.x),
    );
    const cy = luSolve(
      lu,
      row.map((p) => p.y),
    );
    const cz = luSolve(
      lu,
      row.map((p) => p.z),
    );
    const out: Vert3[] = [];
    for (let i = 0; i < n; i++) out.push({ x: cx[i]!, y: cy[i]!, z: cz[i]! });
    return out;
  });
};

/**
 * The cubic (or lower, for short inputs) B-spline curve through `pts`.
 *
 * Degree drops automatically when there are too few points to support a cubic —
 * two points give a straight line, three a quadratic — so callers never have to
 * special-case a short sequence.
 */
export const interpolateCurve = (
  pts: readonly Vert3[],
  degree = CUBIC,
  exponent = CENTRIPETAL,
): BSplineCurve => {
  const p = Math.min(degree, pts.length - 1);
  if (p < 1) throw new Error('interpolateCurve needs at least 2 points');
  const params = pointParams(pts, exponent);
  const knots = averagedKnots(params, p);
  const ctrl = solveRows([pts], params, p, knots)[0]!;
  return { degree: p, ctrl, knots };
};

/** Point on a curve at parameter `u`. */
export const evalCurve = (c: BSplineCurve, u: number): Vert3 => {
  const n = c.ctrl.length - 1;
  const span = findSpan(n, c.degree, u, c.knots);
  const N = basisFuns(span, u, c.degree, c.knots);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k <= c.degree; k++) {
    const P = c.ctrl[span - c.degree + k]!;
    x += N[k]! * P.x;
    y += N[k]! * P.y;
    z += N[k]! * P.z;
  }
  return { x, y, z };
};

export interface SurfaceFitOptions {
  /**
   * Row indices (strictly interior, ascending) at which the data has a genuine
   * tangent break. Each becomes an interior knot of multiplicity `uDegree`.
   */
  readonly uBreaks?: readonly number[];
  readonly uDegree?: number;
  readonly vDegree?: number;
  /** Parameterization exponent along u (default chord length). */
  readonly uExponent?: number;
  /** Parameterization exponent along v (default centripetal). */
  readonly vExponent?: number;
}

/**
 * Interpolate `u` through one column of intermediate control points, splitting at
 * `breaks` and concatenating the strips.
 *
 * Concatenation is exact: each strip is clamped, so its first and last control
 * points ARE the data points at the break rows, and the two strips meeting there
 * contribute the identical point. Dropping one copy and giving the shared knot
 * multiplicity `degree` reproduces both halves unchanged with C0 between them.
 */
const interpolateStrips = (
  columns: readonly (readonly Vert3[])[],
  params: readonly number[],
  degree: number,
  breaks: readonly number[],
): { ctrl: Vert3[][]; knots: number[] } => {
  const bounds = [0, ...breaks, params.length - 1];
  const perColumn: Vert3[][] = columns.map(() => []);
  const knots: number[] = [];

  for (let s = 0; s < bounds.length - 1; s++) {
    const lo = bounds[s]!;
    const hi = bounds[s + 1]!;
    const sub = params.slice(lo, hi + 1);
    // Every strip must carry the SAME degree, or the pieces cannot be concatenated
    // into one surface. Callers that split at creases are responsible for giving
    // each strip enough rows; only an unsplit grid may drop degree to fit.
    if (sub.length < degree + 1) {
      throw new Error(
        `interpolateSurface: strip ${s} has ${sub.length} rows, needs ${degree + 1} for degree ${degree}`,
      );
    }
    const U = averagedKnots(sub, degree);
    const solved = solveRows(
      columns.map((col) => col.slice(lo, hi + 1)),
      sub,
      degree,
      U,
    );
    solved.forEach((ctrl, c) => {
      // Skip the first control point of every strip after the first: it is the
      // previous strip's last, to the bit, because both strips are clamped to the
      // same data row.
      perColumn[c]!.push(...(s === 0 ? ctrl : ctrl.slice(1)));
    });
    if (s === 0) {
      knots.push(...U);
    } else {
      // U0 ends [.., a ×(degree+1)] and U1 starts [a ×(degree+1), ..]. Drop one
      // trailing copy and all leading copies, leaving the shared breakpoint at
      // multiplicity `degree` — C0, which is exactly the crease in the data.
      knots.length -= 1;
      knots.push(...U.slice(degree + 1));
    }
  }
  return { ctrl: perColumn, knots };
};

/**
 * Global bicubic interpolation of a rectangular grid (P&T A9.4).
 *
 * `grid[r][c]` is row `r` along u, column `c` along v; every row must have the
 * same length. The returned surface passes through every grid point.
 */
export const interpolateSurface = (
  grid: readonly (readonly Vert3[])[],
  opts: SurfaceFitOptions = {},
): BSplineSurface => {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows < 2 || cols < 2) throw new Error('interpolateSurface needs a 2x2 grid at least');
  for (const row of grid) {
    if (row.length !== cols) throw new Error('interpolateSurface needs a rectangular grid');
  }

  const uDegree = Math.min(opts.uDegree ?? CUBIC, rows - 1);
  const vDegree = Math.min(opts.vDegree ?? CUBIC, cols - 1);

  // v first: interpolate each row across the profile, giving intermediate control
  // points that are then interpolated along the length.
  const vParams = averageParams(grid.map((row) => pointParams(row, opts.vExponent ?? CENTRIPETAL)));
  const vKnots = averagedKnots(vParams, vDegree);
  const intermediate = solveRows(grid, vParams, vDegree, vKnots);

  // u second, on the columns of the intermediate net.
  const columns: Vert3[][] = [];
  for (let c = 0; c < cols; c++) columns.push(intermediate.map((row) => row[c]!));

  const uParams = averageParams(columns.map((col) => pointParams(col, opts.uExponent ?? CHORD)));
  const breaks = (opts.uBreaks ?? []).filter((b) => b > 0 && b < rows - 1);
  const { ctrl: perColumn, knots: uKnots } = interpolateStrips(columns, uParams, uDegree, breaks);

  // Transpose back to U-major.
  const uCount = perColumn[0]!.length;
  const net: Vert3[][] = [];
  for (let i = 0; i < uCount; i++) net.push(perColumn.map((col) => col[i]!));

  return { uDegree, vDegree, ctrl: net, uKnots, vKnots };
};

/** Point on a surface at `(u, v)`. */
export const evalSurface = (s: BSplineSurface, u: number, v: number): Vert3 => {
  const nu = s.ctrl.length - 1;
  const nv = s.ctrl[0]!.length - 1;
  const uSpan = findSpan(nu, s.uDegree, u, s.uKnots);
  const vSpan = findSpan(nv, s.vDegree, v, s.vKnots);
  const Nu = basisFuns(uSpan, u, s.uDegree, s.uKnots);
  const Nv = basisFuns(vSpan, v, s.vDegree, s.vKnots);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i <= s.uDegree; i++) {
    const row = s.ctrl[uSpan - s.uDegree + i]!;
    for (let j = 0; j <= s.vDegree; j++) {
      const w = Nu[i]! * Nv[j]!;
      const P = row[vSpan - s.vDegree + j]!;
      x += w * P.x;
      y += w * P.y;
      z += w * P.z;
    }
  }
  return { x, y, z };
};

/** Surface point and its two first partial derivatives at `(u, v)`. */
export const evalSurfaceDeriv = (
  s: BSplineSurface,
  u: number,
  v: number,
): { point: Vert3; du: Vert3; dv: Vert3 } => {
  const nu = s.ctrl.length - 1;
  const nv = s.ctrl[0]!.length - 1;
  const uSpan = findSpan(nu, s.uDegree, u, s.uKnots);
  const vSpan = findSpan(nv, s.vDegree, v, s.vKnots);
  const [Nu, dNu] = basisFunsDer1(uSpan, u, s.uDegree, s.uKnots);
  const [Nv, dNv] = basisFunsDer1(vSpan, v, s.vDegree, s.vKnots);
  const acc = { x: 0, y: 0, z: 0 };
  const du = { x: 0, y: 0, z: 0 };
  const dv = { x: 0, y: 0, z: 0 };
  for (let i = 0; i <= s.uDegree; i++) {
    const row = s.ctrl[uSpan - s.uDegree + i]!;
    for (let j = 0; j <= s.vDegree; j++) {
      const P = row[vSpan - s.vDegree + j]!;
      const w = Nu[i]! * Nv[j]!;
      const wu = dNu[i]! * Nv[j]!;
      const wv = Nu[i]! * dNv[j]!;
      acc.x += w * P.x;
      acc.y += w * P.y;
      acc.z += w * P.z;
      du.x += wu * P.x;
      du.y += wu * P.y;
      du.z += wu * P.z;
      dv.x += wv * P.x;
      dv.y += wv * P.y;
      dv.z += wv * P.z;
    }
  }
  return { point: acc, du, dv };
};

/** Unit surface normal (`S_u x S_v`), or null where the surface is degenerate. */
export const surfaceNormal = (s: BSplineSurface, u: number, v: number): Vert3 | null => {
  const { du, dv } = evalSurfaceDeriv(s, u, v);
  const nx = du.y * dv.z - du.z * dv.y;
  const ny = du.z * dv.x - du.x * dv.z;
  const nz = du.x * dv.y - du.y * dv.x;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12)) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
};

/** A surface point with its first and second partial derivatives. */
export interface SurfaceDeriv2 {
  readonly point: Vert3;
  readonly du: Vert3;
  readonly dv: Vert3;
  readonly duu: Vert3;
  readonly duv: Vert3;
  readonly dvv: Vert3;
}

/** One-sided evaluation at a knot; see {@link KnotSide}. Both default to `'above'`. */
export interface KnotSides {
  readonly uSide?: KnotSide;
  readonly vSide?: KnotSide;
}

/** One direction's span and basis functions to second order at a parameter. */
interface Basis2 {
  readonly span: number;
  readonly N: readonly number[];
  readonly dN: readonly number[];
  readonly d2N: readonly number[];
}

const basis2 = (
  knots: readonly number[],
  degree: number,
  count: number,
  t: number,
  side: KnotSide,
): Basis2 => {
  const span = findSpanSided(count - 1, degree, t, knots, side);
  const [N, dN, d2N] = basisFunsDer2(span, t, degree, knots);
  return { span, N, dN, d2N };
};

/**
 * Sum over the control points the two spans touch: first along v (one row of
 * weights per derivative order), then along u — six (u, v) derivative pairs out of
 * three v-sums per control row.
 */
const combine2 = (s: BSplineSurface, bu: Basis2, bv: Basis2): SurfaceDeriv2 => {
  const zero = (): Vert3 => ({ x: 0, y: 0, z: 0 });
  const [point, du, dv, duu, duv, dvv] = [zero(), zero(), zero(), zero(), zero(), zero()];
  const add = (into: Vert3, w: number, x: number, y: number, z: number) => {
    into.x += w * x;
    into.y += w * y;
    into.z += w * z;
  };
  const { N: Nv, dN: dNv, d2N: d2Nv } = bv;
  for (let i = 0; i <= s.uDegree; i++) {
    const row = s.ctrl[bu.span - s.uDegree + i]!;
    // Row i's v-sums: the curve over that control row and its first two derivatives.
    let x0 = 0;
    let y0 = 0;
    let z0 = 0;
    let x1 = 0;
    let y1 = 0;
    let z1 = 0;
    let x2 = 0;
    let y2 = 0;
    let z2 = 0;
    for (let j = 0; j <= s.vDegree; j++) {
      const P = row[bv.span - s.vDegree + j]!;
      const a = Nv[j]!;
      const b = dNv[j]!;
      const c = d2Nv[j]!;
      x0 += a * P.x;
      y0 += a * P.y;
      z0 += a * P.z;
      x1 += b * P.x;
      y1 += b * P.y;
      z1 += b * P.z;
      x2 += c * P.x;
      y2 += c * P.y;
      z2 += c * P.z;
    }
    add(point, bu.N[i]!, x0, y0, z0);
    add(du, bu.dN[i]!, x0, y0, z0);
    add(duu, bu.d2N[i]!, x0, y0, z0);
    add(dv, bu.N[i]!, x1, y1, z1);
    add(duv, bu.dN[i]!, x1, y1, z1);
    add(dvv, bu.N[i]!, x2, y2, z2);
  }
  return { point, du, dv, duu, duv, dvv };
};

/**
 * Surface point and every partial derivative up to second order at `(u, v)`.
 *
 * Analytic, from the basis-function derivatives, for the same reason as
 * {@link evalSurfaceDeriv}: a finite difference straddling one of the board fit's
 * station creases would average two different surfaces. On a knot, `sides` picks
 * which neighbouring span answers.
 */
export const evalSurfaceDeriv2 = (
  s: BSplineSurface,
  u: number,
  v: number,
  sides: KnotSides = {},
): SurfaceDeriv2 =>
  combine2(
    s,
    basis2(s.uKnots, s.uDegree, s.ctrl.length, u, sides.uSide ?? 'above'),
    basis2(s.vKnots, s.vDegree, s.ctrl[0]!.length, v, sides.vSide ?? 'above'),
  );

/** A parameter to sample on a grid, and which side of a knot to take it from. */
export interface GridParam {
  readonly t: number;
  /** Default `'above'`; see {@link KnotSide}. */
  readonly side?: KnotSide;
}

/**
 * {@link evalSurfaceDeriv2} over the tensor grid `us` × `vs`, row by row.
 *
 * Gives the same numbers as calling it per point, but evaluates each row's and
 * each column's basis functions once instead of at every point — the bulk of the
 * cost, and the difference between a few hundred milliseconds and a few tens for
 * the 3D curvature analysis.
 */
export const evalSurfaceDeriv2Grid = (
  s: BSplineSurface,
  us: readonly GridParam[],
  vs: readonly GridParam[],
  visit: (row: number, col: number, d: SurfaceDeriv2) => void,
): void => {
  const cols = vs.map((p) =>
    basis2(s.vKnots, s.vDegree, s.ctrl[0]!.length, p.t, p.side ?? 'above'),
  );
  us.forEach((p, r) => {
    const bu = basis2(s.uKnots, s.uDegree, s.ctrl.length, p.t, p.side ?? 'above');
    cols.forEach((bv, c) => visit(r, c, combine2(s, bu, bv)));
  });
};

/**
 * Principal, mean and Gaussian curvature at a point, with the normal the signs
 * refer to. Curvatures are in 1/length of the surface's own units (1/cm for a
 * board).
 */
export interface PrincipalCurvatures {
  /** The larger principal curvature. */
  readonly k1: number;
  /** The smaller principal curvature: `k2 <= k1`. */
  readonly k2: number;
  /** `(k1 + k2) / 2`. Changes sign with the normal. */
  readonly mean: number;
  /** `k1 * k2`. Independent of the normal: positive on a dome, negative on a saddle. */
  readonly gaussian: number;
  /** Unit normal the signs are taken against. */
  readonly normal: Vert3;
}

export interface CurvatureOptions extends KnotSides {
  /**
   * `1` (default) takes the normal as `S_u x S_v`, as {@link surfaceNormal} does;
   * `-1` flips it. A patch whose parameterization makes `S_u x S_v` point inward
   * passes `-1` to get outward-referenced signs.
   */
  readonly orientation?: 1 | -1;
}

/**
 * Principal curvatures of a surface at `(u, v)`, from the first and second
 * fundamental forms.
 *
 * ## Sign convention
 *
 * Positive means the surface bends AWAY from its normal — convex as seen from the
 * side the normal points to. With outward normals a sphere of radius R reports
 * k1 = k2 = mean = 1/R and gaussian = 1/R²; a concave (dished) patch reports
 * negative curvature. For a board hull with outward normals that reads the way a
 * shaper does: deck crown and rails positive, a bottom concave negative.
 * Concretely, the second fundamental form is taken as `-S_uu·n`, `-S_uv·n`,
 * `-S_vv·n`.
 *
 * Returns null where the surface is degenerate (`S_u x S_v` vanishes), as
 * {@link surfaceNormal} does.
 */
export const principalCurvatures = (
  s: BSplineSurface,
  u: number,
  v: number,
  opts: CurvatureOptions = {},
): PrincipalCurvatures | null => {
  const d = evalSurfaceDeriv2(s, u, v, opts);
  return curvaturesFromDerivs(d, opts.orientation ?? 1);
};

const dot = (a: Vert3, b: Vert3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * {@link principalCurvatures} from derivatives already in hand — for callers that
 * also want the point and the tangents, so the surface is evaluated once.
 */
export const curvaturesFromDerivs = (
  d: SurfaceDeriv2,
  orientation: 1 | -1 = 1,
): PrincipalCurvatures | null => {
  const { du, dv } = d;
  const cx = du.y * dv.z - du.z * dv.y;
  const cy = du.z * dv.x - du.x * dv.z;
  const cz = du.x * dv.y - du.y * dv.x;
  const len = Math.hypot(cx, cy, cz);
  if (!(len > 1e-12)) return null;
  const n: Vert3 = {
    x: (orientation * cx) / len,
    y: (orientation * cy) / len,
    z: (orientation * cz) / len,
  };
  // First fundamental form; EG - F² = |S_u x S_v|², which is already in hand and
  // does not suffer the cancellation the explicit difference would.
  const E = dot(du, du);
  const F = dot(du, dv);
  const G = dot(dv, dv);
  const det = len * len;
  // Second fundamental form, signed so that bending away from n is positive.
  const L = -dot(d.duu, n);
  const M = -dot(d.duv, n);
  const N = -dot(d.dvv, n);
  const gaussian = (L * N - M * M) / det;
  const mean = (L * G - 2 * M * F + N * E) / (2 * det);
  // H² - K = ((k1 - k2) / 2)² ≥ 0 in exact arithmetic; clamp the rounding.
  const half = Math.sqrt(Math.max(0, mean * mean - gaussian));
  return { k1: mean + half, k2: mean - half, mean, gaussian, normal: n };
};

/**
 * A natural boundary of the patch, as an exact B-spline curve.
 *
 * Exact and free: for a clamped surface the v-basis at v = 0 is (1, 0, 0, ...), so
 * `S(u, 0)` is precisely the curve over the boundary control row with the same
 * knot vector. That is what lets the STEP writer emit an `EDGE_CURVE` referencing
 * the very same `CARTESIAN_POINT`s as the surface, with no pcurve and no
 * tolerance.
 */
export const surfaceBoundaryCurve = (s: BSplineSurface, edge: SurfaceEdge): BSplineCurve => {
  switch (edge) {
    case 'v0':
      return { degree: s.uDegree, ctrl: s.ctrl.map((row) => row[0]!), knots: s.uKnots };
    case 'v1':
      return {
        degree: s.uDegree,
        ctrl: s.ctrl.map((row) => row[row.length - 1]!),
        knots: s.uKnots,
      };
    case 'u0':
      return { degree: s.vDegree, ctrl: [...s.ctrl[0]!], knots: s.vKnots };
    case 'u1':
      return { degree: s.vDegree, ctrl: [...s.ctrl[s.ctrl.length - 1]!], knots: s.vKnots };
  }
};

/**
 * A knot vector as STEP wants it: distinct values with their multiplicities.
 * `Σ multiplicities === ctrl.length + degree + 1`.
 */
export const knotMultiplicities = (
  knots: readonly number[],
): { values: number[]; mults: number[] } => {
  const values: number[] = [];
  const mults: number[] = [];
  for (const k of knots) {
    if (values.length > 0 && k === values[values.length - 1]!) {
      mults[mults.length - 1] = mults[mults.length - 1]! + 1;
    } else {
      values.push(k);
      mults.push(1);
    }
  }
  return { values, mults };
};
