// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Classic sampling (docs/design/board2.md §9.2): the classic loft (what the 3D
 * view, the STL and the STEP fit show, decision 23) sampled in rows, its floor
 * zones, and the crease angle at every real station.
 *
 * - **Solid span and floor zones.** The kernel's `surfaceStations(board).span`
 *   is the x-range where the loft's floors (`MIN_DIM`) do not bite; outside it
 *   the loft reports an inflated ring, so nothing from there is data.
 * - **Rows** at a spacing of at most `sampleSpacingX` across the solid span
 *   (both ends included) and at every real station x ± `creaseProbe`, so each
 *   side of a station's tangent break has data next to it.
 * - **Ring points** at the classic's own curvature ladder
 *   `ringFractions(board, ringSamples)` on the +y half (f = 0 the bottom
 *   centre, f = 1 the deck centre); the −y half is its mirror (y ↦ −y), which
 *   the fits add themselves, so the stringer points are not doubled.
 * - **Upper and lower side.** In each row the ring point of largest |y| (the
 *   classic rail's apex, sampled) splits the ring: the points after it are on
 *   the deck side, the points before it on the bottom side.
 * - **Apex, exactly** (step S7): the widest point of each row's section by a
 *   golden-section search over the ring fraction between the sampled apex's
 *   two neighbours (the loft is smooth there: the classic apex knot has
 *   vertical handles), run until the bracket stops shrinking in floating
 *   point. The apex height of §9.7 is read off it, not off the sampled ring
 *   point (one ring step is up to a millimetre of rail there).
 * - **Crease angles** (§9.2): at each real station the largest angle, over the
 *   ring fractions, between the loft's one-sided x-derivatives (difference
 *   quotients at ± `creaseProbe`: O(δ) truncation).
 *
 * Coordinates are the classic board's (tail at x = 0 of the classic outline);
 * the converter moves them into board2's frame itself.
 */
import {
  getLength,
  loftPoint,
  loftSection,
  ringFractions,
  surfaceStations,
} from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import type { ConvertOptions } from './types';

/** The classic loft's solid span and the floor zones outside it (classic x, cm). */
export interface ClassicFloors {
  readonly length: number;
  readonly span: readonly [number, number];
  /** `[0, span[0]]` and `[span[1], length]` where non-empty. */
  readonly zones: readonly (readonly [number, number])[];
}

/** {@link ClassicFloors} of a classic board (the kernel's own `solidSpan`, §9.2). */
export function classicFloors(board: BezierBoard): ClassicFloors {
  const length = getLength(board);
  const [a, b] = surfaceStations(board).span;
  const zones: (readonly [number, number])[] = [];
  if (a > 0) zones.push(Object.freeze([0, a] as const));
  if (b < length) zones.push(Object.freeze([b, length] as const));
  return Object.freeze({
    length,
    span: Object.freeze([a, b] as const),
    zones: Object.freeze(zones),
  });
}

/** The x of every real classic station (the dummies at 0 and the length excluded). */
export function classicStations(board: BezierBoard): readonly number[] {
  return Object.freeze(board.crossSections.slice(1, -1).map((cs) => cs.position));
}

/** Loft rows on the +y half (classic coordinates). */
export interface LoftSamples {
  /** Ring fractions, ascending from 0 (bottom centre) to 1 (deck centre). */
  readonly fractions: readonly number[];
  /** Row x, ascending. */
  readonly x: Float64Array;
  /** `y[r · nf + k]`, `z[r · nf + k]`: ring point k of row r (y ≥ 0). */
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Per row, the index of the largest y (the sampled classic apex). */
  readonly apex: Int32Array;
  /** Per row, the classic apex itself: its y and z (module comment). */
  readonly apexY: Float64Array;
  readonly apexZ: Float64Array;
}

/** Golden-section ratio (1/φ). */
const INV_PHI = (Math.sqrt(5) - 1) / 2;

/**
 * The widest point of the loft section `s` between ring fractions `a` and `b`
 * (module comment): golden-section search for the largest y, to the end of
 * floating point. Returns (y, z) in the board's coordinates (z with the rocker).
 */
function widestBetween(
  s: NonNullable<ReturnType<typeof loftSection>>,
  a: number,
  b: number,
): readonly [number, number] {
  const yAt = (f: number): number => loftPoint(s, f).x;
  let lo = a;
  let hi = b;
  let c = hi - INV_PHI * (hi - lo);
  let d = lo + INV_PHI * (hi - lo);
  let yc = yAt(c);
  let yd = yAt(d);
  while (c > lo && d < hi && c < d) {
    if (yc >= yd) {
      hi = d;
      d = c;
      yd = yc;
      c = hi - INV_PHI * (hi - lo);
      yc = yAt(c);
    } else {
      lo = c;
      c = d;
      yc = yd;
      d = lo + INV_PHI * (hi - lo);
      yd = yAt(d);
    }
  }
  const p = loftPoint(s, 0.5 * (lo + hi));
  return [p.x, p.y + s.rocker];
}

/** The row positions of §9.2: uniform at most `sampleSpacingX` apart across the span, plus station probes. */
export function loftRowPositions(
  board: BezierBoard,
  floors: ClassicFloors,
  opts: Pick<ConvertOptions, 'sampleSpacingX' | 'creaseProbe'>,
): readonly number[] {
  const [a, b] = floors.span;
  const n = Math.max(1, Math.ceil((b - a) / opts.sampleSpacingX));
  const xs: number[] = [];
  for (let k = 0; k <= n; k++) xs.push(k === n ? b : a + ((b - a) * k) / n);
  for (const s of classicStations(board)) {
    for (const x of [s - opts.creaseProbe, s + opts.creaseProbe]) if (x > a && x < b) xs.push(x);
  }
  xs.sort((p, q) => p - q);
  return Object.freeze(xs.filter((x, k) => k === 0 || x !== xs[k - 1]));
}

/**
 * The loft sampled at `xs` (rows where `loftSection` reports no section are
 * dropped; inside the solid span it always reports one).
 */
export function sampleLoft(
  board: BezierBoard,
  xs: readonly number[],
  opts: Pick<ConvertOptions, 'ringSamples'>,
): LoftSamples {
  const fractions = ringFractions(board, opts.ringSamples);
  const nf = fractions.length;
  const rx: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const apex: number[] = [];
  const apexY: number[] = [];
  const apexZ: number[] = [];
  for (const x of xs) {
    const s = loftSection(board, x);
    if (s === null) continue;
    let best = 0;
    let bestY = -Infinity;
    for (let k = 0; k < nf; k++) {
      const p = loftPoint(s, fractions[k]!);
      ys.push(p.x);
      zs.push(p.y + s.rocker);
      if (p.x > bestY) {
        bestY = p.x;
        best = k;
      }
    }
    rx.push(x);
    apex.push(best);
    const [ay, az] = widestBetween(
      s,
      fractions[Math.max(0, best - 1)]!,
      fractions[Math.min(nf - 1, best + 1)]!,
    );
    apexY.push(ay);
    apexZ.push(az);
  }
  return Object.freeze({
    fractions,
    x: Float64Array.from(rx),
    y: Float64Array.from(ys),
    z: Float64Array.from(zs),
    apex: Int32Array.from(apex),
    apexY: Float64Array.from(apexY),
    apexZ: Float64Array.from(apexZ),
  });
}

/** One loft point (y, z) at station x and ring fraction f; null where the loft has no section. */
function loftAt(board: BezierBoard, x: number, f: number): readonly [number, number] | null {
  const s = loftSection(board, x);
  if (s === null) return null;
  const p = loftPoint(s, f);
  return [p.x, p.y + s.rocker];
}

/**
 * The crease angle at every real station inside the solid span (§9.2): the
 * largest angle over the ring fractions between the one-sided x-derivatives
 * `(1, Δy, Δz)/δ` of the loft at `x ± creaseProbe`. A station whose probes
 * leave the solid span is skipped (its neighbourhood is a floor zone).
 */
export function creaseAngles(
  board: BezierBoard,
  floors: ClassicFloors,
  opts: Pick<ConvertOptions, 'ringSamples' | 'creaseProbe'>,
): readonly { readonly x: number; readonly angle: number }[] {
  const fractions = ringFractions(board, opts.ringSamples);
  const d = opts.creaseProbe;
  const out: { x: number; angle: number }[] = [];
  for (const x of classicStations(board)) {
    if (!(x - d >= floors.span[0] && x + d <= floors.span[1])) continue;
    let worst = 0;
    for (const f of fractions) {
      const a = loftAt(board, x - d, f);
      const m = loftAt(board, x, f);
      const b = loftAt(board, x + d, f);
      if (a === null || m === null || b === null) continue;
      const l = [d, m[0] - a[0], m[1] - a[1]] as const;
      const r = [d, b[0] - m[0], b[1] - m[1]] as const;
      const cx = l[1] * r[2] - l[2] * r[1];
      const cy = l[2] * r[0] - l[0] * r[2];
      const cz = l[0] * r[1] - l[1] * r[0];
      const angle = Math.atan2(Math.hypot(cx, cy, cz), l[0] * r[0] + l[1] * r[1] + l[2] * r[2]);
      if (angle > worst) worst = angle;
    }
    out.push(Object.freeze({ x, angle: worst }));
  }
  return Object.freeze(out);
}
