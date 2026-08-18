// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail bands — the flat facets a hand shaper planes into a squared blank before
 * blending the rail round.
 *
 * A shaper does not cut a rail curve. They cut a short sequence of flat planes and
 * blend them away: mark a line up the rail edge and another in from the deck corner,
 * plane the wedge between them, then step inboard and do it again with a shallower
 * cut. Two or three of those on the deck, one on the bottom (the "tuck"), and the
 * remaining corners sand into a rail. The numbers they work from usually come off a
 * printed reference chart. This module derives them from the board actually drawn.
 *
 * ## Tangents, not secants
 *
 * A rail cross-section is convex near the edge. For a facet at angle α, the plane to
 * cut is the **tangent at the point where the section's own slope is α** — not a chord
 * from the apex to the deck flat. A tangent to a convex curve lies outside it
 * everywhere; a chord can pass *inside* the target surface on a section with a heavy
 * deck dome, which means the cut eats foam the finished shape needed. That is the one
 * mistake this whole module exists to avoid, and `rail-facets.test.ts` pins it with a
 * property test rather than a fixture.
 *
 * ## The angles are the normal angles
 *
 * The profile spline runs bottom-centre → rail → deck-centre with x = distance from
 * the centreline and y = height, and the legacy tangent convention is `atan2(dx, dy)`
 * (see `bezier-curve.ts`). Walking it, `normalByTT` sweeps π (bottom flat) → π/2
 * (rail apex, where the tangent is vertical) → 0 (deck flat). So:
 *
 * - the **apex** is `normalByTT = π/2` — the same finder the area integral already
 *   uses to split deck from bottom;
 * - a **deck** facet α° off the deck plane is `normalByTT = α`;
 * - a **bottom** facet β° off the bottom plane is `normalByTT = 180° − β`.
 *
 * ## Dimensions follow the cutting order, not the algebra
 *
 * Band 1 is measured off the squared blank — in from the deck corner, up from the
 * bottom corner — because that is the only thing that exists when the first cut is
 * made. Band 2's mark is measured **on the already-cut face of band 1**, and so on.
 * Reporting every band as an offset from the original corner would be simpler and
 * useless: by the time band 2 is marked, the foam that corner referred to is on the
 * floor.
 *
 * ## No legacy oracle
 *
 * BoardCAD-LE has no rail bands, so there is no golden fixture to port against and
 * none to regenerate (`.claude/CLAUDE.md` rule 2). The tests use analytic oracles: a
 * rail zone built as an exact circular arc has closed-form tangent points, facet
 * vertices and band marks, and those are what the assertions compare to.
 *
 * Nothing here throws. A station that cannot be solved reports {@link RailFacetWarning}s
 * and omits the affected band — a shaper reading a printed number has no way to tell a
 * fabricated one from a real one, so we never fabricate.
 */
import { vec2, type Vec2 } from './vec2';
import { ANGLE_TOLERANCE, DEG_TO_RAD, RAD_TO_DEG, T_ONE, T_ZERO } from './constants';
import { maxX, normalByTT, pointByTT, ttByNormal, type Spline } from './bezier-spline';
import {
  bisectionLadder,
  clearOf,
  dist,
  fitDeck,
  lineAt,
  maxYAt,
  measureLeftover,
  meet,
  meetHorizontal,
  meetVertical,
  type Line,
  type RailAngleMode,
  type RailLeftover,
} from './rail-facet-fit';
import {
  getInterpolatedCrossSection,
  getLength,
  getMaxWidthPos,
  getThicknessAtPos,
  getWidthAtPos,
  type BezierBoard,
} from './board';
import type { CrossSection } from './cross-section';

// --- options -------------------------------------------------------------------

/** The dials a rail-band set is described by. */
export interface RailFacetOptions {
  /** Deck-side band count, 1..{@link MAX_BANDS}. Default 3. */
  readonly deckBands?: number;
  /**
   * How the deck angles are chosen. Default `'balanced'` — see `rail-facet-fit.ts` for
   * the table of what each one leaves behind, and why the default is not `'least-foam'`.
   */
  readonly angleMode?: RailAngleMode;
  /** Angle grid for the fitted modes, degrees. Default 0.5. */
  readonly angleStepDeg?: number;
  /** Closest two fitted bands may sit, degrees. Default 4. */
  readonly minAngleGapDeg?: number;
  /** Shallowest a fitted band may be, degrees. Default 3. */
  readonly minBandAngleDeg?: number;
  /**
   * Explicit deck angles in degrees, outer→inner, strictly decreasing. Overrides both the
   * ladder and the fit — this is how the PDF traces a band between two stations without
   * re-fitting at every sample along the way.
   */
  readonly deckAngles?: readonly number[];
  /** Bottom (tuck) facet angle off the bottom plane, degrees. Default 30 — a common plane setting. */
  readonly bottomAngle?: number;
  /** How far in from the rail counts as "rail zone", as a fraction of half-width. Default 0.45. */
  readonly railZoneFraction?: number;
  /** Below this the residual bottom-edge round is not worth noting (cm). Default 0.05 = 0.5 mm. */
  readonly minEdgeRadius?: number;
  /** Above this a radius fit is treated as a straight run, not a round (cm). Default 15. */
  readonly maxEdgeRadius?: number;
}

/** Station selection: a target spacing, fitted to the length being banded. */
export interface RailFacetStationOptions {
  /**
   * How far apart to aim for (cm). Default 30.48 = 12 in.
   *
   * A *target*, not a promise: the actual spacing is adjusted so the stations land
   * exactly on both ends of the banded length. See {@link railFacetStations}.
   */
  readonly targetSpacingCm?: number;
  /** Leave this much of each tip alone, where the rail is all blend (cm). Default 20. */
  readonly endMarginCm?: number;
  /** Explicit stations (cm from tail); overrides the fit. */
  readonly stations?: readonly number[];
}

export const MAX_BANDS = 6;

const DEFAULT_DECK_BANDS = 3;
const DEFAULT_BOTTOM_ANGLE = 30;
const DEFAULT_RAIL_ZONE_FRACTION = 0.45;
const DEFAULT_MIN_EDGE_RADIUS = 0.05;
const DEFAULT_MAX_EDGE_RADIUS = 15;
const DEFAULT_TARGET_SPACING_CM = 30.48; // 12 in
const DEFAULT_END_MARGIN_CM = 20;

/**
 * Below this width or thickness a station is not a rail. `loft.ts`/`board-surface.ts`
 * floor scaled dimensions at `MIN_DIM = 0.5` cm, so a pointed tip reports a phantom
 * 5 mm ring; anything near that is noise, not geometry.
 */
const MIN_STATION_DIM = 1.1;

/** Samples for the coarse bracket scan across a rail-zone side. */
const SCAN_SAMPLES = 512;
/** Bisection steps; tt resolution ends up far below anything a planer resolves. */
const BISECT_ITERS = 60;
/** How close the verified apex must sit to the section's own max half-width (cm). */
const APEX_X_TOL = 0.02;
/** Samples used for the extremum scans and the circle fit. */
const EXTREMUM_SAMPLES = 256;
/** Longest arc the bottom-edge radius is fitted over (cm). */
const EDGE_FIT_MAX_ARC = 3;
/** Section samples a facet is checked against before it is allowed to cut. */
const CLEARANCE_SAMPLES = 512;

// --- results -------------------------------------------------------------------

/** What a mark is measured from. */
export type MarkRef =
  | { readonly kind: 'deckPlane' }
  | { readonly kind: 'bottomPlane' }
  | { readonly kind: 'railPlane' }
  /** The already-cut face of an earlier facet, measured from its flat-ward edge. */
  | { readonly kind: 'facet'; readonly index: number };

/** One pencil line: how far, measured from what, and where it lands. */
export interface RailFacetMark {
  readonly ref: MarkRef;
  /** Distance from the reference (cm), along the plane or facet named by `ref`. */
  readonly distance: number;
  /** Where the mark sits in section coordinates (x = half-width, y = height). */
  readonly at: Vec2;
}

/** One planed facet. */
export interface FacetLine {
  /** 1-based, in cutting order. */
  readonly index: number;
  readonly side: 'deck' | 'bottom';
  /** The angle asked for (degrees off the deck/bottom plane). */
  readonly targetAngle: number;
  /** The angle achieved at the tangent point — may differ slightly on a coarse section. */
  readonly angle: number;
  /** Where the facet touches the designed section. */
  readonly touch: Vec2;
  /** The cut as actually made: from the rail-ward end to the flat-ward end. */
  readonly cutFrom: Vec2;
  readonly cutTo: Vec2;
  /** The part of the facet still standing after the next band is cut. */
  readonly keepFrom: Vec2;
  readonly keepTo: Vec2;
  /** Length of the cut face (cm). */
  readonly width: number;
  /** How much farther in this band's flat-plane mark sits than the previous band's (cm). */
  readonly step: number;
  readonly marks: readonly RailFacetMark[];
}

export type RailFacetWarningCode =
  | 'bad-angle-input'
  | 'angle-fit-failed'
  | 'no-section'
  | 'degenerate-station'
  | 'non-convex-rail-zone'
  | 'tangent-not-found'
  | 'facet-inverted'
  | 'unvalidated-bottom';

/** Something the shaper needs to know before trusting a number. Never embeds a length. */
export interface RailFacetWarning {
  readonly code: RailFacetWarningCode;
  readonly message: string;
  /** Station position (cm from tail), when the warning belongs to one. */
  readonly position?: number;
  readonly facetIndex?: number;
}

/** The squared blank's reference planes at one station. */
export interface BlankRef {
  /** Deck plane height — the section's highest point; the blank's deck is still flat here. */
  readonly deckY: number;
  /** Bottom plane height — the lowest point *within the rail zone*, not at the stringer. */
  readonly bottomY: number;
  /** Rail plane — the blank's side face, at the section's max half-width. */
  readonly railX: number;
  readonly thickness: number;
}

/** Leftover foam at one station, per side. See {@link measureStation} for why they split. */
export interface RailStationLeftover {
  /** Deck side, scored across the whole half-section. */
  readonly deck: RailLeftover;
  /** Bottom side, scored across the rail zone only. */
  readonly bottom: RailLeftover;
}

export interface RailStationFacets {
  /** cm from the tail. */
  readonly position: number;
  readonly halfWidth: number;
  readonly apex: Vec2;
  readonly blank: BlankRef;
  readonly deckFacets: readonly FacetLine[];
  readonly bottomFacets: readonly FacetLine[];
  /** Residual bottom-edge round (cm), or null when it is flat, unfittable or below the floor. */
  readonly edgeRadius: number | null;
  /** Un-cut vertical strip left on the blank's side face, to be blended away (cm). */
  readonly residualSideHeight: number;
  /** What these cuts leave for the sanding block, deck and bottom scored separately. */
  readonly leftover: RailStationLeftover;
  /** The designed section, for drawing the ghost curve behind the facets. */
  readonly section: CrossSection;
  readonly warnings: readonly RailFacetWarning[];
}

export interface RailFacetPlan {
  readonly stations: readonly RailStationFacets[];
  readonly widePoint: number;
  readonly warnings: readonly RailFacetWarning[];
}

// --- angles --------------------------------------------------------------------

const validAngle = (a: number): boolean => Number.isFinite(a) && a > 0 && a < 90;

/** Fit options pulled straight off the facet options, so the defaults live in one place. */
const fitOptsFrom = (o: RailFacetOptions, bands: number) => ({
  mode: o.angleMode ?? 'balanced',
  stepDeg: o.angleStepDeg,
  minGapDeg: o.minAngleGapDeg,
  minAngleDeg: o.minBandAngleDeg,
  maxBands: bands,
});

/**
 * Resolve and validate the deck angles, or explain why they are unusable.
 *
 * Needs the section, because two of the three modes derive the angles from it. An
 * explicit `deckAngles` still wins over everything.
 */
const resolveDeckAngles = (
  o: RailFacetOptions,
  s: Spline,
  ttApex: number,
): { angles: number[]; error?: string; fallback?: string } => {
  if (o.deckAngles) {
    const a = [...o.deckAngles];
    if (a.length === 0 || a.length > MAX_BANDS) {
      return { angles: [], error: `deck band count must be between 1 and ${MAX_BANDS}` };
    }
    if (!a.every(validAngle)) {
      return { angles: [], error: 'every deck angle must be between 0 and 90 degrees' };
    }
    for (let i = 1; i < a.length; i++) {
      if (a[i]! >= a[i - 1]!) {
        return { angles: [], error: 'deck angles must decrease from the rail inward' };
      }
    }
    return { angles: a };
  }
  const n = o.deckBands ?? DEFAULT_DECK_BANDS;
  if (!Number.isInteger(n) || n < 1 || n > MAX_BANDS) {
    return {
      angles: [],
      error: `deck band count must be a whole number between 1 and ${MAX_BANDS}`,
    };
  }
  if (o.angleMode === 'ladder') return { angles: bisectionLadder(n) };

  const fit = fitDeck(s, ttApex, fitOptsFrom(o, n));
  // A section the fitter cannot walk convexly falls back to the ladder rather than to a
  // fabricated angle: the ladder is at least a number the shaper has seen before, and the
  // fallback is stated on the sheet instead of being silently absorbed.
  if (!fit || fit.byCount.length === 0) {
    return {
      angles: bisectionLadder(n),
      fallback:
        'the angles here could not be fitted to this section, so the halving ladder was used instead',
    };
  }
  const best = fit.byCount[Math.min(n, fit.byCount.length) - 1]!;
  return {
    angles: [...best],
    ...(best.length < n
      ? { fallback: 'this section had room for fewer bands than asked for, and was given the most it could take' } // prettier-ignore
      : {}),
  };
};

/**
 * How much of the proud foam each band count would remove at this station, 1..MAX_BANDS.
 *
 * Comes straight off the dynamic program's layers, so getting the whole curve costs no
 * more than getting one point of it — which is the entire reason a shaper can be shown
 * where the returns die before choosing a count. These are the *ideal* placements: a
 * station that ends up dropping a band (the sheet warns when it does) will do slightly
 * worse than the curve promises.
 */
export const railBandTradeoff = (
  cs: CrossSection,
  opts: RailFacetOptions = {},
): readonly { bands: number; removed: number; areaCm2: number }[] => {
  const { tt } = findApexTT(cs.spline);
  const fit = fitDeck(cs.spline, tt, fitOptsFrom(opts, MAX_BANDS));
  if (!fit || fit.bareArea <= 1e-9) return [];
  return fit.areaByCount.map((area, i) => ({
    bands: i + 1,
    areaCm2: area,
    removed: Math.max(0, Math.min(1, 1 - area / fit.bareArea)),
  }));
};

// --- apex, zone, reference planes ----------------------------------------------

/** Scan tt for the maximum half-width, then refine by golden section. */
const scanApexTT = (s: Spline): number => {
  let bestTT = 0;
  let best = -Infinity;
  for (let i = 0; i <= SCAN_SAMPLES; i++) {
    const tt = i / SCAN_SAMPLES;
    const x = pointByTT(s, tt).x;
    if (x > best) {
      best = x;
      bestTT = tt;
    }
  }
  let lo = Math.max(0, bestTT - 1 / SCAN_SAMPLES);
  let hi = Math.min(1, bestTT + 1 / SCAN_SAMPLES);
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40; i++) {
    const c = hi - (hi - lo) * phi;
    const d = lo + (hi - lo) * phi;
    if (pointByTT(s, c).x > pointByTT(s, d).x) hi = d;
    else lo = c;
  }
  return (lo + hi) / 2;
};

/**
 * The apex: the point of maximum half-width, where the tangent is vertical, and
 * exactly where the unshaped blank's rail edge touches the contour. `ttByNormal` is
 * the finder the area integral already trusts, but it is a root find over the whole
 * spline, so the answer is verified against the section's own max x before use.
 */
const findApexTT = (s: Spline): { tt: number; verified: boolean } => {
  const tt = ttByNormal(s, Math.PI / 2);
  if (Number.isFinite(tt) && tt > 0 && tt < 1) {
    const okNormal = Math.abs(normalByTT(s, tt) - Math.PI / 2) < 20 * ANGLE_TOLERANCE;
    const okX = pointByTT(s, tt).x >= maxX(s) - APEX_X_TOL;
    if (okNormal && okX) return { tt, verified: true };
  }
  return { tt: scanApexTT(s), verified: false };
};

/** Walk from `from` toward `to` until x drops below `xInner`; returns the crossing tt. */
const zoneEdgeTT = (s: Spline, from: number, to: number, xInner: number): number => {
  const steps = EXTREMUM_SAMPLES;
  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const tt = from + ((to - from) * i) / steps;
    if (pointByTT(s, tt).x < xInner) {
      let lo = prev;
      let hi = tt;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (pointByTT(s, mid).x < xInner) hi = mid;
        else lo = mid;
      }
      return (lo + hi) / 2;
    }
    prev = tt;
  }
  return to;
};

/**
 * Minimum y over a tt range, reported at the **outboard-most** point that attains it.
 *
 * Which end matters. A flat bottom attains its minimum over a whole interval, and the
 * inboard end of that interval is metres of flat foam away from the rail; the point
 * worth knowing is where the flat stops and the edge starts to turn, which is the
 * outboard end. On a section that genuinely dips near the rail the interval collapses
 * to the dip and both answers agree.
 */
const minYOver = (s: Spline, a: number, b: number): { tt: number; y: number } => {
  const ys: number[] = [];
  let best = Infinity;
  for (let i = 0; i <= EXTREMUM_SAMPLES; i++) {
    const y = pointByTT(s, a + ((b - a) * i) / EXTREMUM_SAMPLES).y;
    ys.push(y);
    if (y < best) best = y;
  }
  const FLAT_TOL = 1e-4; // 1 micron: fp noise along a straight run, not a real dip
  let lastTT = a;
  for (let i = 0; i < ys.length; i++) {
    if (ys[i]! <= best + FLAT_TOL) lastTT = a + ((b - a) * i) / EXTREMUM_SAMPLES;
  }
  return { tt: lastTT, y: best };
};

// --- tangent search ------------------------------------------------------------

/**
 * The tt where the surface normal equals `target`, searched **outward from the apex
 * within one side of the rail zone only**.
 *
 * Deliberately not `ttByNormal`: that root-finds across the whole spline, and any
 * normal angle occurs on both branches — three times on a section with a bottom
 * concave — so it can return a point on the far side of the board. Scanning outward
 * from the apex and taking the *first* sign change makes the outermost solution the
 * only reachable one.
 */
const findTangentTT = (s: Spline, ttApex: number, ttEnd: number, target: number): number | null => {
  const f = (tt: number): number => normalByTT(s, tt) - target;
  let prevTT = ttApex;
  let prev = f(ttApex);
  if (prev === 0) return ttApex;
  for (let i = 1; i <= SCAN_SAMPLES; i++) {
    const tt = ttApex + ((ttEnd - ttApex) * i) / SCAN_SAMPLES;
    const cur = f(tt);
    if (cur === 0) return tt;
    if (prev < 0 !== cur < 0) {
      let lo = prevTT;
      let hi = tt;
      let flo = prev;
      for (let k = 0; k < BISECT_ITERS; k++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (fm === 0) return mid;
        if (flo < 0 !== fm < 0) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      return (lo + hi) / 2;
    }
    prevTT = tt;
    prev = cur;
  }
  return null;
};

// --- residual bottom-edge radius -----------------------------------------------

/** Algebraic (Kåsa) circle fit: solves x² + y² + Dx + Ey + F = 0 in least squares. */
const fitCircle = (pts: readonly Vec2[]): { c: Vec2; r: number; rms: number } | null => {
  const n = pts.length;
  if (n < 4) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0,
    sz = 0,
    sxz = 0,
    syz = 0;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
    sz += z;
    sxz += p.x * z;
    syz += p.y * z;
  }
  // Normal equations for [D, E, F] with right-hand side -[sxz, syz, sz].
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const rhs = [-sxz, -syz, -sz];
  const det =
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  // A near-straight run makes this system ill-conditioned; scale-free rejection.
  const scale = Math.max(sxx + syy, 1e-9);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * scale * scale) return null;

  const solve3 = (col: number): number => {
    const a = m.map((row, i) => row.map((v, j) => (j === col ? rhs[i]! : v)));
    return (
      (a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) -
        a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) +
        a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!)) /
      det
    );
  };
  const D = solve3(0);
  const E = solve3(1);
  const F = solve3(2);
  const c = vec2(-D / 2, -E / 2);
  const rsq = (D * D + E * E) / 4 - F;
  if (!(rsq > 0)) return null;
  const r = Math.sqrt(rsq);
  let acc = 0;
  for (const p of pts) {
    const d = dist(p, c) - r;
    acc += d * d;
  }
  return { c, r, rms: Math.sqrt(acc / n) };
};

// --- one station ---------------------------------------------------------------

const warn = (
  code: RailFacetWarningCode,
  message: string,
  position: number,
  facetIndex?: number,
): RailFacetWarning => ({ code, message, position, ...(facetIndex ? { facetIndex } : {}) });

/**
 * Build the facet set for one already-resolved cross-section. This is where all the
 * geometry lives; {@link railFacetsAt} only fetches the section for a station.
 *
 * Never throws: anything that cannot be solved comes back as a warning with the
 * affected band omitted.
 */
export const railFacetsForSection = (
  cs: CrossSection,
  opts: RailFacetOptions = {},
): RailStationFacets => {
  const x = cs.position;
  const s = cs.spline;
  const warnings: RailFacetWarning[] = [];

  const bottomAngle = opts.bottomAngle ?? DEFAULT_BOTTOM_ANGLE;
  if (!validAngle(bottomAngle)) {
    warnings.push(warn('bad-angle-input', 'the tuck angle must be between 0 and 90 degrees', x));
  }

  // --- apex + rail zone ---
  const apexInfo = findApexTT(s);
  const ttApex = apexInfo.tt;
  const apex = pointByTT(s, ttApex);
  if (!apexInfo.verified) {
    warnings.push(
      warn(
        'non-convex-rail-zone',
        'the rail apex had to be found by scanning — the section may have a flat or kinked rail edge',
        x,
      ),
    );
  }

  const zoneFraction = opts.railZoneFraction ?? DEFAULT_RAIL_ZONE_FRACTION;
  const zoneInnerX = apex.x * (1 - zoneFraction);
  const ttZoneHi = zoneEdgeTT(s, ttApex, T_ONE, zoneInnerX); // toward the deck
  const ttZoneLo = zoneEdgeTT(s, ttApex, T_ZERO, zoneInnerX); // toward the bottom

  // --- reference planes on the squared blank ---
  // The deck is still flat when the bands are cut (the dome comes after), so the deck
  // plane is the section's high point. The bottom plane is the low point *within the
  // rail zone*: a section with a kink near the rail dips below its stringer value, and
  // measuring up from the stringer would then start below the foam that exists.
  const deck = maxYAt(s, 0, 1, EXTREMUM_SAMPLES);
  const deckY = deck.y;
  // The deck branch is walked to its own high point, not to the rail-zone edge: bands are
  // scored and placed all the way in to the stringer, so a fitted angle shallower than
  // the zone still has to find its tangent. The zone continues to bound the bottom side,
  // the convexity checks and the edge-radius fit.
  const ttDeckTop = Math.max(deck.tt, ttZoneHi);
  const zoneMin = minYOver(s, ttZoneLo, ttApex);
  const bottomY = Math.min(zoneMin.y, pointByTT(s, T_ZERO).y);
  const railX = apex.x;
  const blank: BlankRef = { deckY, bottomY, railX, thickness: deckY - bottomY };

  // --- the angles themselves ---
  // Resolved here rather than at the top because two of the three modes read the section
  // to place their bands, and none of that is knowable before the apex is.
  const { angles: deckAngles, error, fallback } = resolveDeckAngles(opts, s, ttApex);
  if (error) warnings.push(warn('bad-angle-input', error, x));
  if (fallback) warnings.push(warn('angle-fit-failed', fallback, x));

  // Sampled once and reused: every facet is checked against the whole section, not just
  // its own branch, because "outside the shape" has to mean the whole shape.
  const sectionPts = arcPoints(s, T_ZERO, T_ONE, CLEARANCE_SAMPLES);

  // --- bottoms this method has not been proven on ---
  warnings.push(...bottomZoneWarnings(s, ttZoneLo, ttApex, x));

  // --- deck facets, outer (steepest) to inner ---
  const deckFacets: FacetLine[] = [];
  const lines: Line[] = [];
  const cutTos: Vec2[] = [];
  let prevDeckMarkX = railX;
  for (let i = 0; i < deckAngles.length; i++) {
    const target = deckAngles[i]! * DEG_TO_RAD;
    const tt = findTangentTT(s, ttApex, ttDeckTop, target);
    if (tt === null) {
      warnings.push(
        warn(
          'tangent-not-found',
          'the section never reaches this angle inside the rail zone, so the band is not shown',
          x,
          i + 1,
        ),
      );
      continue;
    }
    const cleared = clearOf(lineAt(s, tt), sectionPts);
    const line = cleared.line;
    const touch = cleared.touch;
    const cutTo = meetHorizontal(line, deckY); // every cut runs to the deck flat
    if (!cutTo) {
      warnings.push(warn('facet-inverted', 'this band never meets the deck plane', x, i + 1));
      continue;
    }
    const prevLine = lines[lines.length - 1];
    let cutFrom: Vec2 | null;
    if (!prevLine) {
      cutFrom = meetVertical(line, railX);
    } else {
      cutFrom = meet(prevLine, line);
    }
    if (!cutFrom) {
      warnings.push(
        warn('facet-inverted', 'this band runs parallel to the one before it', x, i + 1),
      );
      continue;
    }
    // A tangent cannot cut inside a convex curve; if the construction says otherwise the
    // zone was not convex, and a wrong number is worse than a missing one.
    const prevTouch = lines[lines.length - 1]?.p;
    if (
      cutFrom.x > railX + 1e-6 ||
      cutTo.x >= prevDeckMarkX ||
      (prevTouch && cutFrom.x > prevTouch.x + 1e-6)
    ) {
      warnings.push(
        warn(
          'facet-inverted',
          'this band would cut inside the shape it is meant to leave — the rail zone is not convex here',
          x,
          i + 1,
        ),
      );
      continue;
    }

    const marks: RailFacetMark[] = [];
    if (!prevLine) {
      const railHit = meetVertical(line, railX)!;
      marks.push({ ref: { kind: 'deckPlane' }, distance: railX - cutTo.x, at: cutTo });
      marks.push({ ref: { kind: 'railPlane' }, distance: railHit.y - bottomY, at: railHit });
    } else {
      const prevCutTo = cutTos[cutTos.length - 1]!;
      marks.push({
        ref: { kind: 'facet', index: deckFacets[deckFacets.length - 1]!.index },
        distance: dist(prevCutTo, cutFrom),
        at: cutFrom,
      });
      marks.push({ ref: { kind: 'deckPlane' }, distance: railX - cutTo.x, at: cutTo });
    }

    deckFacets.push({
      index: deckFacets.length + 1,
      side: 'deck',
      targetAngle: deckAngles[i]!,
      angle: normalByTT(s, tt) * RAD_TO_DEG,
      touch,
      cutFrom,
      cutTo,
      keepFrom: cutFrom,
      keepTo: cutTo,
      width: dist(cutFrom, cutTo),
      step: prevDeckMarkX - cutTo.x,
      marks,
    });
    lines.push(line);
    cutTos.push(cutTo);
    prevDeckMarkX = cutTo.x;
  }

  // Each band eats the inner end of the one before it: trim the kept face back to the
  // vertex it shares with the next cut.
  for (let i = 0; i < deckFacets.length - 1; i++) {
    const next = deckFacets[i + 1]!;
    deckFacets[i] = { ...deckFacets[i]!, keepTo: next.cutFrom };
  }

  // --- bottom tuck ---
  const bottomFacets: FacetLine[] = [];
  let tuckTT: number | null = null;
  if (validAngle(bottomAngle)) {
    const target = (180 - bottomAngle) * DEG_TO_RAD;
    tuckTT = findTangentTT(s, ttApex, ttZoneLo, target);
    if (tuckTT === null) {
      warnings.push(
        warn(
          'tangent-not-found',
          'the bottom never reaches the tuck angle inside the rail zone, so no tuck is shown',
          x,
          1,
        ),
      );
    } else {
      const { line, touch } = clearOf(lineAt(s, tuckTT), sectionPts);
      const railHit = meetVertical(line, railX);
      const flatHit = meetHorizontal(line, bottomY);
      if (railHit && flatHit) {
        bottomFacets.push({
          index: 1,
          side: 'bottom',
          targetAngle: bottomAngle,
          angle: 180 - normalByTT(s, tuckTT) * RAD_TO_DEG,
          touch,
          cutFrom: railHit,
          cutTo: flatHit,
          keepFrom: railHit,
          keepTo: flatHit,
          width: dist(railHit, flatHit),
          step: railX - flatHit.x,
          marks: [
            { ref: { kind: 'railPlane' }, distance: railHit.y - bottomY, at: railHit },
            { ref: { kind: 'bottomPlane' }, distance: railX - flatHit.x, at: flatHit },
          ],
        });
      } else {
        warnings.push(warn('facet-inverted', 'the tuck never meets the blank corner', x, 1));
      }
    }
  }

  // --- residual bottom-edge round ---
  const edge = fitEdgeRadius(s, ttZoneLo, zoneMin.tt, tuckTT, opts);
  if (edge.warning) warnings.push(warn(edge.warning.code, edge.warning.message, x));

  const firstDeckRail = deckFacets[0]?.marks.find((m) => m.ref.kind === 'railPlane');
  const tuckRail = bottomFacets[0]?.marks.find((m) => m.ref.kind === 'railPlane');
  const residualSideHeight =
    firstDeckRail && tuckRail ? Math.max(0, firstDeckRail.distance - tuckRail.distance) : 0;

  const leftover = measureStation(s, {
    apex,
    ttApex,
    ttDeckTop,
    ttZoneLo,
    blank,
    deckFacets,
    bottomFacets,
  });

  return {
    position: x,
    halfWidth: apex.x,
    apex,
    blank,
    deckFacets,
    bottomFacets,
    edgeRadius: edge.radius,
    residualSideHeight,
    leftover,
    section: cs,
    warnings,
  };
};

/** Section points from `a` to `b` in tt order, for closing a loop against a cut path. */
const arcPoints = (s: Spline, a: number, b: number, n = EXTREMUM_SAMPLES): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => pointByTT(s, a + ((b - a) * i) / n));

/**
 * What these cuts leave standing proud of the finished section, deck and bottom apart.
 *
 * Kept separate on purpose. On a board with bottom concave the foam between the bottom
 * plane and the section near the stringer is real, but it comes off when the concave is
 * cut, not when the tuck is — folding it into one headline number would blame the tuck
 * for work that was never its own. So the deck is scored across the whole half-section
 * (bands now run all the way in) and the bottom only across the rail zone.
 */
const measureStation = (
  s: Spline,
  st: {
    apex: Vec2;
    ttApex: number;
    ttDeckTop: number;
    ttZoneLo: number;
    blank: BlankRef;
    deckFacets: readonly FacetLine[];
    bottomFacets: readonly FacetLine[];
  },
): RailStationLeftover => {
  const { apex, blank } = st;
  const { deckY, bottomY, railX } = blank;

  // Deck: the section from its high point out to the apex, closed against the cut path.
  // Walking the facets from the deck plane outward, each one contributes its shared
  // vertex with the band before it — which is exactly what `cutFrom` already holds.
  const deckSection = arcPoints(s, st.ttDeckTop, st.ttApex);
  const inner = st.deckFacets[st.deckFacets.length - 1];
  const deckCut: Vec2[] = [deckSection[0]!];
  if (inner) {
    deckCut.push(inner.cutTo);
    for (let i = st.deckFacets.length - 1; i >= 0; i--) deckCut.push(st.deckFacets[i]!.cutFrom);
  } else {
    deckCut.push(vec2(railX, deckY));
  }
  deckCut.push(apex);
  const deckBare = [deckSection[0]!, vec2(railX, deckY), apex];

  // Bottom: apex down to the rail-zone edge, closed with a vertical at that edge so the
  // two paths share endpoints with the section.
  const bottomSection = arcPoints(s, st.ttApex, st.ttZoneLo);
  const zoneEnd = bottomSection[bottomSection.length - 1]!;
  const tuck = st.bottomFacets[0];
  const bottomCut: Vec2[] = [apex];
  if (tuck) {
    bottomCut.push(tuck.cutFrom, tuck.cutTo);
  } else {
    bottomCut.push(vec2(railX, bottomY));
  }
  bottomCut.push(vec2(zoneEnd.x, bottomY), zoneEnd);
  const bottomBare = [apex, vec2(railX, bottomY), vec2(zoneEnd.x, bottomY), zoneEnd];

  return {
    deck: measureLeftover(deckCut, deckBare, deckSection),
    bottom: measureLeftover(bottomCut, bottomBare, bottomSection),
  };
};

/** Build the facet set at station `x`, or null when the board has no section there. */
export const railFacetsAt = (
  board: BezierBoard,
  x: number,
  opts: RailFacetOptions = {},
): RailStationFacets | null => {
  const cs = getInterpolatedCrossSection(board, x);
  return cs ? railFacetsForSection(cs, opts) : null;
};

/**
 * Fit the round left on the bottom edge after the tuck is cut — a note, not a facet.
 *
 * The window runs from the tuck's touch point inboard, and stops at the in-zone
 * minimum: reaching past that low point into the concavity beyond it fits a circle to
 * an S-curve and returns a meaningless radius. It is also capped by arc length, and
 * the result is clamped — an almost-straight tail section otherwise fits a radius of
 * metres, which is a straight line wearing a number.
 */
const fitEdgeRadius = (
  s: Spline,
  ttZoneLo: number,
  ttMin: number,
  tuckTT: number | null,
  opts: RailFacetOptions,
): { radius: number | null; warning?: { code: RailFacetWarningCode; message: string } } => {
  if (tuckTT === null) return { radius: null };
  // tt rises toward the apex on the bottom side, so the outboard-most of the two
  // candidate starts is the larger. Capping at the in-zone minimum is the whole point:
  // past that low point the curve turns back, and a circle fitted across the turn
  // describes nothing.
  const winLo = Math.max(ttZoneLo, ttMin);
  if (!(tuckTT > winLo)) return { radius: null };

  // Sample the window, trimming it from the inboard end to the arc-length cap.
  const raw: Vec2[] = [];
  for (let i = 0; i <= EXTREMUM_SAMPLES; i++) {
    raw.push(pointByTT(s, winLo + ((tuckTT - winLo) * i) / EXTREMUM_SAMPLES));
  }
  const pts: Vec2[] = [raw[raw.length - 1]!];
  let arc = 0;
  for (let i = raw.length - 2; i >= 0; i--) {
    arc += dist(raw[i]!, raw[i + 1]!);
    if (arc > EDGE_FIT_MAX_ARC) break;
    pts.push(raw[i]!);
  }
  // A null radius is not a failure and gets no warning: plenty of bottom edges are
  // deliberately hard, or blended rather than round, and there is simply no radius to
  // report. The sheet says so in the edge column. Warning about it would put a caveat
  // on every board with a hard tail edge, which is most of them.
  const fit = fitCircle(pts);
  if (!fit || fit.rms > 0.05) return { radius: null };
  // The centre must sit inside the foam, not out in the air.
  const mid = pts[Math.floor(pts.length / 2)]!;
  const nu = normalByTT(s, winLo + (tuckTT - winLo) / 2);
  const inward = vec2(-Math.sin(nu), -Math.cos(nu));
  if ((fit.c.x - mid.x) * inward.x + (fit.c.y - mid.y) * inward.y <= 0) return { radius: null };
  // Both bounds are sanity limits on the *fit*, not clamps on a real measurement. A
  // near-straight run near the tail fits a circle metres across; reporting that clamped
  // to 15 cm would print a number that describes nothing, and a caveat next to a number
  // is no defence — the shaper reads the number. Outside the bounds there is no round
  // worth noting, which is exactly what `null` already means everywhere else here.
  const min = opts.minEdgeRadius ?? DEFAULT_MIN_EDGE_RADIUS;
  const max = opts.maxEdgeRadius ?? DEFAULT_MAX_EDGE_RADIUS;
  if (fit.r < min || fit.r > max) return { radius: null };
  return { radius: fit.r };
};

/**
 * Test the one assumption the whole construction rests on: that the bottom half of
 * the rail zone is a **simple convex turn**. Convexity is exactly monotonicity of the
 * normal angle along the curve, so that is what gets measured — not a catalogue of
 * shape names.
 *
 * Testing the zone rather than the whole section matters. A single concave lifts the
 * bottom at the stringer on a large share of real boards, and warning about every one
 * of them would train the shaper to ignore the warnings; the concave runs out well
 * inboard of the zone and the method never touches it. A vee, a hard edge or a channel
 * that reaches into the zone *does* break the assumption, and none of the three has
 * been checked against a real cut board.
 */
const bottomZoneWarnings = (
  s: Spline,
  ttZoneLo: number,
  ttApex: number,
  x: number,
): RailFacetWarning[] => {
  const steps = 64;
  const normals: number[] = [];
  for (let i = 0; i <= steps; i++) {
    normals.push(normalByTT(s, ttZoneLo + ((ttApex - ttZoneLo) * i) / steps));
  }
  // Walking toward the apex the normal falls π → π/2. A jump this big in one step is a
  // crease, not a curve.
  let maxJump = 0;
  let reversal = 0;
  for (let i = 1; i < normals.length; i++) {
    const d = normals[i]! - normals[i - 1]!;
    maxJump = Math.max(maxJump, Math.abs(d));
    if (d > 0) reversal = Math.max(reversal, d); // convex would only ever fall
  }
  if (maxJump > 25 * DEG_TO_RAD) {
    return [
      warn(
        'unvalidated-bottom',
        'this section has a hard bottom edge — the band method has not been checked against one',
        x,
      ),
    ];
  }
  if (reversal > 0.5 * DEG_TO_RAD) {
    return [
      warn(
        'unvalidated-bottom',
        'the bottom of the rail zone is not a simple convex turn (vee, channel or edge) — the band method has not been checked against one',
        x,
      ),
    ];
  }
  return [];
};

// --- stations + whole-board plan -----------------------------------------------

/** Is there enough board at `x` to have a rail worth banding? */
const bandable = (b: BezierBoard, x: number): boolean =>
  x >= 0 &&
  x <= getLength(b) &&
  getWidthAtPos(b, x) >= MIN_STATION_DIM &&
  getThicknessAtPos(b, x) >= MIN_STATION_DIM;

/**
 * Walk in from `from` toward `to` until the board is bandable, and return that point.
 *
 * Returns `from` unchanged when it is already bandable, which is the common case — this
 * only bites when a margin lands inside a tip that tapers to nothing.
 */
const bandableEnd = (b: BezierBoard, from: number, to: number, dir: 1 | -1): number => {
  if (bandable(b, from)) return from;
  const span = Math.abs(to - from);
  const step = Math.max(span / 200, 0.1);
  let prev = from;
  for (let x = from + dir * step; dir > 0 ? x <= to : x >= to; x += dir * step) {
    if (bandable(b, x)) {
      // Bisect the last unbandable point against the first bandable one.
      let bad = prev;
      let good = x;
      for (let i = 0; i < 40; i++) {
        const mid = (bad + good) / 2;
        if (bandable(b, mid)) good = mid;
        else bad = mid;
      }
      return good;
    }
    prev = x;
  }
  return to;
};

/**
 * Stations covering the banded length, anchored on the **widepoint** and landing
 * exactly on **both ends**.
 *
 * The spacing is a target that gets adjusted, not an interval that gets walked. Walking
 * a fixed interval out from the widepoint leaves a leftover gap of anywhere from nothing
 * to a full interval at each tip, so the last station floats an arbitrary distance short
 * of where the shaper said to stop — the end margin stops meaning what it says. Here the
 * two sides are fitted independently: each takes the whole number of steps closest to
 * the target and divides its span by that, so the outermost stations sit on the margins
 * and the widepoint keeps a station of its own.
 *
 * The two sides therefore get slightly different spacings, which is the right trade. The
 * widepoint is the reference a rail is designed around, and the margin is where the
 * shaper said the bandable rail ends; both are worth more than a spacing that is
 * uniform to the millimetre when it was only ever a round number picked off a tape.
 */
export const railFacetStations = (
  board: BezierBoard,
  o: RailFacetStationOptions = {},
): number[] => {
  const target = Math.max(1, o.targetSpacingCm ?? DEFAULT_TARGET_SPACING_CM);
  const margin = Math.max(0, o.endMarginCm ?? DEFAULT_END_MARGIN_CM);
  const length = getLength(board);
  // Clamp to what can actually be banded *before* fitting the spacing, not after.
  // A margin the user picks off the tail may leave nothing but a point at the nose —
  // a shortboard 5 cm from the tip has no rail. Fitting first and dropping the
  // unbandable stations afterwards spaced the stations across a span that then went
  // uncovered, so the last one floated a long way short of the nose and the pattern
  // looked broken.
  const loWanted = margin;
  const hiWanted = length - margin;
  // Bail before clamping: with margins that swallow the board the two ends cross over,
  // and each would otherwise walk past the other and come back with the far end.
  if (!(hiWanted > loWanted)) return [];
  const lo = bandableEnd(board, loWanted, hiWanted, +1);
  const hi = bandableEnd(board, hiWanted, loWanted, -1);
  // Still crossed means nothing along the span was bandable at all.
  if (!(hi > lo)) return [];
  const wp = Math.min(Math.max(getMaxWidthPos(board), lo), hi);

  /** Steps from `from` to `to`, ending exactly on `to`. */
  const side = (from: number, to: number): number[] => {
    const span = Math.abs(to - from);
    if (span < 1e-9) return [];
    const steps = Math.max(1, Math.round(span / target));
    const step = (to - from) / steps;
    return Array.from({ length: steps }, (_, k) => from + step * (k + 1));
  };

  return [...side(wp, lo), wp, ...side(wp, hi)].sort((p, q) => p - q);
};

/** Facet sets for every station on the board, with all warnings collected. */
export const railFacetPlan = (
  board: BezierBoard,
  opts: RailFacetOptions & RailFacetStationOptions = {},
): RailFacetPlan => {
  const stations = opts.stations ? [...opts.stations].sort((a, b) => a - b) : railFacetStations(board, opts); // prettier-ignore
  const out: RailStationFacets[] = [];
  const warnings: RailFacetWarning[] = [];
  for (const x of stations) {
    if (
      getWidthAtPos(board, x) < MIN_STATION_DIM ||
      getThicknessAtPos(board, x) < MIN_STATION_DIM
    ) {
      warnings.push(warn('degenerate-station', 'this station is too close to the tip to band', x));
      continue;
    }
    const st = railFacetsAt(board, x, opts);
    if (!st) {
      warnings.push(warn('no-section', 'the board has no section at this station', x));
      continue;
    }
    out.push(st);
    warnings.push(...st.warnings);
  }
  return { stations: out, widePoint: getMaxWidthPos(board), warnings };
};
