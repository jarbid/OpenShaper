// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-coordinate sections and conic blends for the rail-law study
 * (`docs/design/rail-laws-test.md`). Scratch module: the engine never imports it.
 *
 * A station's stored section is normalised (u, v); the study measures in the section
 * editor's own physical frame, the one `probe.ts` uses: `y` the distance from the
 * stringer along the chord (0 at the stringer, `chord` at the apex) and `z` the height
 * above the rocker (0 at the bottom centre, `thickness` at the deck centre), both cm.
 *
 * The turn angle `phi` of a point is the angle, in degrees, between the section's tangent
 * there and the vertical apex tangent: 0 at the apex and 90 at a centre, on both halves.
 * It is the study's tangent-point coordinate because it says what a blend has to do —
 * how much of the turn into the apex the conic is asked to carry — rather than how far
 * along a curve of unknown length the point sits.
 */
import { chainEval, compileChain } from '../chain';
import { CONIC_SAMPLES, SECTION_SAMPLES } from './rail-params';
import type { Section } from '../types';

export type P2 = readonly [number, number];

/** A station's stored section in the physical (y, z) frame, sampled densely. */
export interface RealSection {
  readonly x: number;
  readonly chord: number;
  readonly thickness: number;
  /** `[y0, z0, y1, z1, …]`, bottom centre → apex → deck centre. */
  readonly pts: Float64Array;
  /** Unit tangents in increasing-index direction, same layout. */
  readonly tan: Float64Array;
  /** Turn angle from vertical, degrees, one per sample. */
  readonly phi: Float64Array;
  /** Cumulative arc length, cm, one per sample. */
  readonly arc: Float64Array;
  /** Index of the apex sample (exactly on the apex knot). */
  readonly apex: number;
  readonly count: number;
}

const BUF = new Float64Array(6);

/**
 * Samples a stored section into the physical frame. Both halves get
 * {@link SECTION_SAMPLES} samples, so the apex is a sample exactly.
 */
export function realSection(
  section: Section,
  x: number,
  chord: number,
  thickness: number,
): RealSection {
  const ch = compileChain(section.chain);
  const n = SECTION_SAMPLES;
  const apexS = section.apex;
  const endS = ch.segments;
  const count = 2 * n + 1;
  const pts = new Float64Array(2 * count);
  const tan = new Float64Array(2 * count);
  const phi = new Float64Array(count);
  const arc = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const s = i <= n ? (apexS * i) / n : apexS + ((endS - apexS) * (i - n)) / n;
    chainEval(ch, s, 1, BUF, 0);
    const y = BUF[0]! * chord;
    const z = BUF[1]! * thickness;
    let dy = BUF[2]! * chord;
    let dz = BUF[3]! * thickness;
    const len = Math.hypot(dy, dz);
    if (len > 0) {
      dy /= len;
      dz /= len;
    }
    pts[2 * i] = y;
    pts[2 * i + 1] = z;
    tan[2 * i] = dy;
    tan[2 * i + 1] = dz;
    // Angle from the vertical (0, 1): 0 at the apex, 90 at a centre, on both halves.
    phi[i] = (Math.atan2(Math.abs(dy), Math.abs(dz)) * 180) / Math.PI;
    if (dz < 0) phi[i] = 180 - phi[i]!;
    arc[i] = i === 0 ? 0 : arc[i - 1]! + Math.hypot(y - pts[2 * i - 2]!, z - pts[2 * i - 1]!);
  }
  return { x, chord, thickness, pts, tan, phi, arc, apex: n, count };
}

/**
 * The same section record from a polyline already in the physical frame (what
 * `probeSection` returns for the as-built surface), with tangents by central differences.
 * `apex` is the index of the sample at the apex.
 */
export function fromPolyline(
  pts: Float64Array,
  apex: number,
  x: number,
  chord: number,
  thickness: number,
): RealSection {
  const count = pts.length / 2;
  const tan = new Float64Array(2 * count);
  const phi = new Float64Array(count);
  const arc = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    let dy = pts[2 * b]! - pts[2 * a]!;
    let dz = pts[2 * b + 1]! - pts[2 * a + 1]!;
    const len = Math.hypot(dy, dz) || 1;
    dy /= len;
    dz /= len;
    tan[2 * i] = dy;
    tan[2 * i + 1] = dz;
    phi[i] = (Math.atan2(Math.abs(dy), Math.abs(dz)) * 180) / Math.PI;
    if (dz < 0) phi[i] = 180 - phi[i]!;
    arc[i] =
      i === 0
        ? 0
        : arc[i - 1]! + Math.hypot(pts[2 * i]! - pts[2 * i - 2]!, pts[2 * i + 1]! - pts[2 * i - 1]!);
  }
  return { x, chord, thickness, pts, tan, phi, arc, apex, count };
}

/** `[y, z]` of sample `i`. */
export const at = (s: RealSection, i: number): P2 => [s.pts[2 * i]!, s.pts[2 * i + 1]!];
/** Unit tangent at sample `i`, in increasing-index direction. */
export const tangentAt = (s: RealSection, i: number): P2 => [s.tan[2 * i]!, s.tan[2 * i + 1]!];

/**
 * The sample on `half` where the turn from vertical first reaches `deg`, walking out from the
 * apex, as a fractional index (interpolated). `-1` when the half never turns that far.
 */
export function turnIndex(s: RealSection, half: 'bottom' | 'deck', deg: number): number {
  const step = half === 'bottom' ? -1 : 1;
  let prev = s.apex;
  for (let i = s.apex + step; i >= 0 && i < s.count; i += step) {
    const a = s.phi[prev]!;
    const b = s.phi[i]!;
    if (b >= deg) {
      const f = b === a ? 0 : (deg - a) / (b - a);
      return prev + step * Math.max(0, Math.min(1, f));
    }
    prev = i;
  }
  return -1;
}

/** Linear interpolation of a section sample at a fractional index. */
export function sampleAt(s: RealSection, f: number): { p: P2; t: P2 } {
  const i = Math.max(0, Math.min(s.count - 1, Math.floor(f)));
  const j = Math.min(s.count - 1, i + 1);
  const g = Math.max(0, Math.min(1, f - i));
  const lerp = (a: number, b: number): number => a + (b - a) * g;
  let ty = lerp(s.tan[2 * i]!, s.tan[2 * j]!);
  let tz = lerp(s.tan[2 * i + 1]!, s.tan[2 * j + 1]!);
  const len = Math.hypot(ty, tz) || 1;
  ty /= len;
  tz /= len;
  return {
    p: [lerp(s.pts[2 * i]!, s.pts[2 * j]!), lerp(s.pts[2 * i + 1]!, s.pts[2 * j + 1]!)],
    t: [ty, tz],
  };
}

// ---------------------------------------------------------------------------
// Conics
// ---------------------------------------------------------------------------

/**
 * A rational quadratic Bézier through `p0` and `p2` with shoulder control point `p1` and
 * shape factor `rho = w / (1 + w)`: the curve passes through
 * `(1 - rho) · (p0 + p2) / 2 + rho · p1`, so rho = ½ is a parabola, below is an ellipse
 * and above a hyperbola.
 */
export interface Conic {
  readonly p0: P2;
  readonly p1: P2;
  readonly p2: P2;
  readonly rho: number;
}

export function conicPoint(c: Conic, t: number): P2 {
  const w = c.rho / (1 - c.rho);
  const a = (1 - t) * (1 - t);
  const b = 2 * t * (1 - t) * w;
  const d = t * t;
  const den = a + b + d;
  return [
    (a * c.p0[0] + b * c.p1[0] + d * c.p2[0]) / den,
    (a * c.p0[1] + b * c.p1[1] + d * c.p2[1]) / den,
  ];
}

/** `[y0, z0, …]` of `CONIC_SAMPLES + 1` points along a conic. */
export function conicPolyline(c: Conic): Float64Array {
  const out = new Float64Array(2 * (CONIC_SAMPLES + 1));
  for (let i = 0; i <= CONIC_SAMPLES; i++) {
    const p = conicPoint(c, i / CONIC_SAMPLES);
    out[2 * i] = p[0];
    out[2 * i + 1] = p[1];
  }
  return out;
}

/**
 * Intersection of the ray from `a` along `da` with the ray from `b` along `db`, as the point
 * and the two ray parameters. `null` when the lines are near-parallel.
 *
 * A conic's shoulder control point is the meeting of the two end tangents pointing **into**
 * the arc, so both parameters must come back positive; a negative one says the tangents
 * diverge and there is no conic arc between the ends with those tangents.
 */
export function lineMeet(
  a: P2,
  da: P2,
  b: P2,
  db: P2,
): { p: P2; sa: number; sb: number } | null {
  const det = da[0] * -db[1] - da[1] * -db[0];
  if (Math.abs(det) < 1e-12) return null;
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  const sa = (rx * -db[1] - rz * -db[0]) / det;
  const sb = (da[0] * rz - da[1] * rx) / det;
  return { p: [a[0] + sa * da[0], a[1] + sa * da[1]], sa, sb };
}

// ---------------------------------------------------------------------------
// Deviation
// ---------------------------------------------------------------------------

const segDist = (py: number, pz: number, qy: number, qz: number, ry: number, rz: number): number => {
  const ey = ry - qy;
  const ez = rz - qz;
  const wy = py - qy;
  const wz = pz - qz;
  const ee = ey * ey + ez * ez;
  const f = ee > 0 ? Math.min(1, Math.max(0, (wy * ey + wz * ez) / ee)) : 0;
  return Math.hypot(wy - f * ey, wz - f * ez);
};

/**
 * Distance from `(py, pz)` to the polyline `poly`, by an exact scan of its segments.
 *
 * It was a marching search from the previous point's answer, which is what one reaches for
 * when two ordered arcs nearly coincide. It is wrong here: a hill climb stops at the first
 * local minimum, and a section with a hard rail edge — a near-corner where the tangent swings
 * 50 degrees within half a millimetre — gives the distance along the curve several minima.
 * On one such station it reported 15.4 mm where the true distance was a tenth of that. The
 * rail region is a few hundred samples and the model four hundred, so the exact scan costs
 * about a third of a millisecond and removes the question.
 */
function nearest(poly: Float64Array, py: number, pz: number): number {
  const segs = poly.length / 2 - 1;
  let d = Infinity;
  for (let k = 0; k < segs; k++) {
    const e = segDist(py, pz, poly[2 * k]!, poly[2 * k + 1]!, poly[2 * k + 2]!, poly[2 * k + 3]!);
    if (e < d) d = e;
  }
  return d;
}

export interface Deviation {
  /** Largest two-sided distance, cm. */
  readonly max: number;
  /** Root mean square of the section-to-model distances, cm. */
  readonly rms: number;
  /** Index of the section sample where `max` was reached, `-1` when the model side won. */
  readonly worstAt: number;
}

/**
 * Two-sided deviation between the section samples `[from, to]` (fractional bounds, inclusive)
 * and a model polyline: every section sample's distance to the model, and every model
 * sample's distance back to that stretch of section, so a conic that bulges off the end of
 * the data is caught too.
 */
export function deviation(
  s: RealSection,
  from: number,
  to: number,
  model: Float64Array,
): Deviation {
  const lo = Math.max(0, Math.ceil(Math.min(from, to)));
  const hi = Math.min(s.count - 1, Math.floor(Math.max(from, to)));
  let max = 0;
  let sum = 0;
  let n = 0;
  let worstAt = -1;
  for (let i = lo; i <= hi; i++) {
    const d = nearest(model, s.pts[2 * i]!, s.pts[2 * i + 1]!);
    sum += d * d;
    n += 1;
    if (d > max) {
      max = d;
      worstAt = i;
    }
  }
  // Reverse direction, against the section stretch alone. Its ends are the exact
  // fractional bounds: rounding them to a sample would read the half-sample gap at each
  // end (0.4 mm on a shortboard) as a deviation of the model.
  const a = sampleAt(s, Math.min(from, to)).p;
  const b = sampleAt(s, Math.max(from, to)).p;
  const stretch = new Float64Array(2 * (hi - lo + 3));
  stretch[0] = a[0];
  stretch[1] = a[1];
  for (let i = lo; i <= hi; i++) {
    stretch[2 * (i - lo) + 2] = s.pts[2 * i]!;
    stretch[2 * (i - lo) + 3] = s.pts[2 * i + 1]!;
  }
  stretch[stretch.length - 2] = b[0];
  stretch[stretch.length - 1] = b[1];
  for (let k = 0; k * 2 + 1 < model.length; k++) {
    const d = nearest(stretch, model[2 * k]!, model[2 * k + 1]!);
    if (d > max) {
      max = d;
      worstAt = -1;
    }
  }
  return { max, rms: n > 0 ? Math.sqrt(sum / n) : 0, worstAt };
}
