// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail band builder (docs/design/board2.md §3.5, §5.4, §6.3, §13.2 `band`,
 * `offsets`; the S3 exit checks of §14).
 *
 * Boards: the stadium (flat), the crowned stadium (a quadratic dome across the
 * deck and an 8 cm rocker on deck and bottom, exact bicubics), the sample
 * document (a tight eight-point loop, sloped single-patch surfaces, offsets),
 * and the notched loop built directly (bypassing the validator, §3.8).
 *
 * Oracles and tolerances:
 * - **Apex normal angle** along the whole apex, from both sides of v = ½, at
 *   2,000 parameters per board: ≤ 1e-9 rad (unit normals in double precision;
 *   the construction is exact, so this is rounding, far below 0.1°).
 * - **Outline invariance**: law and offset changes leave the apex row's x, y
 *   bitwise equal on the same basis, and on any basis they are bitwise the plan
 *   refined to it (`bandBasis`). **Rocker invariance**: the deck and bottom
 *   nets and the stringer lines are bitwise unchanged.
 * - **Tuck crease = law**: on the stadium's straight stretch the measured
 *   station-plane crease at each column equals `h · φ_chord` to 1e-12 rad, for
 *   several hardness values; elsewhere the report's `tuckCreaseError` is
 *   bounded and falls O(h²) with refinement.
 * - **Deck join**: ≤ `deckJoinAngleTol` after the build, and converging O(h²)
 *   before refinement under uniform halving (crowned stadium; measured ratios
 *   3.06, 3.35, 3.66 → 4, the test needs ≥ 2.9 and the last ≥ 3.5).
 * - **Fidelity met**: the sample board needs refinement (its first pass misses
 *   by 30×) and converges within `maxBandRefinePasses`: every lane within
 *   `lawTolerance`, no `not-converged`; with no refinement allowed the miss is
 *   a `not-converged` warning at the worst span, never silent.
 * - **No degenerate normal** on a 400 × 41 grid of every board.
 * - **Mirror overwrite removes rounding only**: the symmetric build with the
 *   overwrite off differs by ≤ 1e-12 × scale.
 * - **Measured laws at stations**: `measureLaws` at the columns of the
 *   stadium's straight stretch returns the built laws (1e-12; insets
 *   1e-12 × scale).
 * - **Offsets**: the zero layer is the identity (bitwise); a handle offset
 *   moves its row by its value in the column's frame before and after a law
 *   change (1e-12 × scale), and never the apex row (bitwise).
 * - **Determinism and immutability**: the same frozen document builds the same
 *   bits twice and is unchanged.
 */
import {
  controlPointsInto,
  SAMPLE_DEGENERATE,
  surfaceControlPoint,
  surfaceNormal,
} from '@openshaper/geom';
import type { NurbsSurface } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../freeze';
import { stringerLines } from '../height-field';
import { measureLaws } from './profile';
import { DEFAULT_RAIL_LAWS, RAIL_LANES } from '../params';
import { constantLaw, notchedBoard, sampleDoc, stadiumBoard, stadiumFacts } from '../testing/index';
import type { BoardDoc, OffsetLayer, RailLane } from '../types';
import { apexAngleAt, bandContext, buildBand, tuckCreaseAt } from './band';
import type { BandBuild } from './band';
import { bandBasis } from './stations';

const ROWS = 7;

function built(doc: BoardDoc, opts: Parameters<typeof buildBand>[1] = {}): BandBuild {
  const r = buildBand(doc, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function net(s: NurbsSurface): Float64Array {
  const out = new Float64Array(s.u.count * s.v.count * 3);
  for (let i = 0; i < s.u.count; i++) {
    for (let j = 0; j < s.v.count; j++) {
      const p = surfaceControlPoint(s, i, j);
      out.set([p.x, p.y, p.z], (i * s.v.count + j) * 3);
    }
  }
  return out;
}

function row(s: NurbsSurface, r: number): Float64Array {
  const n = net(s);
  const out = new Float64Array(s.u.count * 3);
  for (let i = 0; i < s.u.count; i++)
    out.set(n.subarray((i * ROWS + r) * 3, (i * ROWS + r) * 3 + 3), i * 3);
  return out;
}

const withLaws = (doc: BoardDoc, laws: Partial<Record<RailLane, number>>): BoardDoc => ({
  ...doc,
  laws: {
    ...doc.laws,
    ...Object.fromEntries(Object.entries(laws).map(([k, v]) => [k, constantLaw(v)])),
  },
});

const crowned = (): BoardDoc => stadiumBoard({ crown: 1.5, rocker: 8 });

describe('buildBand: the invariants of §3.5', () => {
  const boards: readonly (readonly [string, () => BoardDoc])[] = [
    ['stadium', () => stadiumBoard()],
    ['crowned', crowned],
    ['sample', sampleDoc],
    ['notched', notchedBoard],
  ];
  for (const [name, make] of boards) {
    it(`${name}: the apex join is G1 to rounding everywhere, and no band normal is degenerate`, () => {
      const r = buildBand(make());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const b = r.value;
      let worst = 0;
      for (let k = 0; k < 2000; k++) worst = Math.max(worst, apexAngleAt(b.band, k / 2000));
      expect(worst).toBeLessThanOrEqual(1e-9);
      expect(b.report.apexJoinAngle).toBeLessThanOrEqual(1e-9);
      let degenerate = 0;
      for (let i = 0; i < 400; i++) {
        for (let j = 0; j <= 40; j++) {
          const n = surfaceNormal(b.band, i / 400, j / 40);
          if (n.kind === 'degenerate') degenerate++;
        }
      }
      expect(degenerate).toBe(0);
      expect(SAMPLE_DEGENERATE).toBeGreaterThan(0);
      expect(b.measure.deckJoin.degenerate + b.measure.tuckJoin.degenerate).toBe(0);
    });
  }

  it('the apex normal is horizontal: the apex row is the plan silhouette', () => {
    const b = built(crowned());
    for (let k = 0; k < 500; k++) {
      const n = surfaceNormal(b.band, k / 500, 0.5);
      expect(n.kind).toBe('regular');
      if (n.kind === 'regular') expect(Math.abs(n.n.z)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('outline invariance: laws and offsets never move the apex row in plan (bitwise)', () => {
    const doc = crowned();
    const a = built(doc, { maxPasses: 0 });
    const offsets: OffsetLayer = {
      basis: { degree: 3, knots: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875] },
      rows: [
        { row: 'deckEdge', values: [0, 0.2, 0.3, 0.1, 0, 0.1, 0.3, 0.2] },
        { row: 'deckHandle', values: [0.1, 0.1, 0.2, 0.2, 0.1, 0.2, 0.2, 0.1] },
        { row: 'apexUpper', values: [0.05, 0, 0.1, 0, 0.05, 0, 0.1, 0] },
        { row: 'apexLower', values: [-0.05, 0, -0.1, 0, -0.05, 0, -0.1, 0] },
        {
          row: 'tuckHandle',
          values: [0, 0.1, 0.1, 0.2, 0.1, 0, 0.2, 0.1, 0, 0.1, 0.2, 0, 0.1, 0.1, 0, 0],
        },
        { row: 'tuck', values: [0, -0.1, 0.2, 0, 0.1, 0, 0.2, -0.1] },
      ],
    };
    const variants: BoardDoc[] = [
      withLaws(doc, { apexHeight: 0.3, upperFullness: 0.8, lowerFullness: 0.5, edgeHardness: 0.9 }),
      withLaws(doc, { deckInset: 4, tuckInset: 1.5 }),
      { ...doc, offsets },
    ];
    const xy = (s: NurbsSurface): number[] => {
      const r3 = row(s, 3);
      return Array.from(r3).filter((_, k) => k % 3 !== 2);
    };
    for (const v of variants) {
      const b = built(v, { maxPasses: 0 });
      expect(Array.from(b.basis.basis.knots)).toEqual(Array.from(a.basis.basis.knots));
      expect(xy(b.band)).toEqual(xy(a.band));
      // Rocker invariance: deck and bottom untouched, stringer lines bitwise.
      expect(b.deck.cw).toEqual(a.deck.cw);
      expect(b.bottom.cw).toEqual(a.bottom.cw);
      const la = stringerLines(a);
      const lb = stringerLines(b);
      expect(lb.rocker.cw).toEqual(la.rocker.cw);
      expect(lb.deck.cw).toEqual(la.deck.cw);
    }
    // With refinement the basis may differ; the apex row is still the plan refined to it.
    for (const v of [sampleDoc(), withLaws(sampleDoc(), { deckInset: 3 })]) {
      const b = built(v);
      const ctx = bandContext(v);
      const ref = bandBasis(ctx.plan, b.basis.inserted, true);
      const p = new Float64Array(ref.basis.count * 2);
      controlPointsInto(ref.apexPlan, p, 0);
      expect(xy(b.band)).toEqual(Array.from(p));
    }
  });
});

describe('buildBand: the tuck crease, the deck join, fidelity', () => {
  it('tuck crease = h · φ_chord on the straight stretch (several hardness values)', () => {
    const f = stadiumFacts();
    for (const h of [0, 0.3, 0.7, 1]) {
      const doc = withLaws(stadiumBoard(), { edgeHardness: h });
      const b = built(doc);
      const ctx = bandContext(doc);
      let n = 0;
      b.pass.columns.forEach((c, i) => {
        const p = surfaceControlPoint(b.band, i, 3);
        if (!(p.x > f.straight[0] + 30 && p.x < f.straight[1] - 30)) return;
        n++;
        const measured = tuckCreaseAt(b.band, ctx.bottomAt, c.frame, c.u);
        // φ_chord on the flat stadium (s_b = 0): the handle chord P4 − T of the column.
        const q = net(b.band).subarray(i * ROWS * 3, (i + 1) * ROWS * 3);
        const wt = DEFAULT_RAIL_LAWS.tuckInset;
        const phi = Math.atan2(q[14]! - q[20]!, wt);
        expect(Math.abs(measured - h * phi), `h ${h} column ${i}`).toBeLessThanOrEqual(1e-12);
      });
      expect(n).toBeGreaterThan(10);
      expect(b.report.tuckCreaseError).toBeLessThanOrEqual(0.01);
    }
  });

  it('deck join within deckJoinAngleTol after the build; O(h²) before refinement', () => {
    const doc = crowned();
    const b = built(doc);
    expect(b.report.deckJoinAngle).toBeGreaterThan(0);
    expect(b.report.deckJoinAngle).toBeLessThanOrEqual(doc.build.deckJoinAngleTol);
    const angles: number[] = [];
    const crease: number[] = [];
    for (let lev = 0; lev < 4; lev++) {
      const r = built(doc, { maxPasses: 0, uniformRefinements: lev });
      angles.push(r.report.deckJoinAngle);
      crease.push(r.report.tuckCreaseError);
    }
    const ratios = angles.slice(1).map((a, k) => angles[k]! / a);
    for (const q of ratios) expect(q).toBeGreaterThanOrEqual(2.9);
    expect(ratios[ratios.length - 1]!).toBeGreaterThanOrEqual(3.5);
    for (let k = 1; k < crease.length; k++) expect(crease[k]!).toBeLessThan(crease[k - 1]!);
  });

  it('fidelity: the sample board refines until every lane is within lawTolerance', () => {
    const doc = sampleDoc();
    const first = built(doc, { maxPasses: 0 });
    expect(first.measure.score).toBeGreaterThan(10);
    const nc = first.report.issues.filter((i) => i.code === 'not-converged');
    expect(nc).toHaveLength(1);
    expect(nc[0]!.severity).toBe('warning');
    expect(nc[0]!.at?.u).toBeTypeOf('number');
    const b = built(doc);
    expect(b.report.refinePasses).toBeGreaterThan(0);
    expect(b.report.refinePasses).toBeLessThanOrEqual(doc.build.maxBandRefinePasses);
    expect(b.report.issues).toEqual([]);
    for (const lane of RAIL_LANES) {
      expect(b.report.lawFidelity[lane], lane).toBeLessThanOrEqual(doc.build.lawTolerance[lane]);
    }
    expect(b.basis.basis.count).toBeGreaterThan(first.basis.basis.count);
    // Edge gaps: the z-fits, within Tolerances.fit.
    expect(b.report.edgeGaps.deckEdge).toBeLessThanOrEqual(1e-4);
    expect(b.report.edgeGaps.tuck).toBeLessThanOrEqual(1e-4);
  });

  it('measureLaws returns the built laws at the columns of the straight stretch', () => {
    const f = stadiumFacts();
    const doc = withLaws(stadiumBoard(), {
      apexHeight: 0.35,
      upperFullness: 0.7,
      edgeHardness: 0.6,
    });
    const b = built(doc);
    const parts = { doc, plan: bandContext(doc).plan, band: b.band, bottom: b.bottom };
    let n = 0;
    b.stations.forEach((s, i) => {
      const p = surfaceControlPoint(b.band, i, 3);
      if (!(p.x > f.straight[0] + 30 && p.x < f.straight[1] - 30)) return;
      n++;
      const m = measureLaws(parts, s.u);
      for (const lane of RAIL_LANES) {
        const tol = lane.endsWith('Inset') ? 1e-12 * 200 : 1e-12;
        expect(Math.abs(m[lane] - s.laws[lane]), `${lane} at column ${i}`).toBeLessThanOrEqual(tol);
      }
    });
    expect(n).toBeGreaterThan(10);
  });
});

describe('buildBand: symmetry, offsets, determinism', () => {
  it('the mirror overwrite only removes rounding (1e-12 × scale)', () => {
    for (const doc of [crowned(), sampleDoc()]) {
      const on = net(built(doc, { maxPasses: 0 }).band);
      const off = net(built(doc, { maxPasses: 0, mirrorOverwrite: false }).band);
      let scale = 0;
      let diff = 0;
      for (let k = 0; k < on.length; k++) {
        scale = Math.max(scale, Math.abs(on[k]!));
        diff = Math.max(diff, Math.abs(on[k]! - off[k]!));
      }
      expect(diff).toBeGreaterThan(0);
      expect(diff).toBeLessThanOrEqual(1e-12 * scale);
    }
  });

  it('the zero offset layer is the identity, bitwise', () => {
    const doc = crowned();
    const zero: OffsetLayer = {
      basis: { degree: 3, knots: [0, 0.25, 0.5, 0.75] },
      rows: [
        { row: 'deckEdge', values: [0, 0, 0, 0] },
        { row: 'deckHandle', values: [0, 0, 0, 0] },
        { row: 'apexUpper', values: [0, 0, 0, 0] },
        { row: 'apexLower', values: [0, 0, 0, 0] },
        { row: 'tuckHandle', values: [0, 0, 0, 0, 0, 0, 0, 0] },
        { row: 'tuck', values: [0, 0, 0, 0] },
      ],
    };
    expect(net(built({ ...doc, offsets: zero }).band)).toEqual(net(built(doc).band));
  });

  it('a handle offset moves its row by its value in the column frame, before and after a law change', () => {
    const c = 0.25;
    const layer = (r: 'apexUpper' | 'apexLower' | 'deckHandle'): OffsetLayer => ({
      basis: { degree: 3, knots: [0, 0.25, 0.5, 0.75] },
      rows: [{ row: r, values: [c, c, c, c] }],
    });
    for (const base of [crowned(), withLaws(crowned(), { upperFullness: 0.9, apexHeight: 0.3 })]) {
      const plain = built(base, { maxPasses: 0 });
      const a = net(plain.band);
      for (const [name, r] of [
        ['apexUpper', 2],
        ['apexLower', 4],
        ['deckHandle', 1],
      ] as const) {
        const moved = net(built({ ...base, offsets: layer(name) }, { maxPasses: 0 }).band);
        for (let i = 0; i < plain.band.u.count; i++) {
          const o = (i * ROWS + r) * 3;
          const d = [moved[o]! - a[o]!, moved[o + 1]! - a[o + 1]!, moved[o + 2]! - a[o + 2]!];
          if (name === 'deckHandle') {
            // Along the deck handle's own direction, by c.
            const p0 = i * ROWS * 3;
            const t = [a[o]! - a[p0]!, a[o + 1]! - a[p0 + 1]!, a[o + 2]! - a[p0 + 2]!];
            const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
            for (let k = 0; k < 3; k++) {
              expect(Math.abs(d[k]! - (c * t[k]!) / tl)).toBeLessThanOrEqual(1e-12 * 250);
            }
          } else {
            expect(d[0]).toBe(0);
            expect(d[1]).toBe(0);
            expect(Math.abs(d[2]! - c)).toBeLessThanOrEqual(1e-12 * 250);
          }
          // Every other row, the apex row included, is bitwise untouched.
          for (let rr = 0; rr < ROWS; rr++) {
            if (rr === r) continue;
            const q = (i * ROWS + rr) * 3;
            expect(moved.subarray(q, q + 3)).toEqual(a.subarray(q, q + 3));
          }
        }
      }
    }
  });

  it('the same frozen document builds the same bits twice and is not changed', () => {
    const doc = deepFreeze(sampleDoc());
    const text = JSON.stringify(doc);
    const a = built(doc);
    const b = built(doc);
    expect(net(b.band)).toEqual(net(a.band));
    expect(JSON.stringify(doc)).toBe(text);
  });
});
