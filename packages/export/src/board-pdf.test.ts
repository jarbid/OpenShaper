import { describe, expect, it } from 'vitest';
import { exportBoardPdf1to1 } from './board-pdf';
import { bbox, planOutlineLoop } from './board-curves';
import { makeTestBoard } from './fixture.test-helper';

const CM_TO_PT = 72 / 2.54;

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

describe('exportBoardPdf1to1', () => {
  const board = makeTestBoard();

  it('is a valid PDF wrapped by %PDF- and %%EOF', () => {
    const pdf = exportBoardPdf1to1(board);
    expect(pdf).toBeInstanceOf(Uint8Array);
    const text = decode(pdf);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('emits one outline page, one rocker page, and one page per cross-section', () => {
    const csCount = 5;
    const text = decode(exportBoardPdf1to1(board, { crossSectionCount: csCount }));
    const count = Number(text.match(/\/Count (\d+)/)![1]);
    expect(count).toBe(2 + csCount);
    const pages = text.match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBe(2 + csCount);
  });

  it('sizes the outline page to the outline bbox × CM_TO_PT plus a margin', () => {
    const text = decode(exportBoardPdf1to1(board, { crossSectionCount: 0 }));
    // First (outline) page MediaBox.
    const m = text.match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    expect(m).not.toBeNull();
    const bb = bbox(planOutlineLoop(board, 200));
    const margin = 2; // MARGIN_CM
    const expectedW = (bb.maxX - bb.minX + 2 * margin) * CM_TO_PT;
    const expectedH = (bb.maxY - bb.minY + 2 * margin) * CM_TO_PT;
    expect(Number(m![1])).toBeCloseTo(expectedW, 1);
    expect(Number(m![2])).toBeCloseTo(expectedH, 1);
  });

  it('titles pages with the model name and a 1:1 note', () => {
    const text = decode(exportBoardPdf1to1(board, { meta: { model: 'Quad 6\'0"' } }));
    expect(text).toContain('Quad');
    // PDF escapes '(' and ')' inside string literals.
    expect(text).toContain('Outline \\(1:1\\)');
    expect(text).toContain('Rocker \\(1:1\\)');
    expect(text).toContain('100% scale');
  });

  it('honours the units flag in labels', () => {
    expect(decode(exportBoardPdf1to1(board, { units: 'in' }))).toContain('units in');
    expect(decode(exportBoardPdf1to1(board, { units: 'cm' }))).toContain('units cm');
  });
});
