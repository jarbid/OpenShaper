import { describe, expect, it } from 'vitest';
import { customPaper, orient, paperSizeById, PAPER_SIZES, POINTS_PER_CM } from './paper';

const PT_PER_MM = 72 / 25.4;

describe('paper sizes', () => {
  it('defines A4 in points from its millimetre dimensions', () => {
    const a4 = paperSizeById('a4')!;
    expect(a4.wPt).toBeCloseTo(210 * PT_PER_MM, 3);
    expect(a4.hPt).toBeCloseTo(297 * PT_PER_MM, 3);
    expect(a4.wPt).toBeLessThan(a4.hPt); // stored portrait
  });

  it('includes the offered ISO + US sizes', () => {
    const ids = PAPER_SIZES.map((p) => p.id);
    expect(ids).toEqual(['a4', 'a3', 'a2', 'a1', 'a0', 'letter', 'tabloid']);
  });

  it('builds a custom paper from centimetres', () => {
    const p = customPaper(50, 70);
    expect(p.id).toBe('custom');
    expect(p.wPt).toBeCloseTo(50 * POINTS_PER_CM, 3);
    expect(p.hPt).toBeCloseTo(70 * POINTS_PER_CM, 3);
  });
});

describe('orient', () => {
  const a4 = paperSizeById('a4')!;

  it('forces portrait / landscape on request', () => {
    expect(orient(a4, 'portrait', 5).wPt).toBeLessThan(orient(a4, 'portrait', 5).hPt);
    expect(orient(a4, 'landscape', 0.1).wPt).toBeGreaterThan(orient(a4, 'landscape', 0.1).hPt);
  });

  it('auto picks landscape for a wide part and portrait for a tall part', () => {
    const wide = orient(a4, 'auto', 3); // aspect > 1
    expect(wide.wPt).toBeGreaterThan(wide.hPt);
    const tall = orient(a4, 'auto', 0.3); // aspect < 1
    expect(tall.wPt).toBeLessThan(tall.hPt);
  });
});
