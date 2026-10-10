// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared value types of `@openshaper/geom`: the shapes every module agrees on.
 *
 * Binding design: `docs/design/geom-core.md` (§4 conventions, §5 core types).
 * This module is type-only. It emits no runtime code, so importing it costs
 * nothing and creates no module state.
 *
 * What the types encode:
 *
 * - **Immutability.** Factories freeze the records. Typed arrays cannot be frozen,
 *   so they are typed read-only ({@link ReadonlyF64}); the immutability tests
 *   checksum every input across every public operation.
 * - **Validated values.** Branded types ({@link Branded}) are produced only by
 *   geom's validating factories. A value that crossed a worker boundary or came
 *   from JSON is plain data again and goes back through `reviveCurve` /
 *   `reviveSurface`.
 * - **Homogeneous storage.** A control net is one `Float64Array` of P&T's Pw
 *   points (`[w·x, w·y, w·z, w]`). `rational` is derived from the weights by the
 *   factory, never set by a caller.
 * - **Explicit domains and bases.** Knots live in a validated {@link Basis} per
 *   direction, shared by reference between versions of a curve or surface, so
 *   `===` on a basis is a cheap validity key for cached evaluation plans.
 */

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

/** Compile-time mark set only by geom's factories. It never exists at runtime. */
export declare const geomBrand: unique symbol;

/** The kinds of validated value geom produces. */
export type BrandKind = 'basis' | 'curve' | 'surface' | 'trim-loop' | 'trimmed-surface' | 'brep';

/** Marks a type that only a validating geom factory can produce. */
export interface Branded<K extends BrandKind> {
  readonly [geomBrand]: K;
}

// ---------------------------------------------------------------------------
// Read-only typed arrays
// ---------------------------------------------------------------------------

/** Methods that write into the array, or hand out a writable view of it. */
type TypedArrayMutator = 'set' | 'fill' | 'copyWithin' | 'reverse' | 'sort' | 'subarray';

/**
 * A typed array the holder may read but not write.
 *
 * A type-level guard, not a security boundary (`.buffer` still reaches the
 * bytes). Every mutable typed array of the same kind is assignable to it, so
 * callers pass ordinary arrays in; geom never writes into an input.
 */
export type ReadonlyTypedArray<
  A extends Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array,
> = Omit<A, number | TypedArrayMutator> & { readonly [index: number]: number };

export type ReadonlyF64 = ReadonlyTypedArray<Float64Array>;
export type ReadonlyF32 = ReadonlyTypedArray<Float32Array>;
export type ReadonlyI32 = ReadonlyTypedArray<Int32Array>;
export type ReadonlyU32 = ReadonlyTypedArray<Uint32Array>;
export type ReadonlyU8 = ReadonlyTypedArray<Uint8Array>;

/** Output buffers: Float32 for GPU upload, Float64 for analysis. */
export type NumArray = Float32Array | Float64Array;

// ---------------------------------------------------------------------------
// Points and small records
// ---------------------------------------------------------------------------

/** 1: scalar laws (board2's rail laws); 2: pcurves and trim loops; 3: space. */
export type Dim = 1 | 2 | 3;

/** Structurally identical to the kernel's `Vec2`. */
export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/** Structurally identical to the kernel's `Vert3`. */
export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The point type of a curve of dimension `D`: a plain number in 1D. */
export type PointOf<D extends Dim> = D extends 1 ? number : D extends 2 ? Point2 : Point3;

export interface UV {
  readonly u: number;
  readonly v: number;
}

export interface Box3 {
  readonly min: Point3;
  readonly max: Point3;
}

/** A closed parameter interval `[a, b]` (half-open `[a, b)` for a periodic domain). */
export type Interval = readonly [number, number];

/** Which one-sided limit to take at a knot. The default is `'right'`. */
export type Side = 'left' | 'right';

export type ParamDir = 'u' | 'v';

/** The four natural boundaries of a surface: `u0` is `u = u_min`, and so on. */
export type SurfaceEdge = 'u0' | 'u1' | 'v0' | 'v1';

/** Row-major 2×3 affine map: `[a, b, tx, c, d, ty]`. */
export type Affine2 = readonly [number, number, number, number, number, number];

/** Row-major 3×4 affine map: three rows of `[m0, m1, m2, t]`. */
export type Affine3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

// ---------------------------------------------------------------------------
// Bases (design §4.3)
// ---------------------------------------------------------------------------

/**
 * A clamped B-spline basis: the first and last `degree + 1` knots are equal.
 * Interior multiplicity is at most `degree`.
 */
export interface ClampedBasis extends Branded<'basis'> {
  readonly kind: 'clamped';
  readonly degree: number;
  /** Basis functions, which is the control-point count along this direction. */
  readonly count: number;
  /** `count + degree + 1` non-decreasing knots. */
  readonly knots: ReadonlyF64;
  /** `[knots[degree], knots[count]]`, positive length. */
  readonly domain: Interval;
}

/**
 * A periodic B-spline basis, stored as one period: `t_{i + k·n} = t_i + k·T`.
 * Control point `i` serves basis function `i mod n`; no wrapped duplicates are
 * stored.
 */
export interface PeriodicBasis extends Branded<'basis'> {
  readonly kind: 'periodic';
  readonly degree: number;
  /** Unique control points `n`, at least `degree + 1`. */
  readonly count: number;
  /** One period `t_0 ≤ … ≤ t_{n−1} < t_0 + period`, length `count`. */
  readonly knots: ReadonlyF64;
  /** `T > 0`. */
  readonly period: number;
  /** `[t_0, t_0 + period)`, half-open. */
  readonly domain: Interval;
}

export type Basis = ClampedBasis | PeriodicBasis;

// ---------------------------------------------------------------------------
// Curves and surfaces (design §4.2, §4.5)
// ---------------------------------------------------------------------------

/** A B-spline or NURBS curve. Polynomial curves store weights of exactly 1. */
export interface NurbsCurve<D extends Dim = Dim> extends Branded<'curve'> {
  readonly dim: D;
  readonly basis: Basis;
  /** Homogeneous control points, stride `dim + 1`, length `basis.count · (dim + 1)`. */
  readonly cw: ReadonlyF64;
  /** Derived by the factory: `false` iff every weight is exactly 1. */
  readonly rational: boolean;
}

export type ClampedCurve<D extends Dim = Dim> = NurbsCurve<D> & { readonly basis: ClampedBasis };
export type PeriodicCurve<D extends Dim = Dim> = NurbsCurve<D> & { readonly basis: PeriodicBasis };

/** A tensor-product B-spline or NURBS surface in 3D. */
export interface NurbsSurface extends Branded<'surface'> {
  readonly u: Basis;
  readonly v: Basis;
  /**
   * Homogeneous control points, stride 4, u-major: point `(i, j)` starts at
   * `(i · v.count + j) · 4` (the existing `BSplineSurface` and STEP order).
   */
  readonly cw: ReadonlyF64;
  /** Derived by the factory: `false` iff every weight is exactly 1. */
  readonly rational: boolean;
}

/** A surface point with its derivatives to second order (P&T's SKL). */
export interface SurfaceDerivs {
  readonly S: Point3;
  readonly Su: Point3;
  readonly Sv: Point3;
  readonly Suu: Point3;
  readonly Suv: Point3;
  readonly Svv: Point3;
}

// ---------------------------------------------------------------------------
// Trimming and curves on surfaces (design §4.7)
// ---------------------------------------------------------------------------

/**
 * A closed loop of clamped pcurves in a surface's (u, v), head to tail with
 * bitwise-equal joins. Material lies on the left: outer loops are
 * counter-clockwise, holes clockwise.
 */
export interface TrimLoop extends Branded<'trim-loop'> {
  readonly curves: readonly ClampedCurve<2>[];
  /** (u, v) area by Green's theorem; positive iff counter-clockwise. */
  readonly signedArea: number;
}

/** A surface restricted to the region inside `outer` and outside every hole. */
export interface TrimmedSurface extends Branded<'trimmed-surface'> {
  readonly surface: NurbsSurface;
  /** `null` is the natural boundary (the only option with a periodic direction). */
  readonly outer: TrimLoop | null;
  readonly holes: readonly TrimLoop[];
}

/** The 3D curve `surface(pcurve(t))`. */
export interface CurveOnSurface {
  readonly surface: NurbsSurface;
  readonly pcurve: NurbsCurve<2>;
}

// ---------------------------------------------------------------------------
// Minimal B-rep (design §13): index-based records, cheap to clone and diff
// ---------------------------------------------------------------------------

export interface BrepVertex {
  readonly point: Point3;
}

export interface BrepEdge {
  /** The whole curve is the edge. */
  readonly curve: ClampedCurve<3>;
  /** Vertex ids; `start === end` for a closed edge. */
  readonly start: number;
  readonly end: number;
}

export interface BrepCoedge {
  readonly edge: number;
  /** `true` when the coedge runs along the edge curve's parameter. */
  readonly sense: boolean;
  /** On the owning face's surface, with the edge curve's parameter domain. */
  readonly pcurve: ClampedCurve<2>;
  /** Which geometry defines the edge (STEP's `master_representation`). */
  readonly master: 'curve3d' | 'pcurve';
}

export interface BrepLoop {
  readonly coedges: readonly BrepCoedge[];
}

export interface BrepFace {
  readonly surface: NurbsSurface;
  /** `true` when the face's outward normal is `+Su × Sv`. */
  readonly sameSense: boolean;
  readonly outer: BrepLoop;
  readonly holes: readonly BrepLoop[];
  readonly label?: string;
}

export interface BrepShell {
  readonly faces: readonly number[];
  readonly closed: boolean;
}

export interface BrepSolid {
  /** Shell id of the outer shell. */
  readonly outer: number;
  /** Checked by Euler–Poincaré when given; derived and reported otherwise. */
  readonly genus?: number;
}

/** The unvalidated input to `makeBrep`. */
export interface BrepSpec {
  readonly vertices: readonly BrepVertex[];
  readonly edges: readonly BrepEdge[];
  readonly faces: readonly BrepFace[];
  readonly shells: readonly BrepShell[];
  readonly solids: readonly BrepSolid[];
}

/** A structurally validated B-rep. */
export interface Brep extends BrepSpec, Branded<'brep'> {}

// ---------------------------------------------------------------------------
// Errors and results (design §8)
// ---------------------------------------------------------------------------

export type GeomErrorCode =
  // construction
  | 'invalid-degree'
  | 'knot-count'
  | 'knots-decreasing'
  | 'knots-not-clamped'
  | 'knot-multiplicity'
  | 'knots-near-coincident'
  | 'non-finite'
  | 'weight-not-positive'
  | 'weight-ratio'
  | 'too-few-points'
  | 'size-mismatch'
  | 'dimension-mismatch'
  | 'empty-domain'
  | 'scratch-too-small'
  // evaluation
  | 'param-out-of-domain'
  | 'side-unavailable'
  // fitting and solving
  | 'schoenberg-whitney'
  | 'singular-system'
  | 'not-positive-definite'
  | 'conflicting-dof-rules'
  | 'dependent-constraints'
  | 'inconsistent-constraints'
  | 'constraint-residual'
  | 'not-converged'
  // trimming, triangulation, tessellation
  | 'trim-not-closed'
  | 'trim-self-intersects'
  | 'trim-orientation'
  | 'trim-outside-domain'
  | 'trim-loops-intersect'
  | 'trim-hole-outside'
  | 'trim-on-periodic'
  | 'cdt-duplicate-point'
  | 'cdt-segments-intersect'
  | 'cdt-failure'
  | 'tessellation-failure'
  // B-rep and STEP
  | 'brep-reference'
  | 'brep-invalid'
  | 'step-unsupported'
  // anything else not supported in Phase 1
  | 'unsupported';

/** One reportable problem, located as precisely as the operation knows. */
export interface GeomIssue {
  readonly code: GeomErrorCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly at?: {
    readonly index?: number;
    readonly t?: number;
    readonly uv?: UV;
    readonly point?: Point3;
    readonly vertex?: number;
    readonly edge?: number;
    readonly face?: number;
    readonly coedge?: readonly [face: number, loop: number, index: number];
  };
  /** The offending measurement (a residual, a gap, an area), when there is one. */
  readonly value?: number;
}

/**
 * Outcome of an operation whose failure depends on the data rather than on the
 * caller breaking a contract. `ok: true` may still carry warnings; `ok: false`
 * carries at least one error.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly GeomIssue[] }
  | { readonly ok: false; readonly issues: readonly GeomIssue[] };

export interface QuadratureResult {
  readonly value: number;
  readonly errorEstimate: number;
  readonly evaluations: number;
  readonly converged: boolean;
}
