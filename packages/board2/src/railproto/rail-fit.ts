// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail model under test (`docs/design/rail-laws-test.md`) and its fit. Scratch module:
 * the engine never imports it.
 *
 * A section half is a panel taken from the section itself out to a tangent point, then a
 * conic from there to the apex, tangent to the panel at one end and vertical at the apex.
 * The two halves are independent given the apex, so the fit splits into two
 * two-parameter problems: the tangent point's turn angle and the conic's rho.
 *
 * **The tangent point needs a floor.** The panel is the section's own curve, so a blend
 * shrunk towards the apex is fitted against less and less data and its error goes to zero
 * while the panel quietly carries the tuck. {@link TURN_FLOOR} is the answer: a blend must
 * carry at least that much of the 90-degree turn from a centre to the apex. The pinned fits
 * ({@link fitPinned}) remove the freedom altogether.
 */
import {
  LEAN_RANGE,
  LEAN_STEPS,
  RHO_ITERS,
  RHO_MAX,
  RHO_MIN,
  TURN_CEIL,
  TURN_FLOOR,
  TURN_REFINE,
  TURN_STEPS,
} from './rail-params';
import {
  at,
  conicPolyline,
  deviation,
  lineMeet,
  sampleAt,
  turnIndex,
} from './rail-geom';
import type { Conic, Deviation, P2, RealSection } from './rail-geom';

export type Half = 'bottom' | 'deck';

/** The apex tangent, leaning `lean` degrees off vertical towards the deck. */
const apexTangent = (lean: number): P2 => {
  const r = (lean * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
};

/**
 * The blend of one half at tangent-point turn angle `turn` and shape `rho`, with the apex
 * tangent leaning `lean` degrees off vertical. `null` when the tangent lines do not meet on
 * the right side (a section whose half never turns that far, or a tuck already past vertical).
 */
export function blend(
  s: RealSection,
  half: Half,
  turn: number,
  rho: number,
  lean = 0,
): { conic: Conic; from: number; to: number } | null {
  const f = turnIndex(s, half, turn);
  if (f < 0) return null;
  const { p, t } = sampleAt(s, f);
  const apex = at(s, s.apex);
  const ta = apexTangent(lean);
  // The blend runs from the tangent point to the apex on the bottom half, and from the apex
  // out to the tangent point on the deck half; the tangent at the panel end points along the
  // blend in both cases.
  const p1 = lineMeet(p, t, apex, ta);
  if (p1 === null) return null;
  // The shoulder must sit between the two ends in y, or the conic is not the arc we meant.
  const lo = Math.min(p[0], apex[0]);
  const hi = Math.max(p[0], apex[0]);
  if (p1[0] < lo - 1e-9 || p1[0] > hi + 1e-9) return null;
  const conic: Conic =
    half === 'bottom' ? { p0: p, p1, p2: apex, rho } : { p0: apex, p1, p2: p, rho };
  return half === 'bottom'
    ? { conic, from: f, to: s.apex }
    : { conic, from: s.apex, to: f };
}

/** Deviation of one half's blend, or `null` when the blend does not exist. */
export function halfDeviation(
  s: RealSection,
  half: Half,
  turn: number,
  rho: number,
  lean = 0,
): Deviation | null {
  const b = blend(s, half, turn, rho, lean);
  if (b === null) return null;
  return deviation(s, b.from, b.to, conicPolyline(b.conic));
}

/** Golden-section minimisation of max deviation over rho at a fixed tangent point. */
function bestRho(
  s: RealSection,
  half: Half,
  turn: number,
  lean: number,
): { rho: number; dev: Deviation } | null {
  const cost = (r: number): number => halfDeviation(s, half, turn, r, lean)?.max ?? Infinity;
  const g = (Math.sqrt(5) - 1) / 2;
  let a = RHO_MIN;
  let b = RHO_MAX;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = cost(c);
  let fd = cost(d);
  for (let i = 0; i < RHO_ITERS; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = cost(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = cost(d);
    }
  }
  const rho = fc < fd ? c : d;
  const dev = halfDeviation(s, half, turn, rho, lean);
  return dev === null ? null : { rho, dev };
}

export interface HalfFit {
  readonly turn: number;
  readonly rho: number;
  readonly max: number;
  readonly rms: number;
  /** Arc length of the blend, cm: how much rail the conic is carrying. */
  readonly span: number;
  /** Distance of the tangent point from the apex along the chord, cm. */
  readonly inset: number;
  readonly worstAt: number;
}

const describe = (s: RealSection, half: Half, turn: number, rho: number, dev: Deviation, lean: number): HalfFit => {
  const b = blend(s, half, turn, rho, lean)!;
  const lo = Math.min(b.from, b.to);
  const hi = Math.max(b.from, b.to);
  const arcAt = (f: number): number => {
    const i = Math.max(0, Math.min(s.count - 1, Math.floor(f)));
    const j = Math.min(s.count - 1, i + 1);
    return s.arc[i]! + (s.arc[j]! - s.arc[i]!) * (f - i);
  };
  const tp = sampleAt(s, half === 'bottom' ? b.from : b.to).p;
  return {
    turn,
    rho,
    max: dev.max,
    rms: dev.rms,
    span: arcAt(hi) - arcAt(lo),
    inset: s.chord - tp[0],
    worstAt: dev.worstAt,
  };
};

/**
 * Best (turn, rho) for one half: a grid over the turn angle between {@link TURN_FLOOR} and
 * {@link TURN_CEIL}, each rung's rho fitted, then the grid's best rung bisected.
 */
export function fitHalf(s: RealSection, half: Half, lean = 0): HalfFit | null {
  let best: { turn: number; rho: number; dev: Deviation } | null = null;
  const try1 = (turn: number): void => {
    if (turn < TURN_FLOOR || turn > TURN_CEIL) return;
    const r = bestRho(s, half, turn, lean);
    if (r !== null && (best === null || r.dev.max < best.dev.max)) {
      best = { turn, rho: r.rho, dev: r.dev };
    }
  };
  for (let i = 0; i < TURN_STEPS; i++) {
    try1(TURN_FLOOR + ((TURN_CEIL - TURN_FLOOR) * i) / (TURN_STEPS - 1));
  }
  if (best === null) return null;
  let step = (TURN_CEIL - TURN_FLOOR) / (TURN_STEPS - 1);
  for (let k = 0; k < TURN_REFINE; k++) {
    step /= 2;
    const t = (best as { turn: number }).turn;
    try1(t - step);
    try1(t + step);
  }
  const b = best as { turn: number; rho: number; dev: Deviation };
  return describe(s, half, b.turn, b.rho, b.dev, lean);
}

/** The same half fitted with the tangent point pinned at `turn`: rho is the only freedom. */
export function fitPinned(s: RealSection, half: Half, turn: number): HalfFit | null {
  const r = bestRho(s, half, turn, 0);
  return r === null ? null : describe(s, half, turn, r.rho, r.dev, 0);
}

export interface StationFit {
  readonly x: number;
  readonly chord: number;
  readonly thickness: number;
  readonly bottom: HalfFit;
  readonly deck: HalfFit;
  /** Worse of the two halves' max deviation, cm: the station's number. */
  readonly max: number;
  readonly rms: number;
}

/** The four-parameter fit of one station. */
export function fitStation(s: RealSection, lean = 0): StationFit | null {
  const bottom = fitHalf(s, 'bottom', lean);
  const deck = fitHalf(s, 'deck', lean);
  if (bottom === null || deck === null) return null;
  return {
    x: s.x,
    chord: s.chord,
    thickness: s.thickness,
    bottom,
    deck,
    max: Math.max(bottom.max, deck.max),
    rms: Math.sqrt((bottom.rms * bottom.rms + deck.rms * deck.rms) / 2),
  };
}

/**
 * The five-parameter variant: the apex tangent may lean off vertical, the same lean on both
 * blends so the section stays G1 through the apex. Returns the best lean and its fit.
 */
export function fitStationLeaning(s: RealSection): { lean: number; fit: StationFit } | null {
  let best: { lean: number; fit: StationFit } | null = null;
  for (let i = 0; i < LEAN_STEPS; i++) {
    const lean = -LEAN_RANGE + (2 * LEAN_RANGE * i) / (LEAN_STEPS - 1);
    const fit = fitStation(s, lean);
    if (fit !== null && (best === null || fit.max < best.fit.max)) best = { lean, fit };
  }
  return best;
}

// ---------------------------------------------------------------------------
// One conic instead of two (open question 1)
// ---------------------------------------------------------------------------

export interface SingleFit {
  readonly rho: number;
  readonly max: number;
  readonly rms: number;
  /** How far the single conic's widest point is from the section's apex, cm. */
  readonly apexMiss: number;
}

/**
 * One conic straight from the bottom tangent point to the deck tangent point, tangent to both
 * panels, with no vertical tangent in between. The tangent points are those the two-conic fit
 * chose, so the two models are asked to cover the same stretch of rail.
 */
export function fitSingle(s: RealSection, turnB: number, turnD: number): SingleFit | null {
  const fB = turnIndex(s, 'bottom', turnB);
  const fD = turnIndex(s, 'deck', turnD);
  if (fB < 0 || fD < 0) return null;
  const B = sampleAt(s, fB);
  const D = sampleAt(s, fD);
  const p1 = lineMeet(B.p, B.t, D.p, D.t);
  if (p1 === null) return null;
  const apex = at(s, s.apex);
  const cost = (rho: number): Deviation | null => {
    const poly = conicPolyline({ p0: B.p, p1, p2: D.p, rho });
    return deviation(s, fB, fD, poly);
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let a = RHO_MIN;
  let b = RHO_MAX;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = cost(c)?.max ?? Infinity;
  let fd = cost(d)?.max ?? Infinity;
  for (let i = 0; i < RHO_ITERS; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = cost(c)?.max ?? Infinity;
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = cost(d)?.max ?? Infinity;
    }
  }
  const rho = fc < fd ? c : d;
  const dev = cost(rho);
  if (dev === null) return null;
  const poly = conicPolyline({ p0: B.p, p1, p2: D.p, rho });
  let widest = 0;
  for (let i = 0; i * 2 + 1 < poly.length; i++) if (poly[2 * i]! > poly[2 * widest]!) widest = i;
  return {
    rho,
    max: dev.max,
    rms: dev.rms,
    apexMiss: Math.hypot(poly[2 * widest]! - apex[0], poly[2 * widest + 1]! - apex[1]),
  };
}
