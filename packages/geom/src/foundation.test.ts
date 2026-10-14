// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The foundation modules (design §6.1): tolerances, errors, scratch and the
 * `vec` helpers.
 *
 * Oracles: the documented defaults of design §7; exact small-integer vector
 * arithmetic (bitwise); `angleBetween` against angles known in closed form,
 * including near 0 and π where `acos` of a dot product loses half its digits;
 * affine composition against applying the two maps in turn; determinants of
 * maps with known orientation. Tolerances are stated per check.
 */
import { describe, expect, it } from 'vitest';
import {
  createScratch,
  DEFAULT_TOLERANCES,
  GeomError,
  isGeomError,
  issueOf,
  resolveTolerances,
  scaleTolerances,
  vec,
} from './index';
import type { Affine2, Affine3, GeomErrorCode } from './index';
import { mulberry32 } from './testing';

const EPS = Number.EPSILON;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected GeomError '${code}'`);
}

describe('tolerances', () => {
  it('has the defaults of design §7, frozen', () => {
    expect(DEFAULT_TOLERANCES).toEqual({
      point: 1e-6,
      fit: 1e-4,
      constraint: 1e-9,
      paramRel: 1e-12,
      knotRel: 1e-10,
      angle: 1e-9,
      cosine: 1e-12,
      degenerateRel: 1e-12,
      umbilicRel: 1e-10,
      pivotRel: 1e-12,
      quadRel: 1e-10,
      weightRatioMax: 1e6,
      newtonMaxIter: 32,
      quadMaxSplits: 4096,
    });
    expect(Object.isFrozen(DEFAULT_TOLERANCES)).toBe(true);
  });

  it('merges overrides without touching the defaults', () => {
    expect(resolveTolerances()).toBe(DEFAULT_TOLERANCES);
    const t = resolveTolerances({ point: 1e-3, newtonMaxIter: 8 });
    expect(t.point).toBe(1e-3);
    expect(t.newtonMaxIter).toBe(8);
    expect(t.fit).toBe(DEFAULT_TOLERANCES.fit);
    expect(DEFAULT_TOLERANCES.point).toBe(1e-6);
    expect(Object.isFrozen(t)).toBe(true);
    expect(resolveTolerances({ point: undefined }).point).toBe(DEFAULT_TOLERANCES.point);
  });

  it('rejects unknown, non-finite, non-positive and fractional-count entries', () => {
    expectCode(() => resolveTolerances({ pointt: 1 } as never), 'unsupported');
    expectCode(() => resolveTolerances({ point: NaN }), 'non-finite');
    expectCode(() => resolveTolerances({ point: Infinity }), 'non-finite');
    expectCode(() => resolveTolerances({ point: 0 }), 'unsupported');
    expectCode(() => resolveTolerances({ quadRel: -1 }), 'unsupported');
    expectCode(() => resolveTolerances({ newtonMaxIter: 2.5 }), 'unsupported');
  });

  it('scales the length entries only', () => {
    const mm = scaleTolerances(DEFAULT_TOLERANCES, 10);
    expect(mm.point).toBe(DEFAULT_TOLERANCES.point * 10);
    expect(mm.fit).toBe(DEFAULT_TOLERANCES.fit * 10);
    expect(mm.constraint).toBe(DEFAULT_TOLERANCES.constraint * 10);
    for (const k of ['paramRel', 'knotRel', 'angle', 'quadRel', 'newtonMaxIter'] as const) {
      expect(mm[k]).toBe(DEFAULT_TOLERANCES[k]);
    }
    expectCode(() => scaleTolerances(DEFAULT_TOLERANCES, 0), 'unsupported');
  });
});

describe('errors', () => {
  it('carries a code and frozen details; isGeomError narrows by code', () => {
    const e = new GeomError('knot-count', 'too few knots', { index: 3, value: 2 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('GeomError');
    expect(Object.isFrozen(e.details)).toBe(true);
    expect(isGeomError(e)).toBe(true);
    expect(isGeomError(e, 'knot-count')).toBe(true);
    expect(isGeomError(e, 'non-finite')).toBe(false);
    expect(isGeomError(new Error('x'))).toBe(false);
  });

  it('issueOf gives a plain, cloneable issue with the typed locations', () => {
    const e = new GeomError('trim-not-closed', 'gap', {
      index: 2,
      t: 0.5,
      uv: { u: 1, v: 2 },
      point: { x: 1, y: 2, z: 3 },
      coedge: [0, 1, 2],
      value: 1e-3,
      ignored: 'text',
      edge: 'not a number',
    });
    const issue = issueOf(e);
    expect(issue).toEqual({
      code: 'trim-not-closed',
      severity: 'error',
      message: 'gap',
      at: { index: 2, t: 0.5, uv: { u: 1, v: 2 }, point: { x: 1, y: 2, z: 3 }, coedge: [0, 1, 2] },
      value: 1e-3,
    });
    expect(structuredClone(issue)).toEqual(issue);
    expect(issueOf(new GeomError('unsupported', 'x'))).toEqual({
      code: 'unsupported',
      severity: 'error',
      message: 'x',
    });
  });
});

describe('scratch', () => {
  it('reports its capacity and rejects invalid capacities', () => {
    const s = createScratch({ maxDegree: 5 });
    expect(s.maxDegree).toBe(5);
    expect(s.maxDerivs).toBe(3);
    expect(createScratch({ maxDegree: 2, maxDerivs: 1 }).maxDerivs).toBe(1);
    expectCode(() => createScratch({ maxDegree: 1.5 }), 'invalid-degree');
    expectCode(() => createScratch({ maxDegree: 3, maxDerivs: -1 }), 'unsupported');
  });
});

describe('vec', () => {
  const a = { x: 1, y: -2, z: 3 };
  const b = { x: 4, y: 5, z: -6 };

  it('does exact small-integer arithmetic in 2D and 3D (bitwise)', () => {
    expect(vec.add(a, b)).toEqual({ x: 5, y: 3, z: -3 });
    expect(vec.sub(a, b)).toEqual({ x: -3, y: -7, z: 9 });
    expect(vec.scale(a, -2)).toEqual({ x: -2, y: 4, z: -6 });
    expect(vec.dot(a, b)).toBe(4 - 10 - 18);
    expect(vec.cross(a, b)).toEqual({ x: 12 - 15, y: 12 + 6, z: 5 + 8 });
    expect(vec.cross({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(vec.norm({ x: 3, y: 4 })).toBe(5);
    expect(vec.norm({ x: 2, y: 3, z: 6 })).toBe(7);
    expect(vec.distance({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(5);
    expect(vec.lerp(a, b, 0.5)).toEqual({ x: 2.5, y: 1.5, z: -1.5 });
    expect(vec.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });

  it('normalize returns a unit vector, or null at (or below) the tolerance', () => {
    expect(vec.normalize({ x: 0, y: 3, z: 4 })).toEqual({ x: 0, y: 0.6, z: 0.8 });
    expect(vec.normalize({ x: 0, y: 0 })).toBeNull();
    expect(vec.normalize({ x: 1e-3, y: 0 }, 1e-3)).toBeNull();
    expect(vec.normalize({ x: Infinity, y: 0 })).toBeNull();
    expect(vec.normalize({ x: NaN, y: 0 })).toBeNull();
  });

  it('angleBetween is accurate near 0 and π, where acos is not', () => {
    // Exact angle δ between (1, 0) and (cos δ, sin δ): relative error ~ε, not ~√ε.
    for (const d of [1e-12, 1e-8, 0.3, Math.PI / 2, 3]) {
      const u = { x: Math.cos(d), y: Math.sin(d) };
      expect(Math.abs(vec.angleBetween({ x: 1, y: 0 }, u) - d)).toBeLessThanOrEqual(4 * EPS * d);
      const u3 = { x: Math.cos(d), y: 0, z: Math.sin(d) };
      expect(Math.abs(vec.angleBetween({ x: 1, y: 0, z: 0 }, u3) - d)).toBeLessThanOrEqual(
        4 * EPS * d,
      );
    }
    expect(vec.angleBetween({ x: 1, y: 0 }, { x: -1, y: 0 })).toBe(Math.PI);
  });

  it('composeAffine3 equals applying b, then a; determinants carry orientation', () => {
    const rng = mulberry32(7);
    const rand = (): number => 2 * rng() - 1;
    for (let trial = 0; trial < 20; trial++) {
      const A = Array.from({ length: 12 }, rand) as unknown as Affine3;
      const B = Array.from({ length: 12 }, rand) as unknown as Affine3;
      const p = { x: rand(), y: rand(), z: rand() };
      const direct = vec.applyAffine3(A, vec.applyAffine3(B, p));
      const composed = vec.applyAffine3(vec.composeAffine3(A, B), p);
      // Entries and points are O(1); ~12 products re-associated: 32 ε.
      expect(vec.distance(direct, composed)).toBeLessThanOrEqual(32 * EPS);
      // det(AB) = det(A)·det(B), entries O(1): 64 ε.
      const dAB = vec.affineDeterminant(vec.composeAffine3(A, B));
      expect(
        Math.abs(dAB - vec.affineDeterminant(A) * vec.affineDeterminant(B)),
      ).toBeLessThanOrEqual(64 * EPS);
    }
    const mirror: Affine3 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0];
    expect(vec.affineDeterminant(mirror)).toBe(-1);
    const m2: Affine2 = [2, 0, 1, 0, 3, -1];
    expect(vec.affineDeterminant(m2)).toBe(6);
    expect(vec.applyAffine2(m2, { x: 1, y: 1 })).toEqual({ x: 3, y: 2 });
  });
});
