// SPDX-License-Identifier: GPL-3.0-or-later
/** Cant and toe changed at a slice: the upper blade bent and twisted. */
import { describe, expect, it } from 'vitest';
import { RAD_TO_DEG } from '../constants';
import {
  FIN_SLICE_REACH,
  bladeSection,
  cosineStations,
  prepareBlade,
  thicknessAt,
  twistAt,
} from './blade';
import { defaultFinDesign } from './fin-defaults';
import type { FinDesign } from './fin-design';
import { finMesh } from './fin-mesh';
import { validateFinDesign } from './fin-rules';

const base = { ...defaultFinDesign('side', 'left'), cant: 7 };
/** A slice at 60% with 12° cant and 1° less toe, eased in over the 15% below it. */
const twisted: FinDesign = {
  ...base,
  slices: [{ height: 0.6, section: base.section, twist: { cant: 12, toe: -1 } }],
};

describe('twistAt', () => {
  it('keeps the fin’s cant and toe below the slice’s reach, the slice’s from it up, eased between', () => {
    expect(twistAt(twisted, 0)).toEqual({ cant: 7, toe: 0 });
    expect(twistAt(twisted, 0.3)).toEqual({ cant: 7, toe: 0 }); // well below: untouched
    expect(twistAt(twisted, 0.8)).toEqual({ cant: 12, toe: -1 });
    const mid = twistAt(twisted, 0.6 - FIN_SLICE_REACH / 2);
    expect(mid.cant).toBeCloseTo(9.5, 12); // halfway through its reach: halfway
    expect(mid.toe).toBeCloseTo(-0.5, 12);
  });

  it('eases with no kink where its reach starts or at the slice', () => {
    const slope = (eta: number) =>
      (twistAt(twisted, eta + 1e-6).cant - twistAt(twisted, eta - 1e-6).cant) / 2e-6;
    expect(Math.abs(slope(0.6 - FIN_SLICE_REACH))).toBeLessThan(1e-3);
    expect(Math.abs(slope(0.6))).toBeLessThan(1e-3);
  });

  it('is valid, and checks the slice’s values', () => {
    expect(validateFinDesign(twisted)).toEqual([]);
    const bad = (twist: { cant: number; toe: number }) =>
      validateFinDesign({ ...twisted, slices: [{ ...twisted.slices[0]!, twist }] }).map(
        (i) => i.code,
      );
    expect(bad({ cant: -25, toe: 0 })).toContain('cant');
    expect(bad({ cant: -15, toe: 0 })).toEqual([]); // negative is allowed
    expect(bad({ cant: 7, toe: 6 })).toContain('toe');
  });
});

describe('the bent, twisted blade', () => {
  const b0 = prepareBlade(base);
  const b = prepareBlade(twisted);

  it('is unchanged at the root', () => {
    const h = 0;
    const s = bladeSection(b, h);
    const s0 = bladeSection(b0, h);
    s.outside.forEach((p, j) => {
      expect(p.x).toBeCloseTo(s0.outside[j]!.x, 9);
      expect(p.y).toBeCloseTo(s0.outside[j]!.y, 9);
    });
  });

  it('leans at the slice’s cant above it', () => {
    // A flat inside face: its lean between two heights above the slice is the cant.
    // The slice also turns its sections a degree, so follow the drift of the inside
    // face's mean rather than one station.
    const meanY = (s: ReturnType<typeof bladeSection>) =>
      s.inside.reduce((t, p) => t + p.y, 0) / s.inside.length;
    const a = bladeSection(b, 0.65 * b.depth);
    const c = bladeSection(b, 0.75 * b.depth);
    const lean = Math.atan2(meanY(c) - meanY(a), c.height - a.height) * RAD_TO_DEG;
    // Within a quarter degree: the toe turns each section about its own centre, which
    // drifts a little along the chord up the sweep.
    expect(Math.abs(lean - 12)).toBeLessThan(0.25);
  });

  it('turns its sections by the slice’s toe: the chord a degree toward toe out', () => {
    const chordAngle = (bl: ReturnType<typeof prepareBlade>) => {
      const s = bladeSection(bl, 0.8 * bl.depth);
      const le = s.inside[0]!;
      const te = s.inside[s.inside.length - 1]!;
      return Math.atan2(le.y - te.y, le.x - te.x) * RAD_TO_DEG;
    };
    // A left fin's stringer is −Y: toe out turns the leading edge toward +Y.
    expect(chordAngle(b) - chordAngle(b0)).toBeCloseTo(1, 6);
  });

  it('keeps the taper’s thickness square to the blade, at the slice’s cant', () => {
    const h = 0.8 * b.depth;
    const s = bladeSection(b, h, cosineStations(2000));
    const widest = Math.max(
      ...s.outside.map((p, j) => Math.hypot(p.x - s.inside[j]!.x, p.y - s.inside[j]!.y)),
    );
    // Within the sweep's lean: up here its sections cross a horizontal cut at a slant.
    expect(
      Math.abs((widest * Math.cos((12 * Math.PI) / 180)) / thicknessAt(b, h) - 1),
    ).toBeLessThan(0.1);
  });

  it('meshes', () => {
    const m = finMesh(twisted);
    expect(m.blade.indices.length).toBeGreaterThan(0);
  });
});
