// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Skinning oracles (design §16, `fit` row; P&T §10.3):
 *
 * - **sections reproduced**: the iso-curve at each section's parameter is the
 *   section (sampled densely), rational sections included, and the reported
 *   `maxError` bounds what sampling measures;
 * - **exact analytic case**: circles whose radius is an affine function of
 *   their height skin into an exact cone, because the interpolation across the
 *   sections reproduces affine functions of the data (every homogeneous
 *   coordinate is affine in the height);
 * - **compatibility**: sections of different degrees and knots are reproduced
 *   after `makeCompatible`;
 * - **periodic**: a closed ring of sections gives a surface periodic across
 *   them that still passes through every section.
 *
 * Tolerances ("scale" = the sections' extent): sections `1e-12 · scale`
 * (one collocation solve, condition ~10, plus rational evaluation); the cone
 * `1e-12 · scale` (same arithmetic at a random point); honesty: sampled ≤
 * reported + `64 ε · scale` (the bound is on control points; sampling adds the
 * evaluation's rounding).
 */
import { describe, expect, it } from 'vitest';
import {
  circle,
  curvePoint,
  isGeomError,
  isoCurve,
  periodicCircle,
  skinCurves,
  surfacePoint,
} from '../index';
import type { GeomErrorCode, NurbsCurve, Point3 } from '../index';
import { mulberry32, randomCurve } from '../testing';

const SECTION = 1e-12;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e, code), String(e)).toBe(true);
    return;
  }
  throw new Error(`expected GeomError ${code}`);
}

/** Max distance between the surface's iso-curve at `v` and `section`, sampled. */
function sectionGap(
  s: ReturnType<typeof skinCurves>['surface'],
  v: number,
  section: NurbsCurve<3>,
): number {
  const iso = isoCurve(s, 'v', v);
  const [a, b] = section.basis.domain;
  let e = 0;
  for (let i = 0; i <= 400; i++) {
    const t = a + ((b - a) * i) / 400;
    const p = curvePoint(iso, t);
    const q = curvePoint(section, t);
    e = Math.max(e, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  return e;
}

const X: Point3 = { x: 1, y: 0, z: 0 };
const Y: Point3 = { x: 0, y: 1, z: 0 };

describe('skinCurves', () => {
  it('skins circles of affinely varying radius into an exact cone', () => {
    const rng = mulberry32(61);
    const zs = [0, 0.7, 1.1, 2.4, 3, 4.2];
    const r = (z: number): number => 1 + 0.5 * z;
    const sections = zs.map((z) => circle({ x: 0, y: 0, z }, X, Y, r(z)));
    const sk = skinCurves(sections);
    expect(sk.surface.u.degree).toBe(2);
    expect(sk.surface.v.degree).toBe(3);
    expect(sk.surface.rational).toBe(true);
    const scale = 2 * r(4.2) + 4.2;
    for (let k = 0; k < zs.length; k++) {
      expect(sectionGap(sk.surface, sk.params[k]!, sections[k]!)).toBeLessThanOrEqual(
        SECTION * scale,
      );
    }
    expect(sk.maxError).toBeLessThanOrEqual(SECTION * scale);
    for (let i = 0; i < 300; i++) {
      const x = surfacePoint(sk.surface, rng(), rng());
      expect(Math.abs(Math.hypot(x.x, x.y) - r(x.z))).toBeLessThanOrEqual(SECTION * scale);
    }
    expect(sk.params[0]).toBe(0);
    expect(sk.params[zs.length - 1]).toBe(1);
  });

  it('reproduces incompatible random sections, with an honest reported error', () => {
    const rng = mulberry32(62);
    // Moderate weight ranges: interpolating very different weights across the
    // sections can overshoot to a non-positive weight (P&T §10.3), which throws.
    for (const weightRange of [undefined, [0.8, 1.25] as const]) {
      const sections = [2, 3, 4, 3, 2].map(
        (degree, k) =>
          randomCurve(rng, { dim: 3, degree, count: degree + 3 + k, weightRange }) as NurbsCurve<3>,
      );
      for (const params of ['chord', 'centripetal', [0, 0.1, 0.5, 0.6, 1]] as const) {
        const sk = skinCurves(sections, { params, degree: 3 });
        if (Array.isArray(params)) expect(Array.from(sk.params)).toEqual(params);
        let worst = 0;
        for (let k = 0; k < sections.length; k++) {
          worst = Math.max(worst, sectionGap(sk.surface, sk.params[k]!, sections[k]!));
        }
        expect(worst).toBeLessThanOrEqual(SECTION * 4);
        expect(worst).toBeLessThanOrEqual(sk.maxError + 64 * Number.EPSILON * 4);
      }
    }
  });

  it('closes across a periodic ring of sections', () => {
    // Circles around the z axis: a ring of eight sections of a torus.
    const sections: NurbsCurve<3>[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8;
      const c = { x: 3 * Math.cos(a), y: 3 * Math.sin(a), z: 0 };
      sections.push(
        periodicCircle(c, { x: Math.cos(a), y: Math.sin(a), z: 0 }, { x: 0, y: 0, z: 1 }, 1),
      );
    }
    const sk = skinCurves(sections, { periodic: true });
    expect(sk.surface.u.kind).toBe('periodic');
    expect(sk.surface.v.kind).toBe('periodic');
    expect(sk.surface.v.domain).toEqual([0, 1]);
    for (let k = 0; k < 8; k++) {
      expect(sectionGap(sk.surface, sk.params[k]!, sections[k]!)).toBeLessThanOrEqual(SECTION * 8);
    }
    // Across the seam v = 0 the surface is C² (cubic, periodic): compare one-sided limits.
    for (const u of [0.1, 0.45, 0.8]) {
      const below = surfacePoint(sk.surface, u, 1 - 1e-9);
      const at = surfacePoint(sk.surface, u, 0);
      expect(Math.hypot(below.x - at.x, below.y - at.y, below.z - at.z)).toBeLessThanOrEqual(1e-7);
    }
  });

  it('rejects what it cannot skin', () => {
    const c = circle({ x: 0, y: 0, z: 0 }, X, Y, 1);
    expectCode(() => skinCurves([c]), 'too-few-points');
    expectCode(() => skinCurves([c, c, c], { degree: 3 }), 'too-few-points');
    expectCode(() => skinCurves([c, c]), 'too-few-points');
    const c2 = circle({ x: 0, y: 0, z: 1 }, X, Y, 1);
    expectCode(() => skinCurves([c, c, c2]), 'schoenberg-whitney');
    const p = periodicCircle({ x: 0, y: 0, z: 1 }, X, Y, 1);
    expectCode(() => skinCurves([c, p]), 'unsupported');
  });
});
