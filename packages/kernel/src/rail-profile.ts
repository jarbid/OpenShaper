// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail profiles — parametric rail shapes named the way shapers name them.
 *
 * A shaper does not describe a rail by its control points; they say "50/50", "60/40
 * tucked", "hard 80/20 in the tail". Those names all measure the same thing: the height
 * of the rail's **apex** — its widest point — as a fraction of the way up the rail. 50/50
 * puts it at mid-rail, 80/20 down near the bottom. Two further axes are orthogonal to the
 * ratio: how the bottom **edge** is finished, and how **full** the rail is.
 *
 * ## Only the rail band is re-cut
 *
 * A shaper changing a rail does not re-cut the whole section. They mark bands in from the
 * rail edge, plane those, and blend the innermost cut away to nothing — the rule of thumb
 * being that the top band should blend into the deck almost invisibly. This module works
 * the same way: it finds a **blend point** on the deck side and another on the bottom
 * side, re-cuts only what lies outboard of them, and joins tangentially. Everything
 * inboard — the deck crown, a bottom vee, a single or double concave — is kept exactly as
 * the shaper left it.
 *
 * That is not only faithful, it is the only correct behaviour: a rail preset that rewrote
 * the whole profile would silently flatten a concave the moment it was applied.
 *
 * ## What must not move
 *
 * The rocker and deck own a station's centre thickness and the outline owns its width
 * (`adjustCrossSectionsToThicknessAndWidth`), and `propagateCrossSectionToCurves` pushes
 * any change to those straight back onto the board's curves. Thickness is safe for free
 * here, because both centreline knots are retained untouched. Width is preserved by
 * pinning the new apex to exactly the old `maxX` and capping every generated control
 * point at or inboard of it.
 *
 * Nothing here is a port: BoardCAD-LE has no rail presets, so there is no legacy oracle
 * and no golden fixture. The tests use analytic oracles (see `.claude/CLAUDE.md` rule 2).
 */
import { vec2, type Vec2 } from './vec2';
import { knot, type Knot } from './knot';
import { splineFromKnots, maxX, type Spline } from './bezier-spline';
import { splitCurve, value, type Coeffs } from './bezier-curve';
import { crossSection, csCenterThickness, csWidth, type CrossSection } from './cross-section';

/** Scalar linear interpolation; `vec2.lerp` is the Vec2 flavour. */
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Unit vector from `from` to `to`; zero when they coincide. */
const dirFrom = (from: Vec2, to: Vec2): Vec2 => {
  const len = dist(from, to);
  return len === 0 ? vec2(0, 0) : vec2((to.x - from.x) / len, (to.y - from.y) / len);
};

/**
 * At or above this `edge` value the bottom edge becomes a genuine crease: the rail turns
 * up sharply off the bottom and the knot is marked a corner, so the editor stops keeping
 * its handles collinear. Below it the bottom rolls smoothly into the rail.
 */
const HARD_EDGE = 0.75;

/**
 * Close enough to an existing knot that we use that knot as the blend point rather than
 * cutting beside it. Without this a band boundary landing a few millimetres off a knot
 * leaves a sliver segment, which carries wild curvature and defeats idempotence.
 */
const T_SNAP = 0.02;

const SAMPLES_PER_SEGMENT = 64;

/** The dials a rail shape is described by. All dimensionless fractions. */
export interface RailProfileParams {
  /**
   * Height of the apex — the widest point of the rail — as a fraction of the way up the
   * rail, from the bottom band mark to the deck band mark. This is the number the ratio
   * names encode: 0.5 = 50/50, 0.4 = 60/40, 0.3 = 70/30, 0.2 = 80/20.
   *
   * Measured up the rail rather than up the centre thickness, which is why a real 50/50
   * apex sits visibly below the midpoint of the deck and bottom planes. Sensible range
   * 0.15…0.85.
   */
  readonly apex: number;
  /** Bottom edge finish: 0 = soft roll, 1 = hard down edge with a deliberate crease. */
  readonly edge: number;
  /** Rail volume: 0 = knifey, 0.5 = medium, 1 = boxy. Scales how long the handles reach. */
  readonly fullness: number;
  /**
   * How far in from the rail the deck-side re-cut reaches, as a fraction of half-width —
   * the shaper's top band mark. Real stations turn the deck from roughly 22% in.
   */
  readonly deckBand: number;
  /**
   * How far in the bottom-side cut reaches — the tuck. Much narrower than the deck band,
   * because a board's bottom stays flat almost all the way out to the rail (real stations
   * turn from about 7% in).
   */
  readonly bottomBand: number;
}

// ---- Locating the band boundaries on the existing profile ------------------------

interface Station {
  readonly seg: number;
  readonly t: number;
  readonly x: number;
}

/** Walk the whole profile at a fixed sample rate, bottom-centre → deck-centre. */
const walk = (s: Spline): Station[] => {
  const out: Station[] = [];
  for (let i = 0; i < s.coeffs.length; i++) {
    for (let j = 0; j < SAMPLES_PER_SEGMENT; j++) {
      const t = j / SAMPLES_PER_SEGMENT;
      out.push({ seg: i, t, x: value(s.coeffs[i]!, t).x });
    }
  }
  const last = s.coeffs.length - 1;
  out.push({ seg: last, t: 1, x: value(s.coeffs[last]!, 1).x });
  return out;
};

/** Refine a bracketed x-crossing within one segment. */
const bisect = (c: Coeffs, target: number, tLo: number, tHi: number, rising: boolean): number => {
  let lo = tLo;
  let hi = tHi;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    const past = rising ? value(c, m).x < target : value(c, m).x > target;
    if (past) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
};

/**
 * Where the profile crosses `target` on one side of the apex. `rising` picks the branch:
 * the bottom branch climbs outboard toward the apex, the deck branch falls away from it.
 *
 * The profile folds back on itself in x at the apex, which is why this walks the
 * parameter directly instead of using `tangentAt` / `curvatureAt` — those index by x
 * through `findSegment` and would silently answer for the wrong branch.
 */
const crossing = (
  s: Spline,
  samples: Station[],
  lo: number,
  hi: number,
  target: number,
  rising: boolean,
): { seg: number; t: number } | null => {
  for (let i = lo + 1; i <= hi; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const crossed = rising ? b.x >= target : b.x <= target;
    if (!crossed) continue;
    // Straddling a knot: take the knot itself rather than an arbitrary side of it.
    if (a.seg !== b.seg) return { seg: b.seg, t: 0 };
    return { seg: b.seg, t: bisect(s.coeffs[b.seg]!, target, a.t, b.t, rising) };
  }
  return null;
};

// ---- Cutting the profile at a band boundary --------------------------------------

/**
 * The knots from the start of the profile up to and including the cut, shape-preserved.
 * The last knot returned is the blend knot; its `tangentToPrev` belongs to the retained
 * curve and its `tangentToNext` is a placeholder for the caller to replace.
 */
const keepStart = (s: Spline, seg: number, t: number): Knot[] => {
  const knots = s.knots;
  if (t <= T_SNAP) return knots.slice(0, seg + 1);
  if (t >= 1 - T_SNAP) return knots.slice(0, seg + 2);
  const split = splitCurve(s.curves[seg]!, t);
  const start = knots[seg]!;
  const kept = knots.slice(0, seg + 1);
  kept[seg] = knot(
    start.end,
    start.tangentToPrev,
    split.startTangentToNext,
    start.continuous,
    start.other,
  );
  kept.push(knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false));
  return kept;
};

/**
 * The knots from the cut to the end of the profile, shape-preserved. The first knot
 * returned is the blend knot; its `tangentToNext` belongs to the retained curve and its
 * `tangentToPrev` is a placeholder for the caller to replace.
 */
const keepEnd = (s: Spline, seg: number, t: number): Knot[] => {
  const knots = s.knots;
  if (t <= T_SNAP) return knots.slice(seg);
  if (t >= 1 - T_SNAP) return knots.slice(seg + 1);
  const split = splitCurve(s.curves[seg]!, t);
  const end = knots[seg + 1]!;
  const rest = knots.slice(seg + 1);
  rest[0] = knot(end.end, split.endTangentToPrev, end.tangentToNext, end.continuous, end.other);
  return [
    knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false),
    ...rest,
  ];
};

// ---- Building the rail --------------------------------------------------------------

/**
 * A handle placed at `end + dir · len`, with `len` held between `lo` and `hi` and the tip
 * kept at or inboard of the apex.
 *
 * The length is clamped along the handle's own direction rather than by clipping a
 * coordinate. That distinction matters: the two handles of a knot flagged `continuous`
 * share one line, so clipping would rotate one of them and leave a knot that claims to be
 * smooth while rendering with a kink — which then snaps the first time it is dragged.
 */
const handle = (
  end: Vec2,
  dir: Vec2,
  want: number,
  lo: number,
  hi: number,
  capX: number,
  yWindow: { min: number; max: number },
): Vec2 => {
  let len = Math.min(Math.max(want, lo), hi);
  if (dir.x > 0) len = Math.min(len, (capX - end.x) / dir.x);
  if (dir.y > 0) len = Math.min(len, (yWindow.max - end.y) / dir.y);
  if (dir.y < 0) len = Math.min(len, (yWindow.min - end.y) / dir.y);
  if (len < 0) len = 0;
  return vec2(end.x + dir.x * len, end.y + dir.y * len);
};

/**
 * Re-cut a cross-section's rail to a named profile, keeping the deck and bottom the
 * shaper already has and blending into them tangentially.
 *
 * Position, width and centre thickness all come back unchanged, so the outline, rocker
 * and deck are left alone and the commit-time rescale has nothing to correct.
 *
 * Returns the section unchanged when there is no rail to shape: the nose and tail dummy
 * stations carry a single knot, a collapsed station has no width or thickness to work
 * against, and a profile whose band boundaries cannot be located is left alone rather
 * than mangled.
 */
export const applyRailProfile = (cs: CrossSection, p: RailProfileParams): CrossSection => {
  const spline = cs.spline;
  if (spline.knots.length < 2 || spline.coeffs.length === 0) return cs;
  const halfWidth = csWidth(cs) / 2;
  const thickness = csCenterThickness(cs);
  if (halfWidth <= 0 || thickness <= 0) return cs;

  // 1. Find the widest point, which separates the bottom branch from the deck branch.
  const samples = walk(spline);
  let apexIdx = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i]!.x > samples[apexIdx]!.x) apexIdx = i;
  if (apexIdx === 0 || apexIdx === samples.length - 1) return cs;

  // 2. Mark the bands and cut there.
  const bottomCut = crossing(spline, samples, 0, apexIdx, (1 - p.bottomBand) * halfWidth, true);
  const deckCut = crossing(
    spline,
    samples,
    apexIdx,
    samples.length - 1,
    (1 - p.deckBand) * halfWidth,
    false,
  );
  if (!bottomCut || !deckCut) return cs;

  const below = keepStart(spline, bottomCut.seg, bottomCut.t);
  const above = keepEnd(spline, deckCut.seg, deckCut.t);
  // Both cuts must leave something of the original behind, or this is not a band re-cut.
  if (below.length < 2 || above.length < 2) return cs;

  const tuck = below[below.length - 1]!;
  const deckBlend = above[0]!;
  if (tuck.end.x >= halfWidth || deckBlend.end.x >= halfWidth) return cs;
  if (deckBlend.end.y <= tuck.end.y) return cs;

  // The apex height is measured up the *rail*, between the two band marks — not up the
  // centre thickness. That is what the ratio names actually mean, and it is why a real
  // 50/50 apex sits below the halfway point of the deck and bottom planes: the deck has
  // already domed away by the time you reach the rail. Measuring against centre thickness
  // instead puts a 50/50 apex up under the deck, where there is no room left to turn and
  // the rail pinches to a crease.
  const apexEnd = vec2(halfWidth, tuck.end.y + p.apex * (deckBlend.end.y - tuck.end.y));

  // 3. The apex: endpoint and both handles on x = halfWidth, so by the convex-hull
  // property no point of the curve can reach past it and the apex attains it — which is
  // what keeps the station's width exactly where it was.
  // The apex handle takes at most half the vertical run to its neighbour, leaving the
  // other half for the blend's own handle. Split it any more generously and the two
  // handles cannot both point outward without the control polygon doubling back in y —
  // which is an S-curve in the rail, and reads as a step where the band meets the deck.
  const toTuck = apexEnd.y - tuck.end.y;
  const toDeck = deckBlend.end.y - apexEnd.y;
  const hDown = Math.min(thickness * mix(0.1, 0.26, p.fullness), Math.max(toTuck * 0.5, 0));
  const hUp = Math.min(thickness * mix(0.13, 0.32, p.fullness), Math.max(toDeck * 0.5, 0));
  const provisional = knot(
    apexEnd,
    vec2(halfWidth, apexEnd.y - hDown),
    vec2(halfWidth, apexEnd.y + hUp),
    true,
    false,
  );

  // 4. The blends. Each keeps the retained handle untouched and sets the rail-side one
  // collinear with it, so the join is tangent-continuous and the `continuous` flag is
  // honest. Length tracks the retained handle — that is what keeps the curvature step
  // across the join small, which is what stops the join reading as a shoulder.
  const reach = mix(1, 1.6, p.fullness);

  const hard = p.edge >= HARD_EDGE;
  const tuckSpan = dist(tuck.end, apexEnd);
  const bottomDir = dirFrom(tuck.tangentToPrev, tuck.end);
  const chordDir = dirFrom(tuck.end, apexEnd);
  // A soft rail leaves the tuck along the bottom's own direction, so the join is smooth
  // and the `continuous` flag is honest. A hard edge breaks away from it toward the apex,
  // which is the crease — and it is a corner knot, so nothing has to stay collinear.
  //
  // Note the crease direction stays *shallower* than the chord to the apex. Leaving
  // steeper than the chord would make the rail turn one way and then back, which collapses
  // the apex handle and pinches the widest point into a cusp.
  const tuckDir = hard
    ? dirFrom(
        vec2(0, 0),
        vec2(mix(bottomDir.x, chordDir.x, 0.6), mix(bottomDir.y, chordDir.y, 0.6)),
      )
    : bottomDir;
  const newTuck = knot(
    tuck.end,
    tuck.tangentToPrev,
    handle(
      tuck.end,
      tuckDir,
      dist(tuck.end, tuck.tangentToPrev) * reach,
      tuckSpan * 0.15,
      tuckSpan * 0.9,
      halfWidth,
      // Stop short of the apex's own handle, keeping the polygon rising in y.
      { min: -Infinity, max: provisional.tangentToPrev.y },
    ),
    !hard,
    tuck.other,
  );

  const deckSpan = dist(deckBlend.end, apexEnd);
  const newDeckBlend = knot(
    deckBlend.end,
    handle(
      deckBlend.end,
      dirFrom(deckBlend.tangentToNext, deckBlend.end),
      dist(deckBlend.end, deckBlend.tangentToNext) * reach,
      deckSpan * 0.2,
      deckSpan * 0.95,
      halfWidth,
      { min: provisional.tangentToNext.y, max: Infinity },
    ),
    deckBlend.tangentToNext,
    true,
    deckBlend.other,
  );

  // 5. Now the neighbours are placed, tighten the apex handles until each rail segment's
  // control polygon turns one way only. A polygon that rotates one way and then back
  // forces an inflection into the rail — the curve goes crowned, flat, then hollow, which
  // is precisely what reads as a step where the band meets the deck. Both bounds are
  // closed-form: the polygon's two turns are linear in the apex handle length.
  const SAFETY = 0.9;

  // Bottom side, polygon tuck → tuck handle → apex lower handle → apex. The second turn
  // is always the right way round; the first bounds how far the lower handle may drop.
  const u = vec2(newTuck.tangentToNext.x - tuck.end.x, newTuck.tangentToNext.y - tuck.end.y);
  const downLimit =
    u.x > 1e-9
      ? apexEnd.y - newTuck.tangentToNext.y - (u.y * (halfWidth - newTuck.tangentToNext.x)) / u.x
      : Infinity;

  // Deck side, polygon apex → apex upper handle → blend handle → blend. Here it is the
  // second turn that binds: too long an upper handle and the middle leg over-rotates past
  // the deck's own direction, so the curve turns back on itself.
  const a = vec2(
    newDeckBlend.tangentToPrev.x - apexEnd.x,
    newDeckBlend.tangentToPrev.y - apexEnd.y,
  );
  const b = vec2(
    newDeckBlend.end.x - newDeckBlend.tangentToPrev.x,
    newDeckBlend.end.y - newDeckBlend.tangentToPrev.y,
  );
  const upLimit = b.x < -1e-9 ? (a.y * b.x - a.x * b.y) / b.x : Infinity;

  // A floor under both, because a convexity limit can come out arbitrarily small on an
  // awkward station. A hair of inflection is a far better failure than a zero-length
  // handle, which turns the widest point into a cusp.
  const settle = (want: number, limit: number, span: number): number =>
    Math.max(Math.min(want, limit * SAFETY), span * 0.12);

  const apexKnot = knot(
    apexEnd,
    vec2(halfWidth, apexEnd.y - settle(hDown, downLimit, toTuck)),
    vec2(halfWidth, apexEnd.y + settle(hUp, upLimit, toDeck)),
    true,
    false,
  );

  const knots = [...below.slice(0, -1), newTuck, apexKnot, newDeckBlend, ...above.slice(1)];
  const next = splineFromKnots(knots);
  // A band re-cut that moved the widest point would drag the outline with it on commit.
  if (Math.abs(maxX(next) - halfWidth) > 1e-9) return cs;
  return crossSection(cs.position, next);
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
 * The first four are the ratio ladder — the apex walking down the rail from mid-height to
 * near the bottom, picking up more edge as it goes, which is the progression a shortboard
 * runs from nose to tail. The last four vary volume and shape at a roughly fixed ratio.
 *
 * The band figures are anchored on real stations from `docs/specs/golden/shortboard.brd`,
 * which turn the deck from about 22% of half-width in and the bottom from only 7%.
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
    params: { apex: 0.5, edge: 0.05, fullness: 0.65, deckBand: 0.3, bottomBand: 0.16 },
  },
  {
    id: '60-40-tucked',
    label: '60/40 tucked',
    summary:
      'Apex 40% up with a tucked-under edge. The all-round rail through the middle of a board: holds in a turn, releases once there is speed.',
    params: { apex: 0.4, edge: 0.5, fullness: 0.55, deckBand: 0.24, bottomBand: 0.1 },
  },
  {
    id: '70-30-tucked',
    label: '70/30 tucked',
    summary:
      'A step lower and harder than 60/40. Sits between the middle of the board and the fin area.',
    params: { apex: 0.3, edge: 0.65, fullness: 0.5, deckBand: 0.22, bottomBand: 0.07 },
  },
  {
    id: '80-20-hard',
    label: '80/20 hard',
    summary:
      'Apex low, with the bottom running flat to a crisp edge that sheds water cleanly. The last stretch of a performance tail.',
    params: { apex: 0.2, edge: 1, fullness: 0.45, deckBand: 0.22, bottomBand: 0.07 },
  },
  {
    id: 'boxy',
    label: 'Boxy',
    summary:
      'Full, high-volume rail that holds its width and rolls over from well inboard. Stable and buoyant — beginner boards and small-wave shapes.',
    params: { apex: 0.45, edge: 0.35, fullness: 1, deckBand: 0.35, bottomBand: 0.13 },
  },
  {
    id: 'pinched',
    label: 'Pinched',
    summary:
      'Low-volume rail that turns in late and thin. Sensitive and quick to bite; wants an experienced back foot, and a domed deck under it.',
    params: { apex: 0.35, edge: 0.6, fullness: 0.15, deckBand: 0.22, bottomBand: 0.09 },
  },
  {
    id: 'egg',
    label: 'Egg',
    summary:
      'Drawn-out elliptical 50/50 with a soft apex and a long roll. Smooth and predictable — retro and hybrid shapes.',
    params: { apex: 0.5, edge: 0, fullness: 0.4, deckBand: 0.32, bottomBand: 0.18 },
  },
  {
    id: 'knifey',
    label: 'Knifey',
    summary:
      'Very thin, almost flat ellipse with minimal buoyancy. Use at the tips only — it catches if carried through the middle.',
    params: { apex: 0.45, edge: 0.1, fullness: 0, deckBand: 0.24, bottomBand: 0.12 },
  },
] as const satisfies readonly RailPreset[];

export type RailPresetId = (typeof RAIL_PRESETS)[number]['id'];

export const railPresetById = (id: string): RailPreset | undefined =>
  RAIL_PRESETS.find((p) => p.id === id);
