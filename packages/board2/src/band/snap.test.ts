// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Boundary rows onto the surfaces (docs/design/board2.md §5.5, §13.2 `snap`).
 *
 * Oracles:
 * - **Edge gaps ≤ `Tolerances.fit`** (geom `edgeContinuity` on the built
 *   band), and **equal to independent sampling**: at every sample parameter of
 *   the gap profile, the distance between the boundary row and the height field
 *   evaluated at the row's own (x, y) (the vertical error, since the row's x and
 *   y are exact) equals the profile's gap within 1e-12 × scale.
 * - **x, y exact, z only**: the boundary rows' x, y are bitwise the column
 *   construction's (the snap touches z alone).
 * - **Handle vectors unchanged**: row 1 − row 0 and row 5 − row 6 equal the
 *   construction's vectors within 1e-12 × scale (both rows moved by one Δz).
 * - **Refinement for a tighter fit**: with `fit` 1e-7 cm the crowned board
 *   refines (more columns) until both gaps are within it, or reports
 *   `not-converged`, never a silent miss.
 */
import { controlPointsInto, curvePoint, resolveTolerances } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { stadiumBoard } from '../testing/index';
import type { BoardDoc } from '../types';
import { bandContext, buildBand, columnAt } from './band';
import type { BandBuild } from './band';

const ROWS = 7;

function built(doc: BoardDoc): BandBuild {
  const r = buildBand(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const crowned = (): BoardDoc => stadiumBoard({ crown: 1.5, rocker: 8 });

describe('snap: rows 0 and 6 onto the deck and the bottom', () => {
  it('gaps within fit, equal to an independent measurement at the same parameters', () => {
    const doc = crowned();
    const b = built(doc);
    const ctx = bandContext(doc);
    const fit = resolveTolerances(doc.build.tolerances).fit;
    for (const [row, prof, at] of [
      [b.deckEdge, b.measure.deckJoin, ctx.deckAt],
      [b.tuck, b.measure.tuckJoin, ctx.bottomAt],
    ] as const) {
      expect(prof.max.gap).toBeLessThanOrEqual(fit);
      expect(prof.max.gap).toBeGreaterThan(0);
      let worst = 0;
      for (let j = 0; j < prof.t.length; j++) {
        const p = curvePoint(row, prof.t[j]!);
        const d = Math.abs(p.z - at(p.x, p.y).z);
        worst = Math.max(worst, d);
        expect(Math.abs(d - prof.gap[j]!)).toBeLessThanOrEqual(1e-12 * 200);
      }
      expect(worst).toBeLessThanOrEqual(prof.max.gap);
      expect(worst).toBeGreaterThan(0.5 * prof.max.gap);
    }
  });

  it('x, y untouched and the handle vectors kept', () => {
    const doc = crowned();
    const b = built(doc);
    const ctx = bandContext(doc);
    const n = b.band.u.count;
    const apex = new Float64Array(n * 2);
    controlPointsInto(b.basis.apexPlan, apex, 0);
    for (let i = 0; i < n; i++) {
      const c = b.pass.columns[i]!;
      if (c.role === 'partner') continue;
      const col = columnAt(ctx, apex[2 * i]!, apex[2 * i + 1]!, c.frame, c.u, c.sigma).profile
        .points;
      // The band is polynomial: its homogeneous net holds x, y, z with w = 1.
      const p = (r: number) => {
        const q = b.band.cw;
        const o = (i * ROWS + r) * 4;
        return [q[o]!, q[o + 1]!, q[o + 2]!] as const;
      };
      for (const r of [0, 6]) {
        expect(p(r)[0]).toBe(col[3 * r]);
        expect(p(r)[1]).toBe(col[3 * r + 1]);
      }
      for (const [edge, handle] of [
        [0, 1],
        [6, 5],
      ] as const) {
        for (let k = 0; k < 3; k++) {
          const built = p(handle)[k]! - p(edge)[k]!;
          const designed = col[3 * handle + k]! - col[3 * edge + k]!;
          expect(
            Math.abs(built - designed),
            `column ${i} rows ${edge}/${handle}`,
          ).toBeLessThanOrEqual(1e-12 * 200);
        }
      }
    }
  });

  it('a tighter fit refines the band until the edges meet it', () => {
    const doc: BoardDoc = {
      ...crowned(),
      build: { ...crowned().build, tolerances: { fit: 1e-7 } },
    };
    const loose = built(crowned());
    const b = built(doc);
    const converged = !b.report.issues.some((i) => i.code === 'not-converged');
    if (converged) {
      expect(b.report.edgeGaps.deckEdge).toBeLessThanOrEqual(1e-7);
      expect(b.report.edgeGaps.tuck).toBeLessThanOrEqual(1e-7);
    }
    expect(converged).toBe(true);
    expect(b.basis.basis.count).toBeGreaterThan(loose.basis.basis.count);
    expect(b.report.refinePasses).toBeGreaterThan(0);
  });
});
