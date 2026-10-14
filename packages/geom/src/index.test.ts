// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Smoke test and public-API pin for the scaffold.
 *
 * The runtime export list is pinned exactly: adding, renaming or removing a
 * public value fails here until this list is updated in the same diff
 * (docs/design/geom-core.md, decision 40). Each build step extends it; F1
 * added tolerances, errors, scratch, `vec`, bases, curves, curve measures,
 * quadrature and the exact curve primitives; F2 surfaces, surface measures,
 * sample plans and the exact surface primitives; A1 curve and surface
 * operations (insertion, refinement, removal, elevation, splitting,
 * compatibility) and `ruled`.
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
  NurbsSurface,
  Point2,
  Point3,
  PointOf,
  ReadonlyF64,
  Result,
  TrimLoop,
} from './index';

/** Every runtime (value) export of `@openshaper/geom`, sorted. */
const PUBLIC_VALUES: readonly string[] = [
  'DEFAULT_TOLERANCES',
  'GL_MAX_ORDER',
  'GeomError',
  'SAMPLE_DEGENERATE',
  'SAMPLE_UMBILIC',
  'arcLengthTable',
  'basisDersInto',
  'basisFunction',
  'basisFunsInto',
  'bezierCurve',
  'bezierSurface',
  'bilinearPatch',
  'boundaryCurve',
  'breakpoints',
  'changedControlPoints',
  'circle',
  'circle2',
  'circleArc',
  'clampUnclamped',
  'clampedBasis',
  'clampedUniformKnots',
  'conicArc',
  'controlPoint',
  'controlPointsInto',
  'controlWeight',
  'createScratch',
  'curveBounds',
  'curveCurvature',
  'curveCurvatureBatchInto',
  'curveDerivatives',
  'curveDomain',
  'curveEvalBatchInto',
  'curveEvalInto',
  'curveFrame',
  'curveFromHomogeneous',
  'curveLength',
  'curvePoint',
  'curveSignedCurvature',
  'curveTangent',
  'curveToJSON',
  'cylinder',
  'decomposeBezier',
  'elevateDegree',
  'elevateDegreeSurface',
  'evalCurvePlan',
  'evalCurvePlanDirty',
  'evalSurfacePlan',
  'evalSurfacePlanDirty',
  'extrude',
  'findSpan',
  'fundamentalForms',
  'fundamentalFormsInto',
  'gaussLegendre',
  'insertKnot',
  'insertKnotSurface',
  'integrate1d',
  'isClosed',
  'isGeomError',
  'isoCurve',
  'issueOf',
  'knotMultiplicities',
  'knotsFromBreaks',
  'lengthAtParam',
  'limitNormal',
  'line',
  'line2',
  'makeCompatible',
  'makeCurve',
  'makeSurface',
  'mergeNearKnots',
  'normalCurvature',
  'normalizeDomain',
  'normalizeSurfaceDomain',
  'paramAtLength',
  'periodicBasis',
  'periodicCircle',
  'periodicUniformKnots',
  'planCurveSamples',
  'planMatches',
  'planSurfaceSamples',
  'planeSurface',
  'polyline',
  'principalCurvatures',
  'refineKnots',
  'refineKnotsSurface',
  'removeKnot',
  'reparameterize',
  'reparameterizeSurface',
  'resolveTolerances',
  'reverseCurve',
  'reverseSurface',
  'reviveCurve',
  'reviveSurface',
  'revolve',
  'ruled',
  'scaleTolerances',
  'sphere',
  'splitCurve',
  'splitSurface',
  'subCurve',
  'surfaceBounds',
  'surfaceControlPoint',
  'surfaceControlWeight',
  'surfaceDerivatives',
  'surfaceDomain',
  'surfaceEvalGridInto',
  'surfaceEvalInto',
  'surfaceFromHomogeneous',
  'surfaceNormal',
  'surfacePoint',
  'surfaceToJSON',
  'swapUV',
  'toClamped',
  'toClampedSurface',
  'torus',
  'transformCurve',
  'transformCurve2',
  'transformSurface',
  'vec',
  'weightsInto',
  'withControlPoints',
  'withSurfaceControlNet',
  'withSurfaceControlPoints',
  'withSurfaceWeights',
  'withWeights',
];

/** The `vec` namespace (design §6.1). */
const VEC_VALUES: readonly string[] = [
  'add',
  'sub',
  'scale',
  'dot',
  'cross',
  'norm',
  'distance',
  'lerp',
  'normalize',
  'angleBetween',
  'applyAffine3',
  'applyAffine2',
  'affineDeterminant',
  'composeAffine3',
];

describe('@openshaper/geom public API', () => {
  it('exports exactly the pinned runtime values', () => {
    expect(Object.keys(geom).sort()).toEqual([...PUBLIC_VALUES].sort());
  });

  it('exports exactly the pinned vec helpers', () => {
    expect(Object.keys(geom.vec).sort()).toEqual([...VEC_VALUES].sort());
  });

  it('keeps internal modules and test helpers out of the main entry', () => {
    for (const name of [
      'oneBasisFun',
      'curveKnotIns',
      'mulberry32',
      'checksum',
      'evalCurveSpan',
      'surfaceDerivsH',
      'evalSurfaceSpan',
      'surfaceMeasureAt',
      'randomSurface',
      'insertDir',
      'deviationBound',
      'unrollPeriodic',
    ]) {
      expect(name in geom).toBe(false);
    }
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

  it('narrows surface derivatives to what was computed', () => {
    const _d1 = (s: NurbsSurface) => geom.surfaceDerivatives(s, 0, 0, 1);
    const _d2 = (s: NurbsSurface) => geom.surfaceDerivatives(s, 0, 0, 2);
    expectTypeOf<ReturnType<typeof _d1>>().not.toHaveProperty('Suu');
    expectTypeOf<ReturnType<typeof _d2>>().toHaveProperty('Suu');
  });

  it('separates success from failure in Result', () => {
    const narrow = (r: Result<number>): number => (r.ok ? r.value : r.issues.length);
    expect(narrow({ ok: true, value: 3, issues: [] })).toBe(3);
    expect(
      narrow({ ok: false, issues: [{ code: 'unsupported', severity: 'error', message: 'x' }] }),
    ).toBe(1);
  });
});
