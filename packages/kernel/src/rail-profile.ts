// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail profiles — parametric cross-section shapes named the way shapers name them.
 *
 * A shaper does not describe a rail by its control points; they say "50/50", "60/40
 * tucked", "hard 80/20 in the tail". Those names all measure the same thing: the height
 * of the rail's **apex** (its widest point) as a fraction of the station's centre
 * thickness, measured up from the bottom. 50/50 puts it at mid-rail, 80/20 down near
 * the bottom. Two further axes are orthogonal to that ratio — how the bottom **edge** is
 * finished (soft and round, tucked under, or a hard down edge) and how **full** the rail
 * is (boxy through to knifey) — plus how much the deck **domes** away from the stringer.
 *
 * This module turns those four numbers into the five knots of a cross-section profile.
 *
 * Nothing here is a port: BoardCAD-LE has no rail presets, so there is no legacy oracle
 * and no golden fixture. The tests use analytic oracles instead (see the golden-data rule
 * in `.claude/CLAUDE.md`).
 *
 * ## Design space
 *
 * Knots are built in a **normalized** frame — `u = x / halfWidth`, `v = (y − y₀) /
 * thickness`, both spanning [0, 1] — and only then scaled onto the station. That is not
 * cosmetic: the store re-runs `adjustCrossSectionsToThicknessAndWidth` on every commit,
 * because the rocker and deck own a station's thickness and the outline owns its width.
 * A profile that changed either would simply be rescaled out from under itself. Working
 * normalized and scaling by the station's *current* dimensions means a preset restyles
 * the rail and touches nothing else.
 */
import { vec2, type Vec2 } from './vec2';
import { knot, type Knot } from './knot';
import { splineFromKnots } from './bezier-spline';
import { crossSection, csCenterThickness, csWidth, type CrossSection } from './cross-section';

/** Scalar linear interpolation; `vec2.lerp` is the Vec2 flavour. */
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const norm = (v: Vec2): Vec2 => {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? vec2(0, 0) : vec2(v.x / len, v.y / len);
};

/**
 * At or above this `edge` value the bottom edge becomes a genuine crease: the profile
 * runs dead flat into the edge and turns up sharply, and the knot is marked a corner so
 * the editor stops keeping its handles collinear. Below it the edge is a smooth turn.
 */
const HARD_EDGE = 0.75;

/** The four dials a rail profile is described by. All dimensionless. */
export interface RailProfileParams {
  /**
   * Height of the apex — the widest point of the rail — as a fraction of centre
   * thickness, measured up from the bottom. This is the number the ratio names encode:
   * 0.5 = 50/50, 0.4 = 60/40, 0.3 = 70/30, 0.2 = 80/20. Sensible range 0.15…0.85.
   */
  readonly apex: number;
  /** Bottom edge finish: 0 = soft and round, 0.5 = tucked under, 1 = hard down edge. */
  readonly edge: number;
  /** Rail volume: 0 = knifey, 0.5 = medium, 1 = boxy. */
  readonly fullness: number;
  /** Deck crown: 0 = flat deck, 1 = strongly domed. */
  readonly domed: number;
}

/**
 * Build the five normalized knots of a rail profile, ordered bottom-centre → around the
 * rail → deck-centre, matching how a `CrossSection` spline is stored.
 *
 * The apex knot is guaranteed to be the widest point of the resulting curve, and it is a
 * guarantee rather than a hope: its endpoint *and both handles* sit at exactly `u = 1`
 * while every other control point is clamped below it, so by the Bézier convex-hull
 * property no point of any segment can exceed `u = 1` — and the apex attains it.
 */
export const railProfileKnots = (p: RailProfileParams): Knot[] => {
  const { apex, edge, fullness, domed } = p;

  /**
   * The longest handle ≤ `want` that keeps its tip inside the unit square — nothing may
   * reach past the apex (or it stops being the widest point), below the bottom, or above
   * the deck.
   *
   * Note this shortens along the handle's own direction rather than clipping a
   * coordinate. That distinction is the whole point: the two handles of a smooth knot
   * share one direction, so clipping would rotate one of them and leave a knot that
   * claims to be continuous while rendering with a kink — which then snaps the first
   * time the shaper drags it. Shortening keeps both on the same line.
   */
  const reach = (end: Vec2, dir: Vec2, want: number): Vec2 => {
    let len = want;
    const limit = (pos: number, d: number): void => {
      if (d > 0) len = Math.min(len, (1 - pos) / d);
      else if (d < 0) len = Math.min(len, -pos / d);
    };
    limit(end.x, dir.x);
    limit(end.y, dir.y);
    if (len < 0) len = 0;
    return vec2(end.x + dir.x * len, end.y + dir.y * len);
  };
  const neg = (v: Vec2): Vec2 => vec2(-v.x, -v.y);

  // Where the rail starts to turn, on both faces. These sit far outboard on purpose: a
  // board is mostly flat bottom and deck, with all the rail action in the last stretch
  // before the apex. The golden shortboard station puts its bottom-edge knot at 97% of
  // half-width and its deck knot at 92%. Bring these inboard and the profile stops
  // looking like a surfboard and starts looking like an aerofoil.
  const uEdge = mix(0.86, 0.975, edge);
  const uDeck = mix(0.78, 0.95, fullness);

  // --- knot 0: bottom centre, on the stringer -------------------------------------
  // Horizontal handles: the bottom must meet its mirror image flat across the stringer.
  // The handle reaches most of the way to the edge knot, which is what holds the bottom
  // flat instead of letting it dome. The outward handle deliberately crosses to negative
  // u — it belongs to the mirrored half, exactly as the legacy `.brd` stations write it,
  // and `enforceJunctions` (JC-8) only floors the inward one.
  const h0 = uEdge * mix(0.55, 0.85, fullness);
  const k0 = knot(vec2(0, 0), vec2(-h0, 0), reach(vec2(0, 0), vec2(1, 0), h0), true, false);

  // --- knot 1: the bottom edge / tuck ---------------------------------------------
  // Sits low and just inboard of the apex. As `edge` rises it slides outboard and drops,
  // which is what turns a soft roll into a tucked-under edge and then a hard one.
  const vTuck = apex * mix(0.5, 0.28, edge);
  const e1 = vec2(uEdge, vTuck);
  const eIn = uEdge * mix(0.2, 0.4, fullness);
  const eOut = mix(0.06, 0.14, fullness);
  const hard = edge >= HARD_EDGE;
  // Soft/tucked: one direction, so the handles are genuinely collinear and `continuous`
  // is honest. `edge` flattens that direction toward horizontal. Hard: two directions —
  // flat in, steep out — and a corner.
  const dirIn = hard ? vec2(1, 0) : norm(vec2(1, apex * (1 - edge)));
  const dirOut = hard ? norm(vec2(0.25, 1)) : dirIn;
  const k1 = knot(e1, reach(e1, neg(dirIn), eIn), reach(e1, dirOut, eOut), !hard, false);

  // --- knot 3: the deck shoulder, where the rail turns into the deck ---------------
  // A fuller rail holds its width further up before turning in; a pinched one turns
  // early. Handles share one direction, so this stays a genuinely smooth knot.
  const vDeck = apex + (1 - apex) * 0.48;
  const e3 = vec2(uDeck, vDeck);
  const dir3 = norm(vec2(-uDeck, 1 - vDeck));
  const dIn = mix(0.06, 0.14, fullness);
  const dOut = uDeck * mix(0.25, 0.5, fullness);
  const k3 = knot(e3, reach(e3, neg(dir3), dIn), reach(e3, dir3, dOut), true, false);

  // --- knot 2: the apex, the widest point -----------------------------------------
  // Endpoint and both handles on u = 1 — vertical, collinear, and the convex-hull cap
  // that makes this the widest point of the curve.
  //
  // The handle lengths are also capped so they never reach past the facing handle of the
  // neighbour they point at. That keeps each segment's control values non-decreasing in
  // v, which is what guarantees the profile climbs monotonically from bottom to deck. A
  // generous `fullness` would otherwise pull the lower handle below the bottom edge and
  // put a dimple in the rail — invisible on screen, but a fold in the lofted surface.
  const e2 = vec2(1, apex);
  const hDown = Math.min(apex * mix(0.12, 0.6, fullness), apex - k1.tangentToNext.y);
  const hUp = Math.min((1 - apex) * mix(0.1, 0.5, fullness), k3.tangentToPrev.y - apex);
  const k2 = knot(
    e2,
    reach(e2, vec2(0, -1), Math.max(hDown, 0)),
    reach(e2, vec2(0, 1), Math.max(hUp, 0)),
    true,
    false,
  );

  // --- knot 4: deck centre, on the stringer ----------------------------------------
  // Horizontal for the same mirror-line reason as knot 0. A *shorter* handle makes the
  // deck fall away from the stringer sooner — which is exactly what doming is.
  const h4 = uDeck * mix(0.8, 0.25, domed);
  const e4 = vec2(0, 1);
  const k4 = knot(e4, reach(e4, vec2(1, 0), h4), vec2(-h4, 1), true, false);

  return [k0, k1, k2, k3, k4];
};

/**
 * Restyle a cross-section to a rail profile, preserving its longitudinal position, its
 * width and its centre thickness — so the outline, rocker and deck are left alone and
 * the commit-time rescale has nothing to undo.
 *
 * Returns the section unchanged when there is no rail to shape: the nose and tail dummy
 * stations carry a single knot, and a collapsed station has no width or thickness to
 * scale onto.
 */
export const applyRailProfile = (cs: CrossSection, p: RailProfileParams): CrossSection => {
  const knots = cs.spline.knots;
  if (knots.length < 2) return cs;
  const halfWidth = csWidth(cs) / 2;
  const thickness = csCenterThickness(cs);
  if (halfWidth <= 0 || thickness <= 0) return cs;

  const y0 = knots[0]!.end.y;
  const place = (v: Vec2): Vec2 => vec2(v.x * halfWidth, y0 + v.y * thickness);
  const scaled = railProfileKnots(p).map((k) =>
    knot(place(k.end), place(k.tangentToPrev), place(k.tangentToNext), k.continuous, k.other),
  );
  return crossSection(cs.position, splineFromKnots(scaled));
};

/** A named rail profile, as offered in the cross-section editor's right-click menu. */
export interface RailPreset {
  /** Stable identifier — also the id the docs registry pins. */
  readonly id: string;
  /** Menu text. */
  readonly label: string;
  /** One line on what the rail does, reused in `/docs/editing`. */
  readonly summary: string;
  readonly params: RailProfileParams;
}

/**
 * The presets offered in the editor.
 *
 * The first four are the ratio ladder — the apex walking down the rail from mid-height
 * to near the bottom, picking up more edge as it goes, which is the progression a
 * shortboard runs from nose to tail. The last four vary volume and shape at a roughly
 * fixed ratio.
 *
 * Ids are kebab-case, deliberately unlike `FinFoil`'s `'50/50'` / `'80/20'` (`fins.ts`),
 * which describe a fin's foil and have nothing to do with rails.
 */
export const RAIL_PRESETS = [
  {
    id: '50-50-soft',
    label: '50/50 soft',
    summary:
      'Apex at mid-rail, round and symmetric. Forgiving and easy to lean on — longboards, noseriders, and the nose of most boards.',
    params: { apex: 0.5, edge: 0.05, fullness: 0.65, domed: 0.25 },
  },
  {
    id: '60-40-tucked',
    label: '60/40 tucked',
    summary:
      'Apex 40% up with a tucked-under edge. The all-round rail through the middle of a board: holds in a turn, releases once there is speed.',
    params: { apex: 0.4, edge: 0.5, fullness: 0.55, domed: 0.4 },
  },
  {
    id: '70-30-tucked',
    label: '70/30 tucked',
    summary:
      'A step lower and harder than 60/40. Sits between the middle of the board and the fin area.',
    params: { apex: 0.3, edge: 0.65, fullness: 0.5, domed: 0.5 },
  },
  {
    id: '80-20-hard',
    label: '80/20 hard',
    summary:
      'Apex low with a crisp down edge that sheds water cleanly. The last stretch of a performance tail.',
    params: { apex: 0.2, edge: 1, fullness: 0.45, domed: 0.55 },
  },
  {
    id: 'boxy',
    label: 'Boxy',
    summary:
      'Full, high-volume rail with a flat deck. Stable and buoyant — beginner boards and small-wave shapes.',
    params: { apex: 0.45, edge: 0.35, fullness: 1, domed: 0.1 },
  },
  {
    id: 'pinched',
    label: 'Pinched',
    summary:
      'Low-volume rail under a strongly domed deck. Sensitive and quick to bite; wants an experienced back foot.',
    params: { apex: 0.35, edge: 0.6, fullness: 0.15, domed: 0.85 },
  },
  {
    id: 'egg',
    label: 'Egg',
    summary:
      'Drawn-out elliptical 50/50 with a soft apex. Smooth and predictable — retro and hybrid shapes.',
    params: { apex: 0.5, edge: 0, fullness: 0.4, domed: 0.35 },
  },
  {
    id: 'knifey',
    label: 'Knifey',
    summary:
      'Very thin, almost flat ellipse with minimal buoyancy. Use at the tips only — it catches if carried through the middle.',
    params: { apex: 0.45, edge: 0.1, fullness: 0, domed: 0.6 },
  },
] as const satisfies readonly RailPreset[];

export type RailPresetId = (typeof RAIL_PRESETS)[number]['id'];

export const railPresetById = (id: string): RailPreset | undefined =>
  RAIL_PRESETS.find((p) => p.id === id);
