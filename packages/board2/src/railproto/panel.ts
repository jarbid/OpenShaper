// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The panel half of the trim-and-blend study (`docs/design/trim-blend-test.md`): a deck or
 * bottom as a height field, and a section assembled from that field plus a forward blend.
 * Scratch module: the engine never imports it.
 *
 * A panel is `z(u, eta)`: `u` the position along the board normalised to [0, 1], `eta` the
 * distance from the stringer over the outline's half width, so the field is defined out to
 * the outline whatever the rail does. It is a tensor-product cubic B-spline with
 * `nx` by `ny` control points, fitted by least squares to the section inboard of the band
 * edge and to that panel's own tangent carried on to the wall. The extension is the
 * "overbuilt" part: it gives the blend a tangent to leave from and keeps the fit well posed
 * where the rail has replaced the data.
 */
import { conicPolyline, deviation, at } from './rail-geom';
import type { Conic, Deviation, RealSection } from './rail-geom';
import type { Half } from './rail-fit';
import { lawBasis } from './rail-laws';
import { FWD_NO_BLEND } from './forward';

/** Samples of the panel in an assembled section. */
export const PANEL_SAMPLES = 160;
/** Samples of a panel's tangent extension from the band edge to the wall, per station. */
export const PANEL_EXTENSION = 12;
/** Ridge on the normal equations, relative to their largest diagonal entry. */
export const PANEL_RIDGE = 1e-10;
/** Half step of the slope's finite difference at the band edge, cm. */
export const PANEL_SLOPE_STEP = 0.02;
const PIVOT = 1e-300;

export interface PanelField {
  readonly nx: number;
  readonly ny: number;
  readonly coef: Float64Array;
}

export interface PanelSample {
  readonly u: number;
  readonly eta: number;
  readonly z: number;
}

/** Least-squares fit of a panel field to samples. */
export function fitPanel(samples: readonly PanelSample[], nx: number, ny: number): PanelField {
  const n = nx * ny;
  const a = new Float64Array(n * (n + 1));
  const row = new Float64Array(n);
  for (const s of samples) {
    const bx = lawBasis(nx, Math.min(1, Math.max(0, s.u)));
    const by = lawBasis(ny, Math.min(1, Math.max(0, s.eta)));
    row.fill(0);
    const cols: number[] = [];
    for (let i = 0; i < nx; i++) {
      if (bx[i] === 0) continue;
      for (let j = 0; j < ny; j++) {
        if (by[j] === 0) continue;
        row[i * ny + j] = bx[i]! * by[j]!;
        cols.push(i * ny + j);
      }
    }
    for (const p of cols) {
      const rp = row[p]!;
      for (const q of cols) a[p * (n + 1) + q]! += rp * row[q]!;
      a[p * (n + 1) + n]! += rp * s.z;
    }
  }
  let big = 0;
  for (let i = 0; i < n; i++) big = Math.max(big, a[i * (n + 1) + i]!);
  for (let i = 0; i < n; i++) a[i * (n + 1) + i]! += PANEL_RIDGE * big;
  // Gaussian elimination with partial pivoting on the augmented system.
  const w = n + 1;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(a[r * w + c]!) > Math.abs(a[piv * w + c]!)) piv = r;
    if (piv !== c) {
      for (let j = c; j < w; j++) {
        const t = a[c * w + j]!;
        a[c * w + j] = a[piv * w + j]!;
        a[piv * w + j] = t;
      }
    }
    const d = a[c * w + c]!;
    if (Math.abs(d) < PIVOT) continue;
    for (let r = c + 1; r < n; r++) {
      const f = a[r * w + c]! / d;
      if (f === 0) continue;
      for (let j = c; j < w; j++) a[r * w + j]! -= f * a[c * w + j]!;
    }
  }
  const coef = new Float64Array(n);
  for (let c = n - 1; c >= 0; c--) {
    let v = a[c * w + n]!;
    for (let j = c + 1; j < n; j++) v -= a[c * w + j]! * coef[j]!;
    const d = a[c * w + c]!;
    coef[c] = Math.abs(d) < PIVOT ? 0 : v / d;
  }
  return { nx, ny, coef };
}

/** The field's height at `(u, eta)`. */
export function panelAt(f: PanelField, u: number, eta: number): number {
  const bx = lawBasis(f.nx, Math.min(1, Math.max(0, u)));
  const by = lawBasis(f.ny, Math.min(1, Math.max(0, eta)));
  let v = 0;
  for (let i = 0; i < f.nx; i++) {
    if (bx[i] === 0) continue;
    for (let j = 0; j < f.ny; j++) v += bx[i]! * by[j]! * f.coef[i * f.ny + j]!;
  }
  return v;
}

/**
 * The samples one station's half gives a panel fit: the section from the stringer to the
 * band edge at fractional index `edge`, then the panel's tangent carried on to the wall.
 * `edge < 0` means there is no blend and the panel is the whole half.
 */
export function panelSamples(s: RealSection, half: Half, u: number, edge: number): PanelSample[] {
  const out: PanelSample[] = [];
  const apex = at(s, s.apex);
  const chord = apex[0];
  const centre = half === 'bottom' ? 0 : s.count - 1;
  const stop = edge < 0 ? s.apex : edge;
  const lo = Math.ceil(Math.min(centre, stop));
  const hi = Math.floor(Math.max(centre, stop));
  for (let i = lo; i <= hi; i++) out.push({ u, eta: s.pts[2 * i]! / chord, z: s.pts[2 * i + 1]! });
  if (edge < 0) return out;
  // tangent extension from the last panel sample to the wall
  const k = half === 'bottom' ? hi : lo;
  const sign = half === 'bottom' ? 1 : -1;
  const dy = sign * s.tan[2 * k]!;
  const dz = sign * s.tan[2 * k + 1]!;
  const y0 = s.pts[2 * k]!;
  const z0 = s.pts[2 * k + 1]!;
  if (dy > 0 && chord > y0) {
    for (let g = 1; g <= PANEL_EXTENSION; g++) {
      const y = y0 + ((chord - y0) * g) / PANEL_EXTENSION;
      out.push({ u, eta: y / chord, z: z0 + ((y - y0) * dz) / dy });
    }
  }
  return out;
}

export interface Assembled {
  readonly dev: Deviation;
  /** The blend had to fall back to a straight bevel: the panel's tangent overshoots the apex. */
  readonly bevel: boolean;
}

/** The panel part of an assembled half: fixed once the band width is, whatever the blend does. */
export interface PanelEdge {
  readonly panel: Float64Array;
  readonly yE: number;
  readonly zE: number;
  /** Height where the panel's tangent meets the wall. */
  readonly g1: number;
  /** Height of the field at the wall itself. */
  readonly zWall: number;
  readonly blendless: boolean;
}

export function panelEdge(s: RealSection, field: PanelField, u: number, width: number): PanelEdge {
  const chord = at(s, s.apex)[0];
  const blendless = width < FWD_NO_BLEND;
  const yE = blendless ? chord : Math.max(0, chord - width);
  const z = (y: number): number => panelAt(field, u, y / chord);
  const panel = new Float64Array(2 * (PANEL_SAMPLES + 1));
  for (let i = 0; i <= PANEL_SAMPLES; i++) {
    const y = (yE * i) / PANEL_SAMPLES;
    panel[2 * i] = y;
    panel[2 * i + 1] = z(y);
  }
  const zE = panel[2 * PANEL_SAMPLES + 1]!;
  const m = (z(yE + PANEL_SLOPE_STEP) - z(yE - PANEL_SLOPE_STEP)) / (2 * PANEL_SLOPE_STEP);
  return { panel, yE, zE, g1: zE + (chord - yE) * m, zWall: z(chord), blendless };
}

/**
 * One half of a section built forward — the panel field to the band edge, then a blend with
 * the given edge fraction and shape to the apex — and its deviation from the real half. The
 * apex is read from the section, as in both earlier studies.
 */
export function assembleHalf(
  s: RealSection,
  half: Half,
  pe: PanelEdge,
  e: number,
  rho: number,
): Assembled {
  const apex = at(s, s.apex);
  const chord = apex[0];
  const panel = pe.panel;
  let rail: Float64Array;
  let bevel = false;
  if (pe.blendless) {
    // the panel runs to the wall: a hard edge. Close any gap to the apex with the wall itself.
    rail = Float64Array.of(chord, pe.zWall, apex[0], apex[1]);
  } else {
    const up = half === 'bottom' ? 1 : -1;
    bevel = up * (apex[1] - pe.g1) <= 0;
    const z1 = bevel ? apex[1] : pe.g1 + e * (apex[1] - pe.g1);
    const conic: Conic = { p0: [pe.yE, pe.zE], p1: [chord, z1], p2: apex, rho };
    rail = conicPolyline(conic);
  }
  const model = new Float64Array(panel.length + rail.length);
  if (half === 'bottom') {
    model.set(panel, 0);
    model.set(rail, panel.length);
    return { dev: deviation(s, 0, s.apex, model), bevel };
  }
  // deck: apex -> band edge -> stringer, the section's own direction
  const nr = rail.length / 2;
  for (let i = 0; i < nr; i++) {
    model[2 * i] = rail[2 * (nr - 1 - i)]!;
    model[2 * i + 1] = rail[2 * (nr - 1 - i) + 1]!;
  }
  for (let i = 0; i <= PANEL_SAMPLES; i++) {
    model[rail.length + 2 * i] = panel[2 * (PANEL_SAMPLES - i)]!;
    model[rail.length + 2 * i + 1] = panel[2 * (PANEL_SAMPLES - i) + 1]!;
  }
  return { dev: deviation(s, s.apex, s.count - 1, model), bevel };
}
