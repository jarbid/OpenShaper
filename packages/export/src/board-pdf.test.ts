import { describe, expect, it } from 'vitest';
import { exportBoardPdf1to1 } from './board-pdf';
import { bbox, planOutlineLoop, planOutlineRail } from './board-curves';
import { defaultFinConfig } from '@openshaper/kernel';
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
    const text = decode(exportBoardPdf1to1(board, { crossSectionCount: 0, halfOutline: false }));
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
    const text = decode(
      exportBoardPdf1to1(board, { meta: { model: 'Quad 6\'0"' }, halfOutline: false }),
    );
    expect(text).toContain('Quad');
    // PDF escapes '(' and ')' inside string literals.
    expect(text).toContain('Outline \\(1:1\\)');
    expect(text).toContain('Rocker \\(1:1\\)');
    expect(text).toContain('100% scale');
  });

  it('brands each tile footer with openshaper.com', () => {
    const text = decode(exportBoardPdf1to1(board));
    expect(text).toContain('openshaper.com');
  });

  it('honours the units flag in labels', () => {
    expect(decode(exportBoardPdf1to1(board, { units: 'in' }))).toContain('units in');
    expect(decode(exportBoardPdf1to1(board, { units: 'cm' }))).toContain('units cm');
  });

  it('draws the outline as exact bezier curves (smooth, not faceted)', () => {
    const text = decode(
      exportBoardPdf1to1(board, {
        crossSectionCount: 0,
        parts: { rocker: false },
        halfOutline: false,
      }),
    );
    // PDF cubic-bezier operator is `x1 y1 x2 y2 x3 y3 c`. Both rails are drawn from the
    // outline spline's true control points → 2 curve ops per segment, no flattening.
    const curveOps = (text.match(/ c\n/g) ?? []).length;
    expect(curveOps).toBe(board.outline.curves.length * 2);
  });
  describe('half template (the default)', () => {
    const halfOpts = { crossSectionCount: 0, parts: { rocker: false } } as const;
    const heightOf = (t: string): number => Number(t.match(/MediaBox \[0 0 [\d.]+ ([\d.]+)\]/)![1]);

    it('draws one rail — half the curve ops of the full outline', () => {
      const half = decode(exportBoardPdf1to1(board, halfOpts));
      const full = decode(exportBoardPdf1to1(board, { ...halfOpts, halfOutline: false }));
      const ops = (t: string): number => (t.match(/ c\n/g) ?? []).length;
      expect(ops(half)).toBe(board.outline.curves.length);
      expect(ops(full)).toBe(board.outline.curves.length * 2);
    });

    it('sizes the page to the rail, still reaching the centreline', () => {
      const margin = 2; // MARGIN_CM
      const steps = 200; // DEFAULT_LENGTH_STEPS
      const bb = bbox(planOutlineRail(board, steps));
      // minY is clamped to 0 so the fold line you flip about is on the sheet.
      const expectedH = (bb.maxY - 0 + 2 * margin) * CM_TO_PT;
      const halfH = heightOf(
        decode(exportBoardPdf1to1(board, { ...halfOpts, lengthSteps: steps })),
      );
      expect(halfH).toBeCloseTo(expectedH, 1);
      expect(halfH).toBeLessThan(
        heightOf(decode(exportBoardPdf1to1(board, { ...halfOpts, halfOutline: false }))),
      );
    });

    it('titles the page as a half template and says how to use it', () => {
      const text = decode(exportBoardPdf1to1(board, { ...halfOpts, meta: { model: 'Fish' } }));
      expect(text).toContain('Outline half \\(1:1\\)');
      expect(text).toContain('flip about the centreline');
    });

    it("drops the far rail's fins but keeps the centre box", () => {
      // 2+1: a port/starboard pair (side ∓1) plus one centre fin (side 0). The half sheet
      // prints the near-side fin and the centre box; the far rail's fin goes.
      const finned = { ...board, fins: defaultFinConfig('2+1', 'futures') };
      // Each fin draws one 0.6-wide base line — but so does the half template's centreline,
      // so count fins as the difference against the same page with fins turned off.
      const strokes = (t: string): number => (t.match(/0\.6 w\n/g) ?? []).length;
      const finCount = (halfOutline: boolean): number => {
        const at = (fins: boolean): number =>
          strokes(
            decode(exportBoardPdf1to1(finned, { ...halfOpts, halfOutline, parts: { rocker: false, fins } })), // prettier-ignore
          );
        return at(true) - at(false);
      };
      expect(finCount(false)).toBe(3);
      expect(finCount(true)).toBe(2);
    });
  });
});
