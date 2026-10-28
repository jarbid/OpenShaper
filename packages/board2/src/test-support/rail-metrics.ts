// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: measurements of the rails of a built board between its stations, for the rail
 * smoothness acceptance test (`rail-smoothness.test.ts`) and the numbers in
 * docs/design/m1-model.md "As built (rail smoothness)".
 *
 * Normal directions are measured in the plane x = ξ on the physical section (the evaluated ring in y, z),
 * where a convex rail's outward normal turns monotonically from -90 degrees (the bottom) through 0 (the
 * apex) to +90 degrees (the deck). A reversal is the angle by which it turns back after having turned the
 * other way: the ripple that shades as a band along the rail.
 */
import { basisDers, BASIS_SIZE, spanOfKnots } from '../bspline';
import type { BuiltBoard } from '../surface';
import { blendAt, controlCount, sectionKnots } from '../sections';
import type { Blend } from '../sections';
import { createEvaluator } from '../surface';
import { nurbsRing } from './mesh-checks';

/** Points per half section of the ring the normal angles are taken from. */
export const RAIL_RING_POINTS = 1000;
/** The rail is the part of a half section whose outward normal is within this angle of horizontal (rad). */
export const RAIL_MAX_ANGLE = (80 * Math.PI) / 180;

/** The outward normal angle (rad) at each point of a half section ring from bottom centre to deck centre. */
export function normalAngles(ring: readonly (readonly [number, number, number])[]): Float64Array {
  const n = ring.length;
  const phi = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const a = ring[Math.max(0, j - 1)]!;
    const b = ring[Math.min(n - 1, j + 1)]!;
    phi[j] = Math.atan2(-(b[1] - a[1]), b[2] - a[2]);
  }
  return phi;
}

/** Index of the apex (largest y) of a ring. */
export function apexIndex(ring: readonly (readonly [number, number, number])[]): number {
  let k = 0;
  for (let j = 1; j < ring.length; j++) if (ring[j]![1] > ring[k]![1]) k = j;
  return k;
}

/**
 * The largest reversal (rad) of the normal angle along the rail of the half section at ξ = x: walking
 * from the apex down to the bottom, and up to the deck, while the normal is within {@link RAIL_MAX_ANGLE}
 * of horizontal, how far it turns back against the direction it has been turning.
 */
export function railReversal(board: BuiltBoard, x: number, side: 0 | 1 = 0): number {
  const ev = createEvaluator(board);
  ev.row(side, x, 0);
  const o = new Float64Array(18);
  const ring: [number, number, number][] = [];
  for (let k = 0; k <= RAIL_RING_POINTS; k++) {
    ev.eval(k / RAIL_RING_POINTS, 0, o);
    ring.push([o[0]!, o[1]!, o[2]!]);
  }
  return reversalOf(ring);
}

/** {@link railReversal} of a ring (bottom centre to deck centre). */
export function reversalOf(ring: readonly (readonly [number, number, number])[]): number {
  const phi = normalAngles(ring);
  const apex = apexIndex(ring);
  let worst = 0;
  let low = phi[apex]!;
  for (let j = apex; j >= 0 && phi[j]! > -RAIL_MAX_ANGLE; j--) {
    low = Math.min(low, phi[j]!);
    worst = Math.max(worst, phi[j]! - low);
  }
  let high = phi[apex]!;
  for (let j = apex; j < phi.length && phi[j]! < RAIL_MAX_ANGLE; j++) {
    high = Math.max(high, phi[j]!);
    worst = Math.max(worst, high - phi[j]!);
  }
  return worst;
}

/** The ring of the plus (side 0) or minus half section at ξ = x, `n + 1` points. */
export function ringAt(board: BuiltBoard, x: number, n: number, side: 0 | 1 = 0) {
  const ev = createEvaluator(board);
  if (side === 0) return nurbsRing(ev, x, n);
  const o = new Float64Array(18);
  ev.row(1, x, 0);
  const out: [number, number, number][] = [];
  for (let k = 0; k <= n; k++) {
    ev.eval(k / n, 0, o);
    out.push([o[0]!, o[1]!, o[2]!]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Landmarks of the blended normalised section
// ---------------------------------------------------------------------------

/** What is read off the normalised section (u, v) of the blend: the apex height and the two 45 degree points. */
export interface Landmarks {
  /** v of the apex. */
  readonly apexV: number;
  /** u and v of the point on the bottom half where the section's tangent is 45 degrees to the horizontal (the tuck). */
  readonly tuckU: number;
  readonly tuckV: number;
  /** The same on the deck half (the deck edge). */
  readonly deckU: number;
  readonly deckV: number;
}

export const LANDMARK_KEYS: readonly (keyof Landmarks)[] = [
  'apexV',
  'tuckU',
  'tuckV',
  'deckU',
  'deckV',
];

/** Samples per half when a landmark is searched along the blended section. */
const LANDMARK_SAMPLES = 800;

/** The (u, v) point and tangent of the blended section at ξ for parameter `t`, from the controls `c`. */
const basis = new Float64Array(BASIS_SIZE);
function sectionPoint(
  knots: Float64Array,
  m: number,
  c: Float64Array,
  t: number,
  out: Float64Array,
): void {
  const count = controlCount(m);
  const N = basis;
  const span = spanOfKnots(knots, count, t, false);
  basisDers(knots, span, t, 1, N);
  let u = 0;
  let v = 0;
  let du = 0;
  let dv = 0;
  for (let j = 0; j < 4; j++) {
    const i = 2 * (span - 3 + j);
    u += N[j]! * c[i]!;
    v += N[j]! * c[i + 1]!;
    du += N[4 + j]! * c[i]!;
    dv += N[4 + j]! * c[i + 1]!;
  }
  out[0] = u;
  out[1] = v;
  out[2] = du;
  out[3] = dv;
}

/** The landmarks of the section the blend gives at ξ. */
export function landmarksAt(b: Blend, xi: number): Landmarks {
  const w = b.width;
  const c = new Float64Array(w);
  blendAt(b, xi, 0, c, new Float64Array(w), new Float64Array(w));
  const p = new Float64Array(4);
  const knots = sectionKnots(b.m);
  // the apex is the control at index (m + 2) (the bottom half's last), t = 1/2
  sectionPoint(knots, b.m, c, 0.5, p);
  const apexV = p[1]!;
  // the bottom half from the apex down to where its tangent drops to 45 degrees, the deck half from
  // the apex up to where its tangent passes 135 degrees (linear between samples)
  const find = (to: number, level: number): [number, number] => {
    let prev: [number, number, number] | null = null;
    for (let k = 0; k <= LANDMARK_SAMPLES; k++) {
      const t = 0.5 + ((to - 0.5) * k) / LANDMARK_SAMPLES;
      sectionPoint(knots, b.m, c, t, p);
      const a = Math.atan2(p[3]!, p[2]!);
      if (prev !== null && (prev[2] - level) * (a - level) <= 0 && a !== prev[2]) {
        const f = (level - prev[2]) / (a - prev[2]);
        return [prev[0] + f * (p[0]! - prev[0]), prev[1] + f * (p[1]! - prev[1])];
      }
      prev = [p[0]!, p[1]!, a];
    }
    return [Number.NaN, Number.NaN];
  };
  const tuck = find(0, Math.PI / 4);
  const deck = find(1, (3 * Math.PI) / 4);
  return { apexV, tuckU: tuck[0], tuckV: tuck[1], deckU: deck[0], deckV: deck[1] };
}

/** The point (u, v) of a section's controls `c` (a fit's `ctrl`, `m` spans per half) at parameter `t` of the whole section. */
export function evalSection(m: number, c: Float64Array, t: number): [number, number] {
  const p = new Float64Array(4);
  sectionPoint(sectionKnots(m), m, c, t, p);
  return [p[0]!, p[1]!];
}
