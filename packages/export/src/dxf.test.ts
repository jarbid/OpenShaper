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

  it('declares a TABLES section with the named layers and line types', () => {
    const dxf = exportDxf(board, { crossSectionCount: 3 });
    expect(dxf).toContain('TABLES');
    expect(dxf).toContain('LTYPE');
    expect(dxf).toContain('LAYER');
    for (const layer of ['OUTLINE', 'ROCKER', 'CROSSSECTION', 'CENTERLINE', 'MARKERS', 'LABELS']) {
      expect(dxf).toContain(layer);
    }
    // TABLES must close before ENTITIES opens.
    expect(dxf.indexOf('TABLES')).toBeLessThan(dxf.indexOf('ENTITIES'));
  });

  it('tags entities to layers and uses CENTER / DASHED line types', () => {
    const lines = exportDxf(board, { crossSectionCount: 3 }).split('\n');
    // A group-code 8 (layer) value follows each '8' code.
    const layerValues = lines.filter((_, i) => lines[i - 1] === '8');
    expect(layerValues).toContain('OUTLINE');
    expect(layerValues).toContain('CENTERLINE');
    expect(layerValues).toContain('MARKERS');
    // Line types referenced by entities (group code 6).
    const ltypeRefs = lines.filter((_, i) => lines[i - 1] === '6');
    expect(ltypeRefs).toContain('CENTER');
    expect(ltypeRefs).toContain('DASHED');
  });

  it('emits LINE and TEXT entities for the centreline, markers and labels', () => {
    const dxf = exportDxf(board, { crossSectionCount: 3 });
    const count = (entity: string) => dxf.split('\n').filter((l) => l === entity).length;
    expect(count('LINE')).toBeGreaterThanOrEqual(2); // stringer + rocker baseline
    expect(count('TEXT')).toBeGreaterThanOrEqual(3); // one x-label per station marker
  });
});
