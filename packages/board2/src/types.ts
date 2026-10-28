// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section-based board model's types (docs/design/m1-model.md §1).
 *
 * Frame: cm, **tail at x = 0**, nose toward +x, y across, z up. The document is
 * plain data (numbers, strings, booleans, arrays, plain objects), so it
 * round-trips through JSON unchanged and can be shared between undo versions.
 * Everything derived from it (compiled chains, fitted sections, the evaluator)
 * lives in {@link BuiltBoard}, is never stored and is rebuilt deterministically.
 */

// ---------------------------------------------------------------------------
// Document (§1)
// ---------------------------------------------------------------------------

export type BoardFormat = 'openshaper';
export type BoardVersion = 3;
export type BoardModel = 'sections';

/** A point or offset in a 2D plane (plan x-y, rocker x-z, or the normalised section u-v). */
export type Pair = readonly [number, number];

/**
 * A Bézier chain knot, the classic knot with absolute handle positions: the
 * on-curve point `p`, the handle towards the previous knot (`in`) and towards
 * the next (`out`). `smooth` says the editor keeps the handles collinear; the
 * geometry reads the handles alone. The first knot's `in` and the last knot's
 * `out` are unused and equal `p`.
 */
export interface ChainKnot {
  readonly p: Pair;
  readonly in: Pair;
  readonly out: Pair;
  readonly smooth: boolean;
}

/** Cubic Bézier segments through consecutive knots; at least two knots. */
export interface Chain {
  readonly knots: readonly ChainKnot[];
}

/**
 * A normalised section (§1): a chain in (u, v) from bottom centre (0, 0) to
 * deck centre (0, 1) with its `apex` knot (u = 1) at index `apex`.
 */
export interface Section {
  readonly chain: Chain;
  readonly apex: number;
}

/** A station at stringer coordinate `x` (ξ); `minus` only on an asymmetric board. */
export interface Station {
  readonly id: string;
  readonly x: number;
  readonly plus: Section;
  readonly minus?: Section;
}

export type Symmetry = 'mirror' | 'asymmetric';

/** `notched`: the outline starts at the notch bottom (d, 0) and its tips are at x = 0; the chord map is ramped over `zone` cm after d. */
export type TailSpec =
  | { readonly kind: 'standard' }
  | { readonly kind: 'notched'; readonly zone: number };

/** Half-outlines (y ≥ 0 both), each from a stringer point to the nose (L, 0). `minus` only when asymmetric. */
export interface Outline {
  readonly plus: Chain;
  readonly minus?: Chain;
}

export interface BoardMeta {
  readonly name: string;
  readonly author?: string;
  readonly comment?: string;
  readonly source?: string;
}

/** Any JSON value; for opaque carried data. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Build settings, stored so a saved board rebuilds identically. */
export interface BuildSettings {
  /** Mesh tolerance, cm (0.05 = 0.5 mm; used by the grid mesh of step 2). */
  readonly tolerance: number;
  /** Share of the bottom half (in t) over which features fade to zero at the apex, in (0, 1]. */
  readonly railFade: number;
}

export interface BoardDoc {
  readonly format: BoardFormat;
  readonly version: BoardVersion;
  readonly model: BoardModel;
  readonly meta: BoardMeta;
  readonly symmetry: Symmetry;
  readonly tail: TailSpec;
  readonly outline: Outline;
  /** z(x) on the stringer over [0, L], as Bézier chains in (x, z). */
  readonly rocker: Chain;
  readonly deck: Chain;
  /** Sorted by `x`. */
  readonly stations: readonly Station[];
  readonly features: readonly BottomFeature[];
  /** Classic fin configuration, opaque here. */
  readonly fins?: JsonValue;
  readonly build: BuildSettings;
}

// ---------------------------------------------------------------------------
// Bottom features (closed forms, η = u)
// ---------------------------------------------------------------------------

export interface EaseHandle {
  readonly ds: number;
  readonly dv: number;
}

export interface LawKey {
  readonly s: number;
  readonly value: number;
  /** Absent: automatic (a third of the segment, monotone slope). */
  readonly in?: EaseHandle;
  readonly out?: EaseHandle;
}

/** A value over x (cm) with Bézier ease handles; strictly increasing keys, zero outside the first and last. */
export interface KeyedCurve {
  readonly keys: readonly LawKey[];
}

interface FeatureBase {
  readonly id: string;
  readonly enabled: boolean;
  /** Depth along x in cm; zero outside its keys. */
  readonly depth: KeyedCurve;
}

export interface VeeFeature extends FeatureBase {
  readonly kind: 'vee';
  /** Half-width of the C¹ blend at the stringer, as a fraction of the chord. */
  readonly stringerRadius: number;
}

export interface ConcaveFeature extends FeatureBase {
  readonly kind: 'concave';
  readonly layout: 'single' | 'double';
  /** Lateral centre of each bump as a fraction of the chord (0 for a single concave). */
  readonly centre: number;
  /** Lateral half-width of each bump as a fraction of the chord. */
  readonly width: number;
}

export interface ChannelsFeature extends FeatureBase {
  readonly kind: 'channels';
  readonly count: number;
  /** Channel width, spacing and distance from the outline along the chord, cm. */
  readonly width: number;
  readonly pitch: number;
  readonly railInset: number;
}

export type BottomFeature = VeeFeature | ConcaveFeature | ChannelsFeature;

// ---------------------------------------------------------------------------
// Issues and results
// ---------------------------------------------------------------------------

/**
 * One code per rule: Phase 0 (section), notch, document and build. Codes marked
 * (warning) are only ever reported as warnings.
 */
export type Board2IssueCode =
  // document structure
  | 'doc-malformed'
  | 'doc-version'
  // symmetry and structure
  | 'symmetry-fields'
  | 'too-few-sections'
  | 'chain-too-short'
  | 'station-order'
  | 'station-id'
  // plan (outline, tail, notch zone)
  | 'outline-endpoints'
  | 'tail-start'
  | 'outline-not-function'
  | 'notch-zone'
  | 'notch-tip'
  | 'notch-chords-cross'
  | 'notch-chord-angle'
  // rocker and deck
  | 'line-domain'
  | 'line-not-function'
  | 'thickness'
  // Phase 0 section rules
  | 'section-centre-moved'
  | 'section-centre-tangent'
  | 'section-apex-index'
  | 'section-apex-moved'
  | 'section-out-of-bounds'
  // features and build settings
  | 'feature-invalid'
  | 'build-invalid'
  // build-time findings (warnings)
  | 'section-fit'
  | 'blend-overshoot'
  // a geom failure
  | 'geom';

export interface Board2Issue {
  readonly code: Board2IssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly at?: {
    readonly x?: number;
    readonly station?: string;
    readonly side?: 'plus' | 'minus';
    readonly feature?: string;
    readonly key?: number;
  };
  readonly value?: number;
}

/** `ok` may carry warnings; not ok carries at least one error. */
export type Board2Result<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly Board2Issue[] }
  | { readonly ok: false; readonly issues: readonly Board2Issue[] };
