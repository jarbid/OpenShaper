// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The forward rail model of the trim-and-blend study (`docs/design/trim-blend-test.md`).
 * Scratch module: the engine never imports it.
 *
 * The rail-law study described a rail by finding the point where an existing section has
 * turned 70 degrees and asking for a conic tangent to the section there. That fails where a
 * rail has an edge, because at a crease there is no tangent to be tangent to. Here the blend
 * is built forward instead, the way an engine would build it:
 *
 *  - it starts at a band edge on the panel and ends on the wall at the apex, vertical there;
 *  - its shoulder point sits on the wall, anywhere between where the panel's own tangent
 *    meets the wall (`e = 0`: the blend leaves tangent, no crease) and the apex itself
 *    (`e = 1`: a straight bevel), so `e` is how hard an edge the blend leaves the panel with;
 *  - and where the band edge is the apex, there is no blend at all: the panel runs to the
 *    wall and the rail is a hard edge. That is a legal state, not a failure.
 */
import { RHO_MAX, RHO_MIN, TURN_CEIL, TURN_FLOOR } from './rail-params';
import { at, conicPolyline, deviation, sampleAt, turnIndex } from './rail-geom';
import type { Conic, Deviation, RealSection } from './rail-geom';
import type { Half } from './rail-fit';

/** Tangent-point turn angles tried between the study's floor and ceiling. */
export const FWD_TURNS = 7;
/** Edge fractions tried besides 0 (tangent). 1 is a straight bevel from band edge to apex. */
export const FWD_EDGES: readonly number[] = [0.2, 0.4, 0.6, 0.8, 1];
/** Golden-section steps on rho per candidate. */
export const FWD_RHO_ITERS = 16;
/** Samples of a straight bevel, so the reverse deviation pass sees its whole length. */
export const FWD_SEGMENT_SAMPLES = 60;
/** A band edge this close to the apex (cm) leaves no blend to fit: the panel runs to the wall. */
export const FWD_NO_BLEND = 0.03;
/** An edge is only worth having when it beats the tangent blend by this much (cm). */
export const FWD_EDGE_GAIN = 0.005;
const PARALLEL = 1e-9;

export interface ForwardBlend {
  readonly poly: Float64Array;
  readonly from: number;
  readonly to: number;
  /** Plan distance from the band edge to the wall, cm. */
  readonly width: number;
  /** Height between the band edge and the apex, cm. */
  readonly height: number;
  /** Angle between the panel's tangent and the blend's start direction, degrees. 0 = tangent. */
  readonly edgeDeg: number;
}

/**
 * The blend of one half from the band edge at turn angle `turn` to the apex, with edge
 * fraction `e` and shape `rho`. `null` when the half never turns that far, when the band edge
 * is wider than the apex, or when `e < 1` is asked for and the panel's tangent overshoots the
 * apex (then only a straight bevel exists).
 */
export function forwardBlend(
  s: RealSection,
  half: Half,
  turn: number,
  e: number,
  rho: number,
): ForwardBlend | null {
  const f = turnIndex(s, half, turn);
  if (f < 0) return null;
  const { p, t } = sampleAt(s, f);
  const apex = at(s, s.apex);
  // The panel's tangent, pointing towards the apex on either half.
  const sign = half === 'bottom' ? 1 : -1;
  const dy = sign * t[0];
  const dz = sign * t[1];
  const width = apex[0] - p[0];
  if (width < -PARALLEL) return null;
  const up = half === 'bottom' ? 1 : -1;
  // Where the panel's own tangent meets the wall, and whether that is short of the apex.
  const g1 = dy > PARALLEL ? p[1] + (width * dz) / dy : Number.NaN;
  const tangentOk = Number.isFinite(g1) && up * (apex[1] - g1) > 0;
  const range = half === 'bottom' ? { from: f, to: s.apex } : { from: s.apex, to: f };
  const height = Math.abs(apex[1] - p[1]);
  const startAngle = (z1: number): number => {
    const vy = width;
    const vz = z1 - p[1];
    const len = Math.hypot(vy, vz);
    if (len < PARALLEL) return 0;
    const c = Math.max(-1, Math.min(1, (vy * dy + vz * dz) / len));
    return (Math.acos(c) * 180) / Math.PI;
  };
  if (e >= 1) {
    const poly = new Float64Array(2 * (FWD_SEGMENT_SAMPLES + 1));
    for (let i = 0; i <= FWD_SEGMENT_SAMPLES; i++) {
      const g = i / FWD_SEGMENT_SAMPLES;
      poly[2 * i] = p[0] + g * (apex[0] - p[0]);
      poly[2 * i + 1] = p[1] + g * (apex[1] - p[1]);
    }
    return { poly, ...range, width, height, edgeDeg: startAngle(apex[1]) };
  }
  if (!tangentOk) return null;
  const z1 = g1 + e * (apex[1] - g1);
  const conic: Conic =
    half === 'bottom'
      ? { p0: p, p1: [apex[0], z1], p2: apex, rho }
      : { p0: apex, p1: [apex[0], z1], p2: p, rho };
  return { poly: conicPolyline(conic), ...range, width, height, edgeDeg: startAngle(z1) };
}

export interface ForwardFit {
  readonly turn: number;
  readonly e: number;
  readonly rho: number;
  readonly dev: Deviation;
  readonly width: number;
  readonly height: number;
  readonly edgeDeg: number;
}

function fitAt(s: RealSection, half: Half, turn: number, e: number): ForwardFit | null {
  const evalAt = (rho: number): ForwardFit | null => {
    const b = forwardBlend(s, half, turn, e, rho);
    if (b === null) return null;
    const dev = deviation(s, b.from, b.to, b.poly);
    return { turn, e, rho, dev, width: b.width, height: b.height, edgeDeg: b.edgeDeg };
  };
  if (e >= 1) return evalAt(RHO_MIN);
  if (evalAt(RHO_MIN) === null) return null;
  const cost = (r: number): number => evalAt(r)?.dev.max ?? Infinity;
  const g = (Math.sqrt(5) - 1) / 2;
  let a = RHO_MIN;
  let b = RHO_MAX;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = cost(c);
  let fd = cost(d);
  for (let i = 0; i < FWD_RHO_ITERS; i++) {
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
  return evalAt(fc < fd ? c : d);
}

export interface HalfForward {
  /** The band edge at the turn floor is the apex: the panel runs to the wall, no blend. */
  readonly hardEdge: boolean;
  /** Best blend that leaves the panel tangent (`e = 0`), or `null` when none exists. */
  readonly tangent: ForwardFit | null;
  /** Best blend over every edge fraction, tangent included, or `null` when none exists. */
  readonly best: ForwardFit | null;
}

/** Fits one half both ways: tangent only, and with an edge allowed. */
export function fitForward(s: RealSection, half: Half): HalfForward {
  const f70 = turnIndex(s, half, TURN_FLOOR);
  const apex = at(s, s.apex);
  let hardEdge = false;
  if (f70 >= 0) {
    const p = sampleAt(s, f70).p;
    hardEdge = Math.hypot(apex[0] - p[0], apex[1] - p[1]) < FWD_NO_BLEND;
  }
  let tangent: ForwardFit | null = null;
  let best: ForwardFit | null = null;
  for (let k = 0; k < FWD_TURNS; k++) {
    const turn = TURN_FLOOR + ((TURN_CEIL - TURN_FLOOR) * k) / (FWD_TURNS - 1);
    const t0 = fitAt(s, half, turn, 0);
    if (t0 !== null && (tangent === null || t0.dev.max < tangent.dev.max)) tangent = t0;
    for (const e of FWD_EDGES) {
      const fe = fitAt(s, half, turn, e);
      if (fe !== null && (best === null || fe.dev.max < best.dev.max)) best = fe;
    }
  }
  // An edge has to earn its place: keep the tangent blend unless the edge is clearly better.
  if (tangent !== null && (best === null || tangent.dev.max - best.dev.max < FWD_EDGE_GAIN)) {
    best = tangent;
  }
  return { hardEdge, tangent, best };
}
