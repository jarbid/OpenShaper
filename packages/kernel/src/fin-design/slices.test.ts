// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Foil slices (docs/design/fin-designer.md, foil slices): foils at chosen heights, the
 * shape blending smoothly between them.
 */
import { yAtX } from './curve-shape';
import { smoothBladeOf } from './smooth-blade';
import { describe, expect, it } from 'vitest';
import { bladeSection, prepareBlade } from './blade';
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

describe('a blade with a slice', () => {
  const d = { ...withSlice(), cant: 0 };
  const b = prepareBlade(d);

  it('is a valid design', () => expect(validateFinDesign(d)).toEqual([]));

  it('is the thickness curve at its thickest on the section’s row', () => {
    const sb = smoothBladeOf(prepareBlade(d));
    const row = d.slices[0]!.height * sb.sTip;
    let most = 0;
    for (let k = 0; k <= 400; k++) {
      const [o, n] = sb.offsets(row, k / 400);
      most = Math.max(most, o - n);
    }
    expect(most).toBeCloseTo(yAtX(d.taper, sb.eta(row)), 3);
  });

  it('hands back to the sweep at the base', () => {
    const plain = prepareBlade({ ...d, slices: [] });
    const a = bladeSection(b, 0);
    const c = bladeSection(plain, 0);
    a.outside.forEach((p, j) => expect(p.y).toBeCloseTo(c.outside[j]!.y, 12));
  });

  it('takes the section’s shape on its row: symmetric about the centre plane', () => {
    const sb = smoothBladeOf(prepareBlade(d));
    const row = d.slices[0]!.height * sb.sTip;
    for (const x of [0.1, 0.3, 0.6, 0.9]) {
      const [o, n] = sb.foil(row, x);
      expect(o).toBeCloseTo(-n, 6);
    }
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
