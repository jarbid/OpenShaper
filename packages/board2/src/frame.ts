// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section frame (docs/design/m1-model.md §2, "Chord frame").
 *
 * A side's sections lie on chords from the stringer point C(ξ) = (ξ, 0) to an
 * outline point P(ξ). On a standard board P(ξ) is the outline point at x = ξ, so
 * the chords are the classic x-planes. On a notched tail (swallow, fish) the
 * outline starts at the notch bottom (d, 0) and its tips are at x = 0, so no
 * x-plane crosses the board once: inside the notch zone `[d, d + zone]`,
 * P(ξ) = O(p(ξ)), where the outline parameter `p` is a quintic Hermite map that
 * starts at the notch bottom and joins the x = ξ branch with C2 at `d + zone`.
 * The chords then fan from the short stringer segment across the inner wall, the
 * tip and the rear outer rail.
 *
 * `frameAt` gives P and its first two derivatives in ξ, exactly.
 */
import { chainEval, chainMinX, chainParamAtX } from './chain';
import type { CompiledChain } from './chain';
import { MIN_CHORD_ANGLE, NOTCH_MIN_LAMBDA, SOLVE_MAX_ITER, TIP_SLOPE_FLOOR } from './params';
import type { TailSpec } from './types';

/** The notch zone's map (undefined on a standard board). */
export interface NotchMap {
  /** Notch bottom x, zone end ξ_e = d + zone, the tip's outline parameter and the parameter at ξ_e. */
  readonly d: number;
  readonly xiEnd: number;
  readonly sTip: number;
  readonly sEnd: number;
  /** Monomial coefficients of p in τ = (ξ − d) / zone. */
  readonly coef: readonly [number, number, number, number, number, number];
  readonly zone: number;
}

export interface PlanFrame {
  readonly chain: CompiledChain;
  /** First and last station coordinate: d (0 on a standard board) and L. */
  readonly xiMin: number;
  readonly xiMax: number;
  readonly notch: NotchMap | null;
  /** Lower end of the forward branch (x non-decreasing): 0, or the tip's parameter. */
  readonly forwardFrom: number;
}

const tmp = new Float64Array(6);

/** Builds the frame of one half-outline for a tail spec. */
export function makeFrame(chain: CompiledChain, tail: TailSpec): PlanFrame {
  const xiMin = chain.c[0]!;
  const xiMax = chain.c[8 * chain.segments - 2]!;
  if (tail.kind === 'standard') {
    return Object.freeze({ chain, xiMin, xiMax, notch: null, forwardFrom: 0 });
  }
  const sTip = chainMinX(chain).s;
  const d = xiMin;
  const zone = tail.zone;
  const xiEnd = d + zone;
  const sEnd = chainParamAtX(chain, xiEnd, sTip, chain.segments);
  chainEval(chain, sEnd, 2, tmp, 0);
  const xs = Math.max(tmp[2]!, TIP_SLOPE_FLOOR);
  const g1 = 1 / xs;
  const g2 = -tmp[4]! / (xs * xs * xs);
  // Start slope of the map: the average, unless that would put the first chords along the wall.
  // Near the notch bottom a chord to the wall at distance λδ (δ the distance along the stringer)
  // crosses it at tan α = sin θ / (λ + cos θ), θ the wall's angle to the stringer; ask for twice
  // the validator's minimum, or as much as the wall allows.
  chainEval(chain, 0, 1, tmp, 0);
  const wall = Math.hypot(tmp[2]!, tmp[3]!);
  const sinW = tmp[3]! / wall;
  const cosW = -tmp[2]! / wall;
  const lambdaFor = (alpha: number): number => sinW / Math.tan(alpha) - cosW;
  const lambda = Math.max(
    lambdaFor(2 * MIN_CHORD_ANGLE),
    0.5 * lambdaFor(MIN_CHORD_ANGLE),
    NOTCH_MIN_LAMBDA,
  );
  const m0 = Math.min(sEnd / zone, lambda / wall);
  const h = zone;
  const p0 = 0;
  const q0 = 0;
  const coef = [
    p0,
    h * m0,
    (h * h * q0) / 2,
    -10 * p0 - 6 * h * m0 - 1.5 * h * h * q0 + 10 * sEnd - 4 * h * g1 + 0.5 * h * h * g2,
    15 * p0 + 8 * h * m0 + 1.5 * h * h * q0 - 15 * sEnd + 7 * h * g1 - h * h * g2,
    -6 * p0 - 3 * h * m0 - 0.5 * h * h * q0 + 6 * sEnd - 3 * h * g1 + 0.5 * h * h * g2,
  ] as const;
  return Object.freeze({
    chain,
    xiMin,
    xiMax,
    notch: Object.freeze({ d, xiEnd, sTip, sEnd, coef, zone }),
    forwardFrom: sTip,
  });
}

/**
 * The outline parameter s(ξ) and its first and second derivatives in ξ into
 * `out[0 … 3)`. On the x = ξ branch s′ = 1/x_s and s″ = −x_ss/x_s³ (x_s floored
 * where the outline is vertical).
 */
export function outlineParam(f: PlanFrame, xi: number, out: Float64Array): void {
  const n = f.notch;
  if (n !== null && xi < n.xiEnd) {
    const tau = (xi - n.d) / n.zone;
    const c = n.coef;
    const s = c[0] + tau * (c[1] + tau * (c[2] + tau * (c[3] + tau * (c[4] + tau * c[5]))));
    const s1 = c[1] + tau * (2 * c[2] + tau * (3 * c[3] + tau * (4 * c[4] + tau * 5 * c[5])));
    const s2 = 2 * c[2] + tau * (6 * c[3] + tau * (12 * c[4] + tau * 20 * c[5]));
    out[0] = Math.min(Math.max(s, 0), n.sEnd);
    out[1] = s1 / n.zone;
    out[2] = s2 / (n.zone * n.zone);
    return;
  }
  const s = chainParamAtX(f.chain, xi, f.forwardFrom, f.chain.segments);
  chainEval(f.chain, s, 2, tmp, 0);
  const xs = Math.max(tmp[2]!, TIP_SLOPE_FLOOR);
  out[0] = s;
  out[1] = 1 / xs;
  out[2] = -tmp[4]! / (xs * xs * xs);
}

const sBuf = new Float64Array(3);

/**
 * The chord end P(ξ) and its derivatives into `out[0 … 6)` as x y x′ y′ x″ y″.
 * On the x = ξ branch x is ξ exactly (x′ = 1, x″ = 0).
 */
export function frameAt(f: PlanFrame, xi: number, out: Float64Array): void {
  outlineParam(f, xi, sBuf);
  const s = sBuf[0]!;
  const s1 = sBuf[1]!;
  const s2 = sBuf[2]!;
  chainEval(f.chain, s, 2, tmp, 0);
  const onBranch = f.notch === null || xi >= f.notch.xiEnd;
  out[0] = onBranch ? xi : tmp[0]!;
  out[1] = tmp[1]!;
  out[2] = onBranch ? 1 : tmp[2]! * s1;
  out[3] = tmp[3]! * s1;
  out[4] = onBranch ? 0 : tmp[4]! * s1 * s1 + tmp[2]! * s2;
  out[5] = tmp[5]! * s1 * s1 + tmp[3]! * s2;
}

const xiBuf = new Float64Array(3);
const ptBuf = new Float64Array(6);

/**
 * The station coordinate ξ whose chord ends at outline parameter `s`: the inverse of
 * {@link outlineParam} inside the notch zone (by bisection; the map is increasing), the
 * outline point's own x elsewhere.
 */
export function xiOfParam(f: PlanFrame, s: number): number {
  const n = f.notch;
  if (n !== null && s <= n.sEnd) {
    let lo = n.d;
    let hi = n.xiEnd;
    for (let it = 0; it < SOLVE_MAX_ITER; it++) {
      const mid = 0.5 * (lo + hi);
      outlineParam(f, mid, xiBuf);
      if (xiBuf[0]! < s) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
  chainEval(f.chain, s, 0, ptBuf, 0);
  return ptBuf[0]!;
}
