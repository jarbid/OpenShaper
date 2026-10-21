// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keyed curves with Bézier ease handles: evaluation, auto ease and certificates
 * (docs/design/board2.md §5.2, decisions 13 and 14).
 *
 * A {@link KeyedCurve} is a list of keys `(s, value)` with optional handles. Between
 * keys k and k + 1 the curve is a cubic Bézier in the `(s, value)` plane with
 * control points
 *
 *   (s_k, v_k), (s_k + out.ds, v_k + out.dv), (s_{k+1} − in.ds, v_{k+1} − in.dv), (s_{k+1}, v_{k+1}).
 *
 * Three kinds exist, told apart by the type of the argument:
 *
 * - `LawCurve` with `domain: 'half'` (symmetric boards): keys on [0, ½] with keys at
 *   exactly 0 and ½; the law on (½, 1) is `v(1 − σ)`.
 * - `LawCurve` with `domain: 'full'` (Phase 6): keys over [0, 1), wrapping; the
 *   segment from the last key to the first runs across σ = 1.
 * - a plain `KeyedCurve` (bottom-feature depths over x in cm): defined between its
 *   first and last key, **zero outside** (the depth convention, §6.2).
 *
 * **Auto ease.** An absent handle has `ds` a third of the segment and `dv = m·ds` with
 * `m` the monotone slope of its key. A third makes σ(t) exactly linear in t, so an
 * all-auto curve is exactly the piecewise cubic Hermite interpolant of its keys with
 * those slopes (the closed-form oracle of `law.test.ts`). The slope is the
 * three-point finite difference, zero at a local extremum of the key values
 * (secants of opposite sign or a zero secant), and limited to three times each
 * adjacent secant (the Fritsch-Carlson box), which keeps every segment monotone,
 * so an auto curve never leaves the range of its key values. The end keys of a
 * half-domain or plain curve have slope zero (the C¹ requirement across the tips
 * of a half-domain law, and the flat ends of a feature depth); a full-domain curve
 * uses its cyclic neighbours. Explicit handles on a key do not influence its
 * neighbours' auto slopes.
 *
 * Everything here is pure; an evaluator closes over a frozen copy of its segments.
 * Curves must satisfy {@link checkLawKeys} before they are evaluated; on malformed
 * keys the result is unspecified (but never throws except for fewer than two keys).
 */
import { DEFAULT_TOLERANCES, resolveTolerances } from '@openshaper/geom';
import type { Tolerances } from '@openshaper/geom';
import { makeIssue } from './issues';
import { LAW_ROUNDING_REL } from './params';
import type { Board2Issue, KeyedCurve, LawCurve, LawKey, RailLane } from './types';

/** One resolved Bézier segment in the `(s, value)` plane. */
export interface LawSegment {
  /** Index of the segment's first key. */
  readonly index: number;
  /** The four control abscissae `s`. */
  readonly s: readonly [number, number, number, number];
  /** The four control values. */
  readonly v: readonly [number, number, number, number];
}

type Kind = 'open' | 'half' | 'full';

const kindOf = (law: KeyedCurve | LawCurve): Kind =>
  'domain' in law ? (law as LawCurve).domain : 'open';

/** Length of segment i (from key i to key i + 1, wrapping for a full domain). */
function segmentLength(keys: readonly LawKey[], i: number): number {
  const n = keys.length;
  // i = n − 1 is reached only for a full domain: the wrap across σ = 1.
  return i + 1 < n ? keys[i + 1]!.s - keys[i]!.s : keys[0]!.s + 1 - keys[n - 1]!.s;
}

/** Number of segments: n − 1, or n for a wrapping full domain. */
const segmentCount = (n: number, kind: Kind): number => (kind === 'full' ? n : n - 1);

/** Monotone slope of every key (see the module comment). */
function autoSlopes(keys: readonly LawKey[], kind: Kind): number[] {
  const n = keys.length;
  const m = new Array<number>(n).fill(0);
  const delta = (i: number): number => {
    const a = keys[i]!;
    const b = keys[(i + 1) % n]!;
    return (b.value - a.value) / segmentLength(keys, i);
  };
  for (let k = 0; k < n; k++) {
    let left: number;
    let right: number;
    if (kind === 'full') {
      left = (k + n - 1) % n;
      right = k;
    } else {
      if (k === 0 || k === n - 1) continue; // end keys: slope zero
      left = k - 1;
      right = k;
    }
    const da = delta(left);
    const db = delta(right);
    if (!(da * db > 0)) continue; // local extremum or flat: slope zero
    const ha = segmentLength(keys, left);
    const hb = segmentLength(keys, right);
    const three = (hb * da + ha * db) / (ha + hb);
    const limit = 3 * Math.min(Math.abs(da), Math.abs(db));
    m[k] = Math.sign(three) * Math.min(Math.abs(three), limit);
  }
  return m;
}

const clampBetween = (x: number, a: number, b: number): number =>
  Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b));

/**
 * The resolved Bézier segments of a curve: auto handles filled in. Segment i runs
 * from key i to key i + 1 (the last key to the first, shifted by 1, for a full
 * domain).
 */
export function lawSegments(law: KeyedCurve | LawCurve): readonly LawSegment[] {
  const keys = law.keys;
  const kind = kindOf(law);
  const n = keys.length;
  if (n < 2) throw new RangeError(`a keyed curve needs at least two keys; got ${n}`);
  const slopes = autoSlopes(keys, kind);
  const out: LawSegment[] = [];
  for (let i = 0; i < segmentCount(n, kind); i++) {
    const a = keys[i]!;
    const bi = (i + 1) % n;
    const b = keys[bi]!;
    const h = segmentLength(keys, i);
    const s0 = a.s;
    const s3 = a.s + h;
    const dvSpan = b.value - a.value;
    const outH = a.out ?? {
      ds: h / 3,
      dv: clampBetween(slopes[i]! * (h / 3), 0, dvSpan),
    };
    const inH = b.in ?? {
      ds: h / 3,
      dv: clampBetween(slopes[bi]! * (h / 3), 0, dvSpan),
    };
    out.push(
      Object.freeze({
        index: i,
        s: Object.freeze([s0, s0 + outH.ds, s3 - inH.ds, s3] as const),
        v: Object.freeze([a.value, a.value + outH.dv, b.value - inH.dv, b.value] as const),
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Linear interpolation that is exact at both ends and for equal operands
 * (`a + t(b − a)` for t < ½, `b − (1 − t)(b − a)` otherwise), so a Bézier of
 * equal values is bitwise constant and a segment ends exactly on its key values.
 */
const lerp = (a: number, b: number, t: number): number =>
  t < 0.5 ? a + t * (b - a) : b - (1 - t) * (b - a);

/** de Casteljau evaluation of a cubic Bézier. */
const bez = (p: readonly number[], t: number): number => {
  const a = lerp(p[0]!, p[1]!, t);
  const b = lerp(p[1]!, p[2]!, t);
  const c = lerp(p[2]!, p[3]!, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
};
const bezD = (p: readonly number[], t: number): number => {
  const u = 1 - t;
  return 3 * (u * u * (p[1]! - p[0]!) + 2 * u * t * (p[2]! - p[1]!) + t * t * (p[3]! - p[2]!));
};

/**
 * The value of a segment at abscissa `x` (within the segment): bracketed Newton
 * on σ(t) = x, with bisection when the step leaves the bracket or the derivative
 * vanishes. It stops at a parameter step or bracket of `paramRel` (relative to the
 * unit parameter domain), the iteration bound being the Newton cap plus the
 * bisection steps that bracket needs, so the loop always terminates.
 */
function solveSegment(seg: LawSegment, x: number, tol: Tolerances): number {
  const span = seg.s[3] - seg.s[0];
  let t = span > 0 ? Math.min(Math.max((x - seg.s[0]) / span, 0), 1) : 0;
  let lo = 0;
  let hi = 1;
  const maxIter = tol.newtonMaxIter + Math.ceil(Math.log2(1 / tol.paramRel));
  for (let it = 0; it < maxIter; it++) {
    const f = bez(seg.s, t) - x;
    if (f === 0) break;
    if (f > 0) hi = t;
    else lo = t;
    const d = bezD(seg.s, t);
    let next = t - f / d;
    if (!(d > 0) || !(next > lo && next < hi)) next = 0.5 * (lo + hi);
    const done = Math.abs(next - t) <= tol.paramRel || hi - lo <= tol.paramRel;
    t = next;
    if (done) break;
  }
  return bez(seg.v, t);
}

/**
 * A closure evaluating `law` at any `s` (see the module comment for the domain
 * rules). Resolves the segments once, so use it for repeated evaluation.
 * `tol` overrides geom's tolerances (`paramRel`, `newtonMaxIter` are used).
 * Throws `RangeError` for fewer than two keys, and for a non-finite `s` at the call.
 */
export function lawEvaluator(
  law: KeyedCurve | LawCurve,
  tol?: Partial<Tolerances>,
): (s: number) => number {
  const kind = kindOf(law);
  const segs = lawSegments(law);
  const t = tol === undefined ? DEFAULT_TOLERANCES : resolveTolerances(tol);
  const starts = segs.map((g) => g.s[0]);
  const first = law.keys[0]!.s;
  const last = law.keys[law.keys.length - 1]!.s;
  return (sIn: number): number => {
    if (!Number.isFinite(sIn)) throw new RangeError(`law abscissa must be finite; got ${sIn}`);
    let x = sIn;
    if (kind === 'half') {
      x -= Math.floor(x); // [0, 1)
      if (x > 0.5) x = 1 - x;
      x = Math.min(Math.max(x, first), last);
    } else if (kind === 'full') {
      x -= Math.floor(x);
      if (x < first) x += 1;
    } else if (x < first || x > last) {
      return 0;
    }
    // Last segment whose start is <= x.
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= x) lo = mid;
      else hi = mid - 1;
    }
    return solveSegment(segs[lo]!, x, t);
  };
}

/** The value of `law` at `s`: `lawEvaluator(law, tol)(s)`. */
export function evaluateLaw(
  law: KeyedCurve | LawCurve,
  s: number,
  tol?: Partial<Tolerances>,
): number {
  return lawEvaluator(law, tol)(s);
}

/**
 * The smallest interval containing every segment's control values. The curve lies
 * inside it (convex hull property), so it is a sufficient range certificate.
 */
export function lawValueRange(law: KeyedCurve | LawCurve): readonly [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const g of lawSegments(law)) {
    for (const v of g.v) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return [min, max];
}

interface LawContext {
  readonly lane?: RailLane;
}

const atKey = (ctx: LawContext, key: number, sigma?: number): Board2Issue['at'] => ({
  ...(ctx.lane === undefined ? {} : { lane: ctx.lane }),
  key,
  ...(sigma === undefined ? {} : { sigma }),
});

/**
 * Structure of a curve's keys: finite numbers (`doc-malformed`), at least two keys,
 * strictly increasing `s`, the domain's end keys (half: exactly 0 and ½; full: in
 * [0, 1)), handles with `ds ≥ 0` that do not overlap (`law-keys-unsorted`), and a
 * flat start and end for a half-domain law (`law-tip-slope`). Returns every issue.
 */
export function checkLawKeys(
  law: KeyedCurve | LawCurve,
  ctx: LawContext = {},
  tol?: Partial<Tolerances>,
): readonly Board2Issue[] {
  const t = tol === undefined ? DEFAULT_TOLERANCES : resolveTolerances(tol);
  const kind = kindOf(law);
  const keys = law.keys;
  const out: Board2Issue[] = [];
  const n = keys.length;
  let finite = true;
  keys.forEach((k, i) => {
    for (const [name, v] of [
      ['s', k.s],
      ['value', k.value],
      ['in.ds', k.in?.ds],
      ['in.dv', k.in?.dv],
      ['out.ds', k.out?.ds],
      ['out.dv', k.out?.dv],
    ] as const) {
      if (v !== undefined && !Number.isFinite(v)) {
        finite = false;
        out.push(
          makeIssue('doc-malformed', `key ${i}: ${name} is not finite`, { at: atKey(ctx, i) }),
        );
      }
    }
  });
  if (n < 2) {
    out.push(
      makeIssue('law-keys-unsorted', `a law needs at least two keys; got ${n}`, { value: n }),
    );
    return out;
  }
  if (!finite) return out;
  let sorted = true;
  for (let i = 1; i < n; i++) {
    if (!(keys[i]!.s > keys[i - 1]!.s)) {
      sorted = false;
      out.push(
        makeIssue('law-keys-unsorted', `key ${i}: s must be strictly greater than key ${i - 1}'s`, {
          at: atKey(ctx, i, keys[i]!.s),
          value: keys[i]!.s,
        }),
      );
    }
  }
  if (kind === 'half') {
    if (keys[0]!.s !== 0) {
      out.push(
        makeIssue('law-keys-unsorted', 'a half-domain law needs a key at exactly σ = 0', {
          at: atKey(ctx, 0, keys[0]!.s),
          value: keys[0]!.s,
        }),
      );
    }
    if (keys[n - 1]!.s !== 0.5) {
      out.push(
        makeIssue('law-keys-unsorted', 'a half-domain law needs a key at exactly σ = ½', {
          at: atKey(ctx, n - 1, keys[n - 1]!.s),
          value: keys[n - 1]!.s,
        }),
      );
    }
  } else if (kind === 'full') {
    if (!(keys[0]!.s >= 0 && keys[n - 1]!.s < 1)) {
      out.push(
        makeIssue('law-keys-unsorted', 'a full-domain law needs its keys in [0, 1)', {
          at: atKey(ctx, 0),
        }),
      );
    }
  }
  if (!sorted) return out;
  let handlesOk = true;
  for (let i = 0; i < n; i++) {
    for (const [name, h] of [
      ['in', keys[i]!.in],
      ['out', keys[i]!.out],
    ] as const) {
      if (h !== undefined && h.ds < 0) {
        handlesOk = false;
        out.push(
          makeIssue(
            'law-keys-unsorted',
            `key ${i}: ${name}.ds must be >= 0 (towards the segment)`,
            {
              at: atKey(ctx, i, keys[i]!.s),
              value: h.ds,
            },
          ),
        );
      }
    }
  }
  for (let i = 0; i < segmentCount(n, kind); i++) {
    const h = segmentLength(keys, i);
    const sum = (keys[i]!.out?.ds ?? h / 3) + (keys[(i + 1) % n]!.in?.ds ?? h / 3);
    if (sum > h * (1 + t.paramRel)) {
      handlesOk = false;
      out.push(
        makeIssue(
          'law-keys-unsorted',
          `segment ${i}: out.ds + in.ds = ${sum} exceeds the segment length ${h} (σ would not be monotone)`,
          { at: atKey(ctx, i, keys[i]!.s), value: sum },
        ),
      );
    }
  }
  if (kind === 'half' && handlesOk && out.length === 0) {
    const segs = lawSegments(law);
    const first = segs[0]!;
    const last = segs[segs.length - 1]!;
    if (!flatTangent(first.s, first.v, false)) {
      out.push(
        makeIssue(
          'law-tip-slope',
          'the law must leave σ = 0 with zero slope (C¹ across the tail tip)',
          {
            at: atKey(ctx, 0, 0),
          },
        ),
      );
    }
    if (!flatTangent(last.s, last.v, true)) {
      out.push(
        makeIssue(
          'law-tip-slope',
          'the law must arrive at σ = ½ with zero slope (C¹ across the nose tip)',
          {
            at: atKey(ctx, n - 1, 0.5),
          },
        ),
      );
    }
  }
  return out;
}

/**
 * True if the Bézier's end tangent is horizontal in the `(s, value)` plane. The
 * tangent direction at an end is the first non-zero difference towards the interior
 * (a zero-length handle defers to the next control point); a vertical or sloped
 * direction is not flat. The value component is compared with the rounding
 * allowance {@link LAW_ROUNDING_REL}.
 */
function flatTangent(s: readonly number[], v: readonly number[], atEnd: boolean): boolean {
  const scale = Math.max(...v.map(Math.abs), 1);
  const order = atEnd ? [2, 1, 0] : [1, 2, 3];
  const base = atEnd ? 3 : 0;
  for (const j of order) {
    const ds = s[j]! - s[base]!;
    const dv = v[j]! - v[base]!;
    if (ds !== 0 || dv !== 0) {
      return Math.abs(dv) <= LAW_ROUNDING_REL * scale && ds !== 0;
    }
  }
  return true; // a constant segment
}

/**
 * Certifies that the curve stays in `[lo, hi]` by the convex hull property: every
 * segment's four control values must lie inside, up to {@link LAW_ROUNDING_REL}
 * of the segment's largest value. The test is sufficient, not necessary (an
 * overshooting handle is rejected even if the curve itself would happen to stay in
 * range), as the design states (§5.1). One `law-out-of-range` issue per violating
 * segment, valued at its worst control value.
 */
export function certifyLawRange(
  law: KeyedCurve | LawCurve,
  lo: number,
  hi: number,
  ctx: LawContext = {},
): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  for (const g of lawSegments(law)) {
    const scale = Math.max(...g.v.map(Math.abs));
    const slack = LAW_ROUNDING_REL * scale;
    let worst: number | undefined;
    let at = 0;
    g.v.forEach((v, j) => {
      const excess = Math.max(lo - v, v - hi);
      if (excess > slack && (worst === undefined || excess > Math.max(lo - worst, worst - hi))) {
        worst = v;
        at = g.s[j]!;
      }
    });
    if (worst !== undefined) {
      out.push(
        makeIssue(
          'law-out-of-range',
          `segment ${g.index}: control value ${worst} is outside [${lo}, ${hi}]`,
          { at: atKey(ctx, g.index, at), value: worst },
        ),
      );
    }
  }
  return out;
}
