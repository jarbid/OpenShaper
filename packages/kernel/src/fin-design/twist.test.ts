// SPDX-License-Identifier: GPL-3.0-or-later
/** Cant lines: the blade bending and twisting from a level line up. */
import { describe, expect, it } from 'vitest';
import { RAD_TO_DEG } from '../constants';
import { FIN_SLICE_REACH, bladeSection, prepareBlade, twistAt } from './blade';
import { fairness } from './fairness';
import { defaultFinDesign } from './fin-defaults';
import type { FinDesign } from './fin-design';
import { finMesh } from './fin-mesh';
import { validateFinDesign } from './fin-rules';
import { smoothBladeOf, smoothSampler } from './smooth-blade';

const base = { ...defaultFinDesign('side', 'left'), cant: 7 };
/** A line at 50% going to 12° cant and 1° less toe. */
const twisted: FinDesign = { ...base, cantLines: [{ height: 0.5, cant: 12, toe: -1 }] };

describe('twistAt', () => {
  it('keeps the fin’s cant and toe up to the line, eases going up, then holds', () => {
    expect(twistAt(twisted, 0)).toEqual({ cant: 7, toe: 0 });
    expect(twistAt(twisted, 0.5)).toEqual({ cant: 7, toe: 0 });
    expect(twistAt(twisted, 0.9)).toEqual({ cant: 12, toe: -1 });
    const mid = twistAt(twisted, 0.5 + FIN_SLICE_REACH / 2);
    expect(mid.cant).toBeCloseTo(9.5, 12);
    expect(mid.toe).toBeCloseTo(-0.5, 12);
  });

  it('has reached the line’s values by the next line', () => {
    const two = {
      ...base,
      cantLines: [
        { height: 0.5, cant: 12, toe: 0 },
        { height: 0.55, cant: 3, toe: 0 },
      ],
    };
    expect(twistAt(two, 0.55).cant).toBeCloseTo(12, 9);
    expect(twistAt(two, 0.9).cant).toBeCloseTo(3, 9);
  });

  it('is valid, and checks each line', () => {
    expect(validateFinDesign(twisted)).toEqual([]);
    const bad = (cant: number, toe: number, height = 0.5) =>
      validateFinDesign({ ...base, cantLines: [{ height, cant, toe }] }).map((i) => i.code);
    expect(bad(-25, 0)).toContain('cant');
    expect(bad(-15, 0)).toEqual([]);
    expect(bad(7, 6)).toContain('toe');
    expect(bad(7, 0, 1)).toContain('cant-line-height');
  });
});

describe('the bent, twisted blade', () => {
  const noToe: FinDesign = { ...base, cantLines: [{ height: 0.5, cant: 12, toe: 0 }] };
  const b0 = prepareBlade(base);
  const b = prepareBlade(noToe);

  it('is the same below the line', () => {
    const s = bladeSection(b, 0.45 * b.depth);
    const s0 = bladeSection(b0, 0.45 * b.depth);
    s.outside.forEach((p, j) => {
      expect(p.x).toBeCloseTo(s0.outside[j]!.x, 9);
      expect(p.y).toBeCloseTo(s0.outside[j]!.y, 9);
    });
  });

  it('bends level: a cut at one height moves across the blade by one amount', () => {
    // Owner testing: bent along control sections, the bend ran across the water flow.
    for (const eta of [0.6, 0.8]) {
      const h = eta * b.depth;
      const s = bladeSection(b, h);
      const s0 = bladeSection(b0, h);
      const shifts = s.inside.map((p, j) => p.y - s0.inside[j]!.y);
      expect(Math.max(...shifts) - Math.min(...shifts)).toBeLessThan(0.05);
      expect(shifts[10]!).toBeGreaterThan(0.01);
    }
  });

  it('leans out at the extra cant, above the line', () => {
    const y = (eta: number) => bladeSection(b, eta * b.depth).inside[10]!.y;
    const lean = Math.atan2(y(0.85) - y(0.7), 0.15 * b.depth) * RAD_TO_DEG;
    expect(Math.abs(lean - 12)).toBeLessThan(1.5);
  });

  it('turns the blade above the line by the toe, about the line’s axis', () => {
    const angle = (d: FinDesign) => {
      const sb = smoothBladeOf(prepareBlade(d));
      const h = 0.85 * sb.blade.depth;
      const s = bladeSection(sb.blade, h);
      const le = s.inside[0]!;
      const te = s.inside[s.inside.length - 1]!;
      return Math.atan2(le.y - te.y, le.x - te.x) * RAD_TO_DEG;
    };
    // Against the same line with no toe: toe out turns the leading edge toward +Y.
    expect(angle(twisted) - angle(noToe)).toBeCloseTo(1, 1);
  });

  it('stays smooth, and meshes', () => {
    expect(fairness(smoothSampler(twisted)).creases).toEqual([]);
    expect(finMesh(twisted).blade.indices.length).toBeGreaterThan(0);
  });
});
