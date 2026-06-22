import { describe, expect, it } from 'vitest';
import { tileDrawing, type PartDrawing } from './pdf-tile';
import { paperSizeById } from './paper';
import { exportBoardPdf1to1Files } from './board-pdf';
import { makeTestBoard } from './fixture.test-helper';

const a4 = paperSizeById('a4')!;

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

const part = (widthPt: number, heightPt: number): PartDrawing => ({
  title: 'T',
  widthPt,
  heightPt,
  content: '0 0 0 RG 1 w 0 0 m 10 10 l S\n',
});

describe('tileDrawing', () => {
  it('keeps a part that fits on one sheet to a single tile', () => {
    const pages = tileDrawing(part(200, 200), {
      paper: a4,
      overlapPt: 20,
      cutMarks: true,
      labels: true,
      partCode: 'Outline',
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.width).toBeCloseTo(a4.wPt, 3);
    expect(pages[0]!.height).toBeCloseTo(a4.hPt, 3);
  });

  it('splits a wide part into a row of tiles, accounting for overlap', () => {
    // A4 portrait printable width ≈ 523pt; a 1200pt part with 20pt overlap → 3 cols.
    const pages = tileDrawing(part(1200, 300), {
      paper: a4,
      overlapPt: 20,
      cutMarks: true,
      labels: true,
      partCode: 'Outline',
    });
    expect(pages).toHaveLength(3);
  });

  it('emits clip + translate operators and tile codes', () => {
    const [tile] = tileDrawing(part(1200, 300), {
      paper: a4,
      overlapPt: 20,
      cutMarks: true,
      labels: true,
      partCode: 'Outline',
    });
    const c = tile!.content;
    expect(c).toContain('re W n'); // clip rectangle
    expect(c).toContain('cm'); // translate matrix
    expect(c).toContain('(A1)'); // top-left tile code
    expect(c).toContain('(A2 >)'); // join id toward the right neighbour
  });

  it('omits marks and labels when disabled', () => {
    const [tile] = tileDrawing(part(1200, 300), {
      paper: a4,
      overlapPt: 0,
      cutMarks: false,
      labels: false,
      partCode: 'Outline',
    });
    expect(tile!.content).not.toContain('(A1)');
  });
});

describe('exportBoardPdf1to1Files', () => {
  const board = makeTestBoard();

  it('combined packaging yields one PDF whose page count = sum of all tiles', () => {
    const { files } = exportBoardPdf1to1Files(board, {
      crossSectionCount: 0,
      parts: { crossSections: false },
      tiling: { paper: a4, orientation: 'auto', overlapCm: 1, cutMarks: true, labels: true },
      packaging: 'combined',
    });
    expect(files).toHaveLength(1);
    const text = decode(files[0]!.bytes);
    expect(text.startsWith('%PDF-')).toBe(true);
    const count = Number(text.match(/\/Count (\d+)/)![1]);
    // Outline + rocker each tile into multiple A4 pages.
    expect(count).toBeGreaterThan(2);
  });

  it('per-part packaging yields one file per included category', () => {
    const { files } = exportBoardPdf1to1Files(board, {
      crossSectionCount: 3,
      tiling: null,
      packaging: 'per-part',
    });
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual([
      'board-1to1-outline.pdf',
      'board-1to1-rocker.pdf',
      'board-1to1-sections.pdf',
    ]);
  });

  it('respects the part selection (no outline → no outline file)', () => {
    const { files } = exportBoardPdf1to1Files(board, {
      crossSectionCount: 0,
      parts: { outline: false, crossSections: false },
      tiling: null,
      packaging: 'per-part',
    });
    expect(files.map((f) => f.name)).toEqual(['board-1to1-rocker.pdf']);
  });
});
