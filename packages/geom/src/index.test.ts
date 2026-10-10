// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Smoke test and public-API pin for the scaffold.
 *
 * The runtime export list is pinned exactly: adding, renaming or removing a
 * public value fails here until this list is updated in the same diff
 * (docs/design/geom-core.md, decision 40). The scaffold exports types only, so
 * the list is empty; each build step extends it.
 *
 * The type-level checks run under `tsc` (`pnpm typecheck` type-checks tests):
 * they pin the conventions the core types encode, so loosening one of them
 * fails the typecheck rather than passing silently.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as geom from './index';
import type {
  Basis,
  ClampedCurve,
  NurbsCurve,
  Point2,
  Point3,
  PointOf,
  ReadonlyF64,
  Result,
  TrimLoop,
} from './index';

/** Every runtime (value) export of `@openshaper/geom`, sorted. */
const PUBLIC_VALUES: readonly string[] = [];

describe('@openshaper/geom public API', () => {
  it('exports exactly the pinned runtime values', () => {
    expect(Object.keys(geom).sort()).toEqual([...PUBLIC_VALUES].sort());
  });
});

describe('core types', () => {
  it('reads typed arrays read-only but accepts mutable ones', () => {
    expectTypeOf<Float64Array>().toExtend<ReadonlyF64>();
    expectTypeOf<ReadonlyF64>().not.toHaveProperty('set');
    expectTypeOf<ReadonlyF64>().not.toHaveProperty('fill');
    expectTypeOf<ReadonlyF64>().not.toHaveProperty('subarray');
    expectTypeOf<ReadonlyF64>().toHaveProperty('length').toEqualTypeOf<number>();
  });

  it('maps a dimension to its point type', () => {
    expectTypeOf<PointOf<1>>().toEqualTypeOf<number>();
    expectTypeOf<PointOf<2>>().toEqualTypeOf<Point2>();
    expectTypeOf<PointOf<3>>().toEqualTypeOf<Point3>();
  });

  it('keeps points structurally compatible with the kernel (Vec2, Vert3)', () => {
    expectTypeOf<{ x: number; y: number }>().toExtend<Point2>();
    expectTypeOf<{ x: number; y: number; z: number }>().toExtend<Point3>();
  });

  it('only lets factories produce validated values', () => {
    // A hand-built literal lacks the compile-time brand.
    expectTypeOf<{
      dim: 2;
      basis: Basis;
      cw: Float64Array;
      rational: false;
    }>().not.toExtend<NurbsCurve<2>>();
  });

  it('keeps pcurves and space curves apart', () => {
    expectTypeOf<ClampedCurve<2>>().toExtend<TrimLoop['curves'][number]>();
    expectTypeOf<ClampedCurve<3>>().not.toExtend<TrimLoop['curves'][number]>();
  });

  it('separates success from failure in Result', () => {
    const narrow = (r: Result<number>): number => (r.ok ? r.value : r.issues.length);
    expect(narrow({ ok: true, value: 3, issues: [] })).toBe(3);
    expect(
      narrow({ ok: false, issues: [{ code: 'unsupported', severity: 'error', message: 'x' }] }),
    ).toBe(1);
  });
});
