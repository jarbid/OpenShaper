// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The v2 board model's types (docs/design/board2.md §3, §5, §6, §8, §11).
 *
 * Type-only module. Two layers (decision 1):
 *
 * - {@link BoardDoc}: the master, plain data only (numbers, strings, booleans,
 *   arrays, plain objects), so it round-trips through JSON unchanged and can be
 *   shared between undo versions by sub-object.
 * - {@link BuiltBoard}: everything derived from a doc with geom objects (curves,
 *   surfaces, the B-rep). Never stored; rebuilt deterministically.
 *
 * Frame (§3.2): cm, x towards the nose, y across, z up, **tail at x = 0**. The
 * loop parameter u has period 1, u = 0 at the tail centre and u = ½ at the nose
 * centre, counter-clockwise seen from +z. σ is the arc-length fraction of the
 * plan loop from the tail centre in the same direction; laws and offsets are
 * keyed on σ.
 */
import type {
  Brep,
  EdgeFitSampling,
  GeomIssue,
  NurbsCurve,
  NurbsSurface,
  PeriodicCurve,
  Point3,
  QuadratureResult,
  Tolerances,
} from '@openshaper/geom';

// ---------------------------------------------------------------------------
// Document (§3)
// ---------------------------------------------------------------------------

/** The document's format tag and version (a change to either is a file-format change). */
export type Board2Format = 'openshaper.board2';
export type Board2Version = 1;

/**
 * The master copy of a v2 board. Every geometry-affecting parameter is stored
 * (`build`), so a saved board rebuilds identically even if a default changes.
 */
export interface BoardDoc {
  readonly format: Board2Format;
  readonly version: Board2Version;
  readonly meta: BoardMeta;
  /** `'none'` is Phase 6; the Phase 2 validator refuses it (§3.7). */
  readonly symmetry: Symmetry;
  /** `'standard'` only in Phase 2 (§3.8); Phase 5 adds notched tails. */
  readonly tail: TailSpec;
  /** The apex loop's plan projection: the outline (§3.3). */
  readonly plan: PlanLoopJSON;
  /** The deck surface (§3.4); there are no deck features. */
  readonly deck: HeightFieldJSON;
  /** The bottom before its feature layers (§3.4, §6.2). */
  readonly bottom: HeightFieldJSON;
  readonly laws: RailLaws;
  readonly offsets: OffsetLayer;
  /** Applied in order; their sum does not depend on the order (§6.2). */
  readonly features: readonly BottomFeature[];
  readonly build: BuildParams;
  readonly passthrough?: Passthrough;
}

export interface BoardMeta {
  readonly name: string;
  readonly author?: string;
  readonly comment?: string;
  /** Where the board came from, e.g. `'brd'`, `'s3dx'`, `'board2'`. */
  readonly source?: string;
}

export type Symmetry = 'mirror-y' | 'none';

/** Phase 5 extends this union with `{ kind: 'notched'; … }`. */
export type TailSpec = { readonly kind: 'standard' };

/** Classic data carried through but not modelled in Phase 2 (§3.10). */
export interface Passthrough {
  /** The classic `FinConfig`, opaque here (Phase 4 places fins on the new surfaces). */
  readonly fins?: JsonValue;
}

/** Any JSON value; for opaque carried data. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A periodic cubic B-spline in the plan (x, y), period 1 (§3.3).
 * `knots` is one period (geom §4.3); `points` are (x, y) pairs, one per knot.
 */
export interface PlanLoopJSON {
  readonly degree: number;
  readonly knots: readonly number[];
  readonly points: readonly number[];
}

/**
 * A non-parametric clamped height field z = F(x, y) (§3.4). Only z is stored:
 * a control point's x and y are the Greville abscissae of its knots mapped
 * affinely onto `x` and `y`, so the surface is exactly a graph over the plan.
 */
export interface HeightFieldJSON {
  readonly degreeU: number;
  readonly degreeV: number;
  /** Full clamped knot vectors on [0, 1]. u runs along x, v along y. */
  readonly knotsU: readonly number[];
  readonly knotsV: readonly number[];
  /** Board-coordinate extent of the u and v domains (cm). */
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  /** Control heights, u-major: `z[i * countV + j]` (geom §4.2's order). */
  readonly z: readonly number[];
}

// ---------------------------------------------------------------------------
// Rail laws (§5)
// ---------------------------------------------------------------------------

/** The six law lanes (§5.1). Adding a lane is additive: `RailLaws` is keyed by lane. */
export type RailLane =
  | 'deckInset'
  | 'tuckInset'
  | 'apexHeight'
  | 'upperFullness'
  | 'lowerFullness'
  | 'edgeHardness';

export type RailLaws = { readonly [L in RailLane]: LawCurve };

/** One value per lane: what a law evaluates to at one σ (also `measureLaws`, §5.7). */
export type RailLawValues = { readonly [L in RailLane]: number };

/**
 * Keys with Bézier ease handles over a domain coordinate `s` (§5.2): σ for rail
 * laws, x in cm for feature depths. Keys are strictly increasing in `s`.
 */
export interface KeyedCurve {
  readonly keys: readonly LawKey[];
}

/**
 * A rail law over σ. `'half'` (symmetric boards): keys on [0, ½] with keys at
 * exactly 0 and ½, mirrored onto (½, 1) as v(1 − σ). `'full'` (Phase 6): keys
 * over [0, 1), wrapping.
 */
export interface LawCurve extends KeyedCurve {
  readonly domain: 'half' | 'full';
}

export interface LawKey {
  readonly s: number;
  readonly value: number;
  /** Absent: automatic (a third of the segment, monotone slope; §5.2). */
  readonly in?: EaseHandle;
  readonly out?: EaseHandle;
}

/** A handle as an offset from its key in the (s, value) plane; `ds ≥ 0` towards the segment. */
export interface EaseHandle {
  readonly ds: number;
  readonly dv: number;
}

// ---------------------------------------------------------------------------
// Rail band rows and the offset layer (§3.5, §6.1)
// ---------------------------------------------------------------------------

/** The band's seven v-rows, deck edge (v = 0) to tuck (v = 1); the apex at v = ½ (§3.5). */
export type BandRow =
  | 'deckEdge'
  | 'deckHandle'
  | 'apexUpper'
  | 'apex'
  | 'apexLower'
  | 'tuckHandle'
  | 'tuck';

/** Rows an offset may move: never the apex, which only the outline and apex-height law move. */
export type OffsetRow = Exclude<BandRow, 'apex'>;

/**
 * Offset components in the rail-local frame (§3.2, §6.1): `n` along the inward
 * plan normal, `z` vertical, `l` along the deck tangent in the station plane.
 * Which row has which components is fixed by its structural rule (§3.5):
 * deckEdge [n], deckHandle [l], apexUpper [z], apexLower [z], tuckHandle [n, z], tuck [n].
 */
export type OffsetComponent = 'n' | 'z' | 'l';

/** A periodic spline basis over σ (period 1), shared by every field of a layer. */
export interface OffsetBasisJSON {
  readonly degree: number;
  /** One period of knots. */
  readonly knots: readonly number[];
}

export interface OffsetField {
  readonly row: OffsetRow;
  /** Control values, one group per basis function, in the row's component order. */
  readonly values: readonly number[];
}

/** `basis: null` with no rows is the empty layer. */
export interface OffsetLayer {
  readonly basis: OffsetBasisJSON | null;
  readonly rows: readonly OffsetField[];
}

// ---------------------------------------------------------------------------
// Bottom features (§6.2)
// ---------------------------------------------------------------------------

/**
 * Displacements of the bottom in z, in the lateral coordinate η = y / h_t(x)
 * (h_t the tuck half-width), fitted onto the bottom's basis and added exactly.
 */
export type BottomFeature = VeeFeature | ConcaveFeature | ChannelsFeature;

interface FeatureBase {
  readonly id: string;
  readonly enabled: boolean;
  /** Depth along x in cm (keys over x); zero outside its keys. */
  readonly depth: KeyedCurve;
}

export interface VeeFeature extends FeatureBase {
  readonly kind: 'vee';
  /** Half-width of the C¹ blend at the stringer, as a fraction of h_t. */
  readonly stringerRadius: number;
}

export interface ConcaveFeature extends FeatureBase {
  readonly kind: 'concave';
  readonly layout: 'single' | 'double';
  /** Lateral centre of each bump as a fraction of h_t (0 for a single concave). */
  readonly centre: number;
  /** Lateral half-width of each bump as a fraction of h_t. */
  readonly width: number;
}

export interface ChannelsFeature extends FeatureBase {
  readonly kind: 'channels';
  readonly count: number;
  /** Channel width, spacing and distance from the tuck, cm. */
  readonly width: number;
  readonly pitch: number;
  readonly railInset: number;
}

// ---------------------------------------------------------------------------
// Build parameters (§12.1)
// ---------------------------------------------------------------------------

/** Per-lane law fidelity between band stations (§5.4); insets in cm, the rest fractions. */
export type LawTolerance = RailLawValues;

export interface BuildParams {
  /** Smallest deck or tuck inset, cm. */
  readonly minInset: number;
  /** Effective inset ≤ this × the plan radius of curvature. */
  readonly insetCurvatureFraction: number;
  /** Smallest deck-edge to tuck height at any station, cm. */
  readonly minRailHeight: number;
  readonly apexHeightRange: readonly [number, number];
  readonly fullnessRange: readonly [number, number];
  /** Plan tangent turn per band span, radians. */
  readonly maxFrameTurn: number;
  /** Arc length per band span, cm. */
  readonly maxStationSpacing: number;
  readonly lawTolerance: LawTolerance;
  /** Deck/band normal angle, radians. */
  readonly deckJoinAngleTol: number;
  /** Apex join acceptance, radians. */
  readonly apexJoinAngleTol: number;
  readonly maxBandRefinePasses: number;
  /** Height-field extent beyond the plan loop, cm. */
  readonly planMargin: number;
  /** Bottom feature fit error, cm. */
  readonly featureTol: number;
  /** geom tolerance overrides; empty means geom's defaults. */
  readonly tolerances: Partial<Tolerances>;
  /** geom edge-fit sampling overrides; empty means `DEFAULT_EDGE_FIT`. */
  readonly edgeFit: Partial<EdgeFitSampling>;
}

// ---------------------------------------------------------------------------
// Issues and results (decision 29)
// ---------------------------------------------------------------------------

export type Board2IssueCode =
  // document structure
  | 'doc-malformed'
  | 'doc-version'
  // model invariants (§3, §4, §5)
  | 'tail-not-standard'
  | 'plan-corner'
  | 'plan-radius'
  | 'tail-not-at-origin'
  | 'asymmetric-unsupported'
  | 'symmetry-broken'
  | 'law-keys-unsorted'
  | 'law-tip-slope'
  | 'law-out-of-range'
  | 'inset-invalid'
  | 'inset-loop-invalid'
  | 'rail-height'
  | 'rail-profile-invalid'
  | 'domain-too-small'
  | 'feature-invalid'
  | 'not-converged'
  // converter (§9)
  | 'unsupported-tail'
  | 'too-few-sections'
  // a geom failure, carried in `cause`
  | 'geom';

export interface Board2Issue {
  readonly code: Board2IssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly at?: {
    readonly sigma?: number;
    readonly u?: number;
    readonly x?: number;
    readonly lane?: RailLane;
    readonly key?: number;
    readonly row?: BandRow;
    readonly feature?: string;
    readonly face?: BoardFace;
  };
  readonly value?: number;
  readonly cause?: GeomIssue;
}

/** Shaped like geom's `Result`: `ok` may carry warnings; not ok carries ≥ 1 error. */
export type Board2Result<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly Board2Issue[] }
  | { readonly ok: false; readonly issues: readonly Board2Issue[] };

// ---------------------------------------------------------------------------
// Built board (§3.5, §3.6, §7)
// ---------------------------------------------------------------------------

export type BoardFace = 'deck' | 'band' | 'bottom';

/** Everything derived from a doc. Holds geom objects: never stored or sent to the store. */
export interface BuiltBoard {
  readonly doc: BoardDoc;
  /** The plan loop (period 1, u = 0 at the tail centre). */
  readonly plan: PeriodicCurve<2>;
  /** Band row `apex`: the plan loop in x, y and the apex height in z. */
  readonly apex: PeriodicCurve<3>;
  /** Band rows `deckEdge` and `tuck`: closed curves on the deck and bottom. */
  readonly deckEdge: PeriodicCurve<3>;
  readonly tuck: PeriodicCurve<3>;
  readonly deck: NurbsSurface;
  /** The bottom with its features added. */
  readonly bottom: NurbsSurface;
  /** u periodic along the loop, v clamped cubic with seven rows (§3.5). */
  readonly band: NurbsSurface;
  /** One entry per band column (u-direction control point). */
  readonly stations: readonly BandStation[];
  readonly brep: Brep;
  /** Face indices in `brep.faces`. */
  readonly faces: { readonly [F in BoardFace]: number };
  readonly report: BuildReport;
}

/** A band column's station: where it sits and its rail-local frame (§3.2). */
export interface BandStation {
  /** Greville parameter on the loop. */
  readonly u: number;
  readonly sigma: number;
  /** Unit vectors: plan tangent, inward plan normal (both horizontal). */
  readonly tangent: Point3;
  readonly inward: Point3;
  /** The laws as built at this column (Schoenberg values, §5.4). */
  readonly laws: RailLawValues;
  /** Index of the mirror partner column; equal to its own index on the stringer. */
  readonly partner: number;
}

/** What a build measured (§3.5, §5.4, §5.5). Angles in radians, lengths in cm. */
/** Per band row, the largest control-point move the offset layer makes (cm). */
export type OffsetContribution = { readonly [R in BandRow]: number };

export interface BuildReport {
  readonly issues: readonly Board2Issue[];
  /** Largest normal angle across the apex row (construction: rounding). */
  readonly apexJoinAngle: number;
  readonly deckJoinAngle: number;
  /** Largest |measured − designed| tuck crease angle. */
  readonly tuckCreaseError: number;
  /**
   * Largest |measured − law| per lane between stations, measured on the
   * law-only band (the laws on the same basis without the offset layer: the
   * offsets move rows by design, §6.1; review of S7). `tuckCreaseError` too.
   */
  readonly lawFidelity: RailLawValues;
  /** What the offset layer moved, per band row (cm; all 0 without offsets). */
  readonly offsetContribution: OffsetContribution;
  /** Band-to-surface gaps of the two trimmed edges (geom `checkBrep`). */
  readonly edgeGaps: { readonly deckEdge: number; readonly tuck: number };
  readonly featureFitError: number;
  readonly refinePasses: number;
  /** Stations where the curvature limit of the effective inset is active. */
  readonly insetLimited: readonly number[];
}

// ---------------------------------------------------------------------------
// Specs (§8)
// ---------------------------------------------------------------------------

export interface BoardSpecs {
  /** x-extent of the apex loop, with its ends. */
  readonly length: { readonly value: number; readonly xMin: number; readonly xMax: number };
  /** 2 × the largest y of the apex loop, and where. */
  readonly width: { readonly value: number; readonly x: number };
  /** Largest deck − bottom over the stringer, and where. */
  readonly thickness: { readonly value: number; readonly x: number };
  /** Area inside the apex loop (exact). */
  readonly planArea: number;
  readonly volume: QuadratureResult;
  readonly surfaceArea: QuadratureResult;
  /** Uniform density. y is 0 for a symmetric board. */
  readonly centroid: Point3;
}

/** The two stringer lines as exact iso-curves (§3.4); x is affine in the parameter. */
export interface StringerLines {
  readonly rocker: NurbsCurve<3>;
  readonly deck: NurbsCurve<3>;
}
