// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The DOF map `x = T z + x_fixed` (design §10.3), checked by construction:
 * every rule's `T` rows and `x_fixed` are what its formula says, evaluated
 * on random `z` (`x = T z + x_fixed` reproduces the rule for any `z`, which is
 * what "exact by construction" means); conflicts and cycles throw; the
 * separability flag follows the structure.
 *
 * Tolerances: rules whose `T` entries are 0/±1 hold bitwise (`===`) by
 * construction; reflections in a general plane and diagonal slides hold to
 * the rounding of a 3-term dot product on unit-size numbers: `1e-14`.
 */
import { describe, expect, it } from 'vitest';
import {
  bezierSurface,
  clampedBasis,
  clampedUniformKnots,
  isGeomError,
  makeCurve,
  makeDofMap,
} from '../index';
import type { DofMap, DofRule } from '../index';
import { mulberry32 } from '../testing';

const ROUND = 1e-14;

/** `x = T z + x_fixed` for a random `z`. */
function apply(map: DofMap, z: Float64Array): Float64Array {
  const x = new Float64Array(map.fixed.length);
  for (let r = 0; r < x.length; r++) {
    let s = map.fixed[r]!;
    for (let q = map.rowPtr[r]!; q < map.rowPtr[r + 1]!; q++) s += map.val[q]! * z[map.col[q]!]!;
    x[r] = s;
  }
  return x;
}

function net(rng: () => number): ReturnType<typeof bezierSurface> {
  const pts = Array.from({ length: 4 * 3 * 3 }, () => 2 * rng() - 1);
  return bezierSurface(pts, 4, 3);
}

describe('makeDofMap', () => {
  it('no rules: T = I, x_fixed = the control points, separable', () => {
    const s = net(mulberry32(1));
    const m = makeDofMap(s, []);
    expect(m.dofCount).toBe(36);
    expect(m.dim).toBe(3);
    expect(m.separable).toBe(true);
    for (let r = 0; r < 36; r++) {
      expect(m.rowPtr[r + 1]! - m.rowPtr[r]!).toBe(1);
      expect(m.col[m.rowPtr[r]!]).toBe(r);
      expect(m.val[m.rowPtr[r]!]).toBe(1);
    }
    for (let i = 0; i < 12; i++)
      for (let c = 0; c < 3; c++) expect(m.fixed[i * 3 + c]).toBe(s.cw[i * 4 + c]);
  });

  it('fix and fixAxes pin coordinates bitwise; the others stay free', () => {
    const rng = mulberry32(2);
    const s = net(rng);
    const m = makeDofMap(s, [
      { kind: 'fix', cp: 0 },
      { kind: 'fixAxes', cp: 5, axes: 4 },
      { kind: 'fixAxes', cp: 5, axes: 1 },
    ]);
    expect(m.dofCount).toBe(36 - 3 - 2);
    const z = Float64Array.from({ length: m.dofCount }, () => rng());
    const x = apply(m, z);
    for (let c = 0; c < 3; c++) expect(x[c]).toBe(s.cw[c]);
    expect(x[15]).toBe(s.cw[20]);
    expect(x[17]).toBe(s.cw[22]);
    expect(x[16]).not.toBe(s.cw[21]);
    expect(m.separable).toBe(true);
  });

  it('mirror in a coordinate plane: −1 entries, x_fixed reflected, exact for every z', () => {
    const rng = mulberry32(3);
    const s = net(rng);
    const rules: DofRule[] = [
      { kind: 'mirror', cp: 3, master: 0, plane: { normal: { x: 0, y: -2, z: 0 }, d: 0 } },
      { kind: 'mirror', cp: 4, master: 1, plane: { normal: { x: 0, y: 0, z: 3 }, d: 1.5 } }, // z = 0.5
    ];
    const m = makeDofMap(s, rules);
    expect(m.separable).toBe(true);
    const z = Float64Array.from({ length: m.dofCount }, () => rng());
    const x = apply(m, z);
    expect(x[9]).toBe(x[0]);
    expect(x[10]).toBe(-x[1]!);
    expect(x[11]).toBe(x[2]);
    expect(x[12]).toBe(x[3]);
    expect(x[13]).toBe(x[4]);
    expect(Math.abs(x[14]! - (1 - x[5]!))).toBeLessThanOrEqual(ROUND);
    // At z = 0 the mirrored point is the reflection of its master's reference.
    expect(m.fixed[10]).toBe(-s.cw[1]!);
  });

  it('general mirror, slide, offsetFrom and copy: formulas hold for every z', () => {
    const rng = mulberry32(4);
    const s = net(rng);
    const n = { x: 1, y: 2, z: -2 }; // |n| = 3
    const d = 0.6;
    const dir = { x: 1, y: 1, z: 0 };
    const rules: DofRule[] = [
      { kind: 'mirror', cp: 6, master: 2, plane: { normal: n, d } },
      { kind: 'slide', cp: 7, dirs: [dir] },
      { kind: 'offsetFrom', cp: 8, master: 7, dirs: [{ x: 0, y: 0, z: 1 }] },
      { kind: 'copy', cp: 9, master: 8, offset: { x: 0.25, y: 0, z: 0 } },
      { kind: 'copy', cp: 10, master: 6 },
    ];
    const m = makeDofMap(s, rules);
    expect(m.separable).toBe(false); // the general mirror and the diagonal slide couple axes
    for (let t = 0; t < 5; t++) {
      const z = Float64Array.from({ length: m.dofCount }, () => 4 * rng() - 2);
      const x = apply(m, z);
      const P = (i: number): number[] => [x[3 * i]!, x[3 * i + 1]!, x[3 * i + 2]!];
      const ref = (i: number): number[] => [s.cw[4 * i]!, s.cw[4 * i + 1]!, s.cw[4 * i + 2]!];
      // mirror: P6 = P2 − 2 (n̂·P2 − d̂) n̂
      const nh = [n.x / 3, n.y / 3, n.z / 3];
      const p2 = P(2);
      const k = 2 * (nh[0]! * p2[0]! + nh[1]! * p2[1]! + nh[2]! * p2[2]! - d / 3);
      P(6).forEach((v, c) =>
        expect(Math.abs(v - (p2[c]! - k * nh[c]!))).toBeLessThanOrEqual(ROUND),
      );
      // slide: P7 − ref7 ∥ (1, 1, 0)
      const d7 = P(7).map((v, c) => v - ref(7)[c]!);
      expect(Math.abs(d7[0]! - d7[1]!)).toBeLessThanOrEqual(ROUND);
      expect(d7[2]).toBe(0);
      // offsetFrom: P8 − P7 = (ref8 − ref7) + s ẑ
      const o = P(8).map((v, c) => v - P(7)[c]! - (ref(8)[c]! - ref(7)[c]!));
      expect(Math.abs(o[0]!)).toBeLessThanOrEqual(ROUND);
      expect(Math.abs(o[1]!)).toBeLessThanOrEqual(ROUND);
      // copies
      P(9).forEach((v, c) =>
        expect(Math.abs(v - P(8)[c]! - (c === 0 ? 0.25 : 0))).toBeLessThanOrEqual(ROUND),
      );
      expect(P(10)).toEqual(P(6));
    }
  });

  it('separable slides along an axis; a 2D curve reads x, y of directions', () => {
    const c = makeCurve({
      dim: 2,
      basis: clampedBasis(2, clampedUniformKnots(2, 5)),
      points: [0, 0, 1, 2, 2, 0, 3, 1, 4, 0],
    });
    const m = makeDofMap(c, [
      { kind: 'slide', cp: 1, dirs: [{ x: 0, y: 1, z: 99 }] },
      { kind: 'mirror', cp: 3, master: 1, plane: { normal: { x: 1, y: 0, z: 0 }, d: 2 } },
    ]);
    expect(m.dim).toBe(2);
    expect(m.separable).toBe(true);
    const x = apply(
      m,
      Float64Array.from({ length: m.dofCount }, (_, i) => i + 0.5),
    );
    expect(x[2]).toBe(1); // slide along y keeps x
    expect(x[6]).toBe(4 - x[2]!); // x = 2 plane
    expect(x[7]).toBe(x[3]);
  });

  it('throws on a coordinate claimed twice, a cycle, bad indices and bad directions', () => {
    const s = net(mulberry32(5));
    const code = (rules: DofRule[]): string | undefined => {
      try {
        makeDofMap(s, rules);
      } catch (e) {
        return isGeomError(e) ? e.code : 'other';
      }
      return undefined;
    };
    expect(
      code([
        { kind: 'fix', cp: 1 },
        { kind: 'fixAxes', cp: 1, axes: 2 },
      ]),
    ).toBe('conflicting-dof-rules');
    expect(
      code([
        { kind: 'fixAxes', cp: 1, axes: 3 },
        { kind: 'fixAxes', cp: 1, axes: 2 },
      ]),
    ).toBe('conflicting-dof-rules');
    expect(
      code([
        { kind: 'copy', cp: 1, master: 2 },
        { kind: 'copy', cp: 2, master: 3 },
        { kind: 'copy', cp: 3, master: 1 },
      ]),
    ).toBe('conflicting-dof-rules');
    expect(code([{ kind: 'fix', cp: 12 }])).toBe('size-mismatch');
    expect(code([{ kind: 'slide', cp: 1, dirs: [{ x: 0, y: 0, z: 0 }] }])).toBe('unsupported');
    expect(
      code([{ kind: 'mirror', cp: 1, master: 0, plane: { normal: { x: 0, y: 0, z: 0 }, d: 0 } }]),
    ).toBe('unsupported');
    expect(code([{ kind: 'fixAxes', cp: 1, axes: 8 }])).toBe('unsupported');
  });
});
