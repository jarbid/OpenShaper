import { board as makeBoard, defaultFinConfig } from '@openshaper/kernel';
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
