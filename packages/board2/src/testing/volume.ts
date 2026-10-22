// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An independent volume oracle for boards with a **flat deck and bottom**
 * (the stadium of `stadium.ts`; docs/design/board2.md §13.2 `brep`). Test-only.
 *
 * By the divergence theorem with the field `F = (0, 0, z)`, `V = ∮ z n_z dA`
 * over the closed skin. On the flat deck (z = `deckZ`, n = +ẑ) that is
 * `deckZ · A_d`, `A_d` the plan area inside the deck-edge row; on the flat
 * bottom (z = `bottomZ`, n = −ẑ) it is `−bottomZ · A_t` inside the tuck row; on
 * the band, whose outward normal is `−(S_u × S_v)/|S_u × S_v|` (§7), it is
 * `−∬ z (S_u × S_v)_z du dv` over the untrimmed parameter rectangle.
 *
 * Every integrand is a polynomial on each Bézier patch or span: `z (S_u × S_v)_z`
 * has degree at most 3 + 5 = 8 in each of u and v on the bicubic band (5
 * Gauss–Legendre points per direction are exact), and Green's `x y′ − y x′` has
 * degree 5 on a cubic row (3 points exact). So the oracle is exact to rounding
 * and shares nothing with geom's `massProperties` / `signedVolume` (trimmed
 * faces, pcurves, Green's theorem in (u, v), adaptive rules): only point and
 * first-derivative evaluation of the band and the rows. Its one geometric
 * assumption is the B-rep's: the deck and bottom faces are the regions inside
 * the rows' plan curves, which is what their exact pcurves trim (§3.4), so the
 * only difference from the solid is the boundary rows' z-fit gap.
 */
import {
  breakpoints,
  createScratch,
  curveEvalInto,
  gaussLegendre,
  surfaceEvalInto,
} from '@openshaper/geom';
import type { NurbsSurface, PeriodicCurve } from '@openshaper/geom';
import type { BuiltBoard } from '../types';

/** Breakpoints of one period `[t0, t0 + T]` of a periodic basis, or of a clamped domain. */
function spans(b: NurbsSurface['u']): [number, number][] {
  const br = Array.from(breakpoints(b));
  if (b.kind === 'periodic') br.push(b.domain[0] + b.period);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < br.length; k++) if (br[k + 1]! > br[k]!) out.push([br[k]!, br[k + 1]!]);
  return out;
}

/** `½ ∮ (x dy − y dx)` of a closed row's plan projection (Gauss–Legendre, exact per span). */
export function rowPlanArea(row: PeriodicCurve<3>): number {
  const gl = gaussLegendre(3);
  const sc = createScratch({ maxDegree: row.basis.degree, maxDerivs: 1 });
  const f = new Float64Array(6);
  let sum = 0;
  for (const [a, b] of spans(row.basis)) {
    const h = 0.5 * (b - a);
    for (let g = 0; g < gl.nodes.length; g++) {
      curveEvalInto(row, a + h * (gl.nodes[g]! + 1), 1, f, 0, sc);
      sum += gl.weights[g]! * h * 0.5 * (f[0]! * f[4]! - f[1]! * f[3]!);
    }
  }
  return sum;
}

/** The band's flux `∬ z (S_u × S_v)_z du dv` (Gauss–Legendre, exact per bicubic patch). */
export function bandZFlux(band: NurbsSurface): number {
  const gl = gaussLegendre(5);
  const sc = createScratch({ maxDegree: Math.max(band.u.degree, band.v.degree), maxDerivs: 1 });
  const f = new Float64Array(9);
  let sum = 0;
  for (const [ua, ub] of spans(band.u)) {
    const hu = 0.5 * (ub - ua);
    for (const [va, vb] of spans(band.v)) {
      const hv = 0.5 * (vb - va);
      for (let i = 0; i < gl.nodes.length; i++) {
        for (let j = 0; j < gl.nodes.length; j++) {
          surfaceEvalInto(
            band,
            ua + hu * (gl.nodes[i]! + 1),
            va + hv * (gl.nodes[j]! + 1),
            1,
            f,
            0,
            sc,
          );
          const cz = f[3]! * f[7]! - f[4]! * f[6]!;
          sum += gl.weights[i]! * gl.weights[j]! * hu * hv * f[2]! * cz;
        }
      }
    }
  }
  return sum;
}

/** The band's area `∬ |S_u × S_v|` by Gauss–Legendre of `n` points per patch direction (not exact: a bound input). */
export function bandArea(band: NurbsSurface, n: number): number {
  const gl = gaussLegendre(n);
  const sc = createScratch({ maxDegree: Math.max(band.u.degree, band.v.degree), maxDerivs: 1 });
  const f = new Float64Array(9);
  let sum = 0;
  for (const [ua, ub] of spans(band.u)) {
    const hu = 0.5 * (ub - ua);
    for (const [va, vb] of spans(band.v)) {
      const hv = 0.5 * (vb - va);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          surfaceEvalInto(
            band,
            ua + hu * (gl.nodes[i]! + 1),
            va + hv * (gl.nodes[j]! + 1),
            1,
            f,
            0,
            sc,
          );
          const cx = f[4]! * f[8]! - f[5]! * f[7]!;
          const cy = f[5]! * f[6]! - f[3]! * f[8]!;
          const cz = f[3]! * f[7]! - f[4]! * f[6]!;
          sum += gl.weights[i]! * gl.weights[j]! * hu * hv * Math.hypot(cx, cy, cz);
        }
      }
    }
  }
  return sum;
}

/** The oracle's parts and the volume of a flat-decked, flat-bottomed board (cm, cm², cm³). */
export interface FlatBoardVolume {
  readonly volume: number;
  /** Plan areas inside the deck-edge and tuck rows (the flat deck's and bottom's areas). */
  readonly deckArea: number;
  readonly bottomArea: number;
  /** The band's outward flux `−∬ z (S_u × S_v)_z`. */
  readonly bandFlux: number;
}

/** The module comment's oracle on a built board whose deck is the plane `deckZ` and bottom `bottomZ`. */
export function flatBoardVolume(
  b: Pick<BuiltBoard, 'band' | 'deckEdge' | 'tuck'>,
  deckZ: number,
  bottomZ: number,
): FlatBoardVolume {
  const deckArea = rowPlanArea(b.deckEdge);
  const bottomArea = rowPlanArea(b.tuck);
  const bandFlux = -bandZFlux(b.band);
  return {
    volume: deckZ * deckArea - bottomZ * bottomArea + bandFlux,
    deckArea,
    bottomArea,
    bandFlux,
  };
}
