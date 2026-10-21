// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Gauss–Legendre tables and adaptive Gauss–Kronrod 7–15 integration
 * (design §6.10).
 *
 * - {@link gaussLegendre}: n-point rules on [−1, 1] for n ≤ {@link GL_MAX_ORDER},
 *   computed once at module evaluation by Newton's method on the Legendre
 *   recurrence and never mutated (the only module-level data geom has,
 *   decision 14). An n-point rule integrates polynomials of degree ≤ 2n − 1
 *   exactly; F2 and later steps use it for Gram matrices and polynomial integrals.
 * - {@link integrate1d}: globally adaptive bisection (QUADPACK's QAG strategy,
 *   Piessens et al. 1983) with the 15-point Kronrod extension of the 7-point
 *   Gauss–Legendre rule. Each subinterval's error estimate is `|K15 − G7|`; the
 *   integral is converged when the summed estimate is at most
 *   `quadRel · ∫|f|`. `∫|f|` (QUADPACK's `resabs`) rather than `|∫f|` keeps the
 *   target meaningful when the integral cancels to ~0. `|K15 − G7|` estimates the
 *   error of the lower-order rule, so it is pessimistic for the K15 value that is
 *   returned; QUADPACK's empirical rescaling (`200·err/resasc` to the power 1.5)
 *   is deliberately not used, since its constants are tuned, not derived.
 */
import { fail } from './errors';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type { QuadratureResult, ReadonlyF64 } from './types';

/** Largest Gauss–Legendre order tabulated (design §4.8: "n ≤ 64"). */
export const GL_MAX_ORDER = 64 as const;

/**
 * Cap on Newton iterations per Legendre root while building the tables. The
 * asymptotic seed `cos(π(i + 3/4)/(n + 1/2))` converges in ≤ 6 iterations for
 * n ≤ 64; the cap only guarantees termination.
 */
const GL_NEWTON_MAX_ITER = 100;

interface GLRule {
  readonly nodes: ReadonlyF64;
  readonly weights: ReadonlyF64;
}

/**
 * Nodes (ascending) and weights of the n-point rule. Newton on `P_n` from the
 * asymptotic seed, stopped once the step is at most machine epsilon (|x| ≤ 1, so
 * the node is then correct to rounding); weights `2 / ((1 − x²) P′_n(x)²)`. Nodes
 * are mirrored so the rule is exactly symmetric; the middle node of an odd rule
 * is exactly 0.
 */
function computeRule(n: number): GLRule {
  const nodes = new Float64Array(n);
  const weights = new Float64Array(n);
  const m = (n + 1) >> 1;
  for (let i = 0; i < m; i++) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0;
    for (let iter = 0; iter < GL_NEWTON_MAX_ITER; iter++) {
      // Legendre recurrence: (k + 1) P_{k+1} = (2k + 1) x P_k − k P_{k−1}.
      let p0 = 1;
      let p1 = x;
      for (let k = 1; k < n; k++) {
        const p2 = ((2 * k + 1) * x * p1 - k * p0) / (k + 1);
        p0 = p1;
        p1 = p2;
      }
      // P′_n = n (x P_n − P_{n−1}) / (x² − 1).
      dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) <= Number.EPSILON) break;
    }
    // Derivative at the final node for the weight.
    let p0 = 1;
    let p1 = x;
    for (let k = 1; k < n; k++) {
      const p2 = ((2 * k + 1) * x * p1 - k * p0) / (k + 1);
      p0 = p1;
      p1 = p2;
    }
    dp = (n * (x * p1 - p0)) / (x * x - 1);
    if (2 * i + 1 === n) x = 0;
    const w = 2 / ((1 - x * x) * dp * dp);
    nodes[n - 1 - i] = x;
    nodes[i] = -x;
    weights[n - 1 - i] = w;
    weights[i] = w;
  }
  return Object.freeze({ nodes, weights });
}

const GL_TABLES: readonly GLRule[] = Object.freeze(
  Array.from({ length: GL_MAX_ORDER }, (_, i) => computeRule(i + 1)),
);

/**
 * The n-point Gauss–Legendre rule on [−1, 1], nodes ascending. The arrays are
 * the shared module tables: read-only by type, never to be written.
 */
export function gaussLegendre(n: number): GLRule {
  if (!Number.isInteger(n) || n < 1 || n > GL_MAX_ORDER) {
    fail(
      'unsupported',
      `Gauss–Legendre order must be an integer in [1, ${GL_MAX_ORDER}]; got ${n}`,
      {
        value: n,
      },
    );
  }
  return GL_TABLES[n - 1]!;
}

// ---------------------------------------------------------------------------
// Gauss–Kronrod 7–15 (QUADPACK qk15)
// ---------------------------------------------------------------------------

/**
 * QUADPACK's qk15 constants, kept as its published 33-digit decimals (so they
 * can be checked against the source) and parsed once into the nearest doubles.
 */
function decimals(ds: readonly string[]): readonly number[] {
  return Object.freeze(ds.map(Number));
}

/** Kronrod nodes, descending; odd entries (1, 3, 5, 7) are the G7 nodes. */
const XGK = decimals([
  '0.991455371120812639206854697526329',
  '0.949107912342758524526189684047851',
  '0.864864423359769072789712788640926',
  '0.741531185599394439863864773280788',
  '0.586087235467691130294144845693013',
  '0.405845151377397166906606412076961',
  '0.207784955007898467600689403773245',
  '0',
]);
/** Kronrod weights for {@link XGK}. */
const WGK = decimals([
  '0.02293532201052922496373200805897',
  '0.063092092629978553290700663189204',
  '0.104790010322250183839876322541518',
  '0.140653259715525918745189590510238',
  '0.16900472663926790282658342659855',
  '0.190350578064785409913256402421014',
  '0.204432940075298892414161999234649',
  '0.209482141084727828012999174891714',
]);
/** G7 weights for the nodes XGK[1], XGK[3], XGK[5], XGK[7]. */
const WG = decimals([
  '0.129484966168869693270611432679082',
  '0.27970539148927666790146777142378',
  '0.381830050505118944950369775488975',
  '0.417959183673469387755102040816327',
]);

/** Exposed for tests: the Kronrod and Gauss constants above. */
export const GK15_TABLE = Object.freeze({ xgk: XGK, wgk: WGK, wg: WG });

/** One GK15 panel: the K15 value, `|K15 − G7|`, and the K15 estimate of `∫|f|`. */
interface Panel {
  value: number;
  error: number;
  abs: number;
}

function checkFinite(y: number, x: number): number {
  if (!Number.isFinite(y)) {
    fail('non-finite', `integrand is not finite at x = ${x}: ${y}`, { t: x, value: y });
  }
  return y;
}

function gk15Panel(f: (x: number) => number, lo: number, hi: number, out: Panel): void {
  const c = 0.5 * (lo + hi);
  const h = 0.5 * (hi - lo);
  const fc = checkFinite(f(c), c);
  let k = WGK[7]! * fc;
  let g = WG[3]! * fc;
  let ab = WGK[7]! * Math.abs(fc);
  for (let j = 0; j < 7; j++) {
    const dx = h * XGK[j]!;
    const f1 = checkFinite(f(c - dx), c - dx);
    const f2 = checkFinite(f(c + dx), c + dx);
    k += WGK[j]! * (f1 + f2);
    ab += WGK[j]! * (Math.abs(f1) + Math.abs(f2));
    if (j & 1) g += WG[j >> 1]! * (f1 + f2);
  }
  out.value = k * h;
  out.error = Math.abs((k - g) * h);
  out.abs = ab * Math.abs(h);
}

/** The K15 value of `∫_lo^hi f` alone (used where a converged table is refined). */
export function gk15(f: (x: number) => number, lo: number, hi: number): number {
  if (lo === hi) return 0;
  const p: Panel = { value: 0, error: 0, abs: 0 };
  gk15Panel(f, lo, hi, p);
  return p.value;
}

/** Number of integrand evaluations per GK15 panel. */
const GK15_POINTS = 15;

/** The final subintervals of an adaptive integration, sorted by position. */
export interface Partition {
  /** Breakpoints `x[0] = a < … < x[count] = b`. */
  readonly x: Float64Array;
  /** K15 value on `[x[i], x[i+1]]`. */
  readonly values: Float64Array;
  readonly result: QuadratureResult;
}

/** Neumaier's compensated sum, in the given order. */
function compensatedSum(xs: ArrayLike<number>): number {
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    const t = s + v;
    c += Math.abs(s) >= Math.abs(v) ? s - t + v : v - t + s;
    s = t;
  }
  return s + c;
}

/**
 * Adaptive GK15 on `[a, b]` (a < b), first split at `breaks` strictly inside.
 * Returns the sorted partition; `integrate1d` and the arc-length table share it,
 * so their totals agree bitwise. Converged when `Σ error ≤ max(quadRel · ∫|f|,
 * absTol)` (`absTol` default 0: relative only).
 */
export function adaptivePartition(
  f: (x: number) => number,
  a: number,
  b: number,
  breaks: ArrayLike<number>,
  t: Tolerances,
  absTol = 0,
): Partition {
  const inner: number[] = [];
  for (let i = 0; i < breaks.length; i++) {
    const x = breaks[i]!;
    if (!Number.isFinite(x))
      fail('non-finite', `quadrature break ${i} is not finite: ${x}`, { index: i });
    if (x > a && x < b) inner.push(x);
  }
  inner.sort((p, q) => p - q);
  const cuts = [a];
  for (const x of inner) if (x > cuts[cuts.length - 1]!) cuts.push(x);
  cuts.push(b);

  // Interval storage and a binary max-heap of indices keyed by error.
  const lo: number[] = [];
  const hi: number[] = [];
  const val: number[] = [];
  const err: number[] = [];
  const abs: number[] = [];
  const heap: number[] = [];
  const less = (i: number, j: number): boolean =>
    err[i]! < err[j]! || (err[i] === err[j] && lo[i]! > lo[j]!);
  const push = (id: number): void => {
    let k = heap.length;
    heap.push(id);
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (!less(heap[parent]!, heap[k]!)) break;
      [heap[parent], heap[k]] = [heap[k]!, heap[parent]!];
      k = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && less(heap[m]!, heap[l]!)) m = l;
        if (r < heap.length && less(heap[m]!, heap[r]!)) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };

  const panel: Panel = { value: 0, error: 0, abs: 0 };
  let evaluations = 0;
  let sumErr = 0;
  let sumAbs = 0;
  const add = (l: number, h: number): void => {
    gk15Panel(f, l, h, panel);
    evaluations += GK15_POINTS;
    const id = lo.length;
    lo.push(l);
    hi.push(h);
    val.push(panel.value);
    err.push(panel.error);
    abs.push(panel.abs);
    sumErr += panel.error;
    sumAbs += panel.abs;
    push(id);
  };
  for (let i = 0; i + 1 < cuts.length; i++) add(cuts[i]!, cuts[i + 1]!);

  let converged = false;
  for (;;) {
    if (sumErr <= Math.max(t.quadRel * sumAbs, absTol)) {
      converged = true;
      break;
    }
    if (heap.length >= t.quadMaxSplits) break;
    const id = heap[0]!;
    const l = lo[id]!;
    const h = hi[id]!;
    const mid = 0.5 * (l + h);
    // Rounding has exhausted the interval: the remaining error is irreducible.
    if (!(mid > l && mid < h)) break;
    pop();
    sumErr -= err[id]!;
    sumAbs -= abs[id]!;
    add(l, mid);
    add(mid, h);
  }

  const live = heap.slice().sort((i, j) => lo[i]! - lo[j]!);
  const x = new Float64Array(live.length + 1);
  const values = new Float64Array(live.length);
  const errors = new Float64Array(live.length);
  live.forEach((id, k) => {
    x[k] = lo[id]!;
    values[k] = val[id]!;
    errors[k] = err[id]!;
  });
  x[live.length] = b;
  return {
    x,
    values,
    result: Object.freeze({
      value: compensatedSum(values),
      errorEstimate: compensatedSum(errors),
      evaluations,
      converged,
    }),
  };
}

/**
 * Checks an absolute quadrature target: finite and `≥ 0` (`undefined` is 0).
 * Throws `non-finite` or `unsupported`.
 */
export function checkAbsTol(absTol: number | undefined): number {
  if (absTol === undefined) return 0;
  if (!Number.isFinite(absTol)) {
    fail('non-finite', `absTol must be finite; got ${absTol}`, { value: absTol });
  }
  if (absTol < 0) fail('unsupported', `absTol must be ≥ 0; got ${absTol}`, { value: absTol });
  return absTol;
}

/**
 * `∫_a^b f(x) dx` by adaptive Gauss–Kronrod 7–15. `breaks` are points where `f`
 * or a derivative jumps (knots); the integration first splits there. Converged
 * when `Σ|K15 − G7| ≤ max(quadRel · ∫|f|, absTol)`; otherwise the best value is
 * returned with `converged: false` (`quadMaxSplits` reached, or rounding
 * exhausted an interval). `absTol` (default 0) is the caller's absolute target:
 * an integrand that is zero up to rounding (cancellation in the caller's
 * formula) has no relative accuracy to reach, and without it refines to
 * `quadMaxSplits` on noise. `a > b` gives the negated integral. Throws
 * `non-finite` if `f` returns a non-finite value.
 */
export function integrate1d(
  f: (x: number) => number,
  a: number,
  b: number,
  opts?: {
    readonly breaks?: ArrayLike<number>;
    readonly tol?: Partial<Tolerances>;
    readonly absTol?: number;
  },
): QuadratureResult {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    fail('non-finite', `integration limits must be finite; got [${a}, ${b}]`, { a, b });
  }
  const t = resolveTolerances(opts?.tol);
  const absTol = checkAbsTol(opts?.absTol);
  if (a === b)
    return Object.freeze({ value: 0, errorEstimate: 0, evaluations: 0, converged: true });
  const breaks = opts?.breaks ?? [];
  if (a < b) return adaptivePartition(f, a, b, breaks, t, absTol).result;
  const r = adaptivePartition(f, b, a, breaks, t, absTol).result;
  return Object.freeze({ ...r, value: -r.value });
}
