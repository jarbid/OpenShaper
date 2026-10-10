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
 * (`book/`, `linalg/`, assembly helpers) are never re-exported.
 */
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
