// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Every tolerance and iteration cap in `@openshaper/geom`, in one record
 * (design §7, decision 16).
 *
 * This is the only source file allowed to contain tolerance literals:
 * `no-magic-tolerances.test.ts` fails on any `1e-N` style literal elsewhere in
 * `src`. A function that compares numbers takes `tol?: Partial<Tolerances>`,
 * merged over {@link DEFAULT_TOLERANCES} by {@link resolveTolerances}.
 *
 * Length-valued defaults assume centimetres at board scale (≤ 400 cm);
 * {@link scaleTolerances} converts them for other units. Knots and weights are
 * never scaled. Tolerances are never loosened to make a test pass.
 */
import { GeomError } from './errors';

export interface Tolerances {
  /**
   * Points coincide (cm): vertex merge, loop closure, `isClosed`, vertex on curve
   * end, edge-gap floor. 1e-6 cm (10 nm) is ~10³ above accumulated rounding at
   * board scale (300 cm × 2.2e-16 × ~10⁴ operations ≈ 7e-10 cm) and ~10⁴ below a
   * CNC finishing pass.
   */
  readonly point: number;
  /**
   * Largest 3D error accepted from any approximation (cm). 1e-4 cm (1 µm) is two
   * orders below CNC accuracy (0.1 mm) and 50× below the existing STEP fit target.
   */
  readonly fit: number;
  /** Post-solve `‖Cx − d‖∞` (cm). Constraints must stay exact: ~10³ × rounding at condition ~10⁶. */
  readonly constraint: number;
  /**
   * Parameter equality, clamping slack and Newton parameter-step stop, relative to
   * the domain length. Relative, so a rescaled domain behaves the same.
   */
  readonly paramRel: number;
  /**
   * Distinct knots closer than this × domain length are rejected at construction
   * and snapped in operations. Above accumulated rounding of insertion and
   * merging; below any real knot spacing (3e-8 cm on a 300 cm curve).
   */
  readonly knotRel: number;
  /** Parallel and perpendicular tests in exact checks (rad); `atan2` angles are good to ~1e-16. */
  readonly angle: number;
  /** Zero-cosine stop in point inversion (P&T §6.1, ε₂). */
  readonly cosine: number;
  /**
   * Scale-free degeneracy test. Surfaces: `|Su × Sv| ≤ degenerateRel · |Su| · |Sv|`
   * ⇒ degenerate normal. Curves: `|C′| ≤ degenerateRel · M / L` ⇒ degenerate
   * tangent, with `M` the largest absolute Euclidean control coordinate and `L`
   * the domain length (period), the size of the rounding in `C′`'s sum.
   * Surfaces apply the same floor to each partial (`|Su| ≤ degenerateRel · M / L_u`,
   * likewise v; `M` from the control points of the point's span pair), since a
   * pole's `Su` is rounding noise rather than zero, and to the curvature
   * difference (`√(H² − K) ≤ degenerateRel · M / (L_u L_v |Su| |Sv|)` ⇒ umbilic:
   * `II` is rounding noise, as on a plane).
   */
  readonly degenerateRel: number;
  /** `H² − K ≤ umbilicRel · H²` ⇒ umbilic: principal directions are `null` (see also `degenerateRel`). */
  readonly umbilicRel: number;
  /** Rank decisions in pivoted factorisations, relative to the largest pivot after scaling. */
  readonly pivotRel: number;
  /**
   * Adaptive quadrature relative target: 3e-6 cm³ on a 30 L board; cheap because
   * polynomial integrands are integrated exactly.
   */
  readonly quadRel: number;
  /** Max/min weight ratio above which a warning is issued: rational evaluation loses ~6 digits beyond it. */
  readonly weightRatioMax: number;
  /**
   * Cap for Newton loops (projection, inverse arc length). Quadratic convergence
   * needs < 8 from a sampled or bracketed seed; the cap only bounds pathological cases.
   */
  readonly newtonMaxIter: number;
  /**
   * Cap on adaptive subintervals per integral: 61k evaluations at GK15. Reaching
   * it means a singular integrand, reported as `converged: false`.
   */
  readonly quadMaxSplits: number;
}

/** The defaults of design §7, frozen. */
export const DEFAULT_TOLERANCES: Tolerances = Object.freeze({
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

/** Entries that are lengths, scaled by {@link scaleTolerances}. */
const LENGTH_KEYS = ['point', 'fit', 'constraint'] as const;
/** Entries that are counts and must be positive integers. */
const INTEGER_KEYS: ReadonlySet<string> = new Set(['newtonMaxIter', 'quadMaxSplits']);

function checkEntry(key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GeomError(
      'non-finite',
      `tolerance ${key} must be a finite number; got ${String(value)}`,
      {
        key,
        value,
      },
    );
  }
  if (!(value > 0)) {
    throw new GeomError('unsupported', `tolerance ${key} must be > 0; got ${value}`, {
      key,
      value,
    });
  }
  if (INTEGER_KEYS.has(key) && !Number.isInteger(value)) {
    throw new GeomError(
      'unsupported',
      `tolerance ${key} is a count and must be an integer; got ${value}`,
      {
        key,
        value,
      },
    );
  }
  return value;
}

/**
 * Merges `overrides` over {@link DEFAULT_TOLERANCES}. Every given entry must be a
 * finite number > 0 (counts: a positive integer); unknown keys are rejected so a
 * misspelt tolerance cannot be ignored silently. Without overrides the frozen
 * defaults are returned as they are (no allocation).
 */
export function resolveTolerances(overrides?: Partial<Tolerances>): Tolerances {
  if (overrides === undefined) return DEFAULT_TOLERANCES;
  const out: Record<string, number> = { ...DEFAULT_TOLERANCES };
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_TOLERANCES)) {
      throw new GeomError('unsupported', `unknown tolerance '${key}'`, { key });
    }
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = checkEntry(key, value);
  }
  return Object.freeze(out) as unknown as Tolerances;
}

/**
 * Converts the length-valued entries (`point`, `fit`, `constraint`) to another
 * unit: `lengthFactor` is model units per centimetre (10 for millimetres).
 * Relative tolerances, angles and counts are unit-free and kept.
 */
export function scaleTolerances(t: Tolerances, lengthFactor: number): Tolerances {
  checkEntry('lengthFactor', lengthFactor);
  const out: Record<string, number> = { ...t };
  for (const key of LENGTH_KEYS) out[key] = t[key] * lengthFactor;
  return Object.freeze(out) as unknown as Tolerances;
}
