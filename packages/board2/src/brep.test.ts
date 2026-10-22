// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board's B-rep, `buildBoard` and STEP (docs/design/board2.md §4, §7, §13.2
 * `brep`; step S4's exit check).
 *
 * - **Topology**: geom's `checkBrep` accepts the board, Euler–Poincaré holds with
 *   V = 2, E = 3, F = 3, L = 3 (χ = 2, genus 0), on the stadium, a crowned and
 *   rockered stadium, the sample board and, built directly past the validator,
 *   the notched loop (§3.8: nothing below the validator slices by x).
 * - **Orientation as designed**: the faces' `sameSense` are deck true, band and
 *   bottom false (§7), and `orientBrep` confirms them (no flip; the build no
 *   longer calls it, S7: `checkBrep` refuses an inside-out shell); the volume is
 *   positive.
 * - **Volume against an independent oracle** (`testing/volume.ts`): on the flat
 *   stadium the divergence theorem with `F = (0, 0, z)` reduces to the plan area
 *   inside the deck-edge row times the deck height plus the band's polynomial
 *   flux, integrated exactly by Gauss–Legendre with point evaluations only;
 *   geom's `massProperties` (trimmed faces, pcurves, adaptive rules) must agree
 *   within 1e-10 relative (the edge gaps of 1e-13 cm leak ~1e-13 relative; the
 *   rest is rounding).
 * - **geom's mutation catalogue on boards**: every defect `MUTATIONS` injects is
 *   refused by the layer it names (`makeBrep` for structural ones, `checkBrep`
 *   for geometric and orientation ones), on the stadium and the notched loop.
 * - **Edges**: the gaps `checkBrep` measures are the build report's, ≤ `fit`,
 *   and equal to an independent measurement of `|row(t) − F(row.xy(t))|`
 *   (dense sampling, then golden-section on the bracket of the largest sample)
 *   within 1e-12 × the board's thickness (§13.2 `snap`).
 * - **STEP**: `writeBoardStep` writes three faces, three edges, two vertices;
 *   geom's subset reader reads it back into a solid `checkBrep` accepts.
 */
import {
  breakpoints,
  checkBrep,
  curvePoint,
  makeBrep,
  massProperties,
  orientBrep,
  resolveTolerances,
  surfacePoint,
} from '@openshaper/geom';
import { MUTATIONS, readStepSubset } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { buildBoard, assembleBoard } from './build';
import { writeBoardStep } from './brep';
import { flatBoardVolume, notchedBoard, sampleDoc, stadiumBoard } from './testing';
import type { BoardDoc, BuiltBoard } from './types';

const TOL = resolveTolerances();

function built(doc: BoardDoc, direct = false): BuiltBoard {
  const r = direct ? assembleBoard(doc) : buildBoard(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.issues.map((i) => i.message)));
  return r.value;
}

const BOARDS: readonly (readonly [string, () => BuiltBoard])[] = [
  ['stadium', () => built(stadiumBoard())],
  ['crowned and rockered stadium', () => built(stadiumBoard({ crown: 1, rocker: 5 }))],
  ['sample board', () => built(sampleDoc())],
  ['notched loop (validator bypassed)', () => built(notchedBoard(), true)],
];

describe('the board B-rep: checkBrep, Euler–Poincaré, orientation', () => {
  for (const [name, make] of BOARDS) {
    it(`${name}: three faces, three edges, two vertices; χ = 2; outward as designed`, () => {
      const b = make();
      const c = checkBrep(b.brep, b.doc.build.tolerances);
      expect(c.ok, JSON.stringify(c.issues)).toBe(true);
      expect(c.euler).toMatchObject({ V: 2, E: 3, F: 3, L: 3, S: 1, G: 0, holds: true });
      expect(c.euler.V - c.euler.E + c.euler.F - (c.euler.L - c.euler.F)).toBe(2);
      expect(c.signedVolume).toBeGreaterThan(0);
      // §7's senses, with no flip by orientBrep.
      expect(orientBrep(b.brep, b.doc.build.tolerances)).toBe(b.brep);
      expect(b.faces).toEqual({ deck: 0, band: 1, bottom: 2 });
      expect(b.brep.faces.map((f) => f.sameSense)).toEqual([true, false, false]);
      expect(b.brep.faces[b.faces.band]!.surface).toBe(b.band);
      expect(b.brep.faces[b.faces.deck]!.surface).toBe(b.deck);
      expect(b.brep.faces[b.faces.bottom]!.surface).toBe(b.bottom);
      // The seam runs from the deck edge to the tuck at the band's domain start.
      const t0 = b.band.u.domain[0];
      const [vd, vt] = b.brep.vertices;
      const pd = curvePoint(b.deckEdge, t0);
      const pt = curvePoint(b.tuck, t0);
      expect(Math.hypot(vd!.point.x - pd.x, vd!.point.y - pd.y, vd!.point.z - pd.z)).toBeLessThan(
        1e-12 * 200,
      );
      expect(Math.hypot(vt!.point.x - pt.x, vt!.point.y - pt.y, vt!.point.z - pt.z)).toBeLessThan(
        1e-12 * 200,
      );
      // The report's edge gaps are checkBrep's, within fit.
      expect(b.report.edgeGaps.deckEdge).toBe(c.edgeGaps[0]);
      expect(b.report.edgeGaps.tuck).toBe(c.edgeGaps[1]);
      expect(Math.max(b.report.edgeGaps.deckEdge, b.report.edgeGaps.tuck)).toBeLessThanOrEqual(
        TOL.fit,
      );
    });
  }
});

/**
 * Whether the deck edge enters the deck's far-corner patch, the only patch `corrupt a weight`
 * changes (it rescales the net's last control point, whose support is the last span in u and
 * in v). Sampled at the row's plan points mapped to the deck's (u, v).
 */
function deckEdgeEntersCornerPatch(b: BuiltBoard): boolean {
  const lastBreak = (bs: BuiltBoard['deck']['u']): number => {
    const br = breakpoints(bs);
    return br[br.length - 2]!;
  };
  const u1 = lastBreak(b.deck.u);
  const v1 = lastBreak(b.deck.v);
  const [x0, x1] = b.doc.deck.x;
  const [y0, y1] = b.doc.deck.y;
  for (let k = 0; k < 20000; k++) {
    const p = curvePoint(b.deckEdge, k / 20000);
    if ((p.x - x0) / (x1 - x0) > u1 && (p.y - y0) / (y1 - y0) > v1) return true;
  }
  return false;
}

describe('geom’s mutation catalogue applied to boards', () => {
  for (const [name, make] of [BOARDS[0]!, BOARDS[3]!]) {
    it(`${name}: every injected defect is refused by the layer that owns it`, () => {
      const board = make();
      const b = board.brep;
      let judged = 0;
      for (const m of MUTATIONS) {
        const layer = m.caughtBy(b);
        if (layer === 'n/a') continue; // a hole-loop defect: the board has no hole
        judged++;
        const made = makeBrep(m.apply(b));
        if (layer === 'makeBrep') {
          expect(made.ok, m.name).toBe(false);
          continue;
        }
        expect(made.ok, `${m.name}: ${JSON.stringify(made.issues)}`).toBe(true);
        if (!made.ok) continue;
        const c = checkBrep(made.value);
        if (m.name === 'corrupt a weight' && !deckEdgeEntersCornerPatch(board)) {
          // The catalogue's premise (the corner control point lies on an edge) holds for an
          // untrimmed face. On a trimmed deck whose edge never enters the corner patch the
          // mutation changes no point of the face: not a defect, and the solid is unchanged.
          expect(c.ok, m.name).toBe(true);
          // Same volume up to rounding (the patch is now rational: another evaluation path).
          const v0 = checkBrep(b).signedVolume;
          expect(Math.abs(c.signedVolume - v0)).toBeLessThanOrEqual(1e-12 * v0);
          continue;
        }
        expect(c.ok, m.name).toBe(false);
      }
      // Everything but the two hole-loop defects applies to a three-face solid.
      expect(judged).toBe(MUTATIONS.length - 2);
    });
  }

  it('the stadium’s deck edge enters the corner patch (so its weight defect is refused)', () => {
    expect(deckEdgeEntersCornerPatch(BOARDS[0]![1]())).toBe(true);
  });
});

describe('edge gaps against an independent sampling', () => {
  it('crowned stadium: |row(t) − F(row.xy(t))| measured independently equals checkBrep’s gap', () => {
    const b = built(stadiumBoard({ crown: 1, rocker: 5 }));
    const [x0, x1] = b.doc.deck.x;
    const [y0, y1] = b.doc.deck.y;
    // The planar parts agree to rounding, so the deviation is vertical: |row.z − F(row.xy)|.
    const gapAt = (row: BuiltBoard['deckEdge'], s: BuiltBoard['deck'], t: number): number => {
      const p = curvePoint(row, t - Math.floor(t));
      return Math.abs(p.z - surfacePoint(s, (p.x - x0) / (x1 - x0), (p.y - y0) / (y1 - y0)).z);
    };
    // The largest of N samples, then golden-section on its bracket [t − 1/N, t + 1/N] to a
    // bracket of 1e-15 (the loop is periodic: t wraps). 20,000 samples put about 100 in each
    // of the row's ~200 spans, so the bracket holds the global maximum, where the gap is
    // smooth; at a smooth maximum the value converges quadratically in the bracket.
    const N = 20000;
    const GOLD = (Math.sqrt(5) - 1) / 2;
    const gap = (row: BuiltBoard['deckEdge'], s: BuiltBoard['deck']): number => {
      let k0 = 0;
      let worst = -1;
      for (let k = 0; k < N; k++) {
        const g = gapAt(row, s, k / N);
        if (g > worst) [worst, k0] = [g, k];
      }
      let a = (k0 - 1) / N;
      let c = (k0 + 1) / N;
      while (c - a > 1e-15) {
        const m1 = c - GOLD * (c - a);
        const m2 = a + GOLD * (c - a);
        if (gapAt(row, s, m1) < gapAt(row, s, m2)) a = m1;
        else c = m2;
      }
      return Math.max(worst, gapAt(row, s, 0.5 * (a + c)));
    };
    // checkBrep's own golden-section stops at a bracket of 0.618⁴⁰ ≈ 4e-9 of its piece; at
    // the smooth maximum that costs ~g″ (4e-9 · piece)² ≪ 1e-12 cm. The rest is the rounding
    // of z differences of a few cm (1e-15 cm). So 1e-12 × the thickness (6 cm), the design's
    // bound, holds with margin; a gap misreported by more fails.
    const scale = 6;
    for (const [row, s, g] of [
      [b.deckEdge, b.deck, b.report.edgeGaps.deckEdge],
      [b.tuck, b.bottom, b.report.edgeGaps.tuck],
    ] as const) {
      expect(g).toBeGreaterThan(1e-7); // a real gap (the crown and rocker), not rounding
      expect(Math.abs(gap(row, s) - g)).toBeLessThanOrEqual(1e-12 * scale);
    }
  });
});

describe('volume against an independent oracle (flat stadium)', () => {
  it('massProperties = deck height × deck-edge area + the band’s exact flux, 1e-10 relative', () => {
    const b = built(stadiumBoard());
    const o = flatBoardVolume(b, 6, 0);
    const m = massProperties(b.brep);
    expect(Math.abs(m.volume.value - o.volume)).toBeLessThanOrEqual(1e-10 * o.volume);
    expect(Math.abs(checkBrep(b.brep).signedVolume - o.volume)).toBeLessThanOrEqual(
      1e-10 * o.volume,
    );
    // The oracle can fail: a deck 1 mm higher is a different volume by 0.1 × the deck area.
    expect(flatBoardVolume(b, 6.1, 0).volume - o.volume).toBeCloseTo(0.1 * o.deckArea, 6);
    // Sanity on the parts: the band carries what lies outside the deck edge.
    expect(o.deckArea).toBeLessThan(o.bottomArea);
    expect(o.bandFlux).toBeGreaterThan(0);
  });
});

describe('buildBoard', () => {
  it('refuses a document validateBoard refuses (the notched loop: tail-not-standard), without throwing', () => {
    const r = buildBoard(notchedBoard());
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('tail-not-standard');
  });

  it('is deterministic: the same document builds the same bits', () => {
    const a = built(stadiumBoard());
    const b = built(stadiumBoard());
    expect(Array.from(a.band.cw)).toEqual(Array.from(b.band.cw));
    expect(a.report).toEqual(b.report);
  });

  it('leaves its input unchanged', () => {
    const doc = stadiumBoard();
    const before = JSON.stringify(doc);
    built(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('writeBoardStep', () => {
  it('writes the three-face solid; geom’s subset reader reads back a solid checkBrep accepts', () => {
    const b = built(stadiumBoard());
    const out = writeBoardStep(b);
    expect(out.stats).toMatchObject({ faces: 3, edges: 3, vertices: 2 });
    expect(out.text).toContain("PRODUCT('Stadium'");
    expect(writeBoardStep(b).text).toBe(out.text);
    const back = readStepSubset(out.text, { unit: 'cm' });
    const c = checkBrep(back);
    expect(c.ok, JSON.stringify(c.issues)).toBe(true);
    expect(Math.abs(c.signedVolume / checkBrep(b.brep).signedVolume - 1)).toBeLessThan(1e-12);
  });
});
