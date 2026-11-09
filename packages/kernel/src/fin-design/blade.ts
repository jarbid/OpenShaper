// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the fin's blade is made from, and level cuts through it: step 4 of
 * docs/design/fin-designer.md. The surface itself is the smooth blade (smooth-blade.ts);
 * this file prepares what doesn't depend on where on it you are, and cuts it horizontally
 * ({@link bladeSection}) for what is measured or fitted at a height: the placement checks,
 * the foil analysis and the STEP surface.
 *
 * - **Minimum thickness:** nowhere thinner than {@link PreparedBlade.minThickness}: the
 *   design minimum ({@link FIN_MIN_THICKNESS}), or an export's. The foil is scaled to the
 *   thickness less the minimum, then the minimum is added all the way along: symmetric
 *   foils half to each face, any other to the outside, so a flat inside face stays flat.
 * - **Cant:** the blade leans out by sliding sideways, z·tan(cant), so the root sits on
 *   the flat tab top; lateral offsets are divided by cos(cant), so the thickness square
 *   to the blade is the curve's.
 * - **Laminate:** the blade can be built as its core ({@link FinLaminate}): each face in
 *   by its laminate; where that would take it under the minimum, the face with less
 *   laminate makes up the shortfall.
 *
 * Frame (cm): the fin stands on its tab, as on a board turned deck-down.
 * - X runs along the tab toward its front (the nose), as in the outline.
 * - Z is height above the tab top.
 * - Y completes a right-handed frame. With the board deck-down and the nose toward +X,
 *   the rider's right rail is on +Y. Seen from below with the nose up (the way fin
 *   makers name fins, {@link FinHand}), +Y is on the left.
 * A left fin's outside face and cant point to +Y; a right fin is its exact mirror
 * ({@link finOutward}). A centre fin's outside is +Y too.
 */
import { value } from '../bezier-curve';
import { splineFromKnots, type Spline } from '../bezier-spline';
import { knot } from '../knot';
import { vec2, type Vec2 } from '../vec2';
import { DEG_TO_RAD } from '../constants';
import type { Vert3 } from '../loft';
import { crossings, splineExtremes, yAtX } from './curve-shape';
import { smoothBladeOf } from './smooth-blade';
import {
  FIN_MIN_THICKNESS,
  finMinThickness,
  finOutward,
  type FinDesign,
  type FinSection,
  type FinTwist,
  type FinThicknessPath,
} from './fin-design';
import { findRaisedRear, type RaisedRear } from './raised-rear';

/** Chord stations from leading edge (0) to trailing edge (1), clustered at both edges. */
export const cosineStations = (n: number): number[] =>
  Array.from({ length: n + 1 }, (_, j) => (1 - Math.cos((Math.PI * j) / n)) / 2);

export const DEFAULT_CHORD_STATIONS: readonly number[] = cosineStations(48);

/**
 * Laminate to be bagged onto the blade's faces (cm, square to the blade): the blade is
 * then built as the core under it (see the file comment). Zero on a face leaves it be.
 */
export interface FinLaminate {
  readonly outside: number;
  readonly inside: number;
  /**
   * The laminate also wraps the tab, over the base where the fin leaves the box (a
   * likely snap point in PLA and similar): the tab's laminated faces are pulled in by
   * the same amount, so laminated it still fits the box ({@link tabFacesY}).
   */
  readonly tab?: boolean;
}

/** No laminate: the blade is the design. */
export const NO_LAMINATE: FinLaminate = { outside: 0, inside: 0 };

/** Everything about a design that doesn't depend on the height, worked out once. */
export interface PreparedBlade {
  readonly design: FinDesign;
  /** Laminate the blade is the core of; {@link NO_LAMINATE} for the finished fin. */
  readonly laminate: FinLaminate;
  /**
   * Thinnest the blade gets (cm): the design minimum, or an export's (never less).
   * The edges and tip come up to it; the thickest point stays on the taper.
   */
  readonly minThickness: number;
  /** Height of the tip above the tab top (cm). */
  readonly depth: number;
  /** Chord fraction where the section shape is thickest. */
  readonly thickestAt: number;
  /** The shape's thickness there, in chords. */
  readonly shapeThickness: number;
  /** +1 if the outside face points to +Y, −1 for a right fin. */
  readonly outward: 1 | -1;
  /** Lateral slide per cm of height (tan cant). */
  readonly lean: number;
  /** Horizontal-slice widening, 1 / cos(cant). */
  readonly widen: number;
  /** The raised rear, if the outline has one. */
  readonly raisedRear: RaisedRear | null;
}

export { findRaisedRear, type RaisedRear } from './raised-rear';

/** One horizontal section of the blade, at shared chord stations. */
export interface BladeSection {
  /** Height above the tab top (cm). */
  readonly height: number;
  readonly leadingX: number;
  readonly trailingX: number;
  /** The taper's thickness at this height (cm), square to the blade. */
  readonly thickness: number;
  /** The chord stations (0 leading edge → 1 trailing edge) the faces were sampled at. */
  readonly stations: readonly number[];
  /** Points on the outside face, one per station. */
  readonly outside: readonly Vert3[];
  /** Points on the inside face, one per station. */
  readonly inside: readonly Vert3[];
}

/** Outside and inside offsets of a foil at chord fraction u, in chords. */
export const sectionShapeAt = (sec: FinSection, u: number): [number, number] => {
  const out = yAtX(sec.outside, u);
  return [out, sec.inside ? yAtX(sec.inside, u) : -out];
};

const SEARCH_SAMPLES = 400;

/**
 * The thickest point of `t` on [0, 1]: a coarse scan, then a golden-section refine. The
 * scan reads `coarse(j)`, t at j / {@link SEARCH_SAMPLES}, if given (from sampled tables).
 */
const findThickest = (
  t: (u: number) => number,
  coarse: (j: number) => number = (j) => t(j / SEARCH_SAMPLES),
): { at: number; thickness: number } => {
  let best = 0;
  let bestT = coarse(0);
  for (let j = 1; j < SEARCH_SAMPLES; j++) {
    const tj = coarse(j);
    if (tj > bestT) {
      best = j;
      bestT = tj;
    }
  }
  let lo = Math.max(0, (best - 1) / SEARCH_SAMPLES);
  let hi = Math.min(1, (best + 1) / SEARCH_SAMPLES);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 80; k++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (t(a) < t(b)) lo = a;
    else hi = b;
  }
  const at = (lo + hi) / 2;
  return { at, thickness: t(at) };
};

/**
 * Where a foil is thickest. It depends only on the foil, and is the bulk of preparing a
 * blade (a few ms), so it is cached per section object: edits that leave the foil alone
 * (outline drags, nudges, cant) reuse it. A WeakMap, so the cache never keeps a section
 * alive.
 */
const thickestCache = new WeakMap<FinSection, { at: number; thickness: number }>();

export const sectionThickest = (sec: FinSection): { at: number; thickness: number } => {
  const hit = thickestCache.get(sec);
  if (hit) return hit;
  const found = findThickest((u) => {
    const [o, i] = sectionShapeAt(sec, u);
    return o - i;
  });
  thickestCache.set(sec, found);
  return found;
};

/** The foil a section is shaped by, at one height (see {@link foilAt}). */
export interface Foil {
  /** Outside and inside offsets at chord fraction u, in chords. */
  readonly shapeAt: (u: number) => [number, number];
  /** Where it is thickest, and how thick (in chords). */
  readonly thickest: { readonly at: number; readonly thickness: number };
  /** The share of the minimum thickness added to the outside face: ½ symmetric, 1 not. */
  readonly outsideShare: number;
}

const share = (sec: FinSection): number => (sec.inside === null ? 0.5 : 1);

const pureFoil = (sec: FinSection): Foil => ({
  shapeAt: (u) => sectionShapeAt(sec, u),
  thickest: sectionThickest(sec),
  outsideShare: share(sec),
});

/** The tip foil (foil sweep end): its own, or the base foil's. */
export const tipFoilOf = (d: FinDesign): FinSection => d.tipSection ?? d.section;

/**
 * The thickness path (base, halfway, tip line): the base and tip foils' thickest points
 * at its ends, the design's middle or halfway between them.
 */
export const thicknessPathOf = (d: FinDesign): FinThicknessPath => {
  const a = sectionThickest(d.section).at;
  const c = sectionThickest(tipFoilOf(d)).at;
  return [a, d.thicknessMid ?? (a + c) / 2, c];
};

/**
 * `sec` reshaped so it is thickest at `to` (fraction of the chord), keeping its ends and
 * the order of its points: every point's (and handle's) x moved by a power curve that
 * takes the old thickest point to the new one, a few times over, as the curve between
 * the points follows them only roughly.
 */
export const moveFoilThickest = (sec: FinSection, to: number): FinSection => {
  const target = Math.min(0.95, Math.max(0.05, to));
  const warp = (s: Spline, q: number): Spline => {
    const x = (v: number) => (v <= 0 || v >= 1 ? v : Math.pow(v, q));
    return splineFromKnots(
      s.knots.map((k) =>
        knot(
          vec2(x(k.end.x), k.end.y),
          vec2(x(k.tangentToPrev.x), k.tangentToPrev.y),
          vec2(x(k.tangentToNext.x), k.tangentToNext.y),
          k.continuous,
        ),
      ),
    );
  };
  let out = sec;
  for (let i = 0; i < 6; i++) {
    const at = sectionThickest(out).at;
    if (Math.abs(at - target) < 5e-4 || !(at > 0 && at < 1)) break;
    const q = Math.log(target) / Math.log(at);
    out = { outside: warp(out.outside, q), inside: out.inside ? warp(out.inside, q) : null };
  }
  return out;
};

/**
 * Work out the height-independent parts of the blade. The design must pass
 * `validateFinDesign`; the result is undefined otherwise.
 */
export const prepareBlade = (
  d: FinDesign,
  laminate: FinLaminate = NO_LAMINATE,
  minThickness: number = FIN_MIN_THICKNESS,
): PreparedBlade => {
  // An export's minimum thickens the edges and tip further; never under the fin's own.
  const { at, thickness } = sectionThickest(d.section);
  const cant = d.cant * DEG_TO_RAD;
  return {
    design: d,
    laminate,
    minThickness: Math.max(finMinThickness(d), minThickness),
    depth: splineExtremes(d.outline, 'y').max.point.y,
    thickestAt: at,
    shapeThickness: thickness,
    outward: finOutward(d.hand),
    lean: Math.tan(cant),
    widen: 1 / Math.cos(cant),
    raisedRear: findRaisedRear(d.outline),
  };
};

/** Leading- and trailing-edge x where the outline is `h` above the tab top. */
export const chordAt = (b: PreparedBlade, h: number): { leading: number; trailing: number } => {
  if (!(h >= 0 && h <= b.depth)) {
    throw new RangeError(`chordAt: height ${h} is outside 0–${b.depth}`);
  }
  // Single-peaked outline: the first crossing is on the leading edge, the last on the
  // trailing edge. At the tip they meet.
  const hits = crossings(b.design.outline, 'y', h);
  if (h === b.depth || hits.length === 0) {
    const tip = splineExtremes(b.design.outline, 'y').max.point.x;
    return { leading: tip, trailing: tip };
  }
  return { leading: hits[0]!.point.x, trailing: hits[hits.length - 1]!.point.x };
};

/**
 * Longest the flat cap that closes the blade under the tip may be (cm). Under a rounded
 * top the chord closes slowly: 0.1 mm down, the keel's is still 8 mm, which a flat cap
 * there leaves as a flat on the top edge (round 4 testing). 1 mm reads as the edge.
 */
export const FIN_TIP_CAP = 0.1;

/**
 * Where the blade's sections stop under the tip: `gap` below it, or higher where the
 * chord there is longer than {@link FIN_TIP_CAP}, so the cap closing it stays short.
 */
export const bladeTop = (b: PreparedBlade, gap: number): number => {
  const span = (h: number) => {
    const c = chordAt(b, h);
    return c.leading - c.trailing;
  };
  let lo = Math.max(0, b.depth - gap);
  if (!(span(lo) > FIN_TIP_CAP)) return lo;
  let hi = b.depth;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (span(mid) > FIN_TIP_CAP) lo = mid;
    else hi = mid;
  }
  return hi;
};

/** The taper's thickness (cm) at height `h`. */
export const thicknessAt = (b: PreparedBlade, h: number): number =>
  yAtX(b.design.taper, Math.min(1, Math.max(0, h / b.depth)));

/** Heights the edges are sampled at, for row spacing and the lean. */
const EDGE_SAMPLES = 1200;

/**
 * Both edges sampled up the blade, and `travel`: the running total of height plus how
 * far both edges have moved, which spaces sections evenly along the edges rather than
 * the height ({@link bladeRowHeights}).
 */
export interface BladeEdges {
  readonly heights: Float64Array;
  readonly leading: Float64Array;
  readonly trailing: Float64Array;
  readonly travel: Float64Array;
}

const edgesCache = new WeakMap<PreparedBlade, BladeEdges>();

/** Both edges up the blade (see {@link BladeEdges}). Cached per blade. */
export const bladeEdges = (b: PreparedBlade): BladeEdges => {
  const hit = edgesCache.get(b);
  if (hit) return hit;
  const n = EDGE_SAMPLES;
  const heights = new Float64Array(n + 1);
  const leading = new Float64Array(n + 1);
  const trailing = new Float64Array(n + 1);
  const travel = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const h = (b.depth * i) / n;
    const c = chordAt(b, h);
    heights[i] = h;
    leading[i] = c.leading;
    trailing[i] = c.trailing;
    if (i > 0) {
      travel[i] =
        travel[i - 1]! +
        (h - heights[i - 1]!) +
        Math.abs(c.leading - leading[i - 1]!) +
        Math.abs(c.trailing - trailing[i - 1]!);
    }
  }
  const edges = { heights, leading, trailing, travel };
  edgesCache.set(b, edges);
  return edges;
};

/** Linear interpolation in a column of {@link BladeEdges} at height `h`. */
const edgeAt = (e: BladeEdges, col: Float64Array, h: number): number => {
  const n = e.heights.length - 1;
  const f = Math.min(n, Math.max(0, (h / e.heights[n]!) * n));
  const i = Math.min(n - 1, Math.floor(f));
  return col[i]! + (col[i + 1]! - col[i]!) * (f - i);
};

/**
 * Heights (cm, strictly inside the blade, below `top`) where the outline turns hardest:
 * its points (a corner, or a smooth point with short handles, like a hooked tip's) and
 * wherever it runs exactly level or upright between them. A tip that sticks out
 * backward or forward peaks at one of these, so sections there catch it: sections only
 * at evenly spaced heights cut it off between them.
 */
export const outlineFeatureHeights = (b: PreparedBlade, top: number): number[] => {
  const hs: number[] = b.design.outline.knots.slice(1, -1).map((k) => k.end.y);
  for (const k of b.design.outline.coeffs) {
    // Roots of each derivative component (a quadratic): level (dy = 0) or upright (dx = 0).
    for (const [a, bb, c] of [
      [3 * k.ax, 2 * k.bx, k.cx],
      [3 * k.ay, 2 * k.by, k.cy],
    ] as const) {
      const roots: number[] = [];
      if (Math.abs(a) < 1e-12) {
        if (Math.abs(bb) > 1e-12) roots.push(-c / bb);
      } else {
        const disc = bb * bb - 4 * a * c;
        if (disc >= 0) {
          const r = Math.sqrt(disc);
          roots.push((-bb - r) / (2 * a), (-bb + r) / (2 * a));
        }
      }
      for (const t of roots) if (t > 0 && t < 1) hs.push(value(k, t).y);
    }
  }
  return [...new Set(hs)].filter((h) => h > 0 && h < top).sort((p, q) => p - q);
};

/** How far the edges have travelled from the root to height `h` (see {@link BladeEdges}). */
export const bladeTravel = (b: PreparedBlade, h: number): number => {
  const e = bladeEdges(b);
  return edgeAt(e, e.travel, h);
};

/**
 * Section heights from `lo` to `hi` (cm), `count` steps, spaced evenly in how far the
 * edges travel rather than in height: where an edge runs nearly level (a raised rear's
 * underside, a hooked tip) it moves far for little height, and gets sections to match.
 * The tip, where both edges close in, gathers them too.
 */
export const bladeRowHeights = (
  b: PreparedBlade,
  lo: number,
  hi: number,
  count: number,
): number[] => {
  const e = bladeEdges(b);
  const t0 = edgeAt(e, e.travel, lo);
  const t1 = edgeAt(e, e.travel, hi);
  const out: number[] = [lo];
  let i = 0;
  for (let k = 1; k < count; k++) {
    const target = t0 + ((t1 - t0) * k) / count;
    while (i < e.travel.length - 2 && e.travel[i + 1]! < target) i++;
    const a = e.travel[i]!;
    const c = e.travel[i + 1]!;
    const h = e.heights[i]! + ((e.heights[i + 1]! - e.heights[i]!) * (target - a)) / (c - a || 1);
    out.push(Math.min(hi, Math.max(lo, h)));
  }
  out.push(hi);
  return out;
};

/**
 * The root section's outside and inside faces (blade-frame y, cm) at its thickest point:
 * what the tab must sit between (fin-placement.ts). Worked out directly rather than by
 * building the section (every nudge rechecks this): at the root the sweep lays the root
 * foil along the chord, scaled to the taper, and wherever the thickness path puts its
 * thickest point the faces there are the same.
 */
export const rootThickestFaces = (b: PreparedBlade): { outside: number; inside: number } => {
  const foil = pureFoil(b.design.section);
  const m = b.minThickness;
  const t = thicknessAt(b, 0);
  const scale = foil.thickest.thickness > 0 ? Math.max(0, t - m) / foil.thickest.thickness : 0;
  const [o, i] = foil.shapeAt(foil.thickest.at);
  const y = (offset: number) => b.outward * offset * b.widen; // no slide at the root
  return {
    outside: y(o * scale + m * foil.outsideShare),
    inside: y(i * scale - m * (1 - foil.outsideShare)),
  };
};

/** 0 → 1 with flat ends: 6t⁵ − 15t⁴ + 10t³, curvature continuous where it joins. */
const smoother = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Whether any cant line changes the cant or toe. */
export const hasTwist = (d: FinDesign): boolean => (d.cantLines?.length ?? 0) > 0;

/** How far above cant line `i` its change is complete (fraction of the depth). */
export const cantLineReach = (d: FinDesign, i: number): number => {
  const lines = d.cantLines ?? [];
  return Math.min(FIN_SLICE_REACH, (lines[i + 1]?.height ?? 1) - lines[i]!.height);
};

/**
 * Cant and toe (deg) at height `eta` (fraction of the depth): the fin's own at the base,
 * each cant line's easing in going up from it, over {@link FIN_SLICE_REACH} of the depth
 * or to the next line if that is nearer, with no crease where it starts or ends. Height
 * alone, so the bends run level, along the flow.
 */
export const twistAt = (d: FinDesign, eta: number): FinTwist => {
  let cant = d.cant;
  let toe = d.toe ?? 0;
  (d.cantLines ?? []).forEach((l, i) => {
    if (!(eta > l.height)) return;
    const w = smoother(Math.min(1, (eta - l.height) / cantLineReach(d, i)));
    cant += (l.cant - cant) * w;
    toe += (l.toe - toe) * w;
  });
  return { cant, toe };
};

/**
 * Where the toe turns the blade, and by how much: about the upright axis through the
 * centre of the root's thickest point, x along the root chord at the foil's thickest
 * fraction, y midway between its faces. Positive toe turns the leading edge toward the
 * stringer: on a fin whose outside face is +Y (a left fin), toward −Y, so a turn of
 * −toe about +Z; a right fin's mirror turns the other way. Null for no toe.
 */
export const toeTurn = (
  b: PreparedBlade,
): { x: number; y: number; cos: number; sin: number } | null => {
  const toe = b.design.toe ?? 0;
  if (!toe) return null;
  const { leading, trailing } = chordAt(b, 0);
  const faces = rootThickestFaces(b);
  const a = -b.outward * toe * DEG_TO_RAD;
  return {
    x: leading + (trailing - leading) * b.thickestAt,
    y: (faces.outside + faces.inside) / 2,
    cos: Math.cos(a),
    sin: Math.sin(a),
  };
};

/**
 * How far a slice reaches either side of its height (fraction of the depth): it blends
 * in over this below it and out over this above it, and its cant and toe ease in over
 * this below it (owner testing: blended over the whole span from the base, a slice high
 * up bent and reshaped the blade a third of the way up). Less where the base, the top
 * or another slice is nearer.
 */
export const FIN_SLICE_REACH = 0.15;

/**
 * How much the slices count at height `eta`, 0 to 1: all of it at a slice, easing to
 * none over {@link FIN_SLICE_REACH} either side, or to the base below and the top above
 * when they are nearer. Between two slices close enough that their reaches meet, all of
 * it. (Owner testing: easing out by the tip line's height instead, a slice just under it
 * handed back to the fin within 2 mm, a kink.)
 */
export const sliceWeight = (d: FinDesign, eta: number): number => {
  const sl = d.slices;
  if (sl.length === 0) return 0;
  let k = -1; // the last slice at or below eta
  while (k < sl.length - 1 && sl[k + 1]!.height <= eta) k++;
  const lo = k >= 0 ? sl[k]!.height : null;
  const hi = k < sl.length - 1 ? sl[k + 1]!.height : null;
  if (lo !== null && hi !== null && hi - lo <= 2 * FIN_SLICE_REACH) return 1;
  let w = 0;
  if (lo !== null) {
    const reach = Math.min(FIN_SLICE_REACH, 1 - lo);
    w = Math.max(w, reach > 0 ? 1 - smoother(Math.min(1, (eta - lo) / reach)) : 0);
  }
  if (hi !== null) {
    const reach = Math.min(FIN_SLICE_REACH, hi);
    w = Math.max(w, reach > 0 ? smoother(Math.max(0, 1 - (hi - eta) / reach)) : 1);
  }
  return w;
};

/** The fin's horizontal section sampled as a foil (bladeShapeAt). */
interface BladeShape {
  /** Chord stations, 0 the leading edge. */
  readonly us: readonly number[];
  /** The faces there, chord fractions, less the minimum thickness. */
  readonly out: readonly number[];
  readonly ins: readonly number[];
  /** The part of the chord short of the tip line (sliceFreeSpan). */
  readonly free: readonly [number, number];
  /** Every foil of the fin is symmetric: so is its section. */
  readonly symmetric: boolean;
}

/** A foil fitted to a sampled section, with a point where it crosses the tip line. */
const fitShape = (s: BladeShape): FinSection => {
  const must = s.free.filter((x) => x > 1e-3 && x < 1 - 1e-3);
  if (s.symmetric) return { outside: fitFace(s.us, s.out, must), inside: null };
  // The edges, where the faces meet: off the chord line if a foil's are.
  const n = s.us.length - 1;
  const ends: [number, number] = [(s.out[0]! + s.ins[0]!) / 2, (s.out[n]! + s.ins[n]!) / 2];
  const outside = fitFace(s.us, s.out, must, ends);
  const flat = s.ins.every((y) => Math.abs(y) < 1e-7);
  return { outside, inside: flat ? straightFace() : fitFace(s.us, s.ins, must, ends) };
};

/**
 * A foil fitted to faces sampled at chord stations `us` (0 → 1), in chords: as few points
 * as follow them to within FIT_TOLERANCE. Symmetric: the outside face only.
 */
export const fitFoil = (
  us: readonly number[],
  out: readonly number[],
  ins: readonly number[],
  symmetric: boolean,
): FinSection => fitShape({ us, out, ins, free: [0, 1], symmetric });

/**
 * How far (a fraction of its thickest, square to the face) a fitted foil may miss the
 * section it follows: two percent, under 0.2 mm on any fin. A percent was finer than the
 * fit can follow a section with few points: it added points that changed next to nothing.
 */
const FIT_TOLERANCE = 0.02;

/** The straight face y = 0, as a flat inside face. */
const straightFace = (): Spline =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(1 / 3, 0), false),
    knot(vec2(1, 0), vec2(2 / 3, 0), vec2(1, 0), false),
  ]);

/**
 * A foil face through samples (`us` from 0 to 1, rising): points at the ends (at `ends`'
 * heights, where the faces meet), at `must`,
 * at its furthest from the chord line, and then wherever it misses by most, until it
 * misses by no more than FIT_TOLERANCE of its furthest, square to the face (or fourteen
 * points). Smooth at each point, its slope there read off the samples, and each stretch's
 * two handles as long as fit it best; square to the chord at the leading edge, as a
 * rounded nose is, and at the trailing edge sloped as fits best.
 */
const fitFace = (
  us: readonly number[],
  ys: readonly number[],
  must: readonly number[],
  ends: readonly [number, number] = [0, 0],
): Spline => {
  /** A stretch's handle lengths, and the trailing edge's slope on the last. */
  type Fit = [number, number, number?];
  const at = (x: number): number => {
    let j = 1;
    while (j < us.length - 1 && us[j]! < x) j++;
    const t = (x - us[j - 1]!) / (us[j]! - us[j - 1]! || 1);
    return ys[j - 1]! + (ys[j]! - ys[j - 1]!) * Math.min(1, Math.max(0, t));
  };
  const slope = (x: number): number => {
    // Finer toward the nose, where the face turns fastest.
    const e = Math.max(1e-5, Math.min(2e-3, x / 4, (1 - x) / 4));
    const lo = Math.max(0, x - e);
    const hi = Math.min(1, x + e);
    return (at(hi) - at(lo)) / (hi - lo);
  };
  let far = 0;
  ys.forEach((y, j) => {
    if (Math.abs(y) > Math.abs(ys[far]!)) far = j;
  });
  const peak = Math.abs(ys[far]!);
  const golden = (lo: number, hi: number, err: (v: number) => number): number => {
    const g = (Math.sqrt(5) - 1) / 2;
    // To a thousandth of the range: finer moves the face by less than the fit's error.
    for (let i = 0; i < 14; i++) {
      const p = hi - g * (hi - lo);
      const q = lo + g * (hi - lo);
      if (err(p) < err(q)) hi = q;
      else lo = p;
    }
    return (lo + hi) / 2;
  };
  /** A point of the face: on the samples, the ends at the edges. */
  const pointAt = (xs: readonly number[], k: number) =>
    vec2(xs[k]!, k === 0 ? ends[0] : k === xs.length - 1 ? ends[1] : at(xs[k]!));
  /**
   * Stretch `k`'s handles: from point k along its slope (straight up at the nose, `a`
   * its height), `a` and `c` of the stretch long. At the trailing edge the slope is the
   * fit's own, `s`: the samples' there can be a thick edge's drop, too steep to follow.
   */
  const handles = (
    xs: readonly number[],
    k: number,
    a: number,
    c: number,
    s = slope(xs[k + 1]!),
  ): [Vec2, Vec2] => {
    const p = pointAt(xs, k);
    const q = pointAt(xs, k + 1);
    const dx = q.x - p.x;
    const s0 = slope(p.x);
    return [
      k === 0 ? vec2(p.x, p.y + a) : vec2(p.x + a * dx, p.y + s0 * a * dx),
      vec2(q.x - c * dx, q.y - s * c * dx),
    ];
  };
  /** Stretch `k`'s handles (and the trailing edge's slope), fitted to its samples by turns. */
  const fitStretch = (xs: readonly number[], k: number): Fit => {
    const p = pointAt(xs, k);
    const q = pointAt(xs, k + 1);
    // Its samples, every few: plenty to fit two handles to.
    const js: number[] = [];
    for (let j = 0; j < us.length; j++) if (us[j]! > p.x && us[j]! < q.x) js.push(j);
    const step = Math.max(1, Math.floor(js.length / 24));
    const fitTo = js.filter((_, i) => i % step === 0);
    const err = (a: number, c: number, s?: number) => {
      const [h0, h1] = handles(xs, k, a, c, s);
      const sp = splineFromKnots([knot(p, p, h0, false), knot(q, h1, q, false)]);
      let e = 0;
      for (const j of fitTo) e += (yAtX(sp, us[j]!) - ys[j]!) ** 2;
      return e;
    };
    const reach = 2 * (q.y - p.y) || 2 * at((p.x + q.x) / 2);
    const [lo, hi] = k === 0 ? [Math.min(0, reach), Math.max(0, reach)] : [0.02, 0.95];
    let a = k === 0 ? reach / 3 : 1 / 3;
    let c = 1 / 3;
    if (k < xs.length - 2) {
      for (let round = 0; round < 2; round++) {
        a = golden(lo, hi, (v) => err(v, c));
        c = golden(0.02, 0.95, (v) => err(a, v));
      }
      return [a, c];
    }
    // Up to four times as steep as the stretch, on average: a sharp edge's is less.
    const steep = (4 * (q.y - p.y)) / (q.x - p.x);
    let s = steep / 4;
    for (let round = 0; round < 3; round++) {
      s = golden(Math.min(0, steep), Math.max(0, steep), (v) => err(a, c, v));
      a = golden(lo, hi, (v) => err(v, c, s));
      c = golden(0.02, 0.95, (v) => err(a, v, s));
    }
    return [a, c, s];
  };
  // A stretch's fit depends only on its ends: kept as points are added between others.
  const fitted = new Map<string, Fit>();
  const fitOf = (xs: readonly number[], k: number): Fit => {
    const key = `${xs[k]},${xs[k + 1]}`;
    let f = fitted.get(key);
    if (!f) fitted.set(key, (f = fitStretch(xs, k)));
    return f;
  };
  const build = (xs: readonly number[]): Spline => {
    const hs = xs.slice(0, -1).map((_, k) => handles(xs, k, ...fitOf(xs, k)));
    return splineFromKnots(
      xs.map((_, k) => {
        const p = pointAt(xs, k);
        const prev = k > 0 ? hs[k - 1]![1] : p;
        const next = k < xs.length - 1 ? hs[k]![0] : p;
        return knot(p, prev, next, k > 0 && k < xs.length - 1);
      }),
    );
  };
  /** Where the fit misses by most, away from the points it already has. */
  const miss = (sp: Spline, xs: readonly number[]): { at: number; by: number } => {
    let worst = { at: 0.5, by: 0 };
    for (let j = 1; j < us.length - 1; j++) {
      if (xs.some((x) => Math.abs(x - us[j]!) < 1e-3)) continue;
      // Square to the face: where it is steep, as at the nose, height misleads.
      const by = Math.abs(yAtX(sp, us[j]!) - ys[j]!) / Math.hypot(1, slope(us[j]!));
      if (by > worst.by) worst = { at: us[j]!, by };
    }
    return worst;
  };
  const xs = [...new Set([0, ...must, us[far]!, 1])]
    .filter((x) => x >= 0 && x <= 1)
    .sort((p, q) => p - q);
  let sp = build(xs);
  for (let k = xs.length; k < 14; k++) {
    const w = miss(sp, xs);
    if (w.by <= FIT_TOLERANCE * peak) break;
    xs.push(w.at);
    xs.sort((p, q) => p - q);
    sp = build(xs);
  }
  return sp;
};

/**
 * The horizontal section of the blade at height `h` (cm above the tab top): the smooth
 * blade (smooth-blade.ts) cut level, for what is measured or fitted at a height: the
 * placement checks, the foil analysis's cuts and the STEP surface. Each station's profile
 * point is found on the blade's layout; a point in the gap under a hook takes the nearest.
 */
export const bladeSection = (
  b: PreparedBlade,
  h: number,
  stations: readonly number[] = DEFAULT_CHORD_STATIONS,
): BladeSection => {
  const { leading, trailing } = chordAt(b, h);
  const sb = smoothBladeOf(b);
  const outside: Vert3[] = [];
  const inside: Vert3[] = [];
  let hint: { s: number; u: number } | null = null;
  for (const u of stations) {
    const x = leading + (trailing - leading) * u;
    const found: { s: number; u: number } = sb.nearest(x, h, hint);
    hint = found;
    // An end of the cut is on the outline, so on the blade's edge: exactly the minimum.
    const onSide = !(u > 0 && u < 1);
    const at = {
      s: onSide && found.s > 0.98 ? 1 : found.s,
      u: onSide && found.u < 0.02 ? 0 : onSide && found.u > 0.98 ? 1 : found.u,
    };
    const f = sb.faces(at.s, at.u);
    // Each station where it belongs along the cut: the layout's edge can stray from the
    // outline by a fraction of a millimetre at a raised rear's corner.
    const dx = x - sb.point(at.s, at.u).x;
    outside.push({ x: f.outside.x + dx, y: f.outside.y, z: h });
    inside.push({ x: f.inside.x + dx, y: f.inside.y, z: h });
  }
  return {
    height: h,
    leadingX: leading,
    trailingX: trailing,
    thickness: thicknessAt(b, h),
    stations,
    outside,
    inside,
  };
};
