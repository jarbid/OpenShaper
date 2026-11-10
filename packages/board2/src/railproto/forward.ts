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
 *  - its shoulder point sits on the wall, at a height that is free. Where the panel's own
 *    direction meets the wall the blend leaves tangent, with no crease; anywhere above that
 *    it leaves at an angle, which is an edge; at the apex itself it is a straight bevel;
 *  - and where the band edge is the apex, there is no blend at all: the panel runs to the
 *    wall and the rail is a hard edge. That is a legal state, not a failure.
 *
 * Two things a real section needs that a drawn one does not. The panel's direction at the
 * band edge is read off the panel side only, over a short length of arc, because at a crease
 * the sampled section can double back on itself by a tenth of a millimetre and a local
 * tangent there points nowhere. And a crease is offered as a band edge in its own right,
 * because no turn angle lands on it reliably.
 */
import { RHO_MAX, RHO_MIN, TURN_FLOOR } from './rail-params';
import { at, conicPolyline, deviation, sampleAt, turnIndex } from './rail-geom';
import type { Conic, Deviation, P2, RealSection } from './rail-geom';
import type { Half } from './rail-fit';

/** Tangent-point turn angles tried, the study's floor to its ceiling. */
export const FWD_TURNS: readonly number[] = [70, 75, 80, 84, 88];
/** Shoulder heights tried besides the tangent one, as fractions of the way up to the apex. */
export const FWD_STARTS: readonly number[] = [0.15, 0.3, 0.5, 0.7, 1];
/** Golden-section steps on rho per candidate. */
export const FWD_RHO_ITERS = 16;
/** Samples of a straight bevel, so the reverse deviation pass sees its whole length. */
export const FWD_SEGMENT_SAMPLES = 60;
/** A band edge this close to the apex (cm) leaves no blend to fit: the panel runs to the wall. */
export const FWD_NO_BLEND = 0.03;
/** An edge is only worth having when it beats the tangent blend by this much (cm). */
export const FWD_EDGE_GAIN = 0.005;
/** Arc length (cm) the panel's direction is read over where the local tangent cannot be trusted. */
export const FWD_PANEL_BASE = 0.25;
/** The local tangent and that chord may disagree by this much (degrees) before the chord wins. */
export const FWD_TANGENT_TRUST = 10;
/** A direction jump this large (degrees) marks a crease worth trying as a band edge. */
export const FWD_CREASE_JUMP = 15;
/** Arc length (cm) either side of a sample that the jump is measured across. */
export const FWD_CREASE_BASE = 0.08;
/** How far in from the apex (cm of arc) a crease is looked for. */
export const FWD_CREASE_REACH = 4;
/** Below this start angle (degrees) a blend counts as leaving tangent. */
export const FWD_TANGENT_DEG = 5;
const PARALLEL = 1e-9;
const DEG = 180 / Math.PI;

/** The fractional index `delta` cm of arc from fractional index `f` (negative: towards index 0). */
function arcIndex(s: RealSection, f: number, delta: number): number {
  const i0 = Math.max(0, Math.min(s.count - 1, Math.floor(f)));
  const j0 = Math.min(s.count - 1, i0 + 1);
  const a0 = s.arc[i0]! + (s.arc[j0]! - s.arc[i0]!) * (f - i0);
  const target = Math.max(0, Math.min(s.arc[s.count - 1]!, a0 + delta));
  let lo = 0;
  let hi = s.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.arc[mid]! <= target) lo = mid;
    else hi = mid;
  }
  const span = s.arc[hi]! - s.arc[lo]!;
  return lo + (span > 0 ? (target - s.arc[lo]!) / span : 0);
}

const angleBetween = (ay: number, az: number, by: number, bz: number): number => {
  const la = Math.hypot(ay, az);
  const lb = Math.hypot(by, bz);
  if (la < PARALLEL || lb < PARALLEL) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ay * by + az * bz) / (la * lb)))) * DEG;
};

/**
 * The panel's direction at fractional index `f`, pointing towards the apex: the local tangent
 * where it agrees with the panel just inboard, otherwise a chord over {@link FWD_PANEL_BASE}
 * of arc on the panel side.
 */
export function panelDirection(s: RealSection, half: Half, f: number): P2 {
  const towardCentre = half === 'bottom' ? -1 : 1;
  const sign = half === 'bottom' ? 1 : -1;
  const here = sampleAt(s, f);
  const back = sampleAt(s, arcIndex(s, f, towardCentre * FWD_PANEL_BASE)).p;
  let cy = here.p[0] - back[0];
  let cz = here.p[1] - back[1];
  const len = Math.hypot(cy, cz);
  if (len < PARALLEL) return [sign * here.t[0], sign * here.t[1]];
  cy /= len;
  cz /= len;
  const ly = sign * here.t[0];
  const lz = sign * here.t[1];
  return ly > 0 && angleBetween(ly, lz, cy, cz) < FWD_TANGENT_TRUST ? [ly, lz] : [cy, cz];
}

/** The sharpest corner of a half within reach of the apex, or `-1` when it has none. */
export function creaseIndex(s: RealSection, half: Half): number {
  const step = half === 'bottom' ? -1 : 1;
  const apexArc = s.arc[s.apex]!;
  let best = -1;
  let jump = FWD_CREASE_JUMP;
  for (let i = s.apex + step; i > 0 && i < s.count - 1; i += step) {
    if (Math.abs(s.arc[i]! - apexArc) > FWD_CREASE_REACH) break;
    const a = sampleAt(s, arcIndex(s, i, -FWD_CREASE_BASE)).p;
    const b = sampleAt(s, arcIndex(s, i, FWD_CREASE_BASE)).p;
    const p = at(s, i);
    const j = angleBetween(p[0] - a[0], p[1] - a[1], b[0] - p[0], b[1] - p[1]);
    if (j > jump) {
      jump = j;
      best = i;
    }
  }
  return best;
}

export interface ForwardBlend {
  readonly poly: Float64Array;
  readonly from: number;
  readonly to: number;
}

/**
 * The blend of one half from the band edge at fractional index `f` to the apex, with its
 * shoulder at height `z1` on the wall and shape `rho`. `z1` at the apex is a straight bevel.
 */
export function forwardBlend(
  s: RealSection,
  half: Half,
  f: number,
  z1: number,
  rho: number,
): ForwardBlend {
  const p = sampleAt(s, f).p;
  const apex = at(s, s.apex);
  const range = half === 'bottom' ? { from: f, to: s.apex } : { from: s.apex, to: f };
  if (Math.abs(z1 - apex[1]) < PARALLEL) {
    const poly = new Float64Array(2 * (FWD_SEGMENT_SAMPLES + 1));
    for (let i = 0; i <= FWD_SEGMENT_SAMPLES; i++) {
      const g = i / FWD_SEGMENT_SAMPLES;
      poly[2 * i] = p[0] + g * (apex[0] - p[0]);
      poly[2 * i + 1] = p[1] + g * (apex[1] - p[1]);
    }
    return { poly, ...range };
  }
  const conic: Conic =
    half === 'bottom'
      ? { p0: p, p1: [apex[0], z1], p2: apex, rho }
      : { p0: apex, p1: [apex[0], z1], p2: p, rho };
  return { poly: conicPolyline(conic), ...range };
}

export interface ForwardFit {
  /** Fractional index of the band edge on the section. */
  readonly f: number;
  /** Height of the shoulder point on the wall, in the section's frame. */
  readonly z1: number;
  /** Where the panel's own direction meets the wall, or `NaN` when it overshoots the apex. */
  readonly g1: number;
  readonly rho: number;
  readonly dev: Deviation;
  /** Plan distance from the band edge to the wall, cm. */
  readonly width: number;
  /** Height between the band edge and the apex, cm. */
  readonly height: number;
  /** Angle between the panel's direction and the blend's start direction, degrees. */
  readonly edgeDeg: number;
  readonly bevel: boolean;
}

function fitShoulder(
  s: RealSection,
  half: Half,
  f: number,
  z1: number,
  g1: number,
  dir: P2,
): ForwardFit {
  const p = sampleAt(s, f).p;
  const apex = at(s, s.apex);
  const width = apex[0] - p[0];
  const bevel = Math.abs(z1 - apex[1]) < PARALLEL;
  const done = (rho: number): ForwardFit => {
    const b = forwardBlend(s, half, f, z1, rho);
    return {
      f,
      z1,
      g1,
      rho,
      dev: deviation(s, b.from, b.to, b.poly),
      width,
      height: Math.abs(apex[1] - p[1]),
      edgeDeg: angleBetween(dir[0], dir[1], width, z1 - p[1]),
      bevel,
    };
  };
  if (bevel) return done(RHO_MIN);
  const cost = (r: number): number => {
    const b = forwardBlend(s, half, f, z1, r);
    return deviation(s, b.from, b.to, b.poly).max;
  };
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
  return done(fc < fd ? c : d);
}

export interface HalfForward {
  /** The band edge is the apex: the panel runs to the wall and there is no blend. */
  readonly hardEdge: boolean;
  /** Best blend that leaves the panel tangent, or `null` when none exists. */
  readonly tangent: ForwardFit | null;
  /** Best blend over every start direction, tangent included, or `null` when none exists. */
  readonly best: ForwardFit | null;
  /** Fractional index of the crease offered as a band edge, or `-1`. */
  readonly crease: number;
}

/** Fits one half both ways: leaving tangent only, and with an edge allowed. */
export function fitForward(s: RealSection, half: Half): HalfForward {
  const apex = at(s, s.apex);
  const up = half === 'bottom' ? 1 : -1;
  const crease = creaseIndex(s, half);
  const edges: number[] = [];
  for (const turn of FWD_TURNS) {
    const f = turnIndex(s, half, turn);
    if (f >= 0) edges.push(f);
  }
  if (crease >= 0) edges.push(crease);
  let hardEdge = false;
  let tangent: ForwardFit | null = null;
  let best: ForwardFit | null = null;
  for (const f of edges) {
    const p = sampleAt(s, f).p;
    const width = apex[0] - p[0];
    if (width < -PARALLEL) continue;
    const dir = panelDirection(s, half, f);
    // the panel may have turned at most 20 degrees by the band edge, or the blend is not carrying the rail
    const turned = Math.atan2(Math.abs(dir[0]), Math.abs(dir[1])) * DEG;
    if (turned < TURN_FLOOR - 0.5) continue;
    if (Math.hypot(width, apex[1] - p[1]) < FWD_NO_BLEND) {
      hardEdge = true;
      continue;
    }
    const g1 = dir[0] > PARALLEL ? p[1] + (width * dir[1]) / dir[0] : Number.NaN;
    const tangentOk = Number.isFinite(g1) && up * (apex[1] - g1) > 0;
    if (tangentOk) {
      const t0 = fitShoulder(s, half, f, g1, g1, dir);
      if (tangent === null || t0.dev.max < tangent.dev.max) tangent = t0;
    }
    const base = tangentOk ? g1 : p[1];
    if (up * (apex[1] - base) <= 0) continue;
    for (const frac of FWD_STARTS) {
      const fe = fitShoulder(
        s,
        half,
        f,
        base + frac * (apex[1] - base),
        tangentOk ? g1 : Number.NaN,
        dir,
      );
      if (best === null || fe.dev.max < best.dev.max) best = fe;
    }
  }
  // An edge has to earn its place: keep the tangent blend unless the edge is clearly better.
  if (tangent !== null && (best === null || tangent.dev.max - best.dev.max < FWD_EDGE_GAIN)) {
    best = tangent;
  }
  return { hardEdge, tangent, best, crease };
}
