// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fitting the two curves an edge needs (design §6.15, integration milestone):
 *
 * - {@link projectCurveToSurface}: the **same-parameter pcurve** of a 3D curve
 *   lying on a surface, `C(t) ≈ S(P(t))` with `P` a 2D curve in the surface's
 *   `(u, v)` domain.
 * - {@link curveOnSurfaceTo3d}: the **3D edge curve** of a pcurve, the image
 *   `t ↦ S(P(t))` fitted by a polynomial B-spline of the same parameter.
 *
 * Both are Track B's projection ({@link projectCurveSamplesToSurface}, P&T
 * §6.1) feeding Track A's least squares (`approximateCurve`, P&T §9.4.1 and
 * A9.6), with a measured honesty check around them:
 *
 * 1. **Knots**: the source's own breakpoints, each at the multiplicity that
 *    lets the fit be as non-smooth there as the source is (`min(p, p − q + m)`
 *    for a fit of degree `p`, source degree `q`, multiplicity `m`): a rational
 *    circle is only C⁰ in its parameter at the quarter points, and a fit with
 *    knots elsewhere converges only quadratically across such a kink. The
 *    same for each place the pcurve crosses a knot line of the surface, where
 *    `S(P(t))` is only as smooth as `S` is across it (but only where that is
 *    less smooth than the fit's own simple knot: `multiplicityFor ≥ 2`).
 * 2. **Sample** `samplesPerSpan` parameters per span of those knots (ends
 *    included) and **fit** on `[0, 1]` (the pcurve fit's data are the
 *    projections of the curve's points, P&T §6.1). The fit is moved back onto
 *    the source's parameter domain (`reparameterize`, exact).
 * 3. **Measure** the 3D deviation on `verifyFactor ×` denser samples than the
 *    fit used. That number, not the fit's own error at its data, is what is
 *    reported as `maxDeviation` / `maxError`: a fit can interpolate its data
 *    and still oscillate between it.
 * 4. **Refine**: if the deviation is above `Tolerances.fit`, bisect every fit
 *    span whose measured deviation exceeds `safety × fit` and fit again, at
 *    most `maxPasses` times; every span gets `samplesPerSpan` samples, so a
 *    bisected span keeps its density. The best pass is kept. A pass that improves the
 *    deviation by under 10% ends the loop: the source is off the surface (or
 *    kinked where no knot says so, e.g. where a pcurve crosses a knot line of
 *    a surface that is only C⁰ there), not under-resolved.
 *
 * Pcurve control points are clamped into the surface's domain in its clamped
 * directions (convex hull property: the curve then stays inside), and the
 * deviation is measured after that.
 *
 * What a caller may rely on: `withinTolerance` is `maxDeviation ≤ tol.fit`
 * measured at those denser samples, not a bound between them; a smooth
 * source and `verifyFactor ≥ 4` make the gap between the two negligible
 * (honesty tests in `edge-fit.test.ts`), but a bound would need Lipschitz
 * constants of both curves.
 */
import { createScratch } from './array';
import type { Scratch } from './array';
import { breakpoints, knotMultiplicities } from './basis';
import { controlPointsInto, curveEvalInto, makeCurve } from './curve';
import { reparameterize } from './curve-ops';
import { curveOnSurfaceEvalInto, curveSampleProjector } from './curve-on-surface';
import { approximateCurve } from './fit/approximate';
import { errResult, fail, okResult } from './errors';
import type { ProjectionSeeding } from './project';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Basis,
  ClampedCurve,
  CurveOnSurface,
  GeomIssue,
  NurbsCurve,
  NurbsSurface,
  Result,
} from './types';

/**
 * The sampling and refinement parameters of the edge fits, one record for both
 * (project principle 3: nothing fixed in code).
 */
export interface EdgeFitSampling {
  /**
   * Degree of the fitted curve. Default 3: C² joins between spans, the degree
   * of the board's rails and the one the existing exporters write.
   */
  readonly degree: number;
  /**
   * Fit samples per span of the fit (a span between distinct knots: the
   * source's own, the kinks, the bisections). Default 8: twice the 4
   * coefficients per coordinate a cubic span has, so every span stays
   * overdetermined as it is bisected; a 60-span curve is 480 projections.
   */
  readonly samplesPerSpan: number;
  /**
   * Deviation samples as a multiple of the fit samples (design §6.15: 4×).
   * Integer ≥ 1; 1 would only re-measure the fit's own data.
   */
  readonly verifyFactor: number;
  /**
   * Refinement passes after the first fit. Default 8: each bisects the failing
   * spans, so the last works with spans up to 256× narrower than the first's.
   * Measured on a board-size bicubic deck's elliptic trim (the integration
   * milestone's V5): the default `fit` needs 4 passes, a tenth of it 5, and a
   * hundredth or a thousandth of it 6, so a default of 5 stopped short
   * (reporting `withinTolerance: false`, honestly) at a target a caller may
   * reasonably ask for; 8 leaves headroom, and the loop stops at the first
   * pass within the target.
   */
  readonly maxPasses: number;
  /**
   * A span is bisected when its measured deviation exceeds this fraction of
   * the target (default 0.5): the deviation between samples is not controlled
   * by the fit, so bisecting only the spans over the target itself would
   * leave the next pass half a ulp from it, and miss again half the time.
   */
  readonly safety: number;
  /**
   * How precisely a crossing of a surface knot line is located, as the fraction
   * of `fit` that a knot misplaced by the remaining uncertainty may cost: the
   * bisection stops at a parameter width of `kinkFraction · fit / speed`, `speed`
   * the largest chord speed `|ΔC| / Δt` of the source. Default 0.1. A C⁰ kink
   * (a deviation of speed × width) is the worst case; smoother ones cost
   * less. The projection of each step starts from its neighbour, so a tighter
   * value costs one Newton run per bit.
   */
  readonly kinkFraction: number;
}

/** The defaults of {@link EdgeFitSampling}, frozen. */
export const DEFAULT_EDGE_FIT: EdgeFitSampling = Object.freeze({
  degree: 3,
  samplesPerSpan: 8,
  verifyFactor: 4,
  maxPasses: 8,
  safety: 0.5,
  kinkFraction: 0.1,
});

function resolveSampling(o: Partial<EdgeFitSampling> | undefined): EdgeFitSampling {
  const s = { ...DEFAULT_EDGE_FIT, ...o };
  const whole = (x: number, name: string, min: number): void => {
    if (!Number.isInteger(x) || x < min) {
      fail('unsupported', `edge-fit ${name} must be an integer ≥ ${min}; got ${x}`, { value: x });
    }
  };
  whole(s.degree, 'degree', 1);
  whole(s.samplesPerSpan, 'samplesPerSpan', 2);
  whole(s.verifyFactor, 'verifyFactor', 1);
  whole(s.maxPasses, 'maxPasses', 0);
  if (!(s.safety > 0 && s.safety <= 1)) {
    fail('unsupported', `edge-fit safety must be in (0, 1]; got ${s.safety}`, { value: s.safety });
  }
  if (!(s.kinkFraction > 0 && s.kinkFraction <= 1)) {
    fail('unsupported', `edge-fit kinkFraction must be in (0, 1]; got ${s.kinkFraction}`, {
      value: s.kinkFraction,
    });
  }
  return Object.freeze(s);
}

/** `per` parameters in each knot span of `b` (domain ends included), non-decreasing. */
function spanSamples(b: Basis, per: number): Float64Array {
  const br = breakpoints(b);
  const edges = b.kind === 'periodic' ? [...br, b.domain[1]] : Array.from(br);
  const out = new Float64Array((edges.length - 1) * per + 1);
  let k = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]!;
    const e = edges[i + 1]!;
    for (let j = 0; j < per; j++) out[k++] = a + ((e - a) * j) / per;
  }
  out[k] = edges[edges.length - 1]!;
  return out;
}

/**
 * `per` samples in each span between distinct knots of `knots` (a clamped
 * vector on `[0, 1]`), the end included: `[0, 1]` coordinates, ends exactly 0
 * and 1 (what `approximateCurve` requires of explicit parameters).
 */
function knotSamples(knots: Float64Array, per: number): Float64Array {
  const br = knots.filter((x, i) => i === 0 || x !== knots[i - 1]);
  const out = new Float64Array((br.length - 1) * per + 1);
  let k = 0;
  for (let i = 0; i + 1 < br.length; i++) {
    for (let j = 0; j < per; j++) out[k++] = br[i]! + ((br[i + 1]! - br[i]!) * j) / per;
  }
  out[k] = 1;
  return out;
}

/** A knot of the fit on `[0, 1]` and how many times to repeat it. */
interface KnotReq {
  readonly at: number;
  readonly mult: number;
}

/** The multiplicity a degree-`p` fit needs to be as non-smooth as a degree-`q` basis with multiplicity `m`. */
const multiplicityFor = (p: number, q: number, m: number): number =>
  Math.max(1, Math.min(p, p - q + m));

/**
 * The interior knots a degree-`p` fit needs to be as non-smooth as `b` is: each
 * interior breakpoint of `b` (on `[0, 1]`) repeated {@link multiplicityFor} times.
 */
function sourceKnots(b: Basis, p: number): KnotReq[] {
  const [a, e] = b.domain;
  const { values, mults } = knotMultiplicities(b);
  const out: KnotReq[] = [];
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!;
    if (x > a && x < e) {
      out.push({ at: (x - a) / (e - a), mult: multiplicityFor(p, b.degree, mults[i]!) });
    }
  }
  return out;
}

/**
 * The pcurve of a source, as `(u, v)` at non-decreasing parameters (stride 2);
 * `null` when it cannot be had (a projection that did not converge: the data
 * pass reports that). Periodic directions are unwrapped continuously along one
 * call's parameters, or, with a `seed`, relative to it (and the projection
 * starts from it: a bisection step is a few Newton iterations, not a global
 * search).
 */
type UvAt = (ts: Float64Array, seed?: readonly [number, number]) => Float64Array | null;

/**
 * Where the pcurve `uvAt` (on `[a, b]`) crosses a knot line of `s`, as knots on
 * `[0, 1]`. The composition `S(P(t))` is only as smooth there as `S` is across
 * its knot line (C^(q − m) for degree `q` and multiplicity `m`), however
 * smooth `P` and the 3D curve are, so the fit must be allowed the same kink.
 * Only lines that make the fit less smooth than a simple knot does get one
 * (module comment). Crossings are found as sign changes of `x(t) − knot` between the samples
 * `ts` and located by bisection on the *source's own* pcurve (not on a fit of
 * it, which would put the kink where the fit crosses the line and need a pass
 * per digit) to `paramRel` of the domain; a pcurve that runs along a knot line
 * crosses none.
 */
function crossingKnots(
  uvAt: UvAt,
  domain: readonly [number, number],
  s: NurbsSurface,
  p: number,
  ts: Float64Array,
  tol: Tolerances,
  width: number,
): KnotReq[] {
  const [a, b] = domain;
  const out: KnotReq[] = [];
  const stop = Math.max(tol.paramRel * (b - a), width);
  // Only a line the fit cannot cross smoothly needs a knot: a degree-`p` fit is C^(p−1) at a
  // simple knot, so a crossing of smoothness C^(p−1) or better (a cubic surface's simple knot
  // line, for a cubic fit) leaves nothing but a jump in the p-th derivative, which refinement
  // resolves like any local feature. If no line is of the kind that does, nothing is projected.
  const needsKnot = (bs: Basis, m: number): boolean => multiplicityFor(p, bs.degree, m) >= 2;
  if (![s.u, s.v].some((bs) => knotMultiplicities(bs).mults.some((m) => needsKnot(bs, m)))) {
    return out;
  }
  const uv = uvAt(ts);
  if (uv === null) return out;
  for (const [k, bs] of [
    [0, s.u],
    [1, s.v],
  ] as const) {
    const { values, mults } = knotMultiplicities(bs);
    const [d0, d1] = bs.domain;
    const x = Float64Array.from(ts, (_, i) => uv[2 * i + k]!);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of x) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    // Candidate lines: the interior knots of a clamped basis; every knot, in every period
    // reached, of a periodic one.
    const lines: { v: number; m: number }[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (!needsKnot(bs, mults[i]!)) continue;
      if (bs.kind === 'clamped') {
        if (v > d0 && v < d1) lines.push({ v, m: mults[i]! });
      } else {
        const T = bs.period;
        for (let j = Math.floor((lo - v) / T); v + j * T <= hi; j++) {
          if (v + j * T >= lo) lines.push({ v: v + j * T, m: mults[i]! });
        }
      }
    }
    for (const { v: line, m } of lines) {
      for (let i = 0; i + 1 < ts.length; i++) {
        const f0 = x[i]! - line;
        const f1 = x[i + 1]! - line;
        // Half-open, so a root exactly on a sample is counted once, by the pair that starts there.
        if (!((f0 <= 0 && f1 > 0) || (f0 >= 0 && f1 < 0))) continue;
        let l = ts[i]!;
        let r = ts[i + 1]!;
        if (f0 === 0) r = l;
        const negative = f0 < 0;
        // The pcurve at l, to start each step from (it is the end of the bracket that moves).
        let seed: readonly [number, number] = [uv[2 * i]!, uv[2 * i + 1]!];
        while (r - l > stop) {
          const mid = 0.5 * (l + r);
          if (mid <= l || mid >= r) break;
          const at = uvAt(Float64Array.of(mid), seed);
          if (at === null) break;
          if (at[k]! - line < 0 === negative) {
            l = mid;
            seed = [at[0]!, at[1]!];
          } else r = mid;
        }
        out.push({ at: (0.5 * (l + r) - a) / (b - a), mult: multiplicityFor(p, bs.degree, m) });
      }
    }
  }
  return out;
}

/**
 * A clamped knot vector on `[0, 1]` from the requirements: sorted, requirements
 * closer than `gap` merged into the one with the larger multiplicity, those
 * within `gap` of an end dropped.
 */
function fitKnots(p: number, reqs: readonly KnotReq[], gap: number): Float64Array {
  const sorted = reqs.filter((r) => r.at > gap && r.at < 1 - gap).sort((l, r) => l.at - r.at);
  const merged: KnotReq[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.at - last.at <= gap) {
      if (r.mult > last.mult) merged[merged.length - 1] = r;
    } else merged.push(r);
  }
  const knots: number[] = new Array<number>(p + 1).fill(0);
  for (const { at, mult } of merged) for (let i = 0; i < mult; i++) knots.push(at);
  for (let i = 0; i <= p; i++) knots.push(1);
  return Float64Array.from(knots);
}

/**
 * The midpoints of the fit spans (between distinct knots of `knots`) in which
 * some verification sample's deviation exceeds `aim`. A midpoint closer than
 * `gap` to a span end is not added.
 */
function bisections(
  knots: Float64Array,
  unitTs: Float64Array,
  dev: Float64Array,
  aim: number,
  gap: number,
): number[] {
  const br = knots.filter((x, i) => i === 0 || x !== knots[i - 1]);
  const worst = new Float64Array(br.length - 1);
  for (let k = 0; k < unitTs.length; k++) {
    const x = unitTs[k]!;
    let lo = 0;
    let hi = br.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (br[mid]! <= x) lo = mid;
      else hi = mid;
    }
    if (dev[k]! > worst[lo]!) worst[lo] = dev[k]!;
  }
  const out: number[] = [];
  for (let i = 0; i < worst.length; i++) {
    if (!(worst[i]! > aim)) continue;
    const m = 0.5 * (br[i]! + br[i + 1]!);
    if (m - br[i]! > gap && br[i + 1]! - m > gap) out.push(m);
  }
  return out;
}

/** What one edge fit is a fit *of*, so the two public functions share one refinement loop. */
interface Source<C extends NurbsCurve> {
  readonly basis: Basis;
  readonly dim: 2 | 3;
  /** The data at the fit's sample parameters, or an issue when it cannot be had. */
  data(ts: Float64Array): Float64Array | GeomIssue;
  /**
   * The fitted curve on the source's domain, ready to report: its end points
   * pinned to the first and last of the `data` it was fitted to, then, for a
   * pcurve, clamped into the surface's domain.
   */
  finish(fit: NurbsCurve, data: Float64Array): C;
  /** Per-parameter 3D deviation of `curve` from what it approximates. */
  deviations(curve: C, ts: Float64Array): Float64Array;
  /**
   * Knots for the places the fitted function is less smooth than the source's
   * own knots say (crossings of surface knot lines), found once from the
   * source itself at the parameters `ts`.
   */
  kinks(p: number, ts: Float64Array, width: number): KnotReq[];
  /** The largest chord speed `|C(t₍ᵢ₊₁₎) − C(tᵢ)| / Δt` of the source over `ts` (3D). */
  speed(ts: Float64Array): number;
}

interface Fitted<C extends NurbsCurve> {
  readonly curve: C;
  readonly deviation: number;
}

/** A refinement pass that improves the deviation by less than this factor ends the loop (0.9: under 10%). */
const STALL = 0.9;

/** The shared loop (module comment, steps 1 to 4). */
function refine<C extends NurbsCurve>(
  src: Source<C>,
  t: Tolerances,
  smp: EdgeFitSampling,
  tol: Partial<Tolerances> | undefined,
): Result<Fitted<C>> {
  const [a, b] = src.basis.domain;
  const real = (xs: Float64Array): Float64Array => xs.map((x) => a + (b - a) * x);
  const base = sourceKnots(src.basis, smp.degree);
  // Where kinks are looked for: on the source's own spans, as dense as the fit samples them.
  const probe = spanSamples(src.basis, smp.samplesPerSpan);
  // A kink is located until a knot misplaced by what is left costs `kinkFraction` of `fit`.
  const speed = src.speed(probe);
  const kinks = src.kinks(smp.degree, probe, speed > 0 ? (smp.kinkFraction * t.fit) / speed : 0);
  const extra: KnotReq[] = [];
  const gap = 2 * t.knotRel;
  let best: Fitted<C> | null = null;
  let previous = Infinity;
  for (let pass = 0; pass <= smp.maxPasses; pass++) {
    const knots = fitKnots(smp.degree, [...base, ...kinks, ...extra], gap);
    // Samples per fit span: a bisected span keeps the density, so it stays overdetermined.
    const xs = knotSamples(knots, smp.samplesPerSpan);
    const data = src.data(real(xs));
    if ('code' in data) {
      if (best !== null) break;
      return errResult([data]);
    }
    const fit = approximateCurve(data, src.dim, { degree: smp.degree, params: xs, knots, tol });
    if (!fit.ok) {
      if (best !== null) break;
      return errResult(fit.issues);
    }
    const curve = src.finish(reparameterize(fit.value.curve, [a, b], tol), data);
    const dense = knotSamples(knots, smp.samplesPerSpan * smp.verifyFactor);
    const dev = src.deviations(curve, real(dense));
    let deviation = 0;
    for (const d of dev) if (d > deviation) deviation = d;
    if (best === null || deviation < best.deviation) best = { curve, deviation };
    if (deviation <= t.fit) break;
    // Barely better than the pass before: not under-resolved (module comment, step 4).
    if (deviation > STALL * previous) break;
    previous = deviation;
    const more = bisections(knots, dense, dev, smp.safety * t.fit, gap);
    if (more.length === 0) break;
    extra.push(...more.map((at) => ({ at, mult: 1 })));
  }
  return okResult(best!, []);
}

/**
 * `fit` (polynomial, clamped) with its first and last control points replaced
 * by the first and last data points, which a clamped curve passes through: an
 * edge ends exactly where its source does, so the two ends of a closed edge
 * coincide to the rounding of the data and a loop of them closes.
 */
function pinEnds(fit: NurbsCurve, data: Float64Array, dim: number): Float64Array {
  const n = fit.basis.count;
  const pts = new Float64Array(dim * n);
  controlPointsInto(fit, pts);
  const m = data.length / dim;
  for (let k = 0; k < dim; k++) {
    pts[k] = data[k]!;
    pts[dim * (n - 1) + k] = data[dim * (m - 1) + k]!;
  }
  return pts;
}

/** A polynomial 2D curve with its Euclidean points clamped into the clamped directions of `s`'s domain. */
function clampIntoDomain(pc: NurbsCurve<2>, pts: Float64Array, s: NurbsSurface): ClampedCurve<2> {
  const n = pc.basis.count;
  for (const [k, b] of [
    [0, s.u],
    [1, s.v],
  ] as const) {
    if (b.kind !== 'clamped') continue;
    const [lo, hi] = b.domain;
    for (let i = 0; i < n; i++) pts[2 * i + k] = Math.min(hi, Math.max(lo, pts[2 * i + k]!));
  }
  return makeCurve({ dim: 2, basis: pc.basis as ClampedCurve<2>['basis'], points: pts });
}

/** `|f(t) − g(t)|` at each `ts`, for two evaluators writing 3 values. */
function distances(
  ts: Float64Array,
  f: (t: number, out: Float64Array) => void,
  g: (t: number, out: Float64Array) => void,
): Float64Array {
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  const out = new Float64Array(ts.length);
  for (let i = 0; i < ts.length; i++) {
    f(ts[i]!, p);
    g(ts[i]!, q);
    out[i] = Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  }
  return out;
}

/** The largest `|f(tᵢ₊₁) − f(tᵢ)| / (tᵢ₊₁ − tᵢ)` over `ts`, for an evaluator writing 3 values. */
function chordSpeed(ts: Float64Array, f: (t: number, out: Float64Array) => void): number {
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  let worst = 0;
  f(ts[0]!, p);
  for (let i = 1; i < ts.length; i++) {
    f(ts[i]!, q);
    const dt = ts[i]! - ts[i - 1]!;
    if (dt > 0)
      worst = Math.max(worst, Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!) / dt);
    p.set(q);
  }
  return worst;
}

const scratchFor = (...degrees: number[]): Scratch =>
  createScratch({ maxDegree: Math.max(3, ...degrees), maxDerivs: 2 });

/**
 * The same-parameter pcurve of a 3D curve lying on a surface (module comment).
 *
 * `c` must have a clamped or periodic basis and should lie on `s`: the result
 * reports how well it does. A curve whose samples do not all project
 * (Newton did not converge from the warm start or any seed) returns
 * `not-converged`. A curve that does not lie on `s` within `tol.fit` still
 * returns its best pcurve with `withinTolerance: false` and a warning that
 * carries the largest projection distance as `value`. Periodic surface
 * directions are unwrapped, so the pcurve may run past one period; a curve
 * through a pole of the surface has a jump in its samples and is not a
 * supported input.
 *
 * The pcurve's end points are exactly the projections of the curve's end
 * points (an edge ends where its curve does), so a closed curve's pcurve
 * closes to the rounding of the two projections.
 *
 * `maxDeviation` is the largest 3D distance `|C(t) − S(P(t))|` over
 * `verifyFactor ×` the fit's samples, measured on the returned (clamped into
 * the domain) pcurve. The pcurve is polynomial (`ClampedCurve<2>`) over the
 * curve's own domain (a periodic curve: `[t₀, t₀ + T]`, closed).
 */
export function projectCurveToSurface(
  c: NurbsCurve<3>,
  s: NurbsSurface,
  tol?: Partial<Tolerances>,
  sampling?: Partial<EdgeFitSampling>,
  seeding?: Partial<ProjectionSeeding>,
): Result<{
  readonly pcurve: ClampedCurve<2>;
  readonly maxDeviation: number;
  readonly withinTolerance: boolean;
}> {
  const t = resolveTolerances(tol);
  const smp = resolveSampling(sampling);
  const sc = scratchFor(smp.degree, c.basis.degree, s.u.degree, s.v.degree);
  const issues: GeomIssue[] = [];
  // The surface is prepared once: every pass and every bisection step projects onto it.
  const project = curveSampleProjector(c, s, {
    tol,
    ...(seeding === undefined ? {} : { seeding }),
  });
  const src: Source<ClampedCurve<2>> = {
    basis: c.basis,
    dim: 2,
    data(ts) {
      const proj = project(ts);
      if (proj.notConverged > 0) {
        return {
          code: 'not-converged',
          severity: 'error',
          message: `${proj.notConverged} of ${ts.length} curve samples did not project onto the surface`,
          value: proj.notConverged,
        };
      }
      if (issues.length === 0 && proj.maxDistance > t.fit) {
        issues.push({
          code: 'not-converged',
          severity: 'warning',
          message: `the curve is not on the surface: samples are up to ${proj.maxDistance} away (fit ${t.fit})`,
          value: proj.maxDistance,
        });
      }
      return Float64Array.from(proj.uv);
    },
    finish: (fit, data) => clampIntoDomain(fit as NurbsCurve<2>, pinEnds(fit, data, 2), s),
    // The pcurve is the projection of the curve: where it crosses knot lines is found on the projections.
    kinks: (p, ts, width) =>
      crossingKnots(
        (xs, seed) => {
          const proj = project(xs, seed);
          return proj.notConverged > 0 ? null : Float64Array.from(proj.uv);
        },
        c.basis.domain,
        s,
        p,
        ts,
        t,
        width,
      ),
    speed: (ts) => chordSpeed(ts, (u, out) => curveEvalInto(c, u, 0, out, 0, sc)),
    deviations: (pcurve, ts) =>
      distances(
        ts,
        (u, out) => curveEvalInto(c, u, 0, out, 0, sc),
        (u, out) => curveOnSurfaceEvalInto({ surface: s, pcurve }, u, 0, out, 0, sc),
      ),
  };
  const r = refine(src, t, smp, tol);
  if (!r.ok) return r;
  return okResult(
    Object.freeze({
      pcurve: r.value.curve,
      maxDeviation: r.value.deviation,
      withinTolerance: r.value.deviation <= t.fit,
    }),
    issues,
  );
}

/**
 * The 3D edge curve of a pcurve: `t ↦ S(P(t))` fitted by a polynomial
 * B-spline over the pcurve's own domain (a periodic pcurve: `[t₀, t₀ + T]`,
 * closed), module comment. `maxError` is the largest 3D distance between the
 * fit and the exact composition over `verifyFactor ×` the fit's samples.
 *
 * An exact rational edge (a circle) is approximated, not reproduced: use the
 * exact curve when one is known, and this when the edge is *defined* as the
 * image of a pcurve.
 */
export function curveOnSurfaceTo3d(
  cs: CurveOnSurface,
  tol?: Partial<Tolerances>,
  sampling?: Partial<EdgeFitSampling>,
): Result<{
  readonly curve: ClampedCurve<3>;
  readonly maxError: number;
  readonly withinTolerance: boolean;
}> {
  const t = resolveTolerances(tol);
  const smp = resolveSampling(sampling);
  const pb = cs.pcurve.basis;
  const sc = scratchFor(smp.degree, pb.degree, cs.surface.u.degree, cs.surface.v.degree);
  const exact = (u: number, out: Float64Array): void =>
    curveOnSurfaceEvalInto(cs, u, 0, out, 0, sc);
  const src: Source<ClampedCurve<3>> = {
    basis: pb,
    dim: 3,
    data(ts) {
      const points = new Float64Array(3 * ts.length);
      for (let i = 0; i < ts.length; i++) curveOnSurfaceEvalInto(cs, ts[i]!, 0, points, 3 * i, sc);
      return points;
    },
    finish: (fit, data) =>
      makeCurve({
        dim: 3,
        basis: fit.basis as ClampedCurve<3>['basis'],
        points: pinEnds(fit, data, 3),
      }),
    kinks: (p, ts, width) =>
      crossingKnots(
        (xs) => {
          const uv = new Float64Array(2 * xs.length);
          const q = new Float64Array(2);
          for (let i = 0; i < xs.length; i++) {
            curveEvalInto(cs.pcurve as NurbsCurve<2>, xs[i]!, 0, q, 0, sc);
            uv[2 * i] = q[0]!;
            uv[2 * i + 1] = q[1]!;
          }
          return uv;
        },
        pb.domain,
        cs.surface,
        p,
        ts,
        t,
        width,
      ),
    speed: (ts) => chordSpeed(ts, exact),
    deviations: (curve, ts) =>
      distances(ts, (u, out) => curveEvalInto(curve, u, 0, out, 0, sc), exact),
  };
  const r = refine(src, t, smp, tol);
  if (!r.ok) return r;
  return okResult(
    Object.freeze({
      curve: r.value.curve,
      maxError: r.value.deviation,
      withinTolerance: r.value.deviation <= t.fit,
    }),
    [],
  );
}
