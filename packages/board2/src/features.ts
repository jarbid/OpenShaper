// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom features (docs/design/m1-model.md §2, "Features"): board2's closed
 * forms, now in the section's lateral coordinate η = u, with exact derivatives.
 *
 * A feature adds `d(ξ, u) = depth(ξ) · h(u)` to z, on the bottom half of the
 * section only and faded to zero over the rail by a C2 quintic fade in t (see
 * `surface.ts`), so the apex and the deck never move. The depth is a keyed curve
 * over x in cm (zero outside its keys).
 *
 * | Kind       | h(u)                                                                         |
 * | ---------- | ---------------------------------------------------------------------------- |
 * | `vee`      | `g(u)`, linear with a C¹ parabolic blend of half-width `r` at the stringer,  |
 * |            | normalised so `g(1) = 1`: the rails rise by `depth`                          |
 * | `concave`  | `bump((u − centre) / width)`, `bump(t) = (1 − t²)²` on \|t\| < 1             |
 * | `channels` | `Σ_k bump((ℓ(u − 1) + c_k) / (width/2))`, ℓ the chord length, `c_k` the      |
 * |            | distance of channel k's centre from the outline: `railInset + width/2 + k·pitch` |
 *
 * A positive concave or channel depth raises the bottom into the board (the
 * hollow a concave is); a positive vee raises the rails.
 */
import { makeIssue } from './issues';
import { CHORD_FLOOR, SOLVE_MAX_ITER, SOLVE_PARAM_REL } from './params';
import type { Board2Issue, BottomFeature, KeyedCurve, LawKey } from './types';

// ---------------------------------------------------------------------------
// The closed forms
// ---------------------------------------------------------------------------

/** `(1 − t²)²` on |t| < 1, else 0: zero value and slope at its edges. */
export function bump(t: number): number {
  if (!(Math.abs(t) < 1)) return 0;
  const s = 1 - t * t;
  return s * s;
}
/** First derivative of {@link bump}. */
export const bump1 = (t: number): number => (Math.abs(t) < 1 ? -4 * t * (1 - t * t) : 0);
/** Second derivative of {@link bump}. */
export const bump2 = (t: number): number => (Math.abs(t) < 1 ? -4 + 12 * t * t : 0);

/**
 * The vee's lateral profile: `g(t) = t²/(2r) / (1 − r/2)` for `t < r`, else
 * `(t − r/2) / (1 − r/2)`; C¹ at `t = r`, flat at the stringer, `g(1) = 1`.
 */
export function veeProfile(t: number, r: number): number {
  const norm = 1 - r / 2;
  return (t < r ? (t * t) / (2 * r) : t - r / 2) / norm;
}
/** First derivative of {@link veeProfile}. */
export const veeProfile1 = (t: number, r: number): number => (t < r ? t / r : 1) / (1 - r / 2);
/** Second derivative of {@link veeProfile}. */
export const veeProfile2 = (t: number, r: number): number => (t < r ? 1 / r : 0) / (1 - r / 2);

/** A channel's distance of its centre from the outline (cm). */
const channelOffset = (f: { width: number; pitch: number; railInset: number }, k: number): number =>
  f.railInset + f.width / 2 + k * f.pitch;

/** The displacement `depth · h(u)` of a feature at lateral coordinate `u` (no fade), `ell` the chord length. */
export function featureDisplacement(
  f: BottomFeature,
  depth: number,
  u: number,
  ell: number,
): number {
  if (depth === 0) return 0;
  switch (f.kind) {
    case 'vee':
      return depth * veeProfile(u, f.stringerRadius);
    case 'concave':
      return depth * bump((u - (f.layout === 'single' ? 0 : f.centre)) / f.width);
    case 'channels': {
      let s = 0;
      for (let k = 0; k < f.count; k++)
        s += bump((ell * (u - 1) + channelOffset(f, k)) / (f.width / 2));
      return depth * s;
    }
  }
}

/**
 * The feature's value `d` and partials `d_ξ, d_u, d_ξξ, d_ξu, d_uu` into
 * `out[0 … 6)`, given the depth `a` and its ξ-derivatives `a1`, `a2` and the
 * chord length `l` with `l1`, `l2` (used by channels).
 */
export function featureTerm(
  f: BottomFeature,
  a: number,
  a1: number,
  a2: number,
  u: number,
  l: number,
  l1: number,
  l2: number,
  out: Float64Array,
): void {
  // h and its partials: h, h_ξ, h_u, h_ξξ, h_ξu, h_uu
  let h = 0;
  let hx = 0;
  let hu = 0;
  let hxx = 0;
  let hxu = 0;
  let huu = 0;
  switch (f.kind) {
    case 'vee':
      h = veeProfile(u, f.stringerRadius);
      hu = veeProfile1(u, f.stringerRadius);
      huu = veeProfile2(u, f.stringerRadius);
      break;
    case 'concave': {
      const c = f.layout === 'single' ? 0 : f.centre;
      const t = (u - c) / f.width;
      h = bump(t);
      hu = bump1(t) / f.width;
      huu = bump2(t) / (f.width * f.width);
      break;
    }
    case 'channels': {
      const hw = f.width / 2;
      for (let k = 0; k < f.count; k++) {
        const arg = (l * (u - 1) + channelOffset(f, k)) / hw;
        const ax = (l1 * (u - 1)) / hw;
        const au = l / hw;
        const axx = (l2 * (u - 1)) / hw;
        const axu = l1 / hw;
        const b0 = bump(arg);
        const b1 = bump1(arg);
        const b2 = bump2(arg);
        h += b0;
        hx += b1 * ax;
        hu += b1 * au;
        hxx += b2 * ax * ax + b1 * axx;
        hxu += b2 * ax * au + b1 * axu;
        huu += b2 * au * au;
      }
      break;
    }
  }
  out[0] = a * h;
  out[1] = a1 * h + a * hx;
  out[2] = a * hu;
  out[3] = a2 * h + 2 * a1 * hx + a * hxx;
  out[4] = a1 * hu + a * hxu;
  out[5] = a * huu;
}

// ---------------------------------------------------------------------------
// Keyed curves (the depth over x)
// ---------------------------------------------------------------------------

/** Evaluates a keyed curve: value, first and second derivative in `s` into `out[o … o + 3)`. */
export type KeyedEval = (s: number, out: Float64Array, o: number) => void;

const clampBetween = (x: number, a: number, b: number): number =>
  Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b));

/** Monotone slope of every key: three-point difference, zero at extrema and ends, Fritsch-Carlson limited. */
function autoSlopes(keys: readonly LawKey[]): number[] {
  const n = keys.length;
  const m = new Array<number>(n).fill(0);
  const delta = (i: number): number =>
    (keys[i + 1]!.value - keys[i]!.value) / (keys[i + 1]!.s - keys[i]!.s);
  for (let k = 1; k < n - 1; k++) {
    const da = delta(k - 1);
    const db = delta(k);
    if (!(da * db > 0)) continue;
    const ha = keys[k]!.s - keys[k - 1]!.s;
    const hb = keys[k + 1]!.s - keys[k]!.s;
    const three = (hb * da + ha * db) / (ha + hb);
    const limit = 3 * Math.min(Math.abs(da), Math.abs(db));
    m[k] = Math.sign(three) * Math.min(Math.abs(three), limit);
  }
  return m;
}

/** The Bézier segments of a keyed curve in the (s, value) plane, auto handles filled in: 8 numbers each (s0..s3, v0..v3). */
function keyedSegments(curve: KeyedCurve): Float64Array[] {
  const keys = curve.keys;
  const slopes = autoSlopes(keys);
  const out: Float64Array[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const h = b.s - a.s;
    const span = b.value - a.value;
    const outH = a.out ?? { ds: h / 3, dv: clampBetween(slopes[i]! * (h / 3), 0, span) };
    const inH = b.in ?? { ds: h / 3, dv: clampBetween(slopes[i + 1]! * (h / 3), 0, span) };
    out.push(
      Float64Array.of(
        a.s,
        a.s + outH.ds,
        b.s - inH.ds,
        b.s,
        a.value,
        a.value + outH.dv,
        b.value - inH.dv,
        b.value,
      ),
    );
  }
  return out;
}

const bez = (p: Float64Array, o: number, t: number): number => {
  const u = 1 - t;
  return (
    u * u * u * p[o]! +
    3 * u * u * t * p[o + 1]! +
    3 * u * t * t * p[o + 2]! +
    t * t * t * p[o + 3]!
  );
};
const bez1 = (p: Float64Array, o: number, t: number): number => {
  const u = 1 - t;
  return (
    3 *
    (u * u * (p[o + 1]! - p[o]!) +
      2 * u * t * (p[o + 2]! - p[o + 1]!) +
      t * t * (p[o + 3]! - p[o + 2]!))
  );
};
const bez2 = (p: Float64Array, o: number, t: number): number =>
  6 * ((1 - t) * (p[o + 2]! - 2 * p[o + 1]! + p[o]!) + t * (p[o + 3]! - 2 * p[o + 2]! + p[o + 1]!));

/**
 * A closure evaluating a keyed curve with exact derivatives. Zero (value and
 * derivatives) outside the first and last key. Needs at least two keys with
 * strictly increasing `s` and non-overlapping handles (see {@link keyedIssues}).
 */
export function keyedEvaluator(curve: KeyedCurve): KeyedEval {
  const segs = keyedSegments(curve);
  const first = curve.keys[0]!.s;
  const last = curve.keys[curve.keys.length - 1]!.s;
  return (x, out, o) => {
    if (!(x > first && x < last)) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      return;
    }
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid]![0]! <= x) lo = mid;
      else hi = mid - 1;
    }
    const g = segs[lo]!;
    const span = g[3]! - g[0]!;
    let t = Math.min(Math.max((x - g[0]!) / span, 0), 1);
    let a = 0;
    let b = 1;
    for (let it = 0; it < SOLVE_MAX_ITER; it++) {
      const f = bez(g, 0, t) - x;
      if (f === 0) break;
      if (f > 0) b = t;
      else a = t;
      const d = bez1(g, 0, t);
      let next = t - f / d;
      if (!(d > 0) || !(next > a && next < b)) next = 0.5 * (a + b);
      const done = Math.abs(next - t) <= SOLVE_PARAM_REL || !(b > a);
      t = next;
      if (done) break;
    }
    const st = bez1(g, 0, t);
    const stt = bez2(g, 0, t);
    const vt = bez1(g, 4, t);
    const vtt = bez2(g, 4, t);
    out[o] = bez(g, 4, t);
    if (st > 0) {
      out[o + 1] = vt / st;
      out[o + 2] = (vtt * st - vt * stt) / (st * st * st);
    } else {
      out[o + 1] = 0;
      out[o + 2] = 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Checks (feature-invalid)
// ---------------------------------------------------------------------------

/** What the geometry checks of {@link featureIssues} need from the board. */
export interface FeatureContext {
  /** The station range [xiMin, xiMax] the features must lie strictly inside. */
  readonly xiMin: number;
  readonly xiMax: number;
  /** The smallest chord length over [a, b] (both sides). */
  readonly minChord: (a: number, b: number) => number;
}

const finite = (x: number): boolean => Number.isFinite(x);

/** Structure of a depth curve: finite, two or more keys, strictly increasing, handles towards the segment and not overlapping. */
function keyedIssues(
  curve: KeyedCurve,
  say: (m: string, key?: number, v?: number) => void,
): boolean {
  const keys = curve.keys;
  if (keys.length < 2) {
    say(`depth needs at least two keys; got ${keys.length}`, undefined, keys.length);
    return false;
  }
  let ok = true;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    for (const x of [k.s, k.value, k.in?.ds, k.in?.dv, k.out?.ds, k.out?.dv]) {
      if (x !== undefined && !finite(x)) {
        say(`depth key ${i} is not finite`, i);
        return false;
      }
    }
    if (i > 0 && !(k.s > keys[i - 1]!.s)) {
      say(`depth key ${i}: s must be strictly greater than key ${i - 1}'s`, i, k.s);
      ok = false;
    }
  }
  if (!ok) return false;
  for (let i = 0; i < keys.length - 1; i++) {
    const h = keys[i + 1]!.s - keys[i]!.s;
    const o = keys[i]!.out;
    const n = keys[i + 1]!.in;
    if ((o !== undefined && o.ds < 0) || (n !== undefined && n.ds < 0)) {
      say(`depth segment ${i}: handle ds must be >= 0 (towards the segment)`, i);
      ok = false;
    } else if ((o?.ds ?? h / 3) + (n?.ds ?? h / 3) > h) {
      say(`depth segment ${i}: out.ds + in.ds exceeds the segment length ${h}`, i, h);
      ok = false;
    }
  }
  return ok;
}

/**
 * The checks of enabled features (`feature-invalid`): ids unique; parameters in
 * range; the depth well formed, 0 at its first and last key, with its support
 * strictly inside the stations' range; channels not reaching the stringer
 * anywhere on the support.
 */
export function featureIssues(
  features: readonly BottomFeature[],
  ctx: FeatureContext,
): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  const ids = new Set<string>();
  for (const f of features) {
    const say = (message: string, key?: number, value?: number): void => {
      out.push(
        makeIssue('feature-invalid', `feature '${f.id}': ${message}`, {
          at: { feature: f.id, ...(key === undefined ? {} : { key }) },
          ...(value === undefined ? {} : { value }),
        }),
      );
    };
    if (ids.has(f.id)) say('id is used by more than one feature');
    ids.add(f.id);
    if (!f.enabled) continue;
    const frac = (name: string, x: number, lo: number, hi: number, loOpen: boolean): void => {
      if (!(finite(x) && (loOpen ? x > lo : x >= lo) && x <= hi)) {
        say(`${name} must be in ${loOpen ? '(' : '['}${lo}, ${hi}]; got ${x}`, undefined, x);
      }
    };
    switch (f.kind) {
      case 'vee':
        frac('stringerRadius', f.stringerRadius, 0, 1, true);
        break;
      case 'concave':
        frac('width', f.width, 0, 1, true);
        if (f.layout === 'single') {
          if (f.centre !== 0) say(`a single concave is centred; centre must be 0, got ${f.centre}`);
        } else {
          frac('centre', f.centre, 0, 1, true);
          if (
            finite(f.centre) &&
            finite(f.width) &&
            !(f.centre >= f.width && f.centre + f.width <= 1)
          ) {
            say(
              `a double concave's bumps must not overlap (centre >= width) or reach the outline (centre + width <= 1); centre ${f.centre}, width ${f.width}`,
            );
          }
        }
        break;
      case 'channels':
        if (!(Number.isInteger(f.count) && f.count >= 1)) {
          say(`count must be an integer >= 1; got ${f.count}`, undefined, f.count);
        }
        for (const name of ['width', 'pitch'] as const) {
          if (!(finite(f[name]) && f[name] > 0)) say(`${name} must be > 0; got ${f[name]}`);
        }
        if (!(finite(f.railInset) && f.railInset >= 0)) {
          say(`railInset must be >= 0; got ${f.railInset}`);
        }
        if (finite(f.width) && finite(f.pitch) && f.pitch < f.width) {
          say(
            `pitch (${f.pitch}) must be at least the channel width (${f.width})`,
            undefined,
            f.pitch,
          );
        }
        break;
    }
    if (!keyedIssues(f.depth, say)) continue;
    const keys = f.depth.keys;
    const first = keys[0]!;
    const last = keys[keys.length - 1]!;
    if (first.value !== 0 || last.value !== 0) {
      say(
        `depth must start and end at 0 (it is 0 outside its keys); got ${first.value} and ${last.value}`,
      );
    }
    if (!(first.s > ctx.xiMin && last.s < ctx.xiMax)) {
      say(
        `depth keys x [${first.s}, ${last.s}] must lie strictly inside the stations' range (${ctx.xiMin}, ${ctx.xiMax})`,
      );
      continue;
    }
    if (f.kind === 'channels' && Number.isInteger(f.count) && f.count >= 1) {
      const reach = channelOffset(f, f.count - 1) + f.width / 2;
      const h = ctx.minChord(first.s, last.s);
      if (!(reach <= h - CHORD_FLOOR)) {
        say(
          `the innermost channel reaches ${reach} cm from the outline, past the stringer where the chord is ${h} cm`,
          undefined,
          h,
        );
      }
    }
  }
  return out;
}
