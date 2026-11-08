// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bladeSection, chordAt, cosineStations, prepareBlade } from './blade';
import { defaultFinDesign } from './fin-defaults';
import { finMesh } from './fin-mesh';
import { measureSlice, sliceMesh } from './mesh-slice';

/** A fine mesh, so the cut follows the surface closely. */
const mesh = (d = defaultFinDesign('centre')) =>
  finMesh(d, { rows: 160, stations: 96, tipGap: 0.01, arcTolerance: 0.001 });

describe('cutting the fin with a plane', () => {
  it('cuts each crossed triangle once, on the plane', () => {
    const m = mesh();
    for (const [axis, at] of [
      ['z', 4],
      ['x', 3],
    ] as const) {
      const s = sliceMesh(m.blade, axis, at);
      expect(s.length % 6).toBe(0);
      expect(s.length).toBeGreaterThan(0);
      const k = axis === 'x' ? 0 : 2;
      for (let i = k; i < s.length; i += 3) expect(s[i]).toBeCloseTo(at, 5);
    }
  });

  it('misses the blade above its tip', () => {
    expect(sliceMesh(mesh().blade, 'z', 50)).toEqual([]);
    expect(measureSlice([], 'z')).toBeNull();
  });

  it('measures a horizontal cut as the foil there: its chord and thickness', () => {
    const d = defaultFinDesign('centre'); // upright: no cant to widen the cut
    const b = prepareBlade(d);
    for (const h of [1, 4, 7]) {
      const m = measureSlice(sliceMesh(mesh(d).blade, 'z', h), 'z')!;
      const { leading, trailing } = chordAt(b, h);
      expect(m.length).toBeCloseTo(leading - trailing, 2);
      // The section's thickest point, to within the mesh.
      const s = bladeSection(b, h, cosineStations(400));
      const widest = Math.max(...s.outside.map((p, j) => p.y - s.inside[j]!.y));
      expect(m.thickness).toBeCloseTo(widest, 2);
    }
  });

  it('measures an upright cut as the blade there: its height and greatest thickness', () => {
    const d = defaultFinDesign('centre');
    const b = prepareBlade(d);
    const { leading, trailing } = chordAt(b, 0);
    const x = (leading + trailing) / 2;
    const m = measureSlice(sliceMesh(mesh(d).blade, 'x', x), 'x')!;
    // Upright fin: no taller than the blade, and thickest at the root, where the root
    // foil is as wide as its two faces at x.
    expect(m.length).toBeGreaterThan(0);
    expect(m.length).toBeLessThanOrEqual(b.depth);
    const s0 = bladeSection(b, 0);
    const widthAt = (px: number) => {
      const xs = s0.outside.map((p) => p.x);
      const j = xs.findIndex((v, n) => n > 0 && (xs[n - 1]! - px) * (v - px) <= 0);
      const f = (px - xs[j - 1]!) / (xs[j]! - xs[j - 1]!);
      const y = (pts: typeof s0.outside) => pts[j - 1]!.y + (pts[j]!.y - pts[j - 1]!.y) * f;
      return y(s0.outside) - y(s0.inside);
    };
    expect(m.thickness).toBeCloseTo(widthAt(x), 2);
  });
});
