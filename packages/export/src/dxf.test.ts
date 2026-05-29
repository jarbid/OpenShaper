import { describe, expect, it } from 'vitest';
import { exportDxf } from './dxf';
import { makeTestBoard } from './fixture.test-helper';

describe('exportDxf', () => {
  const board = makeTestBoard();

  it('produces a minimally valid DXF', () => {
    const dxf = exportDxf(board, { lengthSteps: 40, ringSteps: 16, crossSectionCount: 3 });
    expect(dxf).toContain('SECTION');
    expect(dxf).toContain('ENTITIES');
    expect(dxf).toContain('ENDSEC');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('emits at least one polyline entity', () => {
    const dxf = exportDxf(board, { crossSectionCount: 3 });
    const polylines = dxf.split('\n').filter((l) => l === 'POLYLINE').length;
    expect(polylines).toBeGreaterThanOrEqual(1);
    // outline + bottom + deck + 3 cross-sections.
    expect(polylines).toBeGreaterThanOrEqual(5);
  });

  it('contains no NaN coordinates', () => {
    const dxf = exportDxf(board);
    expect(dxf).not.toMatch(/NaN/);
    expect(dxf).not.toMatch(/Infinity/);
  });
});
