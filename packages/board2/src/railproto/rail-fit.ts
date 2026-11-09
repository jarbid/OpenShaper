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
  FLAT_RANGE,
  FLAT_STEPS,
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
 * tangent leaning `lean` degrees off vertical and a vertical flat of height `flat` cm on the
 * apex side. `null` when the section's half never turns that far, or when the two end
 * tangents diverge so there is no conic arc between them.
 *
 * With a flat the conic stops `flat` short of the apex in z and a straight segment carries
 * the rest, so the halves stay independent and the apex stays the widest point.
 */
export function blend(
  s: RealSection,
  half: Half,
  turn: number,
  rho: number,
  lean = 0,
  flat = 0,
): { conic: Conic; flatTo: P2 | null; from: number; to: number } | null {
  const f = turnIndex(s, half, turn);
  if (f < 0) return null;
  const { p, t } = sampleAt(s, f);
  const apex = at(s, s.apex);
  const end: P2 = [apex[0], half === 'bottom' ? apex[1] - flat : apex[1] + flat];
  const ta = apexTangent(lean);
  // Tangent rays pointing into the arc: along `t` from the panel end (it already points
  // towards the apex on the bottom half and away from it on the deck half, which is the
  // arc's own direction), and along the apex tangent reversed on the bottom half.
  const m =
    half === 'bottom'
      ? lineMeet(p, t, end, [-ta[0], -ta[1]])
      : lineMeet(end, ta, p, [-t[0], -t[1]]);
  if (m === null || m.sa <= 0 || m.sb <= 0) return null;
  const conic: Conic =
    half === 'bottom'
      ? { p0: p, p1: m.p, p2: end, rho }
      : { p0: end, p1: m.p, p2: p, rho };
  const flatTo: P2 | null = flat > 0 ? apex : null;
  return half === 'bottom'
    ? { conic, flatTo, from: f, to: s.apex }
    : { conic, flatTo, from: s.apex, to: f };
}

/** `[y, z, …]` of a half's model: its conic, plus the flat segment to the apex when there is one. */
function halfPolyline(b: {
  conic: Conic;
  flatTo: P2 | null;
}): Float64Array {
  const poly = conicPolyline(b.conic);
  if (b.flatTo === null) return poly;
  const out = new Float64Array(poly.length + 2);
  // The bottom half's conic ends at the flat's lower end; the deck half's starts at its upper one.
  const bottom = b.conic.p2[0] === b.flatTo[0] && b.conic.p2[1] !== b.flatTo[1];
  if (bottom) {
    out.set(poly, 0);
    out[poly.length] = b.flatTo[0];
    out[poly.length + 1] = b.flatTo[1];
  } else {
    out[0] = b.flatTo[0];
    out[1] = b.flatTo[1];
    out.set(poly, 2);
  }
  return out;
}

/** Deviation of one half's blend, or `null` when the blend does not exist. */
export function halfDeviation(
  s: RealSection,
  half: Half,
  turn: number,
  rho: number,
  lean = 0,
  flat = 0,
): Deviation | null {
  const b = blend(s, half, turn, rho, lean, flat);
  if (b === null) return null;
  return deviation(s, b.from, b.to, halfPolyline(b));
}

/** Golden-section minimisation of max deviation over rho at a fixed tangent point. */
function bestRho(
  s: RealSection,
  half: Half,
  turn: number,
  lean: number,
  flat: number,
): { rho: number; dev: Deviation } | null {
  const cost = (r: number): number =>
    halfDeviation(s, half, turn, r, lean, flat)?.max ?? Infinity;
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
  const dev = halfDeviation(s, half, turn, rho, lean, flat);
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

const describe = (
  s: RealSection,
  half: Half,
  turn: number,
  rho: number,
  dev: Deviation,
  lean: number,
  flat: number,
): HalfFit => {
  const b = blend(s, half, turn, rho, lean, flat)!;
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
export function fitHalf(s: RealSection, half: Half, lean = 0, flat = 0): HalfFit | null {
  let best: { turn: number; rho: number; dev: Deviation } | null = null;
  const try1 = (turn: number): void => {
    if (turn < TURN_FLOOR || turn > TURN_CEIL) return;
    const r = bestRho(s, half, turn, lean, flat);
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
  return describe(s, half, b.turn, b.rho, b.dev, lean, flat);
}

/** The same half fitted with the tangent point pinned at `turn`: rho is the only freedom. */
export function fitPinned(s: RealSection, half: Half, turn: number): HalfFit | null {
  const r = bestRho(s, half, turn, 0, 0);
  return r === null ? null : describe(s, half, turn, r.rho, r.dev, 0, 0);
}

/** One half at parameters already chosen: what a law curve's values cost, with nothing refitted. */
export function halfAt(
  s: RealSection,
  half: Half,
  turn: number,
  rho: number,
): HalfFit | null {
  const t = Math.max(TURN_FLOOR, Math.min(TURN_CEIL, turn));
  const r = Math.max(RHO_MIN, Math.min(RHO_MAX, rho));
  const dev = halfDeviation(s, half, t, r, 0, 0);
  return dev === null ? null : describe(s, half, t, r, dev, 0, 0);
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

const station = (s: RealSection, bottom: HalfFit | null, deck: HalfFit | null): StationFit | null =>
  bottom === null || deck === null
    ? null
    : {
        x: s.x,
        chord: s.chord,
        thickness: s.thickness,
        bottom,
        deck,
        max: Math.max(bottom.max, deck.max),
        rms: Math.sqrt((bottom.rms * bottom.rms + deck.rms * deck.rms) / 2),
      };

/**
 * The four-parameter fit of one station. The plain fit is cached by section identity: the
 * study's tables ask for it several times over the same sections and it is the run's cost.
 */
const fitCache = new WeakMap<RealSection, StationFit | null>();

export function fitStation(s: RealSection, lean = 0, flat = 0): StationFit | null {
  if (lean !== 0 || flat !== 0) {
    return station(s, fitHalf(s, 'bottom', lean, flat), fitHalf(s, 'deck', lean, flat));
  }
  if (fitCache.has(s)) return fitCache.get(s)!;
  const r = station(s, fitHalf(s, 'bottom'), fitHalf(s, 'deck'));
  fitCache.set(s, r);
  return r;
}

/** One station at parameters already chosen (a law curve's values). */
export function stationAt(
  s: RealSection,
  turnB: number,
  rhoB: number,
  turnD: number,
  rhoD: number,
): StationFit | null {
  return station(s, halfAt(s, 'bottom', turnB, rhoB), halfAt(s, 'deck', turnD, rhoD));
}

export type Fifth = 'lean' | 'flat';

/**
 * The five-parameter variants. `lean` lets the apex tangent tip off vertical, the same tip on
 * both blends so the section stays G1 there; `flat` puts a short vertical straight segment at
 * the apex, which keeps the apex the widest point. One extra number either way, searched on a
 * grid with the four inner parameters refitted at each rung.
 */
export function fitStationFifth(
  s: RealSection,
  kind: Fifth,
): { value: number; fit: StationFit } | null {
  let best: { value: number; fit: StationFit } | null = null;
  const steps = kind === 'lean' ? LEAN_STEPS : FLAT_STEPS;
  for (let i = 0; i < steps; i++) {
    const value =
      kind === 'lean'
        ? -LEAN_RANGE + (2 * LEAN_RANGE * i) / (steps - 1)
        : (FLAT_RANGE * i) / (steps - 1);
    const fit = kind === 'lean' ? fitStation(s, value, 0) : fitStation(s, 0, value * s.thickness);
    if (fit !== null && (best === null || fit.max < best.fit.max - 1e-9)) best = { value, fit };
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
  const m = lineMeet(B.p, B.t, D.p, [-D.t[0], -D.t[1]]);
  if (m === null || m.sa <= 0 || m.sb <= 0) return null;
  const p1 = m.p;
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
