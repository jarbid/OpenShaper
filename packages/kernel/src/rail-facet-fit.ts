// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where to put the rail bands, and how much foam a given set leaves behind.
 *
 * `rail-facets.ts` answers "given these angles, where are the marks". This module
 * answers the question before it: **which angles**.
 *
 * ## Why not the halving ladder
 *
 * A facet is a tangent, so the foam it leaves over an angular gap Δ on a rail of local
 * radius ρ is `ρ²(tan(Δ/2) − Δ/2)` — cubic in the gap. The halving ladder's gaps across
 * the 90° deck quadrant are 45 / 22.5 / 11.25 / 11.25, which puts **87% of all the
 * leftover foam in the single gap between the rail plane and the first band**, and
 * spends every extra band halving the smallest gap it already has. Three bands at equal
 * 22.5° gaps leave 59% less foam than the same three ladder bands.
 *
 * ## One dynamic program, three placements
 *
 * The leftover region decomposes: the foam between the finished section and the cut
 * polygon is a sum of independent **caps**, one per pair of consecutive facets, and a
 * cap depends on nothing but the two tangents bounding it. That makes optimal placement
 * a shortest path over an angle grid — solved exactly rather than hill-climbed, and it
 * falls out with the answer for *every* band count at once, which is what tells a shaper
 * whether another pass is worth cutting.
 *
 * Every placement minimises `Σ cap area`. They differ only in what they are allowed to
 * do at the rail:
 *
 * - **`balanced`** (the default) holds the first band at 45° or steeper.
 * - **`least-foam`** is unconstrained.
 * - **`ladder`** is not fitted at all — 45°, then halving — but is still *priced* through
 *   the same cap table, so the dialog can compare it honestly.
 *
 * ### Why the constraint
 *
 * Bands are scored all the way in to the stringer, and over that span the deck crown
 * holds far more removable foam than the rail turn does. Left unconstrained the fit
 * spends its bands flattening deck: on the golden shortboard at three bands it opens the
 * first gap to 64° and leaves **2.8 mm** proud at the rail corner, against 1.2 mm for the
 * ladder. That is the one trade a shaper will not take — a rail's character lives in its
 * last couple of millimetres, while the same error on a near-flat deck is one skim.
 *
 * Pinning the first band at 45°, where every printed reference card already puts it,
 * costs half a percent of the foam and buys the rail back. Three bands on the shortboard,
 * foam removed / worst left overall / left at the rail corner:
 *
 * | placement    | angles            | removed | worst  | at the rail |
 * | ------------ | ----------------- | ------- | ------ | ----------- |
 * | ladder       | 45 / 22.5 / 11.25 | 83.8%   | 4.7 mm | 1.21 mm     |
 * | `least-foam` | 25.5 / 9.5 / 4.5  | 95.1%   | 2.8 mm | 2.77 mm     |
 * | `balanced`   | 45 / 11.5 / 5     | 94.6%   | 2.4 mm | 1.21 mm     |
 *
 * `balanced` is the only one that beats the ladder on both measures at once while
 * leaving the rail corner exactly where tradition leaves it. The constraint is
 * one-sided: a tight rail better served by a steeper first band still gets one.
 *
 * ### An objective that was tried and dropped
 *
 * A scale-free variant — minimising `Σ cap area / ρ²`, so a 1 mm leftover on a 15 mm rail
 * radius scores like a 60 mm leftover on a 900 mm deck — is the obvious way to protect
 * the rail without a hard constraint, and it works: equal angular gaps, 0.33 mm at the
 * corner, the finest of any placement. It was removed anyway. **0.33 mm is finer than a
 * hand plane holds**, so it leaves nothing to fair and banks on the cut not having
 * wandered; and it pays for that with 60% foam removal against balanced's 95%, because
 * it spends every band inside the turn and leaves the whole crown to one gap. An option
 * that is worst on every number the sheet prints, in exchange for a precision the tool
 * cannot deliver, is one nobody should be choosing.
  */
import { vec2, type Vec2 } from './vec2';
import { DEG_TO_RAD, T_ONE } from './constants';
import { normalByTT, pointByTT, type Spline } from './bezier-spline';

// --- line geometry --------------------------------------------------------------
//
// These live here rather than in rail-facets.ts so the dependency runs one way: the
// fitter needs tangent lines and their intersections, and rail-facets.ts needs the
// fitter.

/** A facet as an infinite line: a point on it and a unit direction. */
export interface Line {
  readonly p: Vec2;
  readonly d: Vec2;
}

export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

/**
 * Unit direction of the surface at normal angle `nu`, in the tt-increasing sense.
 * With `tangent = atan2(dx, dy)` the tangent vector is `(sin T, cos T)` for
 * `T = nu - π/2`, which reduces to `(-cos nu, sin nu)`.
 */
export const dirFromNormal = (nu: number): Vec2 => vec2(-Math.cos(nu), Math.sin(nu));

export const lineAt = (s: Spline, tt: number): Line => ({
  p: pointByTT(s, tt),
  d: dirFromNormal(normalByTT(s, tt)),
});

/** Intersection of two lines, or null when they are (near) parallel. */
export const meet = (a: Line, b: Line): Vec2 | null => {
  const den = cross(a.d, b.d);
  if (Math.abs(den) < 1e-6) return null;
  const t = cross(vec2(b.p.x - a.p.x, b.p.y - a.p.y), b.d) / den;
  return vec2(a.p.x + a.d.x * t, a.p.y + a.d.y * t);
};

/** Where a line crosses the vertical `x = X`. */
export const meetVertical = (l: Line, X: number): Vec2 | null => {
  if (Math.abs(l.d.x) < 1e-9) return null;
  const t = (X - l.p.x) / l.d.x;
  return vec2(X, l.p.y + l.d.y * t);
};

/** Where a line crosses the horizontal `y = Y`. */
export const meetHorizontal = (l: Line, Y: number): Vec2 | null => {
  if (Math.abs(l.d.y) < 1e-9) return null;
  const t = (Y - l.p.y) / l.d.y;
  return vec2(l.p.x + l.d.x * t, Y);
};

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Slide a facet outward until nothing on the section pokes through it, and report where
 * it then touches.
 *
 * On a convex curve a tangent already clears everything and this changes nothing, which
 * is the case every analytic test exercises. Real boards are not quite convex: the
 * shortboard fixture has a ~0.1 mm kink at a spline knot on the deck, where the slope
 * jumps back up for a fraction of a segment, so the tangent taken at the first slope
 * match gets crossed by the curve just inboard of it. Sliding the plane out by that much
 * costs a rounding error's worth of extra foam and keeps the one invariant the whole
 * module exists for: **a facet never cuts inside the shape it is meant to leave.**
 *
 * This only started to matter once bands were placed across the whole half-section. The
 * rail turn itself is reliably convex; deck crown and its transitions are not.
 */
export const clearOf = (
  line: Line,
  pts: readonly Vec2[],
  eps = 1e-5,
): { line: Line; touch: Vec2 } => {
  const out = vec2(line.d.y, -line.d.x);
  let worst = 0;
  let at = line.p;
  for (const q of pts) {
    const v = (q.x - line.p.x) * out.x + (q.y - line.p.y) * out.y;
    if (v > worst) {
      worst = v;
      at = q;
    }
  }
  if (worst <= eps) return { line, touch: line.p };
  return { line: { p: at, d: line.d }, touch: at };
};

/** Highest point over a tt range, and where it is. */
export const maxYAt = (
  s: Spline,
  a: number,
  b: number,
  samples = 256,
): { tt: number; y: number } => {
  let bestTT = a;
  let best = -Infinity;
  for (let i = 0; i <= samples; i++) {
    const tt = a + ((b - a) * i) / samples;
    const y = pointByTT(s, tt).y;
    if (y > best) {
      best = y;
      bestTT = tt;
    }
  }
  return { tt: bestTT, y: best };
};

// --- options --------------------------------------------------------------------

/** How the band angles are chosen. */
export type RailAngleMode = 'balanced' | 'least-foam' | 'ladder';

export const RAIL_ANGLE_MODES: readonly RailAngleMode[] = ['balanced', 'least-foam', 'ladder'];

/**
 * The bisection ladder: each band halves the remaining angle to the flat.
 * `3 → [45, 22.5, 11.25]`. Predictable, and each cut is a bevel-gauge setting a shaper
 * can dial without arithmetic — which is why it is still on offer, and why the fit has
 * to be able to price it on the same terms.
 */
export const bisectionLadder = (n: number): number[] => {
  const out: number[] = [];
  let a = 45;
  for (let i = 0; i < n; i++) {
    out.push(a);
    a /= 2;
  }
  return out;
};

export interface DeckFitOptions {
  readonly mode?: RailAngleMode;
  /**
   * The first band may not sit shallower than this, degrees. Default 45 for `balanced`,
   * unset otherwise. This is the constraint that protects the rail.
   */
  readonly firstBandMinDeg?: number;
  /**
   * Angle grid, degrees. Default 0.5 — every angle that comes out is a half-degree a
   * bevel gauge can actually be set to, and the answer is optimal *on that grid* rather
   * than a fabricated 63.184°.
   */
  readonly stepDeg?: number;
  /** Closest two consecutive facets may sit, degrees. Default 4. */
  readonly minGapDeg?: number;
  /** The shallowest a band may be, degrees. Default 3 — below that it is a deck skim. */
  readonly minAngleDeg?: number;
  /** Fit every count up to this. Default 6. */
  readonly maxBands?: number;
}

const DEFAULT_STEP_DEG = 0.5;
/** Where the first band has to sit to leave the rail turn no coarser than tradition does. */
export const DEFAULT_FIRST_BAND_MIN_DEG = 45;
const DEFAULT_MIN_GAP_DEG = 4;
const DEFAULT_MIN_ANGLE_DEG = 3;
const DEFAULT_MAX_BANDS = 6;

/** Samples the deck branch is hulled from. */
const PROFILE_SAMPLES = 512;

// --- candidates -----------------------------------------------------------------

interface Candidate {
  /** Degrees off the deck plane: 90 at the apex, 0 at the stringer. */
  readonly angle: number;
  /** Index into the hull, so the prefix sums can be shared between candidates. */
  readonly hull: number;
  readonly p: Vec2;
  readonly line: Line;
}

/**
 * The outward-facing convex hull of the deck branch, apex first, deck plane last.
 *
 * Walking the branch the points turn one way while the curve is convex; a stretch that
 * turns back gets popped, and the hull bridges it with a single straight edge. That
 * bridge is the honest answer to a non-convex deck: a plane set to an angle in that
 * range rides across the hollow on the two high points either side of it, which is
 * exactly what the hull edge is.
 *
 * The alternative — refusing angles past the first reversal — was tried and is much
 * worse. Real decks stop being convex a third of the way in (the shortboard's tail
 * stations reverse at 18°), so it walled the bands out of the crown entirely and left
 * more foam than the halving ladder did.
 */
const upperHull = (pts: readonly Vec2[]): Vec2[] => {
  const h: Vec2[] = [];
  for (const p of pts) {
    while (h.length >= 2) {
      const a = h[h.length - 2]!;
      const b = h[h.length - 1]!;
      if (cross(vec2(b.x - a.x, b.y - a.y), vec2(p.x - b.x, p.y - b.y)) > 0) break;
      h.pop();
    }
    h.push(p);
  }
  return h;
};

/** Normal angle of a hull edge, in the same convention as `normalByTT`. */
const edgeAngle = (a: Vec2, b: Vec2): number => Math.atan2(b.y - a.y, -(b.x - a.x));

/**
 * Tangent candidates on the angle grid, one per half-degree from the apex to the deck.
 *
 * Each is the **supporting line** of the hull at that angle: it touches at the hull
 * vertex where the edge angles cross the target, which for a genuinely convex stretch is
 * the tangent point and for a bridged hollow is the high point the plane would ride on.
 * Several grid angles can share a vertex, and that is correct — two facets meeting at a
 * point leave no foam between them, which is what the cap area then works out to be.
 */
const buildCandidates = (
  s: Spline,
  ttApex: number,
  ttDeck: number,
  stepDeg: number,
): { cand: Candidate[]; hull: Vec2[] } => {
  const pts: Vec2[] = [];
  for (let i = 0; i <= PROFILE_SAMPLES; i++) {
    pts.push(pointByTT(s, ttApex + ((ttDeck - ttApex) * i) / PROFILE_SAMPLES));
  }
  const hull = upperHull(pts);
  if (hull.length < 3) return { cand: [], hull };

  const angles: number[] = [];
  for (let i = 0; i < hull.length - 1; i++) angles.push(edgeAngle(hull[i]!, hull[i + 1]!));

  // The apex tangent is the blank's own rail plane: exactly vertical, whatever the
  // spline's numerics say, because that face is a saw cut and not a curve.
  const cand: Candidate[] = [
    { angle: 90, hull: 0, p: hull[0]!, line: { p: hull[0]!, d: vec2(0, 1) } },
  ];

  let seg = 0;
  const top = 90 - stepDeg;
  for (let a = top; a > 0; a -= stepDeg) {
    const target = a * DEG_TO_RAD;
    while (seg < angles.length - 1 && angles[seg]! > target) seg++;
    // `seg` is the first edge shallower than the target, so the plane rides on the vertex
    // where it starts.
    const at = Math.max(0, Math.min(hull.length - 1, seg));
    cand.push({ angle: a, hull: at, p: hull[at]!, line: { p: hull[at]!, d: dirFromNormal(target) } }); // prettier-ignore
  }

  // The last candidate is the blank's deck plane: horizontal, touching the section's
  // high point. Pinning it here rather than taking whatever the grid reached keeps the
  // "how much foam is there in total" denominator honest.
  const lastI = hull.length - 1;
  cand.push({ angle: 0, hull: lastI, p: hull[lastI]!, line: { p: hull[lastI]!, d: vec2(-1, 0) } });
  return { cand, hull };
};

// --- cap costs ------------------------------------------------------------------

/**
 * Everything the dynamic program needs, precomputed so a cap costs O(1) to price.
 *
 * The prefix sums run along the candidate polyline, which makes the area between any
 * chord and its arc, and the arc length between any two candidates, a subtraction.
 */
interface CapTable {
  readonly cand: readonly Candidate[];
  /** Prefix sums along the **hull**, which is what the candidates index into. */
  readonly prefCross: readonly number[];
}

const capTable = (cand: readonly Candidate[], hull: readonly Vec2[]): CapTable => {
  const prefCross = [0];
  for (let i = 0; i < hull.length - 1; i++) {
    prefCross.push(prefCross[i]! + cross(hull[i]!, hull[i + 1]!));
  }
  return { cand, prefCross };
};

/** Area between the chord joining two hull vertices and the hull between them. */
const segmentArea = (t: CapTable, a: Candidate, b: Candidate): number => {
  const loop = t.prefCross[b.hull]! - t.prefCross[a.hull]! + cross(b.p, a.p);
  return Math.abs(loop) / 2;
};

/** Foam left in the cap between facets `i` and `j`. */
const cap = (t: CapTable, i: number, j: number): { area: number } => {
  const a = t.cand[i]!;
  const b = t.cand[j]!;
  const v = meet(a.line, b.line);
  if (!v) return { area: Infinity };
  const tri = Math.abs(cross(vec2(v.x - a.p.x, v.y - a.p.y), vec2(b.p.x - a.p.x, b.p.y - a.p.y))) / 2; // prettier-ignore
  return { area: Math.max(0, tri - segmentArea(t, a, b)) };
};

// --- the fit --------------------------------------------------------------------

export interface DeckFit {
  /** Best angle set for each band count: `byCount[k]` holds `k + 1` angles. */
  readonly byCount: readonly (readonly number[])[];
  /** Deck-side foam those sets leave (cm²), same indexing. */
  readonly areaByCount: readonly number[];
  /** Foam standing proud of the deck with no bands cut at all — the denominator. */
  readonly bareArea: number;
}

/**
 * Place `1..maxBands` deck facets optimally, by dynamic program over the angle grid.
 *
 * Returns null when the deck branch cannot be walked convexly far enough to place even
 * one band; the caller falls back to the ladder and warns, because a fabricated angle is
 * worse than a familiar one.
 */
export const fitDeck = (s: Spline, ttApex: number, o: DeckFitOptions = {}): DeckFit | null => {
  const step = o.stepDeg ?? DEFAULT_STEP_DEG;
  const minGap = o.minGapDeg ?? DEFAULT_MIN_GAP_DEG;
  const minAngle = o.minAngleDeg ?? DEFAULT_MIN_ANGLE_DEG;
  const maxBands = o.maxBands ?? DEFAULT_MAX_BANDS;
  const mode = o.mode ?? 'balanced';
  const firstMin = o.firstBandMinDeg ?? (mode === 'balanced' ? DEFAULT_FIRST_BAND_MIN_DEG : 0);

  const ttDeck = maxYAt(s, ttApex, T_ONE).tt;
  if (!(ttDeck > ttApex)) return null;
  const { cand, hull } = buildCandidates(s, ttApex, ttDeck, step);
  if (cand.length < 3) return null;

  const t = capTable(cand, hull);
  const n = cand.length;
  const last = n - 1;
  const bare = cap(t, 0, last);
  if (!Number.isFinite(bare.area)) return null;

  const cost = (i: number, j: number): number => cap(t, i, j).area;

  const chainArea = (chain: readonly number[]): number => {
    let area = cap(t, 0, chain[0]!).area;
    for (let i = 1; i < chain.length; i++) area += cap(t, chain[i - 1]!, chain[i]!).area;
    return area + cap(t, chain[chain.length - 1]!, last).area;
  };

  // The ladder is not fitted, but it still has to be *priced* — a dialog reporting the
  // fitted placement's numbers beside a ladder the user actually chose is describing a
  // board they are not going to cut.
  if (mode === 'ladder') {
    const nearest = (deg: number): number => {
      let best = 1;
      for (let j = 1; j < last; j++) {
        if (Math.abs(cand[j]!.angle - deg) < Math.abs(cand[best]!.angle - deg)) best = j;
      }
      return best;
    };
    const byC: number[][] = [];
    const areaC: number[] = [];
    for (let k = 1; k <= maxBands; k++) {
      byC.push(bisectionLadder(k));
      areaC.push(chainArea(bisectionLadder(k).map(nearest)));
    }
    return { byCount: byC, areaByCount: areaC, bareArea: bare.area };
  }

  const usable = (j: number): boolean =>
    j > 0 && j < last && cand[j]!.angle >= minAngle && cand[0]!.angle - cand[j]!.angle >= minGap;

  const byCount: number[][] = [];
  const areaByCount: number[] = [];
  // best[j]: cheapest chain of k facets whose innermost facet is candidate j.
  let best: number[] = new Array<number>(n).fill(Infinity);
  let chains: number[][] = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j++) {
    if (!usable(j) || cand[j]!.angle < firstMin) continue;
    best[j] = cost(0, j);
    chains[j] = [j];
  }

  for (let k = 1; k <= maxBands; k++) {
    // Close the chain: whatever it ends on still has to reach the deck plane.
    let bestEnd = Infinity;
    let bestChain: number[] | null = null;
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(best[j]!)) continue;
      const total = best[j]! + cost(j, last);
      if (total < bestEnd) {
        bestEnd = total;
        bestChain = chains[j]!;
      }
    }
    if (!bestChain || bestChain.length === 0) break;

    byCount.push(bestChain.map((i) => cand[i]!.angle));
    areaByCount.push(chainArea(bestChain));
    if (k === maxBands) break;

    const nextBest: number[] = new Array<number>(n).fill(Infinity);
    const nextChains: number[][] = Array.from({ length: n }, () => []);
    for (let j = 0; j < n; j++) {
      if (!usable(j)) continue;
      for (let i = 1; i < j; i++) {
        if (!Number.isFinite(best[i]!)) continue;
        // The grid runs steep to shallow, so once the gap is too small it stays so.
        if (cand[i]!.angle - cand[j]!.angle < minGap) break;
        const total = best[i]! + cost(i, j);
        if (total < nextBest[j]!) {
          nextBest[j] = total;
          nextChains[j] = [...chains[i]!, j];
        }
      }
    }
    best = nextBest;
    chains = nextChains;
  }

  if (byCount.length === 0) return null;
  return { byCount, areaByCount, bareArea: bare.area };
};

// --- leftover measurement -------------------------------------------------------

/** What a set of cuts leaves standing proud of the finished section. */
export interface RailLeftover {
  /** Foam still outside the designed section, in section area (cm²). */
  readonly areaCm2: number;
  /** Fraction of the blank's proud foam these cuts take out, 0..1. */
  readonly removed: number;
  /** Deepest remaining foam (cm), and where the shaper will find it. */
  readonly worstDepth: number;
  readonly worstAt: Vec2;
}

const polyArea = (pts: readonly Vec2[]): number => {
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    acc += cross(pts[i]!, pts[(i + 1) % pts.length]!);
  }
  return Math.abs(acc) / 2;
};

/** Perpendicular distance from `p` to the segment `a→b`. */
const distToSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-18) return dist(p, a);
  let u = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(p.x - (a.x + vx * u), p.y - (a.y + vy * u));
};

/**
 * Measure one side's leftover: the region between the cut path and the section, against
 * the region between the squared blank's corner and the same section.
 *
 * `cut`, `bare` and `section` must all run in the same direction and share their two
 * endpoints, so each path closes into a simple loop with the section.
 */
export const measureLeftover = (
  cut: readonly Vec2[],
  bare: readonly Vec2[],
  section: readonly Vec2[],
): RailLeftover => {
  const back = [...section].reverse();
  const area = polyArea([...cut, ...back]);
  const bareArea = polyArea([...bare, ...back]);
  let worstDepth = 0;
  let worstAt = section[0] ?? vec2(0, 0);
  for (const p of section) {
    let d = Infinity;
    for (let i = 0; i < cut.length - 1; i++) d = Math.min(d, distToSeg(p, cut[i]!, cut[i + 1]!));
    if (d > worstDepth) {
      worstDepth = d;
      worstAt = p;
    }
  }
  return {
    areaCm2: area,
    removed: bareArea > 1e-9 ? Math.max(0, Math.min(1, 1 - area / bareArea)) : 0,
    worstDepth,
    worstAt,
  };
};
