import {
  board as makeBoard,
  crossSection,
  curveFromKnots,
  defaultFinConfig,
  knot,
  splineFromKnots,
  splitCurve,
  vec2,
  type Knot,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { exportStl } from './stl';
import { makeTestBoard } from './fixture.test-helper';

describe('exportStl', () => {
  const board = makeTestBoard();
  const finned = () => {
    const b = makeTestBoard();
    return makeBoard(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, defaultFinConfig('thruster', 'futures')); // prettier-ignore
  };

  it('produces a valid ASCII STL solid', () => {
    const stl = exportStl(board, { lengthSteps: 40, ringSteps: 16 });
    expect(stl.startsWith('solid ')).toBe(true);
    expect(stl.trimEnd().endsWith('endsolid openshaper')).toBe(true);
  });

  it('emits a positive facet count', () => {
    const stl = exportStl(board, { lengthSteps: 40, ringSteps: 16 });
    const facets = stl.match(/facet normal/g)?.length ?? 0;
    expect(facets).toBeGreaterThan(0);
    // facet / outer loop / vertex×3 should be balanced.
    expect(stl.match(/endfacet/g)?.length).toBe(facets);
  });

  it('contains no NaN or Infinity in vertices/normals', () => {
    const stl = exportStl(board, { lengthSteps: 40, ringSteps: 16 });
    expect(stl).not.toMatch(/NaN/);
    expect(stl).not.toMatch(/Infinity/);
  });

  it('respects the name option', () => {
    const stl = exportStl(board, { name: 'mytest', lengthSteps: 8, ringSteps: 8 });
    expect(stl.startsWith('solid mytest')).toBe(true);
    expect(stl.trimEnd().endsWith('endsolid mytest')).toBe(true);
  });

  it('defaults to a fine, dense mesh and a finer target gives more facets', () => {
    const fine = exportStl(board, { targetFaceSize: 0.5 });
    const coarse = exportStl(board, { targetFaceSize: 4 });
    const count = (s: string) => s.match(/facet normal/g)?.length ?? 0;
    expect(count(fine)).toBeGreaterThan(count(coarse));
    // The default (no options) is fine, so plenty of facets for a 100cm test board.
    expect(count(exportStl(board))).toBeGreaterThan(500);
  });

  it('appends fin blade solids (more facets than the bare hull), and can opt out', () => {
    const opts = { lengthSteps: 40, ringSteps: 16 } as const;
    const count = (s: string) => s.match(/facet normal/g)?.length ?? 0;
    const hull = count(exportStl(board, opts));
    const withFins = count(exportStl(finned(), opts));
    const without = count(exportStl(finned(), { ...opts, includeFins: false }));
    expect(withFins).toBeGreaterThan(hull);
    expect(without).toBe(hull);
    expect(exportStl(finned(), opts)).not.toMatch(/NaN/);
  });
});

/** Insert one knot via exact de Casteljau split — same curve, one more segment. */
const insertKnot = (knots: readonly Knot[], seg: number, t: number): Knot[] => {
  const a = knots[seg]!;
  const b = knots[seg + 1]!;
  const split = splitCurve(curveFromKnots(a, b), t);
  const out = [...knots];
  out[seg] = knot(a.end, a.tangentToPrev, split.startTangentToNext, a.continuous, a.other);
  out[seg + 1] = knot(b.end, split.endTangentToPrev, b.tangentToNext, b.continuous, b.other);
  out.splice(
    seg + 1,
    0,
    knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false),
  );
  return out;
};

/**
 * `exportStl` has its own ring-sampling loft (it does not go through
 * `tessellateBoard` for a normal board), so the arc-length sampling fix needs
 * its own regression guard here — see the matching kernel test
 * `tessellate.continuity.test.ts`.
 */
describe('exportStl: continuity across a mismatched knot-count station', () => {
  const LENGTH = 120;
  const HALF_W = 10;
  const THICK = 6;

  const straight = (ax: number, ay: number, bx: number, by: number) =>
    splineFromKnots([
      knot(vec2(ax, ay), vec2(ax, ay), vec2(ax + (bx - ax) / 3, ay + (by - ay) / 3)),
      knot(vec2(bx, by), vec2(ax + ((bx - ax) * 2) / 3, ay + ((by - ay) * 2) / 3), vec2(bx, by)),
    ]);

  const profile = () =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(HALF_W * 0.5, 0)),
      knot(vec2(HALF_W, THICK * 0.25), vec2(HALF_W * 0.7, THICK * 0.05), vec2(HALF_W, THICK * 0.45)), // prettier-ignore
      knot(vec2(HALF_W, THICK * 0.75), vec2(HALF_W, THICK * 0.55), vec2(HALF_W * 0.7, THICK * 0.95)), // prettier-ignore
      knot(vec2(0, THICK), vec2(HALF_W * 0.5, THICK), vec2(0, THICK)),
    ]);

  /**
   * Constant-prism board: identical rail curve at every station, but stored with
   * 4 / 5 / 7 knots. Station B (5) is not a local max among its neighbors, which
   * is the configuration a per-station rail preset creates.
   */
  const prism = () => {
    const four = profile().knots;
    const five = insertKnot(four, 0, 0.5);
    const seven = insertKnot(insertKnot(insertKnot(four, 2, 0.5), 1, 0.5), 0, 0.5);
    return makeBoard(
      straight(0, HALF_W, LENGTH, HALF_W),
      straight(0, 0, LENGTH, 0),
      straight(0, THICK, LENGTH, THICK),
      [
        crossSection(0, splineFromKnots(four)),
        crossSection(30, splineFromKnots(four)),
        crossSection(60, splineFromKnots(five)),
        crossSection(90, splineFromKnots(seven)),
        crossSection(LENGTH, splineFromKnots(four)),
      ],
      'controlPoint',
    );
  };

  /** Same prism, but every station stored with the SAME knot count (no morph). */
  const uniformPrism = () => {
    const four = profile().knots;
    return makeBoard(
      straight(0, HALF_W, LENGTH, HALF_W),
      straight(0, 0, LENGTH, 0),
      straight(0, THICK, LENGTH, THICK),
      [0, 30, 60, 90, LENGTH].map((p) => crossSection(p, splineFromKnots(four))),
      'controlPoint',
    );
  };

  /**
   * Largest longitudinal edge displacement in (y, z) across the exported hull.
   *
   * A band facet spans two adjacent stations, so it has exactly two distinct x
   * values and two vertex pairs that cross between them: the LONGITUDINAL edge
   * (corresponding ring indices) and the quad's DIAGONAL. The diagonal always
   * spans about one ring step of profile arc (~1 cm here) whether or not the
   * loft is correct, so only the shorter of the two — the longitudinal edge —
   * measures a crease. On a constant prism it must be ~0.
   */
  const bandJump = (stl: string): number => {
    const verts: [number, number, number][] = [];
    for (const m of stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)) {
      verts.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    }
    const xk = (v: [number, number, number]) => Math.round(v[0] * 1e6);
    let mx = 0;
    let bands = 0;
    for (let f = 0; f < verts.length; f += 3) {
      const tri = [verts[f]!, verts[f + 1]!, verts[f + 2]!];
      if (new Set(tri.map(xk)).size !== 2) continue; // cap fan, not a band facet
      bands++;
      let longitudinal = Infinity;
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const a = tri[i]!;
          const b = tri[j]!;
          if (xk(a) === xk(b)) continue;
          longitudinal = Math.min(longitudinal, Math.hypot(a[1] - b[1], a[2] - b[2]));
        }
      if (Number.isFinite(longitudinal)) mx = Math.max(mx, longitudinal);
    }
    expect(bands).toBeGreaterThan(500);
    return mx;
  };

  const stlOf = (b: ReturnType<typeof prism>) =>
    exportStl(b, { lengthSteps: 200, ringSteps: 24, includeFins: false });

  it('samples every station on the same profile (no crease in the exported hull)', () => {
    // The prism's true shape never varies along x, so every longitudinal edge
    // should be near axis-parallel. Segment-index sampling instead skews the
    // band by ~5 cm at the station whose knot count is not a local max.
    //
    // The bound is 1 mm rather than 0: where knot counts differ, the legacy
    // control-point morph (`interpolateCrossSection`) blends two differently
    // resliced control polygons of the same curve, which does not reproduce
    // that curve exactly. That residual measures ~0.07 cm here — ~70x smaller
    // than the sampling defect this guards, and inherent to the ported morph
    // rather than to ring sampling.
    expect(bandJump(stlOf(prism()))).toBeLessThan(0.1);
  });

  it('is no worse than the uniform-knot-count baseline by more than the morph residual', () => {
    // Control: identical geometry with the same knot count everywhere, so no
    // control-point morph runs at all and the loft should be essentially exact.
    const uniform = bandJump(stlOf(uniformPrism()));
    expect(uniform).toBeLessThan(0.02);
    expect(bandJump(stlOf(prism()))).toBeLessThan(uniform + 0.1);
  });
});
