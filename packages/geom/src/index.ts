// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @openshaper/geom — the pure NURBS core of the geometry overhaul (Phase 1 of
 * `docs/design/geometry-overhaul.md`; binding design in `docs/design/geom-core.md`).
 *
 * Curves and surfaces (clamped and periodic, rational from the start), knot
 * operations, fitting, the constrained fairness solver, curves on surfaces,
 * trimming and tessellation, quadrature, continuity measures, a minimal B-rep
 * and a STEP writer. No board concepts, no UI, no workers, no other workspace
 * package: everything here is pure, immutable and deterministic.
 *
 * Every export is listed by name, and `index.test.ts` pins the runtime export
 * list, so each change to the public API shows up in a diff. Internal modules
 * (`book/`, `linalg/`, assembly helpers) are never re-exported. Test helpers
 * live in the `@openshaper/geom/testing` subpath, never here.
 */

// Tolerances, errors, scratch, vectors (§6.1)
export { DEFAULT_TOLERANCES, resolveTolerances, scaleTolerances } from './tolerance';
export type { Tolerances } from './tolerance';
export { GeomError, isGeomError, issueOf } from './errors';
export { createScratch } from './array';
export type { Scratch } from './array';
export * as vec from './vec';

// Bases (§6.2)
export {
  basisDersInto,
  basisFunction,
  basisFunsInto,
  breakpoints,
  clampedBasis,
  clampedUniformKnots,
  findSpan,
  knotMultiplicities,
  knotsFromBreaks,
  mergeNearKnots,
  periodicBasis,
  periodicUniformKnots,
} from './basis';

// Curves (§6.3)
export {
  bezierCurve,
  clampUnclamped,
  controlPoint,
  controlPointsInto,
  controlWeight,
  curveDerivatives,
  curveDomain,
  curveEvalBatchInto,
  curveEvalInto,
  curveFromHomogeneous,
  curvePoint,
  curveToJSON,
  isClosed,
  makeCurve,
  reviveCurve,
  transformCurve,
  transformCurve2,
  weightsInto,
  withControlPoints,
  withWeights,
} from './curve';
export type { CurveJSON } from './curve';

// Curve measures (§6.4)
export {
  arcLengthTable,
  curveBounds,
  curveCurvature,
  curveCurvatureBatchInto,
  curveFrame,
  curveLength,
  curveSignedCurvature,
  curveTangent,
  lengthAtParam,
  paramAtLength,
} from './curve-measure';
export type { ArcLengthTable } from './curve-measure';

// Curve operations (§6.5)
export {
  decomposeBezier,
  elevateDegree,
  insertKnot,
  makeCompatible,
  normalizeDomain,
  refineKnots,
  removeKnot,
  reparameterize,
  reverseCurve,
  splitCurve,
  subCurve,
  toClamped,
} from './curve-ops';

// Surfaces (§6.6)
export {
  boundaryCurve,
  isoCurve,
  makeSurface,
  reviveSurface,
  surfaceBounds,
  surfaceControlPoint,
  surfaceControlWeight,
  surfaceDerivatives,
  surfaceDomain,
  surfaceEvalGridInto,
  surfaceEvalInto,
  surfaceFromHomogeneous,
  surfacePoint,
  surfaceToJSON,
  transformSurface,
  withSurfaceControlNet,
  withSurfaceControlPoints,
  withSurfaceWeights,
} from './surface';
export type { SurfaceDerivs1, SurfaceJSON, SurfaceSide } from './surface';
export type { BasisJSON } from './basis';

// Surface measures (§6.7)
export {
  fundamentalForms,
  fundamentalFormsInto,
  limitNormal,
  normalCurvature,
  principalCurvatures,
  SAMPLE_DEGENERATE,
  SAMPLE_UMBILIC,
  surfaceNormal,
} from './surface-measure';
export type { Curvatures, FundamentalForms, NormalResult } from './surface-measure';

// Surface operations (§6.8)
export {
  elevateDegreeSurface,
  insertKnotSurface,
  normalizeSurfaceDomain,
  refineKnotsSurface,
  reparameterizeSurface,
  reverseSurface,
  splitSurface,
  swapUV,
  toClampedSurface,
} from './surface-ops';

// Sample plans: incremental evaluation (§6.9)
export {
  changedControlPoints,
  evalCurvePlan,
  evalCurvePlanDirty,
  evalSurfacePlan,
  evalSurfacePlanDirty,
  planCurveSamples,
  planMatches,
  planSurfaceSamples,
} from './plan';
export type { CurveSamplePlan, SampleOutputs, SurfaceSamplePlan } from './plan';

// Quadrature (§6.10)
export { GL_MAX_ORDER, gaussLegendre, integrate1d } from './quadrature';

// Exact primitives (§6.11)
export {
  bezierSurface,
  bilinearPatch,
  circle,
  circle2,
  circleArc,
  conicArc,
  cylinder,
  extrude,
  line,
  line2,
  periodicCircle,
  planeSurface,
  polyline,
  revolve,
  ruled,
  sphere,
  torus,
} from './primitives';

// Fitting (§6.12)
export { averagedKnots, lsqKnots, parameterize } from './fit/param';
export type { Parameterization } from './fit/param';
export { interpolateCurve, interpolatePeriodic, interpolateSurface } from './fit/interpolate';
export type { CurveInterpolation, SurfaceInterpolation } from './fit/interpolate';
export { approximateCurve, approximateSurface } from './fit/approximate';
export type { CurveConstraint, CurveFit, SurfaceConstraint, SurfaceFit } from './fit/approximate';
export { skinCurves } from './fit/skin';
export type { SkinResult } from './fit/skin';

// Constrained fair solver (§6.13)
export { fairnessEnergy } from './solver/fairness';
export type { FairnessWeights } from './solver/fairness';
export { makeDofMap } from './solver/dof';
export type { DofMap, DofRule } from './solver/dof';
export { fairInfluenceInto, prepareFairSolver, solveFair, solveFairInto } from './solver/solver';
export type { FairProblem, FairSolver, LinearConstraint, SolveReport } from './solver/solver';

// Shared value types (§5)
export type {
  Affine2,
  Affine3,
  Basis,
  Box3,
  BrandKind,
  Branded,
  Brep,
  BrepCoedge,
  BrepEdge,
  BrepFace,
  BrepLoop,
  BrepShell,
  BrepSolid,
  BrepSpec,
  BrepVertex,
  ClampedBasis,
  ClampedCurve,
  CurveOnSurface,
  Dim,
  GeomErrorCode,
  GeomIssue,
  Interval,
  NumArray,
  NurbsCurve,
  NurbsSurface,
  ParamDir,
  PeriodicBasis,
  PeriodicCurve,
  Point2,
  Point3,
  PointOf,
  QuadratureResult,
  ReadonlyF32,
  ReadonlyF64,
  ReadonlyI32,
  ReadonlyTypedArray,
  ReadonlyU32,
  ReadonlyU8,
  Result,
  Side,
  SurfaceDerivs,
  SurfaceEdge,
  TrimLoop,
  TrimmedSurface,
  UV,
} from './types';
