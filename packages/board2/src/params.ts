// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named parameters and structural constants (docs/design/board2.md §12.1, §5.1, §6.1).
 *
 * This file and the geom tolerances are the only places a threshold may be
 * written down (`no-magic-tolerances.test.ts` scans every other source file).
 * Every geometry-affecting build parameter is stored in the document
 * (`BoardDoc.build`), so a saved board rebuilds identically even if a default
 * changes; the defaults here are what a new document starts from.
 */
import { DEFAULT_EDGE_FIT, DEFAULT_TOLERANCES, resolveTolerances } from '@openshaper/geom';
import { causeOf, makeIssue } from './issues';
import { deepFreeze } from './freeze';
import type {
  Board2Issue,
  BuildParams,
  OffsetComponent,
  OffsetRow,
  RailLane,
  RailLawValues,
} from './types';

const DEG = Math.PI / 180;

/**
 * Relative slack of the law range and flat-tip certificates. A handle value is
 * built as `v + m·ds` (one multiply, one add), so it can miss the key value it
 * is meant to reach by about one unit in the last place of the larger operand;
 * four machine epsilons leave a factor of two of margin and no more. It is a
 * rounding allowance on exact decisions (auto handles reach their key value
 * exactly in real arithmetic), not a design tolerance: it is applied relative to
 * the largest value on the segment.
 */
export const LAW_ROUNDING_REL = 4 * Number.EPSILON;

/** The §12.1 defaults, frozen. Reasons per entry are in the design table. */
export const DEFAULT_BUILD_PARAMS: BuildParams = deepFreeze({
  minInset: 0.1,
  insetCurvatureFraction: 0.5,
  minRailHeight: 0.1,
  apexHeightRange: [0.05, 0.95],
  fullnessRange: [0.05, 1],
  maxFrameTurn: 5 * DEG,
  maxStationSpacing: 5,
  lawTolerance: {
    deckInset: 0.005,
    tuckInset: 0.005,
    apexHeight: 0.002,
    upperFullness: 0.005,
    lowerFullness: 0.005,
    edgeHardness: 0.005,
  },
  deckJoinAngleTol: 0.1 * DEG,
  apexJoinAngleTol: 0.1 * DEG,
  maxBandRefinePasses: 6,
  planMargin: 2,
  featureTol: 0.001,
  tolerances: {},
  edgeFit: {},
});

/**
 * The lane values a new board starts from (a constant law per lane). Chosen as a
 * typical shortboard rail: insets of 21% and 8% of a 25 cm half width (the
 * medians of the classic presets, §12.2), a 60/40 rail (apex height 0.4), a
 * parabolic profile (fullness 2/3 is exactly a parabola, §5.3) and a medium edge.
 */
export const DEFAULT_RAIL_LAWS: RailLawValues = deepFreeze({
  deckInset: 5.25,
  tuckInset: 2,
  apexHeight: 0.4,
  upperFullness: 2 / 3,
  lowerFullness: 2 / 3,
  edgeHardness: 0.5,
});

/** The six lanes, in the order of the `RailLane` union. */
export const RAIL_LANES: readonly RailLane[] = Object.freeze([
  'deckInset',
  'tuckInset',
  'apexHeight',
  'upperFullness',
  'lowerFullness',
  'edgeHardness',
] as const satisfies readonly RailLane[]);

/** Offset components per band row: the structural rules of §3.5 / §6.1 (the apex has none). */
export const OFFSET_ROW_COMPONENTS: { readonly [R in OffsetRow]: readonly OffsetComponent[] } =
  deepFreeze({
    deckEdge: ['n'],
    deckHandle: ['l'],
    apexUpper: ['z'],
    apexLower: ['z'],
    tuckHandle: ['n', 'z'],
    tuck: ['n'],
  });

/**
 * The allowed value range of a lane under `build` (§5.1): `[lo, hi]`, with
 * `hi = Infinity` for the insets and `[0, 1]` for the hardness.
 */
export function laneRange(lane: RailLane, build: BuildParams): readonly [number, number] {
  switch (lane) {
    case 'deckInset':
    case 'tuckInset':
      return [build.minInset, Infinity];
    case 'apexHeight':
      return build.apexHeightRange as readonly [number, number];
    case 'upperFullness':
    case 'lowerFullness':
      return build.fullnessRange as readonly [number, number];
    case 'edgeHardness':
      return [0, 1];
  }
}

function bad(message: string, extra: { value?: number } = {}): Board2Issue {
  return makeIssue('doc-malformed', message, extra);
}

/**
 * Range checks of the build parameters (the shape is `reviveBoardDoc`'s job).
 * Returns every violation as `doc-malformed`; empty when the record is usable.
 * The reasons for each bound are the design's: a bound that is not a physical
 * limit is stated here.
 */
export function validateBuildParams(p: BuildParams): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  const positive = (name: string, v: number): void => {
    if (!(Number.isFinite(v) && v > 0))
      out.push(bad(`build.${name} must be finite and > 0`, { value: v }));
  };
  positive('minInset', p.minInset);
  // d < rho keeps the inset loop off the cusp (§12.1); 1 itself is the cusp.
  if (!(p.insetCurvatureFraction > 0 && p.insetCurvatureFraction < 1)) {
    out.push(
      bad('build.insetCurvatureFraction must be in (0, 1)', { value: p.insetCurvatureFraction }),
    );
  }
  positive('minRailHeight', p.minRailHeight);
  const [aLo, aHi] = p.apexHeightRange;
  // Open at both ends: H_u, H_l > 0 needs margin from 0 and 1 (§12.1).
  if (!(aLo > 0 && aLo < aHi && aHi < 1)) {
    out.push(bad('build.apexHeightRange must satisfy 0 < lo < hi < 1'));
  }
  const [fLo, fHi] = p.fullnessRange;
  // Fullness 0 collapses the apex normal (§3.5); above 1 the handle passes the corner.
  if (!(fLo > 0 && fLo <= fHi && fHi <= 1)) {
    out.push(bad('build.fullnessRange must satisfy 0 < lo <= hi <= 1'));
  }
  // The offset-vs-inset error w·dθ²/8 (§12.1) assumes a span that turns less than a right angle.
  if (!(p.maxFrameTurn > 0 && p.maxFrameTurn <= Math.PI / 2)) {
    out.push(bad('build.maxFrameTurn must be in (0, π/2] rad', { value: p.maxFrameTurn }));
  }
  positive('maxStationSpacing', p.maxStationSpacing);
  for (const lane of RAIL_LANES) positive(`lawTolerance.${lane}`, p.lawTolerance[lane]);
  // A join tolerance of a right angle or more accepts any surface pair.
  for (const name of ['deckJoinAngleTol', 'apexJoinAngleTol'] as const) {
    if (!(p[name] > 0 && p[name] < Math.PI / 2)) {
      out.push(bad(`build.${name} must be in (0, π/2) rad`, { value: p[name] }));
    }
  }
  if (!(Number.isInteger(p.maxBandRefinePasses) && p.maxBandRefinePasses >= 0)) {
    out.push(
      bad('build.maxBandRefinePasses must be an integer >= 0', { value: p.maxBandRefinePasses }),
    );
  }
  if (!(Number.isFinite(p.planMargin) && p.planMargin >= 0)) {
    out.push(bad('build.planMargin must be finite and >= 0', { value: p.planMargin }));
  }
  positive('featureTol', p.featureTol);
  try {
    resolveTolerances(p.tolerances);
  } catch (e) {
    const cause = causeOf(e);
    out.push(
      makeIssue(
        'doc-malformed',
        `build.tolerances: ${e instanceof Error ? e.message : String(e)}`,
        {
          ...(cause === undefined ? {} : { cause }),
        },
      ),
    );
  }
  return out;
}

/** The geom tolerance keys, for the shape check of `build.tolerances`. */
export const GEOM_TOLERANCE_KEYS: readonly string[] = Object.freeze(
  Object.keys(DEFAULT_TOLERANCES),
);

/** The geom edge-fit keys, for the shape check of `build.edgeFit`. */
export const EDGE_FIT_KEYS: readonly string[] = Object.freeze(Object.keys(DEFAULT_EDGE_FIT));
