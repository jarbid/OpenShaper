// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prototype chord maps for the tail-model study (`docs/design/tail-model.md`).
 *
 * Scratch module: nothing in the engine imports it. Each factory is passed to
 * `buildBoard(doc, { chordMap })`, which hands it to `makeFrame`, so the whole
 * downstream stack (evaluator, mesh, STEP) runs on the alternative map with no
 * other change.
 *
 * Two candidates, against today's piecewise map (`frame.ts`, the control):
 *
 * - {@link smoothMapFactory} — **option D**. The same rule as today (the chord runs
 *   from the stringer point (ξ, 0) to an outline point), but the map from ξ to the
 *   outline parameter has **no breakpoint**: the zone's quintic, which joins the
 *   x = ξ branch with C2 (so its third derivative jumps and the fan's turning stops
 *   abruptly), is replaced by a C-infinity transition. A standard board gets `null`,
 *   so its frame is bit-identical to today's.
 * - {@link normalMapFactory} — **option B**. The chord is perpendicular to the
 *   outline in plan: the row at ξ ends at the outline point whose inward
 *   perpendicular meets the stringer at x = ξ. On a notched tail the inner wall's
 *   perpendicular points at the outer rail, never at the stringer, so the rule
 *   cannot reach the wall at all; there the map falls back to today's fan.
 */
import { chainEval, chainMinX, chainParamAtX } from '../chain';
import type { CompiledChain } from '../chain';
import { MIN_CHORD_ANGLE, NOTCH_MIN_LAMBDA, TIP_SLOPE_FLOOR } from '../params';
import type { ChordMap, ChordMapFactory } from '../frame';
import type { TailSpec } from '../types';
import {
  NORMAL_FOOT_BISECT,
  NORMAL_FOOT_STEP,
  PROTO_ANGLE_SAMPLES,
  SMOOTH_LAMBDA_LADDER,
  SMOOTH_MIN_SLOPE_SHARE,
} from './proto-params';

/** The forward (outer-rail) branch's parameter at x = ξ and its first two derivatives in ξ. */
function branch(
  chain: CompiledChain,
  forwardFrom: number,
  xi: number,
  tmp: Float64Array,
): readonly [number, number, number] {
  const s = chainParamAtX(chain, xi, forwardFrom, chain.segments);
  chainEval(chain, s, 2, tmp, 0);
  const xs = Math.max(tmp[2]!, TIP_SLOPE_FLOOR);
  return [s, 1 / xs, -tmp[4]! / (xs * xs * xs)];
}

// ---------------------------------------------------------------------------
// Option D: the same chord rule, a C-infinity transition
// ---------------------------------------------------------------------------

/**
 * `Φ(τ)` and its first two derivatives: the C-infinity ramp `(1 + bτ)·e^(1 - 1/(1 - τ))`,
 * which is 1 at τ = 0 and **flat to every order** at τ = 1 (where it, and all its
 * derivatives, are exactly 0). `b` sets Φ′(0) = b − 1, which is how the map's start slope
 * is controlled.
 */
function phi(b: number, tau: number, out: Float64Array): void {
  if (tau >= 1) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return;
  }
  const q = 1 / (1 - tau);
  // ψ = e^(1 - q), ψ(0) = 1
  const psi = Math.exp(1 - q);
  const psi1 = -psi * q * q;
  const psi2 = psi * q * q * q * (q - 2);
  const w = 1 + b * tau;
  out[0] = w * psi;
  out[1] = b * psi + w * psi1;
  out[2] = 2 * b * psi1 + w * psi2;
}

/**
 * Option D's map. `s(ξ) = s_x(ξ) − s_x(d)·Φ((ξ − d)/λ)`, with `s_x` the forward branch's
 * parameter at x = ξ:
 *
 * - at ξ = d the chord collapses onto the notch bottom (s = 0) exactly, as today;
 * - beyond ξ = d + λ the map **is** the forward branch, to every derivative, so the
 *   fan dies out with no join of any order — there is no zone boundary;
 * - Φ′(0) is chosen so the first chords leave the notch bottom at the same slope
 *   today's quintic uses, floored at a share of the branch slope so the map stays
 *   increasing.
 *
 * λ is picked from {@link SMOOTH_LAMBDA_LADDER} (multiples of the notch depth): the
 * shortest whose map is increasing and whose chords cross the outline at the
 * validator's minimum angle.
 */
function smoothMap(chain: CompiledChain, zone: number, lambdaMul: number): ChordMap {
  const d = chain.c[0]!;
  const sTip = chainMinX(chain).s;
  const tmp = new Float64Array(6);
  const lambda = Math.max(lambdaMul * d, zone);
  const [s0, s0d] = branch(chain, sTip, d, tmp);
  // Start slope at the notch bottom, the same rule as today's quintic (`frame.ts`): a chord to the
  // inner wall at distance λ·δ crosses it at tan α = sin θ / (λ + cos θ), θ the wall's angle to the
  // stringer; ask for twice the validator's minimum, or as much as the wall allows.
  chainEval(chain, 0, 1, tmp, 0);
  const wall = Math.hypot(tmp[2]!, tmp[3]!);
  const sinW = tmp[3]! / wall;
  const cosW = -tmp[2]! / wall;
  const lambdaFor = (alpha: number): number => sinW / Math.tan(alpha) - cosW;
  const wallRatio = Math.max(
    lambdaFor(2 * MIN_CHORD_ANGLE),
    0.5 * lambdaFor(MIN_CHORD_ANGLE),
    NOTCH_MIN_LAMBDA,
  );
  const slope = Math.max(
    Math.min(s0 / lambda, wallRatio / wall),
    SMOOTH_MIN_SLOPE_SHARE * s0 / lambda,
  );
  // s'(d) = s0d − s0·Φ'(0)/λ = slope  →  Φ'(0) = λ(s0d − slope)/s0
  const b = 1 + (lambda * (s0d - slope)) / s0;
  const pb = new Float64Array(3);
  const param = (xi: number, out: Float64Array): void => {
    const tau = (xi - d) / lambda;
    if (tau >= 1) {
      const [s, s1, s2] = branch(chain, sTip, xi, tmp);
      out[0] = s;
      out[1] = s1;
      out[2] = s2;
      return;
    }
    const [s, s1, s2] = branch(chain, sTip, Math.max(xi, d), tmp);
    phi(b, tau, pb);
    out[0] = Math.max(0, s - s0 * pb[0]!);
    out[1] = s1 - (s0 * pb[1]!) / lambda;
    out[2] = s2 - (s0 * pb[2]!) / (lambda * lambda);
  };
  const probe = new Float64Array(3);
  return Object.freeze({
    param,
    xiOf: (s: number): number => {
      // the map is increasing; bisect over [d, d + λ] while s is below its value there
      param(d + lambda, probe);
      if (s >= probe[0]!) {
        chainEval(chain, s, 0, tmp, 0);
        return tmp[0]!;
      }
      let lo = d;
      let hi = d + lambda;
      for (let i = 0; i < NORMAL_FOOT_BISECT; i++) {
        const mid = 0.5 * (lo + hi);
        param(mid, probe);
        if (probe[0]! < s) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    },
    exact: (xi: number): boolean => xi - d >= lambda,
  });
}

/** How far the chords of a map cross the outline at ξ (radians); `Infinity` where there is no chord. */
export function chordAngle(chain: CompiledChain, map: ChordMap, xi: number): number {
  const s = new Float64Array(3);
  const o = new Float64Array(6);
  map.param(xi, s);
  chainEval(chain, s[0]!, 1, o, 0);
  const wx = o[0]! - xi;
  const wy = o[1]!;
  const len = Math.hypot(wx, wy) * Math.hypot(o[2]!, o[3]!);
  if (!(len > 0)) return Infinity;
  return Math.asin(Math.min(1, Math.abs(wx * o[3]! - wy * o[2]!) / len));
}

/** Whether a map is increasing and clears `minAngle` over `[d, d + span]`. */
function mapOk(chain: CompiledChain, map: ChordMap, span: number, minAngle: number): boolean {
  const d = chain.c[0]!;
  const s = new Float64Array(3);
  for (let i = 0; i <= PROTO_ANGLE_SAMPLES; i++) {
    const xi = d + (span * i) / PROTO_ANGLE_SAMPLES;
    map.param(xi, s);
    if (!(s[1]! > 0)) return false;
    if (i > 0 && chordAngle(chain, map, xi) < minAngle) return false;
  }
  return true;
}

/**
 * Option D's factory: `null` on a standard board (its frame is then today's, bit for bit),
 * otherwise the shortest λ of the ladder whose map is increasing and whose chords clear
 * `minAngle`.
 */
export function smoothMapFactory(minAngle: number): ChordMapFactory {
  return (chain, tail: TailSpec) => {
    if (tail.kind !== 'notched') return null;
    let last: ChordMap | null = null;
    for (const mul of SMOOTH_LAMBDA_LADDER) {
      const m = smoothMap(chain, tail.zone, mul);
      last = m;
      if (mapOk(chain, m, Math.max(mul * chain.c[0]!, tail.zone), minAngle)) return m;
    }
    return last;
  };
}

// ---------------------------------------------------------------------------
// Option B: chords perpendicular to the outline
// ---------------------------------------------------------------------------

/**
 * Where the inward perpendicular of the outline at parameter `s` meets the stringer:
 * `foot = x + y·y_s/x_s`, and its derivative in `s`. On a standard board `foot(0) = 0`
 * and `foot(L) = L` (y = 0 at both ends), so the rows still span the whole board; at the
 * widest point `y_s = 0` and the chord is today's x-plane.
 */
function footAt(chain: CompiledChain, s: number, tmp: Float64Array): readonly [number, number] {
  chainEval(chain, s, 2, tmp, 0);
  const x = tmp[0]!;
  const y = tmp[1]!;
  const xs = tmp[2]!;
  const ys = tmp[3]!;
  const xss = tmp[4]!;
  const yss = tmp[5]!;
  const sign = xs >= 0 ? 1 : -1;
  const xsf = sign * Math.max(Math.abs(xs), TIP_SLOPE_FLOOR);
  const foot = x + (y * ys) / xsf;
  const dfoot = xs + (ys * ys) / xsf + (y * (yss * xsf - ys * xss)) / (xsf * xsf);
  return [foot, dfoot];
}

/**
 * Option B's map on a board with no notch: `s(ξ)` inverts {@link footAt} by bisection, so
 * every row runs perpendicular to the outline. Derivatives come from `1/foot′` and a central
 * difference of the analytic `foot′`.
 */
function normalMap(chain: CompiledChain): ChordMap {
  const tmp = new Float64Array(6);
  const sHi = chain.segments;
  const invert = (xi: number): number => {
    let lo = 0;
    let hi = sHi;
    for (let i = 0; i < NORMAL_FOOT_BISECT; i++) {
      const mid = 0.5 * (lo + hi);
      if (footAt(chain, mid, tmp)[0] < xi) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  return Object.freeze({
    param: (xi: number, out: Float64Array): void => {
      const s = invert(xi);
      const h = NORMAL_FOOT_STEP * sHi;
      const lo = Math.max(0, s - h);
      const hi = Math.min(sHi, s + h);
      const d0 = footAt(chain, s, tmp)[1];
      const dm = footAt(chain, lo, tmp)[1];
      const dp = footAt(chain, hi, tmp)[1];
      const d2 = hi > lo ? (dp - dm) / (hi - lo) : 0;
      const g = Math.abs(d0) > TIP_SLOPE_FLOOR ? d0 : TIP_SLOPE_FLOOR;
      out[0] = s;
      out[1] = 1 / g;
      out[2] = -d2 / (g * g * g);
    },
    xiOf: (s: number): number => footAt(chain, s, tmp)[0],
    exact: () => false,
  });
}

/** Option B's factory. Standard boards only; a notched tail is reported, not approximated. */
export const normalMapFactory: ChordMapFactory = (chain, tail) =>
  tail.kind === 'notched' ? null : normalMap(chain);

/**
 * Where option B's rule stops being able to reach the stringer on a notched outline: the
 * outline parameter at which `x_s` changes sign (the tip). Behind it the inward perpendicular
 * points at the outer rail, so no perpendicular chord reaches the stringer and the model has
 * to fan to the notch bottom, exactly as today.
 */
export function normalBreakdown(chain: CompiledChain): { sTip: number; xAtTip: number } {
  const t = chainMinX(chain);
  return { sTip: t.s, xAtTip: t.x };
}
