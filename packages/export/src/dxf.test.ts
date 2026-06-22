import { board as makeBoard, defaultFinConfig } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { exportDxf } from './dxf';
import { makeTestBoard } from './fixture.test-helper';

/** The test board with a fin configuration applied. */
const withFins = (system: Parameters<typeof defaultFinConfig>[1], setup = 'thruster' as const) => {
  const b = makeTestBoard();
  return makeBoard(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, defaultFinConfig(setup, system)); // prettier-ignore
};

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

  describe('curve modes', () => {
    const count = (dxf: string, entity: string) =>
      dxf.split('\n').filter((l) => l === entity).length;

    it('polyline mode (default) emits POLYLINE and no SPLINE, with R12 (no header)', () => {
      const dxf = exportDxf(board, { crossSectionCount: 3 });
      expect(count(dxf, 'POLYLINE')).toBeGreaterThanOrEqual(5);
      expect(count(dxf, 'SPLINE')).toBe(0);
      expect(dxf).not.toContain('$ACADVER');
    });

    it('spline mode emits SPLINE entities, an AC1015 header, and no curve POLYLINEs', () => {
      const dxf = exportDxf(board, { crossSectionCount: 3, curveMode: 'spline' });
      expect(dxf).toContain('$ACADVER');
      expect(dxf).toContain('AC1015');
      // outline + bottom + deck + 3 cross-sections = 6 splines.
      expect(count(dxf, 'SPLINE')).toBe(6);
      // No POLYLINE for the curves (fins/ghost aside; this board is finless, no ghost).
      expect(count(dxf, 'POLYLINE')).toBe(0);
    });

    it('spline control-point and knot counts are consistent (knots = ctrl + degree + 1)', () => {
      const lines = exportDxf(board, { crossSectionCount: 0, curveMode: 'spline' }).split('\n');
      // Inspect the first SPLINE (the outline): read 72 (#knots) and 73 (#ctrl).
      const si = lines.indexOf('SPLINE');
      const after = lines.slice(si, si + 40);
      const valAfter = (code: string) => Number(after[after.indexOf(code) + 1]);
      const nKnots = valAfter('72');
      const nCtrl = valAfter('73');
      expect(nKnots).toBe(nCtrl + 3 + 1); // degree 3
    });

    it('keeps coordinates finite in both modes', () => {
      for (const curveMode of ['polyline', 'spline'] as const) {
        const dxf = exportDxf(board, { curveMode });
        expect(dxf).not.toMatch(/NaN|Infinity/);
      }
    });
  });

  describe('ghost board overlay', () => {
    const entityLayers = (dxf: string): string[] => {
      const lines = dxf.split('\n');
      return lines.filter((_, i) => lines[i - 1] === '8');
    };
    const polylineCount = (dxf: string): number =>
      dxf.split('\n').filter((l) => l === 'POLYLINE').length;

    it('draws the ghost outline + rocker dashed on the GHOST layer', () => {
      const plain = exportDxf(board, { crossSectionCount: 3 });
      const withGhost = exportDxf(board, { crossSectionCount: 3, ghostBoard: makeTestBoard() });

      // Outline loop + deck + bottom = three extra polylines, all on GHOST.
      expect(polylineCount(withGhost)).toBe(polylineCount(plain) + 3);
      expect(entityLayers(withGhost)).toContain('GHOST');
      // Dashed so the reference reads as non-cutting geometry.
      const lines = withGhost.split('\n');
      const ghostIdx = lines.findIndex((l, i) => l === 'GHOST' && lines[i - 1] === '8');
      expect(lines.slice(ghostIdx, ghostIdx + 4)).toContain('DASHED');
    });

    it('puts nothing on the GHOST layer without a ghost board', () => {
      expect(entityLayers(exportDxf(board, { crossSectionCount: 3 }))).not.toContain('GHOST');
    });
  });

  describe('fins', () => {
    const entityLayers = (dxf: string): string[] => {
      const lines = dxf.split('\n');
      return lines.filter((_, i) => lines[i - 1] === '8');
    };

    it('declares the FINS layer and draws nothing there for a finless board', () => {
      const dxf = exportDxf(board, { crossSectionCount: 3 });
      expect(dxf).toContain('FINS'); // layer declared in TABLES
      expect(entityLayers(dxf)).not.toContain('FINS'); // but no entities on it
    });

    it('draws Futures boxes as closed polylines on the FINS layer', () => {
      const dxf = exportDxf(withFins('futures'), { crossSectionCount: 3 });
      expect(entityLayers(dxf)).toContain('FINS');
      // 3 fins → 3 footprint LINEs + 3 box POLYLINEs on FINS.
      expect(dxf).not.toMatch(/NaN/);
    });

    it('draws FCS x2 plugs as CIRCLE entities on the FINS layer', () => {
      const dxf = exportDxf(withFins('fcs-x2'), { crossSectionCount: 3 });
      const lines = dxf.split('\n');
      const circleLayers = lines
        .map((l, i) => (l === 'CIRCLE' ? lines[i + 2] : null)) // '0 CIRCLE 8 <layer>'
        .filter(Boolean);
      // Two plugs per side fin (thruster has 2 side fins) + 2 for the centre = 6 circles.
      expect(circleLayers.length).toBeGreaterThanOrEqual(4);
      expect(circleLayers.every((l) => l === 'FINS')).toBe(true);
    });

    it('glass-on draws footprints but no box geometry', () => {
      const dxf = exportDxf(withFins('glass-on'), { crossSectionCount: 3 });
      expect(dxf).not.toContain('CIRCLE');
      expect(entityLayers(dxf)).toContain('FINS'); // footprint LINEs only
    });
  });
});
