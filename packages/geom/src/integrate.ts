// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration over trimmed surface domains: integrals, area and enclosed
 * volume (design §6.16, §11.3, decision 28).
 *
 * **Green's theorem** in the parameter domain, boundary positively oriented
 * (outer counter-clockwise, holes clockwise, as trim loops are):
 *
 *     ∫∫_D f(u, v) du dv = ∮_∂D F(u, v) dv,   F(u, v) = ∫_{u_ref}^{u} f(s, v) ds
 *
 * - `u_ref` is the smallest u of the loops' control points (any constant is
 *   exact; this one keeps the strips short, so the loop integral cancels less).
 * - **Inner integral** split at the surface's u-knots.
 * - **Outer integral** along each trim curve, split at the curve's knots and at
 *   every `t` where `u(t)` crosses a surface u-knot or `v(t)` a v-knot (found on
 *   the curve's Bézier pieces by certified subdivision and bisection,
 *   `pieces.ts`), so every piece of the integrand is smooth.
 * - **Exactness.** With `polynomialDegree = [d_u, d_v]` the caller promises `f`
 *   is a polynomial of at most that bidegree on each span pair. The inner rule
 *   is then `⌈(d_u + 1)/2⌉`-point Gauss–Legendre per u-span (exact), and on a
 *   polynomial pcurve of degree `q` the outer integrand `F(u(t), v(t))·v′(t)` is
 *   a polynomial of degree `q(d_u + d_v + 2) − 1` per piece, integrated exactly
 *   by `⌈q(d_u + d_v + 2)/2⌉` points (when that is at most `GL_MAX_ORDER`). For
 *   polynomial `S` of bidegree `(p, q)` the volume integrand
 *   `(S − c)·(S_u × S_v)` has bidegree `(3p − 1, 3q − 1)` (§11.3).
 * - **Otherwise** (rational geometry, the area integrand `|S_u × S_v|`):
 *   adaptive Gauss–Kronrod 7–15 (`integrate1d`) on both levels until
 *   `quadRel`.
 * - **Natural-boundary faces** (no loops) use the tensor-product rule per span
 *   pair, exact under the same conditions, or nested adaptive integration.
 *   Periodic directions integrate over one period.
 *
 * **Error estimate.** Exact rules report the rounding bound `n·ε·Σ|terms|`
 * (Higham's summation bound). Adaptive results report the outer Gauss–Kronrod
 * estimate plus the largest inner estimate times the outer measure (the
 * v-length for tensor faces; the total variation of `v` along the loops,
 * bounded by the control polygons, for Green). `converged` is true only if
 * every inner and outer integral met `quadRel`.
 *
 * **Absolute target.** `absTol` (default 0) lets an adaptive integral also
 * converge when its estimated error is at most that, split between the levels so
 * the reported total stays within it: half to the outer integrals (shared
 * equally between the trim curves), half to the inner ones (divided by the
 * outer measure they are multiplied with). A caller whose integrand can cancel
 * to rounding noise (a moment component over a wall, a volume integrand over a
 * face through the reference point) passes the accuracy it needs on the scale of
 * the whole result; relative accuracy of a zero is unattainable, and nested
 * adaptive rules on noise refine to `quadMaxSplits` at both levels.
 */
import { makeScratch } from './array';
import type { ScratchImpl } from './array';
import { breakpoints, sanitizeParam, spanOf } from './basis';
import { curveEvalInto } from './curve';
import { fail } from './errors';
import { bezierPieces, crossings, ctrl } from './pieces';
import { checkAbsTol, GL_MAX_ORDER, gaussLegendre, integrate1d } from './quadrature';
import { checkSurfaceShape, evalSurfaceSpan } from './surface';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import { loopsOf } from './trim';
import type {
  ClampedCurve,
  NurbsSurface,
  QuadratureResult,
  ReadonlyF64,
  TrimmedSurface,
} from './types';

/** An integrand on the surface: `(u, v)` and the SKL derivatives there (layout §4.6). */
export type SurfaceIntegrand = (u: number, v: number, skl: ReadonlyF64) => number;

/** A face of a closed set for {@link enclosedVolume}: `sameSense` false flips its normal. */
export interface VolumeFace {
  readonly face: TrimmedSurface | NurbsSurface;
  readonly sameSense?: boolean;
}

const isTrimmed = (x: TrimmedSurface | NurbsSurface): x is TrimmedSurface =>
  (x as TrimmedSurface).surface !== undefined;

/** Accumulated statistics of one integral. */
interface Acc {
  evaluations: number;
  converged: boolean;
  innerErrMax: number;
}

/** Evaluates SKL to `nDer` at `(u, v)` (right-hand spans) into scratch; returns the 18-value view. */
function evaluator(s: NurbsSurface, nDer: number): (u: number, v: number) => ReadonlyF64 {
  const sc: ScratchImpl = makeScratch(Math.max(s.u.degree, s.v.degree), nDer);
  const view = sc.f.subarray(sc.oS, sc.oS + 18);
  return (u, v) => {
    const uu = sanitizeParam(s.u, u);
    const vv = sanitizeParam(s.v, v);
    evalSurfaceSpan(s, uu, vv, spanOf(s.u, uu, false), spanOf(s.v, vv, false), nDer, sc);
    return view;
  };
}

/** Distinct breakpoints of a direction over its domain (one period for a periodic basis, ends included). */
function spanBreaks(b: NurbsSurface['u']): number[] {
  const br = Array.from(breakpoints(b));
  if (b.kind === 'periodic') {
    const t0 = b.domain[0];
    const inPeriod = br.filter((x) => x >= t0 && x < t0 + b.period);
    if (inPeriod[0] !== t0) inPeriod.unshift(t0);
    inPeriod.push(t0 + b.period);
    return inPeriod;
  }
  return br;
}

function glOrder(degree: number): number {
  return Math.max(1, Math.ceil((degree + 1) / 2));
}

function checkDegrees(d: readonly [number, number] | undefined): void {
  if (d === undefined) return;
  for (const x of d) {
    if (!Number.isInteger(x) || x < 0) {
      fail('unsupported', `polynomialDegree entries must be integers ≥ 0; got ${String(x)}`, {
        value: x,
      });
    }
  }
  if (glOrder(d[0]) > GL_MAX_ORDER || glOrder(d[1]) > GL_MAX_ORDER) {
    fail(
      'unsupported',
      `polynomialDegree [${d[0]}, ${d[1]}] needs more than ${GL_MAX_ORDER} Gauss points`,
    );
  }
}

/** Tensor-product integral over the whole (natural) domain. */
function integrateTensor(
  s: NurbsSurface,
  f: SurfaceIntegrand,
  nDer: number,
  deg: readonly [number, number] | undefined,
  t: Tolerances,
  absTol: number,
): QuadratureResult {
  const ev = evaluator(s, nDer);
  const ub = spanBreaks(s.u);
  const vb = spanBreaks(s.v);
  if (deg !== undefined) {
    const ru = gaussLegendre(glOrder(deg[0]));
    const rv = gaussLegendre(glOrder(deg[1]));
    let sum = 0;
    let abs = 0;
    let n = 0;
    for (let i = 0; i + 1 < ub.length; i++) {
      const um = 0.5 * (ub[i]! + ub[i + 1]!);
      const uh = 0.5 * (ub[i + 1]! - ub[i]!);
      for (let j = 0; j + 1 < vb.length; j++) {
        const vm = 0.5 * (vb[j]! + vb[j + 1]!);
        const vh = 0.5 * (vb[j + 1]! - vb[j]!);
        for (let a = 0; a < ru.nodes.length; a++) {
          const u = um + uh * ru.nodes[a]!;
          for (let b = 0; b < rv.nodes.length; b++) {
            const v = vm + vh * rv.nodes[b]!;
            const y = finite(f(u, v, ev(u, v)), u, v);
            const term = uh * vh * ru.weights[a]! * rv.weights[b]! * y;
            sum += term;
            abs += Math.abs(term);
            n++;
          }
        }
      }
    }
    return Object.freeze({
      value: sum,
      errorEstimate: n * Number.EPSILON * abs,
      evaluations: n,
      converged: true,
    });
  }
  const acc: Acc = { evaluations: 0, converged: true, innerErrMax: 0 };
  const vLength = vb[vb.length - 1]! - vb[0]!;
  const inner = (v: number): number => {
    const r = integrate1d((u) => finite(f(u, v, ev(u, v)), u, v), ub[0]!, ub[ub.length - 1]!, {
      breaks: ub,
      tol: t,
      absTol: (0.5 * absTol) / vLength,
    });
    acc.evaluations += r.evaluations;
    acc.converged &&= r.converged;
    if (r.errorEstimate > acc.innerErrMax) acc.innerErrMax = r.errorEstimate;
    return r.value;
  };
  const outer = integrate1d(inner, vb[0]!, vb[vb.length - 1]!, {
    breaks: vb,
    tol: t,
    absTol: 0.5 * absTol,
  });
  return Object.freeze({
    value: outer.value,
    errorEstimate: outer.errorEstimate + acc.innerErrMax * (vb[vb.length - 1]! - vb[0]!),
    evaluations: acc.evaluations,
    converged: acc.converged && outer.converged,
  });
}

function finite(y: number, u: number, v: number): number {
  if (!Number.isFinite(y))
    fail('non-finite', `integrand is not finite at (${u}, ${v}): ${y}`, { uv: { u, v }, value: y });
  return y;
}

/** Parameters where a trim curve's u or v crosses a surface knot line, plus its own knots. */
function curveBreaks(
  c: ClampedCurve<2>,
  ub: readonly number[],
  vb: readonly number[],
  t: Tolerances,
): {
  breaks: number[];
  variationV: number;
} {
  const [a, b] = c.basis.domain;
  const minWidth = t.paramRel * (b - a);
  const out: number[] = Array.from(breakpoints(c.basis));
  let variationV = 0;
  for (const pc of bezierPieces(c)) {
    for (const x of ub) crossings(pc, 0, x, minWidth, out);
    for (const y of vb) crossings(pc, 1, y, minWidth, out);
    for (let j = 1; j <= pc.p; j++) variationV += Math.abs(ctrl(pc, j, 1) - ctrl(pc, j - 1, 1));
  }
  const sorted = out.filter((x) => x >= a && x <= b).sort((x, y) => x - y);
  const breaks = sorted.filter((x, i) => i === 0 || x > sorted[i - 1]!);
  return { breaks, variationV };
}

/**
 * The exact inner integrals of Green's theorem, cached as polynomials in v
 * (performance; docs/design/board2.md S7 as built).
 *
 * The strips of `F(u, v) = ∫_{uRef}^{u} f(s, v) ds` are cut at the surface's
 * u-breaks: `c_0 = uRef < c_1 < … < c_M`. On a v-span of the surface, the
 * integral of `f` over one whole strip `[c_k, c_{k+1}]` is a polynomial in v of
 * degree at most `dv` (the integrand's promised v-degree per span pair, and
 * the inner rule is exact in u), so it is stored by its values at the `dv + 1`
 * Chebyshev–Lobatto points of the v-span, prefix-summed over k, and evaluated
 * by barycentric interpolation (exact for polynomials of degree `dv`, to
 * rounding: the Lebesgue constant of these points is below 3 for `dv ≤ 16`).
 * A v-span's prefix grows lazily to the largest u asked for. Each outer point
 * then costs one interpolation and the inner rule on its own last strip
 * instead of the rule on every strip from `uRef`: the strips of one v-span are
 * integrated once, at `dv + 1` values of v, however many outer points fall in
 * it (at least one Bézier piece of the trim curve, `⌈q(d_u + d_v + 2)/2⌉`
 * points, does). Only `u > uRef` asks: `uRef` is the loops' smallest
 * control-point u, so every loop point has `u ≥ uRef`.
 */
function stripCache(
  ub: readonly number[],
  vb: readonly number[],
  uRef: number,
  dv: number,
): {
  at(
    u: number,
    v: number,
    piece: (a: number, b: number, v: number) => { sum: number; abs: number },
  ): { sum: number; abs: number; from: number; cells: number };
} {
  const cuts = [uRef, ...ub.filter((x) => x > uRef)];
  const n = dv + 1;
  // Chebyshev–Lobatto points on [−1, 1] and their barycentric weights.
  const nodes = new Float64Array(n);
  const bw = new Float64Array(n);
  for (let l = 0; l < n; l++) {
    nodes[l] = n === 1 ? 0 : -Math.cos((Math.PI * l) / dv);
    bw[l] = (l % 2 === 0 ? 1 : -1) * (n > 1 && (l === 0 || l === dv) ? 0.5 : 1);
  }
  /** Per v-span: prefix values (and of |terms|) per cut, `n` per cut, from cut 0. */
  const cache = new Map<number, { val: number[]; abs: number[] }>();
  const spanOfV = (v: number): number => {
    let lo = 0;
    let hi = vb.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (vb[mid]! <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    at(u, v, piece) {
      // The last cut below u: strips [c_0, c_1], …, [c_{k−1}, c_k] are whole.
      let lo = 0;
      let hi = cuts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cuts[mid]! < u) lo = mid;
        else hi = mid - 1;
      }
      const k = lo;
      const j = spanOfV(v);
      const a = vb[j]!;
      const b = vb[j + 1]!;
      const m = 0.5 * (a + b);
      const h = 0.5 * (b - a);
      let c = cache.get(j);
      if (c === undefined) {
        c = { val: new Array<number>(n).fill(0), abs: new Array<number>(n).fill(0) };
        cache.set(j, c);
      }
      while (c.val.length < (k + 1) * n) {
        const s = c.val.length / n - 1;
        for (let l = 0; l < n; l++) {
          const r = piece(cuts[s]!, cuts[s + 1]!, m + h * nodes[l]!);
          c.val.push(c.val[s * n + l]! + r.sum);
          c.abs.push(c.abs[s * n + l]! + r.abs);
        }
      }
      if (k === 0) return { sum: 0, abs: 0, from: cuts[0]!, cells: 0 };
      // Barycentric interpolation at x = (v − m)/h.
      const x = h > 0 ? (v - m) / h : 0;
      let num = 0;
      let numAbs = 0;
      let den = 0;
      for (let l = 0; l < n; l++) {
        const d = x - nodes[l]!;
        if (d === 0)
          return { sum: c.val[k * n + l]!, abs: c.abs[k * n + l]!, from: cuts[k]!, cells: k };
        const w = bw[l]! / d;
        num += w * c.val[k * n + l]!;
        numAbs += Math.abs(w) * c.abs[k * n + l]!;
        den += w;
      }
      return { sum: num / den, abs: numAbs / Math.abs(den), from: cuts[k]!, cells: k };
    },
  };
}

/** Green's-theorem integral over the loops of a trimmed surface. */
function integrateGreen(
  ts: TrimmedSurface,
  f: SurfaceIntegrand,
  nDer: number,
  deg: readonly [number, number] | undefined,
  t: Tolerances,
  absTol: number,
): QuadratureResult {
  const s = ts.surface;
  const ev = evaluator(s, nDer);
  const ub = spanBreaks(s.u);
  const vb = spanBreaks(s.v);
  const loops = loopsOf(ts);
  // Each trim curve's pieces and v-variation up front: the inner integrals' share of `absTol`
  // is divided by the total variation they are multiplied with in the error estimate.
  const curves = loops.flatMap((l) => l.curves);
  const pieces = curves.map((c) => curveBreaks(c, ub, vb, t));
  const variationV = pieces.reduce((sum, x) => sum + x.variationV, 0);
  const innerAbs = variationV > 0 ? (0.5 * absTol) / variationV : 0.5 * absTol;
  const outerAbs = (0.5 * absTol) / Math.max(1, curves.length);
  let uRef = Infinity;
  for (const l of loops) {
    for (const c of l.curves) {
      for (let i = 0; i < c.basis.count; i++) {
        const x = c.cw[3 * i]! / c.cw[3 * i + 2]!;
        if (x < uRef) uRef = x;
      }
    }
  }
  uRef = sanitizeParam(s.u, uRef);
  const ruInner = deg !== undefined ? gaussLegendre(glOrder(deg[0])) : null;
  const acc: Acc = { evaluations: 0, converged: true, innerErrMax: 0 };
  let exactAbs = 0;
  let exactTerms = 0;
  const strips = ruInner !== null && deg !== undefined ? stripCache(ub, vb, uRef, deg[1]) : null;
  // The strip cache's integrand evaluations, and the terms the error estimate
  // counts for its interpolated values (as many as the direct sum would add).
  let stripEvals = 0;
  let stripTerms = 0;
  /** The exact integral of `f(·, v)` over `[a, b]` (inside one u-span) by the inner rule. */
  const exactPiece = (a: number, b: number, v: number): { sum: number; abs: number } => {
    stripEvals += ruInner!.nodes.length;
    const m = 0.5 * (a + b);
    const h = 0.5 * (b - a);
    let sum = 0;
    let abs = 0;
    for (let i = 0; i < ruInner!.nodes.length; i++) {
      const uu = m + h * ruInner!.nodes[i]!;
      const term = h * ruInner!.weights[i]! * finite(f(uu, v, ev(uu, v)), uu, v);
      sum += term;
      abs += Math.abs(term);
    }
    return { sum, abs };
  };
  /** F(u, v) = ∫_{uRef}^{u} f(s, v) ds. */
  const F = (u: number, v: number): number => {
    if (u === uRef) return 0;
    const lo = Math.min(u, uRef);
    const hi = Math.max(u, uRef);
    const sign = u > uRef ? 1 : -1;
    if (strips !== null && u > uRef) {
      // Whole strips between cuts from the polynomial cache, the last one directly.
      const r = strips.at(u, sanitizeParam(s.v, v), exactPiece);
      exactAbs += r.abs;
      const terms = r.cells * ruInner!.nodes.length + ruInner!.nodes.length;
      exactTerms += terms;
      stripTerms += terms;
      const last = exactPiece(r.from, u, v);
      exactAbs += last.abs;
      return r.sum + last.sum;
    }
    if (ruInner !== null) {
      let sum = 0;
      let x0 = lo;
      for (let k = 0; k <= ub.length; k++) {
        const x1 = k < ub.length ? Math.min(ub[k]!, hi) : hi;
        if (x1 > x0) {
          const m = 0.5 * (x0 + x1);
          const h = 0.5 * (x1 - x0);
          for (let i = 0; i < ruInner.nodes.length; i++) {
            const uu = m + h * ruInner.nodes[i]!;
            const term = h * ruInner.weights[i]! * finite(f(uu, v, ev(uu, v)), uu, v);
            sum += term;
            exactAbs += Math.abs(term);
            exactTerms++;
          }
          x0 = x1;
        }
        if (x0 >= hi) break;
      }
      return sign * sum;
    }
    const r = integrate1d((uu) => finite(f(uu, v, ev(uu, v)), uu, v), lo, hi, {
      breaks: ub,
      tol: t,
      absTol: innerAbs,
    });
    acc.evaluations += r.evaluations;
    acc.converged &&= r.converged;
    if (r.errorEstimate > acc.innerErrMax) acc.innerErrMax = r.errorEstimate;
    return sign * r.value;
  };
  let value = 0;
  let outerErr = 0;
  curves.forEach((c, ci) => {
    const sc = makeScratch(c.basis.degree, 1);
    const cv = new Float64Array(4);
    const g = (x: number): number => {
      curveEvalInto(c, x, 1, cv, 0, sc);
      return F(cv[0]!, cv[1]!) * cv[3]!;
    };
    const { breaks } = pieces[ci]!;
    const q = c.basis.degree;
    const nT = deg !== undefined && !c.rational ? Math.ceil((q * (deg[0] + deg[1] + 2)) / 2) : 0;
    if (nT >= 1 && nT <= GL_MAX_ORDER) {
      const rt = gaussLegendre(nT);
      for (let k = 0; k + 1 < breaks.length; k++) {
        const m = 0.5 * (breaks[k]! + breaks[k + 1]!);
        const h = 0.5 * (breaks[k + 1]! - breaks[k]!);
        for (let i = 0; i < nT; i++) {
          const term = h * rt.weights[i]! * g(m + h * rt.nodes[i]!);
          value += term;
          exactAbs += Math.abs(term);
          exactTerms++;
        }
      }
    } else {
      const r = integrate1d(g, breaks[0]!, breaks[breaks.length - 1]!, {
        breaks,
        tol: t,
        absTol: outerAbs,
      });
      value += r.value;
      outerErr += r.errorEstimate;
      acc.converged &&= r.converged;
      acc.evaluations += r.evaluations;
    }
  });
  return Object.freeze({
    value,
    errorEstimate: outerErr + acc.innerErrMax * variationV + exactTerms * Number.EPSILON * exactAbs,
    evaluations: acc.evaluations + exactTerms - stripTerms + stripEvals,
    converged: acc.converged,
  });
}

function checkNDerOpt(nDer: unknown): 0 | 1 | 2 {
  if (nDer === undefined) return 1;
  if (nDer === 0 || nDer === 1 || nDer === 2) return nDer;
  return fail('unsupported', `nDer must be 0, 1 or 2; got ${String(nDer)}`, { value: nDer });
}

/**
 * `∫∫_D f(u, v) du dv` over the trimmed domain (module comment). `f` receives
 * the SKL derivatives to `nDer` (default 1: `[S, Su, Sv]`) in a scratch view
 * that it must not retain. `polynomialDegree` promises a polynomial integrand
 * of that bidegree per span pair (then exact rules are used). `absTol`
 * (default 0) is an absolute error target for the adaptive rules, met as well
 * as or instead of `quadRel` (module comment); exact rules ignore it.
 */
export function integrateTrimmed(
  ts: TrimmedSurface,
  f: SurfaceIntegrand,
  opts?: {
    readonly polynomialDegree?: readonly [number, number];
    readonly nDer?: 0 | 1 | 2;
    readonly tol?: Partial<Tolerances>;
    readonly absTol?: number;
  },
): QuadratureResult {
  checkSurfaceShape(ts.surface);
  if (typeof f !== 'function') fail('unsupported', 'integrand must be a function');
  const t = resolveTolerances(opts?.tol);
  const deg = opts?.polynomialDegree;
  checkDegrees(deg);
  const nDer = checkNDerOpt(opts?.nDer);
  const absTol = checkAbsTol(opts?.absTol);
  if (ts.outer === null && ts.holes.length === 0)
    return integrateTensor(ts.surface, f, nDer, deg, t, absTol);
  return integrateGreen(ts, f, nDer, deg, t, absTol);
}

const natural = (s: NurbsSurface): TrimmedSurface =>
  Object.freeze({ surface: s, outer: null, holes: Object.freeze([]) }) as unknown as TrimmedSurface;

/** `|S_u × S_v|`: the area element. */
const areaElement: SurfaceIntegrand = (_u, _v, d) => {
  const cx = d[4]! * d[8]! - d[5]! * d[7]!;
  const cy = d[5]! * d[6]! - d[3]! * d[8]!;
  const cz = d[3]! * d[7]! - d[4]! * d[6]!;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
};

/** Area of a trimmed surface (or of a whole surface) by adaptive integration of `|S_u × S_v|` to `quadRel`. */
export function surfaceArea(
  x: TrimmedSurface | NurbsSurface,
  tol?: Partial<Tolerances>,
): QuadratureResult {
  const ts = isTrimmed(x) ? x : natural(x);
  return integrateTrimmed(ts, areaElement, { tol });
}

/**
 * Whether `integrateTrimmed(ts, f, { polynomialDegree: deg })` uses exact rules
 * only (no adaptive level, so no `quadRel` or `absTol` applies): a polynomial
 * surface over its natural boundary, or trimmed by polynomial curves whose
 * outer rule fits in `GL_MAX_ORDER` (the conditions of `integrateGreen`).
 */
function exactOnly(ts: TrimmedSurface, deg: readonly [number, number] | undefined): boolean {
  if (deg === undefined) return false;
  if (ts.outer === null && ts.holes.length === 0) return true;
  return loopsOf(ts).every((l) =>
    l.curves.every(
      (c) => !c.rational && Math.ceil((c.basis.degree * (deg[0] + deg[1] + 2)) / 2) <= GL_MAX_ORDER,
    ),
  );
}

/**
 * Volume enclosed by a closed set of faces by the divergence theorem,
 * `V = ⅓ Σ σ_f ∫∫ (S − c)·(S_u × S_v) du dv` with `σ_f = −1` where
 * `sameSense` is false (the face's outward normal is `−n`) and `c` the centre
 * of the faces' control-point bounding box (subtracted to limit cancellation;
 * any `c` is exact for a closed set). Polynomial faces use the exact rules of
 * bidegree `(3p − 1, 3q − 1)`; rational ones adaptive integration, to
 * `quadRel` relative to each face's integral or, for a face whose integral is
 * small against the solid (down to rounding noise: a face through `c`), to
 * `quadRel · |V|` shared equally among the faces (the `absTol` of
 * {@link integrateTrimmed}): the total error target is
 * `quadRel · (Σ_f ∫∫|f_f| / 3 + |V|)`, at most twice the relative one for a
 * solid star-shaped about `c`, and invariant under rigid motions. `|V|` comes
 * from a scale pass over the adaptive faces at `√quadRel` (with the bounding
 * box's volume as its own absolute scale, so noise faces converge there too),
 * whose evaluations are counted; if that pass cannot resolve `|V|` from zero
 * (a degenerate or open set), the box's volume stays the scale.
 * Closure is the caller's (B-rep checks it, step B4): for an open set the result
 * depends on `c`.
 */
export function enclosedVolume(
  faces: readonly VolumeFace[],
  tol?: Partial<Tolerances>,
): QuadratureResult {
  if (!Array.isArray(faces) || faces.length === 0)
    fail('size-mismatch', 'enclosedVolume needs at least one face');
  const t = resolveTolerances(tol);
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  const tss = faces.map((fc) => {
    const ts = isTrimmed(fc.face) ? fc.face : natural(fc.face);
    const s = ts.surface;
    checkSurfaceShape(s);
    for (let i = 0; i < s.cw.length; i += 4) {
      const w = s.cw[i + 3]!;
      const X = s.cw[i]! / w;
      const Y = s.cw[i + 1]! / w;
      const Z = s.cw[i + 2]! / w;
      if (X < x0) x0 = X;
      if (X > x1) x1 = X;
      if (Y < y0) y0 = Y;
      if (Y > y1) y1 = Y;
      if (Z < z0) z0 = Z;
      if (Z > z1) z1 = Z;
    }
    return ts;
  });
  const cx = 0.5 * (x0 + x1);
  const cy = 0.5 * (y0 + y1);
  const cz = 0.5 * (z0 + z1);
  const integrand: SurfaceIntegrand = (_u, _v, d) => {
    const nx = d[4]! * d[8]! - d[5]! * d[7]!;
    const ny = d[5]! * d[6]! - d[3]! * d[8]!;
    const nz = d[3]! * d[7]! - d[4]! * d[6]!;
    return (d[0]! - cx) * nx + (d[1]! - cy) * ny + (d[2]! - cz) * nz;
  };
  const sigmaOf = (i: number): number => (faces[i]!.sameSense === false ? -1 : 1);
  const degOf = (s: NurbsSurface): readonly [number, number] | undefined =>
    s.rational ? undefined : [3 * s.u.degree - 1, 3 * s.v.degree - 1];
  const results: QuadratureResult[] = new Array<QuadratureResult>(faces.length);
  // Faces integrated by exact rules alone: once (no adaptive target applies to them).
  const adaptive: number[] = [];
  let exactSum = 0;
  tss.forEach((ts, i) => {
    const deg = degOf(ts.surface);
    if (!exactOnly(ts, deg)) {
      adaptive.push(i);
      return;
    }
    results[i] = integrateTrimmed(ts, integrand, { polynomialDegree: deg, tol: t });
    exactSum += sigmaOf(i) * results[i].value;
  });
  let evaluations = 0;
  if (adaptive.length > 0) {
    // Each face integral is 3 × its volume share, so absolute targets of 3 · rel · scale / faces
    // sum to rel × scale in the volume.
    const share = (rel: number, scale: number): number => (3 * rel * scale) / faces.length;
    const box = (x1 - x0) * (y1 - y0) * (z1 - z0);
    const scaleRel = Math.sqrt(t.quadRel);
    let estimate = exactSum;
    let estimateErr = 0;
    for (const i of adaptive) {
      const r = integrateTrimmed(tss[i]!, integrand, {
        polynomialDegree: degOf(tss[i]!.surface),
        tol: { ...t, quadRel: scaleRel },
        absTol: share(scaleRel, box),
      });
      estimate += sigmaOf(i) * r.value;
      estimateErr += r.errorEstimate;
      evaluations += r.evaluations;
    }
    const scale = Math.abs(estimate) > estimateErr ? Math.abs(estimate) / 3 : box;
    for (const i of adaptive) {
      results[i] = integrateTrimmed(tss[i]!, integrand, {
        polynomialDegree: degOf(tss[i]!.surface),
        tol: t,
        absTol: share(t.quadRel, scale),
      });
    }
  }
  // Summed in face order.
  let value = 0;
  let errorEstimate = 0;
  let converged = true;
  results.forEach((r, i) => {
    value += sigmaOf(i) * r.value;
    errorEstimate += r.errorEstimate;
    evaluations += r.evaluations;
    converged &&= r.converged;
  });
  return Object.freeze({
    value: value / 3,
    errorEstimate: errorEstimate / 3,
    evaluations,
    converged,
  });
}
