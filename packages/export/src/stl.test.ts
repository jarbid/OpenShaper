import { describe, expect, it } from 'vitest';
import { exportStl } from './stl';
import { makeTestBoard } from './fixture.test-helper';

describe('exportStl', () => {
  const board = makeTestBoard();

  it('produces a valid ASCII STL solid', () => {
    const stl = exportStl(board, { lengthSteps: 40, ringSteps: 16 });
    expect(stl.startsWith('solid ')).toBe(true);
    expect(stl.trimEnd().endsWith('endsolid boardstudio')).toBe(true);
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
});
