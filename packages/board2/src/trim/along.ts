// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The blend along the board (docs/design/trim-blend-engine.md, "The panels are lofted at
 * fixed u"): a set of scalars, each given at every station, run along x by the local C2
 * quintic Hermite that `sections.ts` uses for a section's control coordinates.
 *
 * Per scalar and station the slope is the Fritsch–Carlson / Brodlie weighted harmonic mean of
 * the neighbouring chord slopes (0 at a local extremum and at the end stations), and the second
 * derivative is the minmod of the monotone cubic's one-sided second derivatives there (0 where
 * they disagree in sign, and at the end stations). Beyond the end stations the end values are
 * held. This is `blendControls` and `blendAt` without the limiter `blendAt` applies to the u
 * coordinates: those functions fix the width to a section's control count and limit every
 * other coordinate, so the same arithmetic is written here for any width, and along.test.ts
 * proves it equal to theirs on the unlimited coordinates.
 */

/** What an evaluation needs; arrays are row-major, station `k`'s `width` scalars at `[k·width …)`. */
export interface Along {
  /** Station coordinates, strictly increasing. */
  readonly xs: Float64Array;
  readonly width: number;
  /** Values at the stations. */
  readonly q: Float64Array;
  /** First and second derivatives along x at the stations. */
  readonly d: Float64Array;
  readonly dd: Float64Array;
}

/** The blend of `width` scalars through stations `xs` with values `q` (row-major). One station gives a constant. */
export function quinticAlong(xs: Float64Array, q: Float64Array, width: number): Along {
  const n = xs.length;
  if (n < 1 || q.length !== n * width)
    throw new RangeError('quinticAlong: q must hold width values per station');
  for (let i = 0; i + 1 < n; i++) {
    if (!(xs[i + 1]! > xs[i]!))
      throw new RangeError('quinticAlong: stations must be strictly increasing');
  }
  const d = new Float64Array(n * width);
  const dd = new Float64Array(n * width);
  const h = (i: number): number => xs[i + 1]! - xs[i]!;
  for (let k = 0; k < width; k++) {
    const delta = (i: number): number => (q[(i + 1) * width + k]! - q[i * width + k]!) / h(i);
    for (let i = 1; i + 1 < n; i++) {
      const l = delta(i - 1);
      const r = delta(i);
      if (l * r > 0) {
        const w1 = 2 * h(i) + h(i - 1);
        const w2 = h(i) + 2 * h(i - 1);
        d[i * width + k] = (w1 + w2) / (w1 / l + w2 / r);
      }
    }
    for (let i = 1; i + 1 < n; i++) {
      const di = d[i * width + k]!;
      const left = (-6 * delta(i - 1) + 2 * d[(i - 1) * width + k]! + 4 * di) / h(i - 1);
      const right = (6 * delta(i) - 4 * di - 2 * d[(i + 1) * width + k]!) / h(i);
      dd[i * width + k] =
        left * right > 0 ? Math.sign(left) * Math.min(Math.abs(left), Math.abs(right)) : 0;
    }
  }
  return Object.freeze({ xs, width, q, d, dd });
}

/**
 * The interval of `xs` holding `x`: the `lo` with `xs[lo] <= x < xs[lo + 1]`, for `x` strictly
 * inside the stations. `hint` is tried first, then its neighbours, then a bisection.
 */
export function stationSpan(xs: Float64Array, x: number, hint: number): number {
  const last = xs.length - 2;
  if (hint >= 0 && hint <= last) {
    if (xs[hint]! <= x) {
      if (x < xs[hint + 1]!) return hint;
      if (hint < last && x < xs[hint + 2]!) return hint + 1;
    } else if (hint > 0 && xs[hint - 1]! <= x) return hint - 1;
  }
  let lo = 0;
  let hi = last + 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The values at `x` into `out[0 … width)`, and their derivatives along x into `d1` if given. */
export function alongAt(a: Along, x: number, out: Float64Array, d1?: Float64Array): void {
  const xs = a.xs;
  const n = xs.length;
  const w = a.width;
  if (n === 1 || x <= xs[0]! || x >= xs[n - 1]!) {
    const o = n === 1 || x <= xs[0]! ? 0 : (n - 1) * w;
    for (let k = 0; k < w; k++) {
      out[k] = a.q[o + k]!;
      if (d1 !== undefined) d1[k] = 0;
    }
    return;
  }
  const lo = stationSpan(xs, x, 0);
  const h = xs[lo + 1]! - xs[lo]!;
  const t = (x - xs[lo]!) / h;
  const o0 = lo * w;
  const o1 = (lo + 1) * w;
  for (let k = 0; k < w; k++) {
    const y0 = a.q[o0 + k]!;
    const y1 = a.q[o1 + k]!;
    const s0 = a.d[o0 + k]! * h;
    const s1 = a.d[o1 + k]! * h;
    const D0 = a.dd[o0 + k]! * h * h;
    const D1 = a.dd[o1 + k]! * h * h;
    // p(t) = y0 + s0 t + D0/2 t² + c3 t³ + c4 t⁴ + c5 t⁵ with p, p', p'' = y1, s1, D1 at t = 1
    const r0 = y1 - y0 - s0 - D0 / 2;
    const r1 = s1 - s0 - D0;
    const r2 = D1 - D0;
    const c3 = 10 * r0 - 4 * r1 + r2 / 2;
    const c4 = -15 * r0 + 7 * r1 - r2;
    const c5 = 6 * r0 - 3 * r1 + r2 / 2;
    out[k] = y0 + t * (s0 + t * (D0 / 2 + t * (c3 + t * (c4 + t * c5))));
    if (d1 !== undefined) d1[k] = (s0 + t * (D0 + t * (3 * c3 + t * (4 * c4 + t * 5 * c5)))) / h;
  }
}

/**
 * The blend as polynomials, for a caller that evaluates a few of many scalars: for interval `i`
 * (from station `i` to `i + 1`) and scalar `k`, the quintic in `t = (x − xs[i]) / h` has
 * coefficients `c0 … c5` at `[(i·width + k)·6 …)`, so the value is
 * `c0 + t (c1 + t (c2 + t (c3 + t (c4 + t c5))))` and its derivative along x that polynomial's
 * derivative over `h`. They are the coefficients `alongAt` forms, by the same arithmetic. One
 * station gives one interval, the constant.
 */
export function alongPolynomials(a: Along): Float64Array {
  const xs = a.xs;
  const w = a.width;
  const spans = Math.max(xs.length - 1, 1);
  const c = new Float64Array(spans * w * 6);
  if (xs.length === 1) {
    for (let k = 0; k < w; k++) c[k * 6] = a.q[k]!;
    return c;
  }
  for (let i = 0; i < spans; i++) {
    const h = xs[i + 1]! - xs[i]!;
    const o0 = i * w;
    const o1 = (i + 1) * w;
    for (let k = 0; k < w; k++) {
      const y0 = a.q[o0 + k]!;
      const y1 = a.q[o1 + k]!;
      const s0 = a.d[o0 + k]! * h;
      const s1 = a.d[o1 + k]! * h;
      const D0 = a.dd[o0 + k]! * h * h;
      const D1 = a.dd[o1 + k]! * h * h;
      const r0 = y1 - y0 - s0 - D0 / 2;
      const r1 = s1 - s0 - D0;
      const r2 = D1 - D0;
      const b = (i * w + k) * 6;
      c[b] = y0;
      c[b + 1] = s0;
      c[b + 2] = D0 / 2;
      c[b + 3] = 10 * r0 - 4 * r1 + r2 / 2;
      c[b + 4] = -15 * r0 + 7 * r1 - r2;
      c[b + 5] = 6 * r0 - 3 * r1 + r2 / 2;
    }
  }
  return c;
}
