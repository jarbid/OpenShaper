// SPDX-License-Identifier: GPL-3.0-or-later
/** Toe correction: the blade turned on its tab about the root's thickest point. */
import { describe, expect, it } from 'vitest';
import { bladeSection, prepareBlade, rootThickestFaces, toeTurn } from './blade';
import { defaultFinDesign } from './fin-defaults';
import { FIN_MAX_TOE, type FinHand } from './fin-design';
import { finMesh } from './fin-mesh';
import { validateFinDesign } from './fin-rules';

const fin = (hand: FinHand, toe: number) => ({ ...defaultFinDesign('side', hand), toe });
const leRoot = (hand: FinHand, toe: number) =>
  bladeSection(prepareBlade(fin(hand, toe)), 0).outside[0]!;

describe('toe', () => {
  it('turns the leading edge toward the stringer on either side', () => {
    // A left fin's outside face is +Y, so the stringer is toward −Y; a right fin's, +Y.
    expect(leRoot('left', 2).y).toBeLessThan(leRoot('left', 0).y);
    expect(leRoot('right', 2).y).toBeGreaterThan(leRoot('right', 0).y);
  });

  it('turns about the centre of the root’s thickest point, which stays put', () => {
    const b = prepareBlade(fin('left', 3));
    const t = toeTurn(b)!;
    const flat = prepareBlade(fin('left', 0));
    const faces = rootThickestFaces(flat);
    expect(t.y).toBeCloseTo((faces.outside + faces.inside) / 2, 6);
    // Any point turns by the toe about it: distances to the pivot are kept.
    const s0 = bladeSection(flat, 0.3 * flat.depth);
    const s1 = bladeSection(b, 0.3 * b.depth);
    s0.outside.forEach((p, j) => {
      const q = s1.outside[j]!;
      expect(Math.hypot(q.x - t.x, q.y - t.y)).toBeCloseTo(Math.hypot(p.x - t.x, p.y - t.y), 6);
    });
  });

  it('keeps a right fin the exact mirror of a left one', () => {
    const l = bladeSection(prepareBlade(fin('left', 2.5)), 4);
    const r = bladeSection(prepareBlade(fin('right', 2.5)), 4);
    l.outside.forEach((p, j) => {
      expect(r.outside[j]!.x).toBeCloseTo(p.x, 12);
      expect(r.outside[j]!.y).toBeCloseTo(-p.y, 12);
    });
  });

  it('is limited to ±5°', () => {
    expect(validateFinDesign(fin('left', FIN_MAX_TOE))).toEqual([]);
    expect(validateFinDesign(fin('left', -FIN_MAX_TOE))).toEqual([]);
    expect(validateFinDesign(fin('left', 5.25)).map((i) => i.code)).toContain('toe');
  });

  it('still meshes into a solid on the flat tab top', () => {
    const m = finMesh(fin('right', -4));
    let minZ = Infinity;
    for (let i = 2; i < m.blade.positions.length; i += 3)
      minZ = Math.min(minZ, m.blade.positions[i]!);
    expect(minZ).toBeCloseTo(0, 6);
  });
});
