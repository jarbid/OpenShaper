// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Foil slices (docs/design/fin-designer.md, foil slices): foils at chosen heights, the
 * shape blending smoothly between them.
 */
import { describe, expect, it } from 'vitest';
import { bladeSection, cosineStations, foilAt, prepareBlade, thicknessAt } from './blade';
import { defaultFinDesign } from './fin-defaults';
import { FIN_SLICE_MIN_GAP, type FinDesign } from './fin-design';
import { validateFinDesign } from './fin-rules';
import { nacaSection } from './naca';

const base = defaultFinDesign('side', 'left');
const thin = nacaSection('0008'); // symmetric, thinner than the root's flat-inside foil
const withSlice = (height = 0.6, d: FinDesign = base): FinDesign => ({
  ...d,
  slices: [{ height, section: thin }],
});

describe('foilAt', () => {
  const d = withSlice();

  it('is the root foil at the root and the slice at the slice', () => {
    expect(foilAt(d, 0).shapeAt(0.3)).toEqual(foilAt(base, 0).shapeAt(0.3));
    const [o, i] = foilAt(d, 0.6).shapeAt(0.3);
    expect(o).toBeCloseTo(foilAt({ ...base, section: thin }, 0).shapeAt(0.3)[0], 15);
    expect(i).toBeCloseTo(-o, 15); // the slice is symmetric
  });

  it('stays as the last slice above it', () => {
    expect(foilAt(d, 0.9).shapeAt(0.4)).toEqual(foilAt(d, 0.6).shapeAt(0.4));
  });

  it('blends smoothly through the slice: no kink in the shape against height', () => {
    // Second difference of the outside offset at a fixed chord fraction, across heights
    // spanning the slice. A linear blend would kink at the slice.
    const step = 0.002;
    const at = (eta: number) => foilAt(d, eta).shapeAt(0.4)[0];
    let worst = 0;
    for (let eta = 0.5; eta <= 0.7; eta += step) {
      worst = Math.max(worst, Math.abs(at(eta - step) - 2 * at(eta) + at(eta + step)) / step ** 2);
    }
    let elsewhere = 0;
    for (let eta = 0.2; eta <= 0.4; eta += step) {
      elsewhere = Math.max(
        elsewhere,
        Math.abs(at(eta - step) - 2 * at(eta) + at(eta + step)) / step ** 2,
      );
    }
    expect(worst).toBeLessThan(2 * elsewhere + 1e-9);
  });

  it('shares the minimum thickness as the foils do, blending half-and-half to all-out', () => {
    expect(foilAt(d, 0).outsideShare).toBe(1); // flat inside
    expect(foilAt(d, 0.6).outsideShare).toBe(0.5); // symmetric
    const mid = foilAt(d, 0.3).outsideShare;
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
  });
});

describe('a blade with a slice', () => {
  const d = { ...withSlice(), cant: 0 };
  const b = prepareBlade(d);

  it('is a valid design', () => expect(validateFinDesign(d)).toEqual([]));

  it('is the taper thickness at its thickest at the slice, and close to it either side', () => {
    const widest = (h: number) => {
      const s = bladeSection(b, h, cosineStations(2000));
      return Math.max(...s.outside.map((p, j) => p.y - s.inside[j]!.y));
    };
    // At the slice, all horizontal slice foil, as thick as the fin without it there: the
    // thickness curve's, to within the sweep's sections leaning a little.
    const h = 0.6 * b.depth;
    const plain = prepareBlade({ ...d, slices: [] });
    const s = bladeSection(plain, h, cosineStations(2000));
    expect(widest(h)).toBeCloseTo(Math.max(...s.outside.map((p, j) => p.y - s.inside[j]!.y)), 4);
    expect(Math.abs(widest(h) / thicknessAt(b, h) - 1)).toBeLessThan(0.01);
    // Either side it blends with the sweep, whose sections lean a little.
    for (const f of [0.1, 0.3, 0.45, 0.8]) {
      const z = f * b.depth;
      expect(Math.abs(widest(z) / thicknessAt(b, z) - 1)).toBeLessThan(0.08);
    }
  });

  it('hands back to the sweep at the base', () => {
    const plain = prepareBlade({ ...d, slices: [] });
    const a = bladeSection(b, 0);
    const c = bladeSection(plain, 0);
    a.outside.forEach((p, j) => expect(p.y).toBeCloseTo(c.outside[j]!.y, 12));
  });

  it('takes the slice’s shape at the slice: symmetric about the centre plane', () => {
    const s = bladeSection(b, 0.6 * b.depth);
    // To a few microns: the fin the slice is measured against is read off a table.
    s.outside.forEach((p, j) => expect(s.inside[j]!.y).toBeCloseTo(-p.y, 3));
  });
});

describe('slice rules', () => {
  it('keeps slices in order, apart, and off the root and tip', () => {
    const at = (...hs: number[]): FinDesign => ({
      ...base,
      slices: hs.map((height) => ({ height, section: thin })),
    });
    const codes = (d: FinDesign) => validateFinDesign(d).map((i) => i.code);
    expect(codes(at(0.3, 0.7))).toEqual([]);
    expect(codes(at(0.7, 0.3))).toContain('slice-height');
    expect(codes(at(0.5, 0.5 + FIN_SLICE_MIN_GAP / 2))).toContain('slice-height');
    expect(codes(at(FIN_SLICE_MIN_GAP / 2))).toContain('slice-height');
    expect(codes(at(1))).toContain('slice-height');
  });

  it('checks each slice’s foil, and names the slice', () => {
    const d: FinDesign = {
      ...defaultFinDesign('centre'),
      slices: [{ height: 0.5, section: base.section }], // flat inside, on a centre fin
    };
    const issue = validateFinDesign(d).find((i) => i.code === 'section-symmetry');
    expect(issue?.message).toMatch(/control section at 50%/);
  });
});
