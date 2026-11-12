// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named parameters of the section-based model (docs/design/m1-model.md; one
 * tolerance, 0.5 mm, in docs/design/nurbs-plan.md). Every numeric threshold in
 * `src` lives here (`no-magic-tolerances.test.ts` exempts this file only).
 * Lengths are cm, angles radians.
 */
import type { BuildSettings } from './types';

/** The document's format tag, version and model (the plan's "v2"; classic `.board.json` is already v2). */
export const BOARD_FORMAT = 'openshaper';
export const BOARD_VERSION = 3;
export const BOARD_MODEL = 'sections';

/** Defaults of {@link BuildSettings}: the mesh tolerance (0.5 mm) and the share of the bottom half over which features fade. */
export const DEFAULT_BUILD: BuildSettings = Object.freeze({ tolerance: 0.05, railFade: 0.2 });

// ---------------------------------------------------------------------------
// Section fit (m1-model.md §2, "Smooth blend")
// ---------------------------------------------------------------------------

/**
 * A station's fitted section must be within this of the stored one (cm): the project's one
 * tolerance, 0.5 mm. The measure is conservative (normalised error times the larger of the
 * chord length and the thickness), so the true station deviation is about half of it.
 */
export const SECTION_FIT_TOL = DEFAULT_BUILD.tolerance;
// Rail smoothness (m1-model.md "As built (rail smoothness)"; `section-lsq.ts`, `sections.ts`).

/**
 * Registration. The centre of a section half's turning (its rail: the arc position of each turn, weighted
 * by the turn) is placed at the knot nearest this t of the half in every section, bottom half ...
 */
export const SECTION_LANDMARK_BOTTOM = 0.78;
/** ... and deck half, so the rails of two stations lie at the same t and a blend between them blends rail with rail. */
export const SECTION_LANDMARK_DECK = 0.4;
/** A half that turns by this much (rad) or more is registered in full; one that turns less (a flat or vee bottom) in proportion. */
export const SECTION_REGISTER_TURN = 0.5;
/**
 * Graded knots. The span density of the shared knot vector is 1 over the flat end of a half (the bottom
 * centre, the deck centre) up to this fraction of it, rises to {@link SECTION_GRADE_RATIO}
 * at {@link SECTION_GRADE_TO}, and stays there to the apex: the rail and the wall have that many times
 * the spans per length of the flat bottom and the crown of the deck.
 */
export const SECTION_GRADE_FROM = 0.4;
export const SECTION_GRADE_TO = 0.7;
export const SECTION_GRADE_RATIO = 5;
/** Steps of the numeric inverse of the span density. */
export const SECTION_GRADE_STEPS = 2000;
/**
 * A knot of a stored section where its chain turns by more than this (rad) is a corner: the end
 * stations' 90 degree rail edge, the polygon sections' edges. A half with one corner holds it exactly.
 */
export const SECTION_CORNER_ANGLE = (15 * Math.PI) / 180;
/**
 * Weight of the tangent-direction rows of the fit: this many spans of position per radian (the
 * rows ask the fitted tangent to be parallel to the stored one at every sample).
 */
export const SECTION_NORMAL_WEIGHT = 0.5;
/**
 * A rung of the span ladder is accepted only if the fitted section's tangent direction is within this
 * angle (rad) of the stored one's, as well as the position being within {@link SECTION_FIT_TOL}.
 */
export const SECTION_NORMAL_TOL = (4 * Math.PI) / 180;
/** Samples either side within which the stored tangent direction may match the fitted one (the position tolerance slides the fit along a bend). */
export const SECTION_NORMAL_WINDOW = 1;
/** The tangent-direction check measures angles on the section's real shape, with its width to thickness ratio held within 1/this and this (a sliver at a tip has no normal of its own). */
export const SECTION_ASPECT_LIMIT = 8;
/** A fitted curve moving slower than this share of its half's arc length per unit t has no tangent direction worth comparing (beside an exact corner it stands still). */
export const SECTION_SPEED_FLOOR = 0.05;
/** Share of a station's position error added to its fit cost: a tie-break between rungs whose tangent directions are equally far off. */
export const SECTION_COST_TIE = 0.01;
/** Polyline points per Bézier segment of a stored section, which the samples are taken from. */
export const SECTION_POLYLINE_SAMPLES = 128;
/** Polyline points either side of a sample that give its stored tangent direction. */
export const SECTION_TANGENT_REACH = 3;
/** Polyline points either side of a sample searched for the nearest point of the stored section when the fit error is measured (a few samples' worth). */
export const SECTION_DISTANCE_REACH = 12;
/** Ridge added to the diagonal of the fit's normal equations (a pivot guard, far below the data's weight of about 1). */
export const SECTION_RIDGE = 1e-12;
/** A rung must beat the best error so far by this factor (error ratio) to count as an improvement. */
export const SECTION_STALL_RATIO = 0.85;
/** Rungs in a row without such an improvement after which the ladder stops and keeps the best. */
export const SECTION_STALL_PATIENCE = 2;
/** A centre tangent is horizontal when its vertical share of its length is below this. */
export const SECTION_DIRECTION_TOL = 1e-9;
/**
 * A side of the apex tangent is vertical (G1 across t = 1/2) when it is within this angle (rad) of
 * vertical. The fit then holds it exactly vertical, and the converter snaps the handles to it: a handle a few micrometres off vertical (a classic file that stores
 * 1.4e-5 of sideways run in a 0.27 cm handle) would otherwise lose the constraint and leave a rail crease
 * along the apex line of up to 1.7 degrees. 1e-3 rad moves a point of the section by less than 0.02 mm.
 */
export const SECTION_APEX_TOL = 1e-3;
/**
 * A section handle shorter than this (normalised units, about 0.02 micrometres on a 20 cm chord) has no
 * direction: the curve leaves along the next control point instead. A hand-edited or perturbed handle
 * of 1e-8 must not decide whether a tangent is horizontal or vertical.
 */
export const SECTION_HANDLE_MIN = 1e-6;
/**
 * Room (normalised u) below which the blend of a u coordinate is taken to sit on its bound: the limiter
 * of `blendAt` has nothing to give there and the coordinate is the monotone interpolant itself. The error is
 * below this, far under a micrometre.
 */
export const BLEND_ROOM_MIN = 1e-9;
/** Samples per half section (bottom to apex, apex to deck) the fit is made to, at equal steps of the fit's parameter t (arc length, registered at the rail). */
export const SECTION_HALF_SAMPLES = 192;
/** Spans per half of the common knot vector, tried in order until every station fits. */
export const SECTION_SPAN_LADDER: readonly number[] = [12, 16, 24, 32, 48];
/** Polyline samples per Bézier segment when measuring arc length. */
export const CHAIN_ARC_SAMPLES = 48;

// ---------------------------------------------------------------------------
// Frame and evaluation
// ---------------------------------------------------------------------------

/** Newton/bisection iteration cap of the inverse function solves (x → parameter). */
export const SOLVE_MAX_ITER = 80;
/** Relative parameter step at which an inverse solve stops. */
export const SOLVE_PARAM_REL = 1e-15;
/**
 * Floor of dx/ds where a plan end is vertical (a blunt tail or nose): derivatives
 * there are singular and are evaluated with this floor so they stay finite.
 */
export const TIP_SLOPE_FLOOR = 1e-9;
/** Smallest chord length (cm) for which the chord-length derivatives of a channel are formed. */
export const CHORD_FLOOR = 1e-9;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/** Rounding slack of the exact-equality rules (centre points, apex u, bounds), in normalised units. */
export const SECTION_EXACT_TOL = 1e-12;
/** Smallest angle (rad) at which a notch-zone chord may cross the outline: 20 degrees. */
export const MIN_CHORD_ANGLE = (20 * Math.PI) / 180;
/** Samples per outline segment for the monotonicity and notch checks. */
export const OUTLINE_CHECK_SAMPLES = 24;
/** Samples across a notch zone for p' > 0 and the chord angles. */
export const NOTCH_CHECK_SAMPLES = 96;
/** Samples per line segment of the rocker/deck thickness check. */
export const LINE_CHECK_SAMPLES = 16;
/** Smallest thickness (cm) the rocker and deck may leave anywhere. */
export const MIN_THICKNESS = 0;
/** Rounding slack (cm) of the thickness at x = 0 and x = L, where the deck may meet the rocker. */
export const THICKNESS_END_SLACK = 1e-9;
/** Samples per station interval when reporting blend overshoot. */
export const BLEND_CHECK_SAMPLES = 8;

/** Slack (cm) of the plan's exact coordinates: a standard tail at x = 0, a notch tip at x = 0, stringer points at y = 0. */
export const PLAN_EXACT_TOL = 1e-9;

/** Smallest ratio of wall distance to stringer distance at the start of a notch zone's chord map. */
export const NOTCH_MIN_LAMBDA = 0.05;

// ---------------------------------------------------------------------------
// Grid mesh (m1-model.md §3)
// ---------------------------------------------------------------------------

/**
 * Share of the mesh tolerance that one direction's midpoint deviation (distance of
 * the surface at the midpoint of two neighbours from the chord between them) may
 * use. The deviations of the two directions add at a quad's centre, so the triangle
 * centres and edge midpoints stay within the tolerance itself.
 */
export const MESH_DEV_FRACTION = 0.4;
/**
 * Share of the tolerance that the twist of a cell, `|a + d - b - c| / 4` for its corners, may use: a
 * diagonal's midpoint sits that far from the cell's bilinear centre, on top of the sag.
 */
export const MESH_TWIST_FRACTION = 0.45;
/** Seed columns per half (bottom to apex, apex to deck) before refinement. */
export const MESH_SEED_COLS_PER_HALF = 10;
/** Seed rows spaced uniformly in ξ, and spaced by outline arc length, before refinement. */
export const MESH_SEED_ROWS_UNIFORM = 8;
export const MESH_SEED_ROWS_ARC = 32;
/** Columns probed when a row interval is tested (a stride through the column ladder). */
export const MESH_PROBE_COLS = 64;
/** Uniformly spaced probe rows added to the stations and their midpoints when testing columns. */
export const MESH_PROBE_ROWS_UNIFORM = 6;
/** Hard caps on the ladders (a guard against a runaway refinement). */
export const MESH_MAX_ROWS = 4096;
export const MESH_MAX_COLS = 1024;
/** Smallest row interval (cm of ξ) and column interval (in t) that is still split. */
export const MESH_MIN_XI_SPAN = 1e-6;
export const MESH_MIN_T_SPAN = 1e-6;
/** Bisection levels of a refinement. */
export const MESH_MAX_LEVELS = 24;
/** Where a collapsed end row takes its normals from: this share of the way to the next row. */
export const MESH_NORMAL_OFFSET = 0.5;
/** Rows (a stride through the row ladder) at which the finished column ladder is verified. */
export const MESH_VERIFY_ROWS = 96;

// ---------------------------------------------------------------------------
// Classic converter (m1-model.md §4)
// ---------------------------------------------------------------------------

/** Two knots at the board's ends whose x differ by less than this (cm) form an end wall of the classic deck, which the section model does not store. */
export const CONVERT_WALL_TOL = 1e-6;
/** A normalised u this close to 0 or 1 is rounding and is set to the bound. */
export const CONVERT_SNAP = 1e-9;
/** Relative difference under which two candidate widest points are a tie (a vertical plateau of the rail). */
export const CONVERT_TIE = 1e-9;
/** Times a section segment whose control polygon leaves 0 <= u <= 1 is halved before its control points are clamped. */
export const CONVERT_MAX_SPLIT_DEPTH = 6;
/** A classic slice narrower or thinner than this (cm), or off the centre line by more, cannot be normalised. */
export const CONVERT_MIN_SIZE = 1e-6;
export const CONVERT_CENTRE_TOL = 1e-6;
/** Notch zone lengths tried, in multiples of the notch depth d, until the plan validates (the converter's choice, and a tail marked `auto`'s). */
export const NOTCH_ZONE_LADDER: readonly number[] = [1.5, 2, 3, 4, 6, 8, 12];
/** Largest control-point move (cm) a repair may make before the board is refused: the build tolerance. */
export const CONVERT_MAX_ADJUST = DEFAULT_BUILD.tolerance;
/** Decimals (normalised units) to which two converted sections are the same section, and how many are remembered. */
export const CONVERT_CONTENT_DIGITS = 9;
export const CONVERT_CONTENT_CACHE = 96;

// ---------------------------------------------------------------------------
// STEP solid (docs/design/m3-exports.md, step 2)
// ---------------------------------------------------------------------------

/** The STEP surfaces stay within this distance (cm) of the evaluator at the same (ξ, t): 0.5 mm (plan decision 6). */
export const STEP_TOLERANCE = 0.05;
/** The fit refines until its dense-sample deviation is below this share of the tolerance, leaving room for what lies between the samples. */
export const STEP_ACCEPT_SHARE = 0.8;
/** Degree of the fitted surfaces, in both directions (the degree of the rails and of the classic export). */
export const STEP_DEGREE = 3;
/** Spans of the first ξ knot vector, and spans per half of the first t knot vector. */
export const STEP_START_SPANS = 12;
export const STEP_START_HALF_SPANS = 4;
/** Data points per span in each direction for the fit, and dense check points per span for the deviation. */
export const STEP_FIT_SAMPLES = 3;
export const STEP_CHECK_SAMPLES = 6;
/** Refinement passes allowed before the fit gives up and reports the deviation it reached. */
export const STEP_MAX_PASSES = 30;
/** A span narrower than this (parameter units) is not bisected further. */
export const STEP_MIN_SPAN = 1e-6;
/**
 * How an end closes (docs/design/m3-exports.md, "As built (rounded tips)"). An end whose half-width is at
 * most {@link STEP_TIP_WIDTH} (cm) is a tip: the surface runs to it and its end row collapses onto the
 * vertical tip edge, or onto a pole where the thickness is at most {@link STEP_POLE_THICKNESS} (cm). A wider
 * end is a blunt end (a transom) with a planar cap. A tip is round when the outline's tangent there leaves
 * the vertical by at most {@link STEP_ROUND_SLOPE} (|dx| / |d(x, y)|): the faces then meet tangent along it.
 */
export const STEP_TIP_WIDTH = 1e-6;
export const STEP_POLE_THICKNESS = 1e-3;
export const STEP_ROUND_SLOPE = 1e-6;
/** Arc-length table entries per outline segment for the shared s(ξ) map, and bisections that invert it. */
export const STEP_ARC_TABLE = 512;
export const STEP_ARC_BISECT = 60;
/** Bisections that place an entry of the warp table. */
export const STEP_WARP_BISECT = 40;
/** A refinement direction counts when its predicted error is at least this share of the other direction's. */
export const STEP_DIRECTION_SHARE = 0.5;
/** Margin (cm) added around a cap's section for the plane it lies in. */
export const STEP_CAP_MARGIN = 1;
/** Weight of the data on the boundary rows of a fit (the stringer, the notch edge, the caps), which `snap` then makes exact. */
export const STEP_EDGE_WEIGHT = 100;
/** A station closer than this (parameter units) to a break of the first s knots is not added as a break of its own. */
export const STEP_STATION_GAP = 1e-3;

/** A fit needing more control points than this (per side) fails with a clear message instead of running for minutes. */
export const STEP_MAX_CONTROLS = 12000;
/**
 * The minus side of an asymmetric board is sampled at a reparametrised `t` near a collapsed end (a notch bottom
 * or a tip edge), so that its collapsed row is the plus side's row point for point: the share of `s` over which
 * the shift fades out, and the entries of the table that inverts the minus side's height along that edge.
 */
export const STEP_END_BLEND = 0.06;
export const STEP_WARP_TABLE = 1024;
/** Check samples per span along the boundary rows (the stringer, the apex and the ends), which `snap` moves. */
export const STEP_EDGE_SAMPLES = 24;

/**
 * The trim-and-blend kernel (`trim/`, docs/design/trim-blend-plan.md): the outline as a
 * closed loop, the rail blends swept along it and the trimmed panels between them.
 */
export const TRIM = {
  /** Outline sample spacing, cm: its floor and ceiling. */
  spacingMin: 0.035,
  spacingMax: 0.55,
  /** Between them, the spacing is this fraction of the local plan radius. */
  spacingPerRadius: 0.16,
  /** Spacing may grow by this fraction of the distance travelled, so a tight corner is approached finely from both sides and never stepped over. */
  spacingGrade: 0.25,
  /** Samples either side that the local plan radius is measured across. */
  radiusWindow: 3,
  /** A turn below this (radians) across that window is straight. */
  straightTurn: 1e-9,
  /** The radius reported for a straight stretch, cm. */
  straightRadius: 1e6,
  /** Two pieces whose directions differ by less than this (sine of the turn) join smoothly and get no corner. */
  cornerMinTurn: 0.03,
  /** How far along each piece a corner's tangent points are looked for: this many radii, plus this many cm. */
  cornerReachRadii: 7,
  cornerReach: 1,
  /** A corner whose radius will not fit is retried smaller: this many times, by this factor, down to this floor (cm). */
  cornerRetries: 6,
  cornerShrink: 0.6,
  cornerFloor: 0.02,
  /** A rounded corner is sampled in at least this many steps, and one per this many radians. */
  cornerSteps: 8,
  cornerStep: 0.07,
  /** Determinant below which two segments are parallel. */
  parallel: 1e-14,
  /** Shortest length treated as a length, cm. */
  tiny: 1e-12,
  /** Cap on the local feature size, cm. */
  featureCap: 60,
  /** Neighbours skipped either side when measuring local feature size, so a point's own arc does not count. */
  featureSkip: 2,
  /** A neighbour counts towards local feature size only when it is this far (cm) to the inside. */
  featureInside: 1e-9,
  /** A band may take this share of the smoothed local feature size, and never more than `bandHard` of the raw one, so bands from opposite edges cannot cross. */
  bandShare: 0.72,
  bandHard: 0.9,
  /** Arc length (cm) the local feature size is smoothed over before it limits a band. */
  bandSmooth: 0.35,
  /** Neighbours either side that the smoothing looks at. */
  smoothReach: 90,
  /** Sharpness of the soft minimum that applies the limit. */
  bandSoftmin: 5,
  /** The narrowest a band or tuck is ever built, cm: a hard edge is a very small blend, never a missing one. */
  bandMin: 0.05,
  /** The apex is kept this far, as a fraction, from either end of the wall, and a conic's rho this far from 0 and 1. */
  apexInset: 0.02,
  rhoInset: 0.05,
  /**
   * The least thickness (cm) the kernel builds the panels to, so a tip ends in a ball and never
   * a point: a thickness t becomes `(t^p + T^p)^(1/p)` with `T = tipThickness` and
   * `p = tipSharpness`, and `T` where the panels touch or cross. At these values a board 1 cm
   * thick gains 0.026 mm, one 2 cm thick under 0.001 mm.
   */
  tipThickness: 0.5,
  tipSharpness: 6,
  /** The least height (cm) of the rail's wall, from the bottom's tangent to the deck's, at any loop sample: the strips need a wall to stand on. */
  wallMin: 0.1,
  /** An edge's shoulder stops this fraction of the way short of the apex. */
  edgeShort: 0.05,
  /** Rows across the deck blend and across the tuck. */
  deckRows: 14,
  tuckRows: 10,
  /** Half step of the finite difference that reads a panel's slope at a band edge, and a panel's normal, cm. */
  slopeStep: 0.01,
  normalStep: 0.02,
  /** Panel grid nodes are nudged by this fraction of the grid spacing, so no three stitch vertices are collinear and the triangulator drops none. */
  gridJitter: 0.16,
  /** The loop is walked at this fraction of the grid spacing to find the cells it touches. */
  blockStep: 1 / 3,
  /** Passes of diagonal-pinch removal on the kept cells. */
  pinchPasses: 30,
  /** A panel is sampled every this many cm in a slice, and at least this many times per span. */
  sliceStep: 0.15,
  sliceMin: 4,
  /**
   * Reading a rail off a section (`trim/station.ts`). A panel ends `panelLead` (cm) inboard
   * of its band edge: more than the reach of the finite difference that reads its slope there
   * (`slopeStep`), so that is read on the straight stretch. Its direction at its end is read
   * over `panelBase` (cm) of panel before it, through this many even samples. Where a crease
   * lies within `panelClear` (cm) either side of the end, the panel ends that far inboard of the
   * crease instead, so the wobble of a sampled section's last half millimetre at a crease never
   * sets the panel's tangent. A crease further inboard shortens the stretch to the part
   * `panelClear` clear of it, while at least `panelBaseMin` (cm) is left; with less, the panel
   * ends inboard of that crease too.
   */
  panelLead: 0.03,
  panelBase: 0.4,
  panelSamples: 9,
  panelClear: 0.1,
  /**
   * A facet of `2 * panelClear + panelBaseMin` is read: 2.5 mm. At `panelBaseMin` 0.1 a 3 mm
   * facet would sit on the threshold, and the creases' placement, a fraction of a millimetre,
   * would give it up on half of the sections that have one.
   */
  panelBaseMin: 0.05,
  /** A crease: where a half turns towards its apex by this many degrees or more across this much arc (cm) either side, and by this share of that across the smaller arc (cm). It is looked for every `creaseStep` cm. */
  edgeJump: 8,
  creaseBase: 0.08,
  creaseTight: 0.03,
  creaseShare: 0.6,
  creaseStep: 0.01,
  /** A panel's end is moved clear of creases at most this many times, and a crease closer than this (cm) to the one just cleared is the same crease. */
  creasePasses: 3,
  creaseApart: 0.005,
  /** A deck's band starts where the deck, walking in from the apex, has come down to this slope (degrees above level). */
  deckSlope: 20,
  /** A bottom's band starts where the bottom has come back to within this many degrees of the direction of the panel just inboard: read from this far to this far inboard (cm of arc). */
  bottomTurn: 6,
  /**
   * Under the 'turn' rule the figure is at most this share of the turn at the apex, so a half
   * that turns up by less than twice `bottomTurn` still gets a band, half as far round; a turn
   * at the apex under `turnFloor` (degrees) is no rail, and the half is a hard edge.
   */
  turnShare: 0.5,
  turnFloor: 1,
  turnRefNear: 0.5,
  turnRefFar: 2,
  /** Arc (cm) either side of a sample that its direction is read across when a band edge is looked for. */
  turnBase: 0.05,
  /** Under the 'turn' rule, a half steeper than this (degrees) is rail, even where it has stopped turning: a tall rail's straight wall is not panel. */
  panelSteepest: 25,
  /** No band reaches further in from the wall than this share of the half width. */
  fitWidest: 0.6,
  /** A band edge this close (cm) to the apex leaves no blend: the panel runs to the wall. */
  fitNoBlend: 0.03,
  /**
   * A panel's own tangent has to meet the wall at least this far (cm) short of the apex for a
   * blend to stand on it. Under it a blend and a hard edge differ by less than this; over it a
   * half that curls up a degree or two gets its blend, so it does not jump to a hard edge.
   */
  fitRiseMin: 0.001,
  /** Shoulder heights tried besides the tangent one, as fractions of the way up the wall from the panel's tangent to the apex. */
  fitShoulders: [0.15, 0.3, 0.5, 0.7, 0.95],
  /** Golden-section steps on a blend's rho, and on its shoulder between two of those heights. */
  fitRhoSteps: 14,
  fitShoulderSteps: 8,
  /** Segments of a blend, and the spacing (cm) of the section's samples, when the gap between them is measured. */
  fitBlendSteps: 40,
  fitSpacing: 0.02,
  /** An edge is taken only when it is this much (cm) closer than the tangent blend. */
  fitEdgeGain: 0.005,
  /** A section is read as cutting the outline at an angle whose cosine is at least this: one nearly tangent to it would see the narrowest band many centimetres wide. */
  skewMin: 0.2,
  /** Default corner radii of a rails board's outline, cm: the ball on a nose, on a tail tip or corner, and in a notch's crotch. */
  radiusNose: 0.8,
  radiusTail: 0.6,
  radiusCrotch: 0.2,
  /** Samples of one outline piece per Bézier segment in it, gathered towards the piece's ends. */
  pieceSamples: 160,
  /**
   * The lofted panels (`trim/loft.ts`). A station curve is sampled at `loftOversample` points
   * per cell of the u grid across its extent in u, and at least `loftSegmentSamples` per Bézier
   * segment, then read on the grid by straight lines between those samples.
   */
  loftOversample: 8,
  loftSegmentSamples: 16,
  /** Node spacing (cm) of the tables of rocker, thickness and half width along x, read as cubic Hermites. */
  loftTableStep: 0.1,
  /** A half width (cm) under which a point is on the stringer: u is 0 and the panel has no slope across. */
  loftTipWidth: 1e-6,
  /**
   * Where the least thickness `T` stops taking a root: a panel pair thicker than `tipFar * T`
   * is thickened by the first term of the series of `(t^p + T^p)^(1/p)`, whose error is under
   * 1e-8 of t at this ratio with `tipSharpness` 6.
   */
  tipFar: 4,
  /**
   * Converting a sections board (`trim/convert.ts`). A section is sampled at
   * `convertSegmentSamples` even parameter steps per Bézier segment, at least as fine as the
   * bridge's 600 a half. A station is a tip, with no rail key of its own, where the board is
   * thinner than `convertMinThickness` (cm) or narrower than `convertMinChord` (cm, half
   * width). The outline's angle at a station is read by a central difference of the half width
   * over ±`convertSlopeStep` (cm). The knot where a curve leaves the section for its straight
   * end is smooth when the section's own tangent there is within `convertSmoothAngle`
   * (degrees, in physical units) of the panel's slope, and a corner otherwise.
   */
  convertSegmentSamples: 600,
  convertMinThickness: 0.6,
  convertMinChord: 2.5,
  convertSlopeStep: 0.5,
  convertSmoothAngle: 1,
  /** A triangle whose area is below this fraction of its longest edge squared is a sliver and adds no curvature. */
  curvatureSliverArea: 1e-9,
  /** A face tensor is rejected when its normal-equation determinant is below this fraction of the cube of the squared edge-length sum. */
  curvatureSolveDet: 1e-12,
  /** A vertex frame is not rotated onto a face whose normal is within this of opposite (1 + cosine below it): the face folds back on the vertex. */
  curvatureFoldCos: 1e-6,
  /**
   * The rails engine (`trim/native.ts`, docs/design/trim-blend-engine.md, "Cost"). Station
   * curves are lofted on an even u grid whose spacing at the widest half width is
   * `loftSpacing` (cm) or finer. The mesh is cut on a panel grid of `viewGrid` (cm) with the
   * strip rows `deckRows` and `tuckRows` at view quality, and of `draftGrid` with
   * `draftDeckRows` and `draftTuckRows` while dragging. For an STL face size f (cm) the grid
   * is min(`viewGrid`, f), the loop is sampled no coarser than f, and the rows are at least
   * `stlDeckRows` and `stlTuckRows`, scaled up by `stlFace / f` where f is finer than
   * `stlFace` (cm).
   */
  loftSpacing: 0.05,
  viewGrid: 0.7,
  draftGrid: 1,
  draftDeckRows: 8,
  draftTuckRows: 6,
  stlDeckRows: 28,
  stlTuckRows: 20,
  stlFace: 0.5,
  /**
   * Bottom features as a relief (`trim/relief.ts`): the half width is read from a table along
   * x with nodes `reliefStep` (cm) apart, as cubic Hermites whose node slopes are central
   * differences of the node values; the gradient through u = |y| / w(x) takes w' from it.
   */
  reliefStep: 0.1,
} as const;
