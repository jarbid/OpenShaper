// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `buildBoard` and the surface evaluator (docs/design/m1-model.md §2).
 *
 * Each side is `S(ξ, t) = frame(ξ, section(ξ, t))` with ξ the stringer coordinate
 * and t ∈ [0, 1] around the section from bottom centre (t = 0) over the apex
 * (t = ½) to deck centre (t = 1). With the chord from C = (ξ, 0) to the outline
 * point P(ξ) and the blended normalised section (u, v):
 *
 *   X = ξ + u·(P.x − ξ),  Y = u·P.y,  Z = R(X) + T(X)·v + features,
 *
 * R the rocker, T = deck − rocker. The minus side is the same function on its own
 * outline and sections with Y negated. The evaluator returns S and its first and
 * second partials by a hand-written chain rule, so normals and principal
 * curvatures are exact.
 *
 * **Layout of a point's output** (stride 3, geom's `SKL` layout): S, S_ξ, S_t,
 * S_ξξ, S_ξt, S_tt at `out[0…]`, `out[3…]`, … `out[15…]`; orders above the one
 * asked are left unwritten.
 *
 * **Cost.** `row` prepares a station (frame, blended controls, feature depths)
 * once; `eval` then costs one basis evaluation, two rocker/deck lookups (cached
 * while X is unchanged, which is the whole row on a standard board) and a few
 * dozen flops. Nothing allocates after `createEvaluator`.
 *
 * **Tips.** Where the chord has zero length the section collapses to the true
 * point or vertical edge. ∂S/∂ξ is singular at a pointed end and where the
 * outline is vertical (floored, `TIP_SLOPE_FLOOR`); the normal there is the
 * limit, which `measure` reports as degenerate.
 */
import { DEFAULT_TOLERANCES, surfaceMeasureAt } from '@openshaper/geom';
import { BASIS_SIZE, basisDers, spanOfKnots } from './bspline';
import { chainXRange, compileChain, funcEval } from './chain';
import type { CompiledChain } from './chain';
import { featureTerm, keyedEvaluator } from './features';
import type { KeyedEval } from './features';
import { frameAt, makeFrame } from './frame';
import type { PlanFrame } from './frame';
import { board2Err, board2Ok, hasErrors, makeIssue } from './issues';
import { BLEND_CHECK_SAMPLES, CHORD_FLOOR, SECTION_FIT_TOL } from './params';
import { blendAt, controlCount, fitSide } from './sections';
import type { SideBlend, SideItem } from './sections';
import type { Board2Issue, Board2Result, BoardDoc, BottomFeature } from './types';
import { validateBoard } from './validate';

/** One side of a built board. */
export interface BuiltSide {
  readonly frame: PlanFrame;
  readonly blend: SideBlend;
  /** `+1` for the plus side, `-1` for the minus side (y negated). */
  readonly sign: 1 | -1;
}

export interface BuildReport {
  /** Largest station fit error over both sides, cm. */
  readonly stationFitError: number;
  /** Spans per half of the common knot vector, per side. */
  readonly sectionSpans: readonly [number, number];
  /** Section controls pulled back into bounds or onto the Phase 0 rules by the fits. */
  readonly clampedControls: number;
  /** Largest blended control outside 0 ≤ u ≤ 1 before clamping, in cm (0 if none). */
  readonly blendOvershoot: number;
}

export interface CompiledFeature {
  readonly feature: BottomFeature;
  readonly depth: KeyedEval;
}

export interface BuiltBoard {
  readonly doc: BoardDoc;
  /** Station coordinate range: d (0 on a standard board) to the board length. */
  readonly xiMin: number;
  readonly xiMax: number;
  readonly rocker: CompiledChain;
  readonly deck: CompiledChain;
  /** `[plus, minus]`; a mirror board's minus side shares the plus frame and blend. */
  readonly sides: readonly [BuiltSide, BuiltSide];
  readonly features: readonly CompiledFeature[];
  readonly report: BuildReport;
}

/** Chord length and thickness at ξ: the scale that turns a normalised section error into cm. */
function stationScale(
  frame: PlanFrame,
  rocker: CompiledChain,
  deck: CompiledChain,
  xi: number,
): number {
  const p = new Float64Array(6);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  frameAt(frame, xi, p);
  funcEval(rocker, xi, r, 0);
  funcEval(deck, xi, d, 0);
  return Math.max(Math.hypot(p[0]! - xi, p[1]!), d[0]! - r[0]!, CHORD_FLOOR);
}

/**
 * Builds the evaluator data of a document. Runs `validateBoard` first (pass
 * `{ check: false }` for a document already validated). A section fit that
 * misses {@link SECTION_FIT_TOL} or a blend that leaves the bounds is a warning.
 */
export function buildBoard(
  doc: BoardDoc,
  opts: { readonly check?: boolean } = {},
): Board2Result<BuiltBoard> {
  const issues: Board2Issue[] = [];
  if (opts.check !== false) {
    const v = validateBoard(doc);
    if (hasErrors(v)) return board2Err(v);
    issues.push(...v);
  }
  const rocker = compileChain(doc.rocker);
  const deck = compileChain(doc.deck);
  const mirror = doc.symmetry === 'mirror';
  const sideOf = (outline: BoardDoc['outline']['plus'], pick: 'plus' | 'minus', sign: 1 | -1) => {
    const frame = makeFrame(compileChain(outline), doc.tail);
    const items: SideItem[] = doc.stations.map((s) => ({
      id: s.id,
      x: s.x,
      section: pick === 'plus' ? s.plus : (s.minus ?? s.plus),
      scale: stationScale(frame, rocker, deck, s.x),
    }));
    const blend = fitSide(items);
    if (blend === null) {
      issues.push(
        makeIssue('geom', `the ${pick} sections could not be fitted`, { at: { side: pick } }),
      );
      return null;
    }
    for (let i = 0; i < items.length; i++) {
      if (blend.stationError[i]! > SECTION_FIT_TOL) {
        issues.push(
          makeIssue(
            'section-fit',
            `station '${items[i]!.id}' (${pick}): the fitted section is ${blend.stationError[i]!.toPrecision(2)} cm from the stored one (limit ${SECTION_FIT_TOL} cm)`,
            {
              severity: 'warning',
              at: { station: items[i]!.id, side: pick },
              value: blend.stationError[i]!,
            },
          ),
        );
      }
    }
    return { frame, blend, sign } as BuiltSide;
  };
  const plus = sideOf(doc.outline.plus, 'plus', 1);
  const minus = mirror
    ? plus === null
      ? null
      : ({ ...plus, sign: -1 } as BuiltSide)
    : sideOf(doc.outline.minus ?? doc.outline.plus, 'minus', -1);
  if (plus === null || minus === null) return board2Err(issues);
  const [xiMin, xiMax] = chainXRange(plus.frame.chain);
  let over = 0;
  for (const s of mirror ? [plus] : [plus, minus]) over = Math.max(over, overshoot(s.blend, doc));
  if (over > SECTION_FIT_TOL) {
    issues.push(
      makeIssue(
        'blend-overshoot',
        `the blended section leaves 0 <= u <= 1 by ${over.toPrecision(2)} cm; clamped`,
        {
          severity: 'warning',
          value: over,
        },
      ),
    );
  }
  const report: BuildReport = Object.freeze({
    stationFitError: Math.max(
      Math.max(...plus.blend.stationError),
      Math.max(...minus.blend.stationError),
    ),
    sectionSpans: [plus.blend.m, minus.blend.m] as const,
    clampedControls: plus.blend.clamped + (mirror ? 0 : minus.blend.clamped),
    blendOvershoot: over,
  });
  const features = doc.features
    .filter((f) => f.enabled)
    .map((feature) => Object.freeze({ feature, depth: keyedEvaluator(feature.depth) }));
  return board2Ok(
    Object.freeze({
      doc,
      xiMin,
      xiMax,
      rocker,
      deck,
      sides: [plus, minus] as const,
      features,
      report,
    }),
    issues,
  );
}

/** Largest excess of a blended control's u over [0, 1], in cm (scaled by the board's largest chord), sampled between stations. */
function overshoot(b: SideBlend, doc: BoardDoc): number {
  const c = new Float64Array(b.width);
  const none = new Float64Array(b.width);
  const n = b.xs.length;
  if (n < 2) return 0;
  let worst = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 1; k < BLEND_CHECK_SAMPLES; k++) {
      blendAt(
        b,
        b.xs[i]! + ((b.xs[i + 1]! - b.xs[i]!) * k) / BLEND_CHECK_SAMPLES,
        0,
        c,
        none,
        none,
      );
      for (let j = 0; j < b.width; j += 2) worst = Math.max(worst, -c[j]!, c[j]! - 1);
    }
  }
  const half = doc.stations.length > 0 ? 1 : 1;
  return worst * half * maxChord(doc);
}

/** The largest outline half-width of the document, a scale in cm. */
function maxChord(doc: BoardDoc): number {
  let m = 0;
  for (const o of [doc.outline.plus, doc.outline.minus]) {
    if (o === undefined) continue;
    for (const k of o.knots) m = Math.max(m, k.p[1], k.in[1], k.out[1]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/** Offsets in the `measure` output. */
export const MEASURE = {
  nx: 0,
  ny: 1,
  nz: 2,
  k1: 3,
  k2: 4,
  H: 5,
  K: 6,
  flags: 7,
  size: 8,
} as const;

export interface SurfaceEvaluator {
  /** Prepares the station ξ of `side` (0 plus, 1 minus) for evaluation up to `order` in the following `eval` calls. */
  row(side: 0 | 1, xi: number, order: 0 | 1 | 2): void;
  /**
   * S and the partials up to `order` (≤ the row's) at `t` of the prepared row into
   * `out[o …]` (18 values at order 2). At a breakpoint of the section (t = ½)
   * derivatives are the right-hand ones, the left-hand ones with `left`.
   */
  eval(t: number, order: 0 | 1 | 2, out: Float64Array, o?: number, left?: boolean): void;
  /** `row` then `eval`. */
  at(side: 0 | 1, xi: number, t: number, order: 0 | 1 | 2, out: Float64Array, o?: number): void;
  /**
   * Outward unit normal, principal curvatures `k1 ≥ k2`, mean `H` and Gaussian `K` (convex
   * positive) of the prepared row at `t` into `out[0 … MEASURE.size)`; `flags` carries geom's
   * `SAMPLE_DEGENERATE` (normal undefined: tips) and `SAMPLE_UMBILIC`.
   */
  measure(t: number, out: Float64Array, left?: boolean): void;
}

// Offsets of geom's `surfaceMeasureAt` results (surface-measure.ts: MEASURE_N, MEASURE_K, MEASURE_HK).
const M_N = 0;
const M_K = 9;
const M_HK = 11;

/** Allocates the scratch of an evaluator over `board`; evaluators are independent and not thread-shared. */
export function createEvaluator(board: BuiltBoard): SurfaceEvaluator {
  const nf = board.features.length;
  const hasChannels = board.features.some((f) => f.feature.kind === 'channels');
  const t0 = 0.5 * (1 - board.doc.build.railFade);
  const fadeW = 0.5 - t0;
  const maxWidth = Math.max(...board.sides.map((s) => s.blend.width));
  const c0 = new Float64Array(maxWidth);
  const c1 = new Float64Array(maxWidth);
  const c2 = new Float64Array(maxWidth);
  const P = new Float64Array(6);
  const N = new Float64Array(BASIS_SIZE);
  const depths = new Float64Array(3 * Math.max(nf, 1));
  const rz = new Float64Array(3);
  const dz = new Float64Array(3);
  const term = new Float64Array(6);
  const dsum = new Float64Array(6);
  // geom's measure kernel reads the derivatives from fm[0 … 18) and writes its 16 results from fm[18]
  const fm = new Float64Array(34);
  let side: BuiltSide = board.sides[0];
  let xi = 0;
  let a = 0,
    a1 = 0,
    a2 = 0,
    b = 0,
    b1 = 0,
    b2 = 0;
  let l = 0,
    l1 = 0,
    l2 = 0;
  let cachedX = Number.NaN;
  const measureScale = DEFAULT_TOLERANCES.degenerateRel * Math.max(board.xiMax, 1);
  const lu = Math.max(board.xiMax - board.xiMin, 1);

  const row = (which: 0 | 1, xiIn: number, order: 0 | 1 | 2): void => {
    side = board.sides[which];
    xi = xiIn;
    frameAt(side.frame, xi, P);
    a = P[0]! - xi;
    a1 = P[2]! - 1;
    a2 = P[4]!;
    b = P[1]!;
    b1 = P[3]!;
    b2 = P[5]!;
    blendAt(side.blend, xi, order, c0, c1, c2);
    if (hasChannels) {
      const len = Math.hypot(a, b);
      if (len > CHORD_FLOOR) {
        l = len;
        l1 = (a * a1 + b * b1) / len;
        l2 = (a1 * a1 + a * a2 + b1 * b1 + b * b2 - l1 * l1) / len;
      } else {
        l = 0;
        l1 = 0;
        l2 = 0;
      }
    }
    // the bounds 0 <= u <= 1 hold exactly: an interpolation overshoot is clamped (and reported at build)
    for (let k = 0; k < side.blend.width; k += 2) {
      const u = c0[k]!;
      if (u < 0 || u > 1) {
        c0[k] = u < 0 ? 0 : 1;
        if (order >= 1) c1[k] = 0;
        if (order >= 2) c2[k] = 0;
      }
    }
    for (let i = 0; i < nf; i++) board.features[i]!.depth(xi, depths, 3 * i);
    cachedX = Number.NaN;
  };

  const evalPoint = (
    t: number,
    order: 0 | 1 | 2,
    out: Float64Array,
    o: number,
    left: boolean,
  ): void => {
    const knots = side.blend.knots;
    const count = controlCount(side.blend.m);
    const span = spanOfKnots(knots, count, t, left);
    basisDers(knots, span, t, order, N);
    if (t <= knots[3]!) {
      N[0] = 1;
      N[1] = 0;
      N[2] = 0;
      N[3] = 0;
    } else if (t >= knots[count]!) {
      N[0] = 0;
      N[1] = 0;
      N[2] = 0;
      N[3] = 1;
    }
    const base = 2 * (span - 3);
    let u = 0,
      v = 0,
      ut = 0,
      vt = 0,
      utt = 0,
      vtt = 0;
    let ux = 0,
      vx = 0,
      uxx = 0,
      vxx = 0,
      uxt = 0,
      vxt = 0;
    for (let j = 0; j < 4; j++) {
      const i = base + 2 * j;
      const n0 = N[j]!;
      const cu = c0[i]!;
      const cv = c0[i + 1]!;
      u += n0 * cu;
      v += n0 * cv;
      if (order >= 1) {
        const n1 = N[4 + j]!;
        ut += n1 * cu;
        vt += n1 * cv;
        ux += n0 * c1[i]!;
        vx += n0 * c1[i + 1]!;
      }
      if (order >= 2) {
        const n1 = N[4 + j]!;
        utt += N[8 + j]! * cu;
        vtt += N[8 + j]! * cv;
        uxx += n0 * c2[i]!;
        vxx += n0 * c2[i + 1]!;
        uxt += n1 * c1[i]!;
        vxt += n1 * c1[i + 1]!;
      }
    }
    // plan point
    const X = xi + u * a;
    const Y = u * b;
    // rocker and deck at X (cached while X is unchanged: a whole row on a standard board)
    if (X !== cachedX) {
      funcEval(board.rocker, X, rz, 0);
      funcEval(board.deck, X, dz, 0);
      cachedX = X;
    }
    const T = dz[0]! - rz[0]!;
    const T1 = dz[1]! - rz[1]!;
    const T2 = dz[2]! - rz[2]!;
    const g = rz[0]! + T * v;
    const gX = rz[1]! + T1 * v;
    const gXX = rz[2]! + T2 * v;
    // features (bottom half, faded)
    let D = 0,
      Dx = 0,
      Dt = 0,
      Dxx = 0,
      Dxt = 0,
      Dtt = 0;
    if (nf > 0 && t < 0.5) {
      let F = 1,
        F1 = 0,
        F2 = 0;
      if (t > t0) {
        const tau = (t - t0) / fadeW;
        const s = tau * tau * tau * (10 - 15 * tau + 6 * tau * tau);
        const s1 = 30 * tau * tau * (1 - tau) * (1 - tau);
        const s2 = 60 * tau * (1 - tau) * (1 - 2 * tau);
        F = 1 - s;
        F1 = -s1 / fadeW;
        F2 = -s2 / (fadeW * fadeW);
      }
      dsum.fill(0);
      for (let i = 0; i < nf; i++) {
        featureTerm(
          board.features[i]!.feature,
          depths[3 * i]!,
          depths[3 * i + 1]!,
          depths[3 * i + 2]!,
          u,
          l,
          l1,
          l2,
          term,
        );
        for (let k = 0; k < 6; k++) dsum[k] = dsum[k]! + term[k]!;
      }
      const [d, dX, dU, dXX, dXU, dUU] = [
        dsum[0]!,
        dsum[1]!,
        dsum[2]!,
        dsum[3]!,
        dsum[4]!,
        dsum[5]!,
      ];
      D = d * F;
      Dx = (dX + dU * ux) * F;
      Dt = dU * ut * F + d * F1;
      Dxx = (dXX + 2 * dXU * ux + dUU * ux * ux + dU * uxx) * F;
      Dxt = (dXU * ut + dUU * ux * ut + dU * uxt) * F + (dX + dU * ux) * F1;
      Dtt = (dUU * ut * ut + dU * utt) * F + 2 * dU * ut * F1 + d * F2;
    }
    const sgn = side.sign;
    const sy = (y: number): number => (sgn === 1 ? y : 0 - y);
    out[o] = X;
    out[o + 1] = sy(Y);
    out[o + 2] = g + D;
    if (order < 1) return;
    const Xx = 1 + ux * a + u * a1;
    const Xt = ut * a;
    const Yx = ux * b + u * b1;
    const Yt = ut * b;
    out[o + 3] = Xx;
    out[o + 4] = sy(Yx);
    out[o + 5] = gX * Xx + T * vx + Dx;
    out[o + 6] = Xt;
    out[o + 7] = sy(Yt);
    out[o + 8] = gX * Xt + T * vt + Dt;
    if (order < 2) return;
    const Xxx = uxx * a + 2 * ux * a1 + u * a2;
    const Xxt = uxt * a + ut * a1;
    const Xtt = utt * a;
    out[o + 9] = Xxx;
    out[o + 10] = sy(uxx * b + 2 * ux * b1 + u * b2);
    out[o + 11] = gXX * Xx * Xx + 2 * T1 * Xx * vx + gX * Xxx + T * vxx + Dxx;
    out[o + 12] = Xxt;
    out[o + 13] = sy(uxt * b + ut * b1);
    out[o + 14] = gXX * Xx * Xt + T1 * (Xx * vt + Xt * vx) + gX * Xxt + T * vxt + Dxt;
    out[o + 15] = Xtt;
    out[o + 16] = sy(utt * b);
    out[o + 17] = gXX * Xt * Xt + 2 * T1 * Xt * vt + gX * Xtt + T * vtt + Dtt;
  };

  return {
    row,
    eval: (t, order, out, o = 0, left = false) => evalPoint(t, order, out, o, left),
    at: (which, x, t, order, out, o = 0) => {
      row(which, x, order);
      evalPoint(t, order, out, o, false);
    },
    measure: (t, out, left = false) => {
      evalPoint(t, 2, fm, 0, left);
      const flags = surfaceMeasureAt(
        fm,
        0,
        2,
        measureScale,
        lu,
        1,
        DEFAULT_TOLERANCES.degenerateRel,
        DEFAULT_TOLERANCES.umbilicRel,
        18,
      );
      // geom's normal is S_ξ × S_t: inward on the plus side, outward on the minus side.
      const plus = side.sign === 1;
      const n = plus ? -1 : 1;
      out[MEASURE.nx] = n * fm[18 + M_N]!;
      out[MEASURE.ny] = n * fm[18 + M_N + 1]!;
      out[MEASURE.nz] = n * fm[18 + M_N + 2]!;
      const k1 = fm[18 + M_K]!;
      const k2 = fm[18 + M_K + 1]!;
      out[MEASURE.k1] = plus ? k1 : -k2;
      out[MEASURE.k2] = plus ? k2 : -k1;
      out[MEASURE.H] = plus ? fm[18 + M_HK]! : -fm[18 + M_HK]!;
      out[MEASURE.K] = fm[18 + M_HK + 1]!;
      out[MEASURE.flags] = flags;
    },
  };
}
