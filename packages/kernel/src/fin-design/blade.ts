// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The 3D blade of a {@link FinDesign}, as horizontal sections: step 4 of
 * docs/design/fin-designer.md. Meshing (step 7) and STEP (step 5) both loft these.
 *
 * At height h above the tab top, a section runs along the chord there (where the line
 * y = h crosses the outline) and takes its thickness from the **foil sweep**
 * (swept-loft.ts): the root foil laid along sections swept from the base to the tip
 * line, each as thick at its thickest point as the taper says at that point's height.
 * A horizontal slice ({@link slicesAt}) adds the difference between its foil and the fin
 * at its height, blending in and out around it ({@link sliceWeight}); past the tip line the
 * chord is the tip's. The outline sets the chord, the taper the thickness; neither scales
 * the other.
 *
 * Then two adjustments:
 * - **Minimum thickness:** nowhere thinner than {@link PreparedBlade.minThickness}: the
 *   design minimum ({@link FIN_MIN_THICKNESS}), or an export's. The foil is
 *   scaled to the taper's thickness less the minimum, then the minimum is added all the
 *   way along: symmetric foils half to each face, so they stay symmetric; any other foil
 *   to the outside, so a flat inside face stays flat. The faces stay as convex as the
 *   foil right to the edges, which end exactly at the minimum, with no parallel-sided
 *   run (round 2 testing: padding only where the foil was thin left flat ends).
 * - **Cant:** the blade leans out by sliding each section sideways, h·tan(cant). The
 *   sections stay horizontal, so the root sits exactly on the flat tab top (see "Cant
 *   as a lean of horizontal sections" in the design doc). A horizontal slice of a
 *   leaning blade is wider than the blade is thick, so lateral offsets are divided by
 *   cos(cant); the thickness measured square to the blade is then the taper value.
 *
 * For a laminated fin, the blade can be built as its **core** ({@link FinLaminate}):
 * each face pulled in by the laminate that will be bagged onto it, so the finished fin
 * is the design. The core is never thinner than the minimum. Where the laminate would
 * take it below (toward the edges, which end at the minimum), a laminated face is still
 * pulled in by its whole laminate, so it stays true (a flat inside face stays flat and
 * flush with a wrapped tab), and the face with less laminate makes up the shortfall:
 * all of it on the bare face when only one is laminated, half each when both are
 * equally. So the edges come out a little thicker than designed once laminated, on
 * the side with less laminate.
 *
 * **Why sweep.** Stretching the foil along horizontal sections ties every point of it to
 * both edges, and wherever an edge runs near level (a hooked tip, a raised rear's
 * underside) a horizontal section meets it at a glancing angle: whole sections shifted
 * at once, creasing the blade, or thinned to a flap. Owner testing needed a pile of edge
 * smoothing to hide that; the sweep's sections meet both edges across instead. Every
 * edge ends at the minimum, except a raised rear's underside ({@link RaisedRear}), which
 * is part of the sweep's base and keeps the root foil's thickness.
 *
 * Frame (cm): the fin stands on its tab, as on a board turned deck-down.
 * - X runs along the tab toward its front (the nose), as in the outline.
 * - Z is height above the tab top.
 * - Y completes a right-handed frame. With the board deck-down and the nose toward +X,
 *   the rider's right rail is on +Y. Seen from below with the nose up (the way fin
 *   makers name fins, {@link FinHand}), +Y is on the left.
 * A left fin's outside face and cant point to +Y; a right fin is its exact mirror
 * ({@link finOutward}). A centre fin's outside is +Y too; it is symmetric with no cant,
 * so the choice is moot.
 */
import { value } from '../bezier-curve';
import { splineFromKnots, type Spline } from '../bezier-spline';
import { knot } from '../knot';
import { vec2, type Vec2 } from '../vec2';
import { DEG_TO_RAD } from '../constants';
import type { Vert3 } from '../loft';
import { crossings, splineExtremes, yAtX } from './curve-shape';
import {
  FIN_MIN_THICKNESS,
  finMinThickness,
  finOutward,
  type FinDesign,
  type FinSection,
  type FinSlice,
  type FinThicknessPath,
} from './fin-design';
import { findRaisedRear, type RaisedRear } from './raised-rear';
import {
  cellsAtHeight,
  foilFractionAt,
  locateOnSweep,
  sweepGrid,
  sweepTipEdge,
  sweepPointOn,
  thicknessPathAt,
  type SweepGrid,
} from './swept-loft';

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

/**
 * A foil's faces at the thickest-point search's coarse stations (j / SEARCH_SAMPLES),
 * cached per section: a blend of two foils scans these instead of solving each face
 * afresh at every station for every blend (owner report: point drags on a fin with its
 * own tip foil took 0.4 s a step, nearly all of it here).
 */
const coarseCache = new WeakMap<FinSection, { outside: Float64Array; inside: Float64Array }>();

const coarseFaces = (sec: FinSection) => {
  const hit = coarseCache.get(sec);
  if (hit) return hit;
  const outside = new Float64Array(SEARCH_SAMPLES);
  const inside = new Float64Array(SEARCH_SAMPLES);
  for (let j = 0; j < SEARCH_SAMPLES; j++) {
    [outside[j], inside[j]] = sectionShapeAt(sec, j / SEARCH_SAMPLES);
  }
  const faces = { outside, inside };
  coarseCache.set(sec, faces);
  return faces;
};

/** `a` blended `w` of the way to `b`, thickest point found exactly as on a single foil. */
const blendedFoil = (a: FinSection, b: FinSection, w: number): Foil => {
  const shapeAt = (u: number): [number, number] => {
    const [o0, i0] = sectionShapeAt(a, u);
    const [o1, i1] = sectionShapeAt(b, u);
    return [o0 + (o1 - o0) * w, i0 + (i1 - i0) * w];
  };
  // Found when first asked for: the sweep's rows blend the base and tip foils but lay
  // each on its own thickest point (rowFaces), so most blends never need theirs.
  let thickest: Foil['thickest'] | null = null;
  return {
    shapeAt,
    get thickest() {
      if (thickest) return thickest;
      const fa = coarseFaces(a);
      const fb = coarseFaces(b);
      return (thickest = findThickest(
        (u) => {
          const [o, i] = shapeAt(u);
          return o - i;
        },
        // shapeAt's arithmetic on the sampled faces: the same numbers, read not solved.
        (j) => {
          const o0 = fa.outside[j]!;
          const i0 = fa.inside[j]!;
          return o0 + (fb.outside[j]! - o0) * w - (i0 + (fb.inside[j]! - i0) * w);
        },
      ));
    },
    outsideShare: share(a) + (share(b) - share(a)) * w,
  };
};

/** Two foils blended, `w` of the way from `a` to `b`. */
const blendFoils = (a: FinSection, b: FinSection, w: number): Foil => {
  if (w <= 0 || a === b) return pureFoil(a);
  if (w >= 1) return pureFoil(b);
  return blendedFoil(a, b, w);
};

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
 * The foil at height `eta` (a fraction of the depth): the root foil, a slice's, or a
 * blend of the two either side. The blend eases in and out with flat ends (`smoother`),
 * so the shape changes smoothly through every slice and can't crease the blade there.
 * Above the last slice the foil stays as the last.
 */
export const foilAt = (d: FinDesign, eta: number): Foil => {
  const anchors = [{ height: 0, section: d.section }, ...d.slices];
  let k = 0;
  while (k < anchors.length - 1 && eta >= anchors[k + 1]!.height) k++;
  const lo = anchors[k]!;
  const hi = anchors[k + 1];
  if (!hi) return pureFoil(lo.section);
  const w = smoother(Math.min(1, Math.max(0, (eta - lo.height) / (hi.height - lo.height))));
  if (w <= 0) return pureFoil(lo.section);
  if (w >= 1) return pureFoil(hi.section);
  return blendedFoil(lo.section, hi.section, w);
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

const designBladeCache = new WeakMap<FinDesign, PreparedBlade>();

/**
 * The finished blade of a design (no laminate, the design minimum), kept per design: the
 * editor's helpers (a slice's crossing, its free span, a new slice's foil) all ask for it
 * after each edit, and each built its sweep afresh.
 */
const designBlade = (d: FinDesign): PreparedBlade => {
  let b = designBladeCache.get(d);
  if (!b) designBladeCache.set(d, (b = prepareBlade(d)));
  return b;
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
  const foil = foilAt(b.design, 0);
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

/** Whether any slice changes the cant or toe. */
export const hasTwist = (d: FinDesign): boolean => d.slices.some((sl) => sl.twist);

/**
 * Cant and toe (deg) at height `eta` (fraction of the depth): the fin's own at the root,
 * each slice's with a twist from its height up, easing in over {@link FIN_SLICE_REACH}
 * below it (less if the root or the slice below is nearer) with no crease where it
 * starts or ends (`smoother`).
 */
export const twistAt = (d: FinDesign, eta: number): { cant: number; toe: number } => {
  let from = { height: 0, cant: d.cant, toe: d.toe ?? 0 };
  for (const sl of d.slices) {
    if (!sl.twist) continue;
    const to = { height: sl.height, cant: sl.twist.cant, toe: sl.twist.toe };
    if (eta < to.height) {
      const start = Math.max(from.height, to.height - FIN_SLICE_REACH);
      const w = smoother(Math.max(0, (eta - start) / (to.height - start)));
      return {
        cant: from.cant + (to.cant - from.cant) * w,
        toe: from.toe + (to.toe - from.toe) * w,
      };
    }
    from = to;
  }
  return { cant: from.cant, toe: from.toe };
};

const slideCache = new WeakMap<PreparedBlade, Float64Array>();

/**
 * How far the blade has leant out by height `h` (cm): the lean, tan(cant), added up
 * from the root, since with a slice's cant the lean changes up the blade and bends it.
 * Tabulated once per blade (Simpson's rule per step), read by interpolation.
 */
export const slideAt = (b: PreparedBlade, h: number): number => {
  let table = slideCache.get(b);
  const n = EDGE_SAMPLES;
  if (!table) {
    table = new Float64Array(n + 1);
    const lean = (z: number) =>
      Math.tan(twistAt(b.design, b.depth > 0 ? z / b.depth : 0).cant * DEG_TO_RAD);
    const dz = b.depth / n;
    for (let i = 1; i <= n; i++) {
      const z0 = (i - 1) * dz;
      table[i] = table[i - 1]! + (dz / 6) * (lean(z0) + 4 * lean(z0 + dz / 2) + lean(z0 + dz));
    }
    slideCache.set(b, table);
  }
  const f = Math.min(n, Math.max(0, (h / b.depth) * n));
  const i = Math.min(n - 1, Math.floor(f));
  return table[i]! + (table[i + 1]! - table[i]!) * (f - i);
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

/** What the swept loft needs per blade: its grid, each section's foil and path, and the tip. */
interface SweptBlade {
  readonly grid: SweepGrid;
  /** Per grid row: the foil laid along it, blended from the base foil to the tip foil. */
  readonly foils: readonly Foil[];
  /** The base and tip foils themselves: each row lays both on its thickness path (rowFaces). */
  readonly ends: readonly [Foil, Foil];
  /** Per grid row: how far from the base foil to the tip foil it is, 0 to 1. */
  readonly foilW: Float64Array;
  /** Per grid row: where the section is thickest (fraction along it). */
  readonly path: Float64Array;
  /** Per grid row up to the tip line: the height of that thickest point (cm). */
  readonly pathZ: Float64Array;
  /**
   * How far each row is along the sweep, base 0 to the tip edge 1, by the length of the
   * thickness path out to it and then on across the tip (to the tip line's row).
   */
  readonly sweepEta: Float64Array;
  /**
   * How much the thickness curve is read along the sweep rather than up the height, 0 to
   * 1: 0 on a fin whose thickness path runs up the blade, toward 1 the further it sweeps
   * back ({@link alongSweepOf}).
   */
  readonly alongSweep: number;
  /** The tip line's middle height, as a fraction of the depth. */
  readonly tipEta: number;
  /** The tip line's ends (tab frame, cm): leading-edge side, trailing-edge side. */
  readonly tipLine: readonly [
    { readonly x: number; readonly y: number },
    { readonly x: number; readonly y: number },
  ];
  /** Unit vector square to the tip line, toward the tip edge. */
  readonly tipNormal: { readonly x: number; readonly y: number };
  /**
   * How far the tip edge is from the tip line, square to it, at {@link TIP_REACH_SAMPLES}
   * + 1 points evenly along it (cm).
   */
  readonly tipReach: Float64Array;
}

const tipReachCache = new WeakMap<SweepGrid, Float64Array>();

/** Points along the tip line its distance to the tip edge is tabled at. */
const TIP_REACH_SAMPLES = 256;

/**
 * How far the tip edge is from each point of the tip line, square to it (see
 * {@link SweptBlade.tipReach}): the nearest crossing of the edge, or where the edge
 * doesn't cross (a hook curling back), the nearest point of it.
 */
const tipReach = (
  edge: readonly { x: number; y: number }[],
  s: { x: number; y: number },
  e: { x: number; y: number },
  n: { x: number; y: number },
): Float64Array => {
  const out = new Float64Array(TIP_REACH_SAMPLES + 1);
  for (let k = 0; k <= TIP_REACH_SAMPLES; k++) {
    const t = k / TIP_REACH_SAMPLES;
    const qx = s.x + (e.x - s.x) * t;
    const qy = s.y + (e.y - s.y) * t;
    let best = Infinity;
    let near = Infinity;
    for (let i = 1; i < edge.length; i++) {
      const a = edge[i - 1]!;
      const b = edge[i]!;
      near = Math.min(near, Math.hypot(b.x - qx, b.y - qy));
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = n.x * ey - n.y * ex;
      if (Math.abs(den) < 1e-15) continue;
      const ax = a.x - qx;
      const ay = a.y - qy;
      const along = (ax * ey - ay * ex) / den;
      const f = (ax * n.y - ay * n.x) / den;
      if (f >= -1e-9 && f <= 1 + 1e-9 && along > 1e-9) best = Math.min(best, along);
    }
    out[k] = Number.isFinite(best) ? best : near;
  }
  return out;
};

const sweptCache = new WeakMap<PreparedBlade, SweptBlade>();

/**
 * The sweep rows' foils hang only on the base and tip foils and the grid's shape, so
 * they are kept for those: outline, thickness and twist drags reuse them, and so do the
 * other blades of the same design (the 3D view's at the export minimum thickness).
 */
const rowFoilsCache = new WeakMap<FinSection, WeakMap<FinSection, Map<string, RowFoils>>>();

interface RowFoils {
  readonly foilW: Float64Array;
  readonly foils: readonly Foil[];
}

const rowFoils = (base: FinSection, tip: FinSection, rows: number, tipRow: number): RowFoils => {
  let byTip = rowFoilsCache.get(base);
  if (!byTip) rowFoilsCache.set(base, (byTip = new WeakMap()));
  let byGrid = byTip.get(tip);
  if (!byGrid) byTip.set(tip, (byGrid = new Map()));
  const key = `${rows}/${tipRow}`;
  const hit = byGrid.get(key);
  if (hit) return hit;
  const foilW = Float64Array.from({ length: rows }, (_, i) => smoother(Math.min(1, i / tipRow)));
  const made = {
    foilW,
    foils: Array.from({ length: rows }, (_, i) => blendFoils(base, tip, foilW[i]!)),
  };
  byGrid.set(key, made);
  return made;
};

const sweptBlade = (b: PreparedBlade): SweptBlade => {
  const hit = sweptCache.get(b);
  if (hit) return hit;
  const d = b.design;
  const grid = sweepGrid(d);
  const tip = tipFoilOf(d);
  const { foilW, foils } = rowFoils(d.section, tip, grid.rows, grid.tipRow);
  const path = new Float64Array(grid.rows);
  const way = thicknessPathOf(d);
  // Up to the tip line; past it the tip carries the tip line's foil out (sweepFaces).
  const pathZ = new Float64Array(grid.tipRow + 1);
  for (let i = 0; i <= grid.tipRow; i++) {
    path[i] = thicknessPathAt(way, i / grid.tipRow);
    pathZ[i] = sweepPointOn(grid, i, path[i]!).y;
  }
  const tipBase = grid.tipRow * grid.cols;
  const tipEnd = tipBase + grid.cols - 1;
  const ts = { x: grid.x[tipBase]!, y: grid.z[tipBase]! };
  const te = { x: grid.x[tipEnd]!, y: grid.z[tipEnd]! };
  const edge = sweepTipEdge(d);
  // Square to the tip line, on the tip edge's side.
  const len = Math.hypot(te.x - ts.x, te.y - ts.y) || 1;
  let normal = { x: -(te.y - ts.y) / len, y: (te.x - ts.x) / len };
  const mid = edge[Math.floor(edge.length / 2)]!;
  if ((mid.x - ts.x) * normal.x + (mid.y - ts.y) * normal.y < 0) {
    normal = { x: -normal.x, y: -normal.y };
  }
  // Depends only on the outline and tip line: kept with the sweep's grid.
  let reach = tipReachCache.get(grid);
  if (!reach) tipReachCache.set(grid, (reach = tipReach(edge, ts, te, normal)));
  // Along the sweep: the thickness path's length out to each row, then on across the tip
  // from its high point to the tip edge.
  const sweepEta = new Float64Array(grid.tipRow + 1);
  let run = 0;
  let prev = sweepPointOn(grid, 0, path[0]!);
  for (let i = 1; i <= grid.tipRow; i++) {
    const p = sweepPointOn(grid, i, path[i]!);
    run += Math.hypot(p.x - prev.x, p.y - prev.y);
    sweepEta[i] = run;
    prev = p;
  }
  const total = run + lerpTable(reach, path[grid.tipRow]!) || 1;
  for (let i = 0; i <= grid.tipRow; i++) sweepEta[i] = sweepEta[i]! / total;
  const baseFoil = pureFoil(d.section);
  const swept: SweptBlade = {
    grid,
    foils,
    // One foil when the tip foil is the base foil: rowFaces then reads it once.
    ends: [baseFoil, tip === d.section ? baseFoil : pureFoil(tip)],
    foilW,
    path,
    pathZ,
    sweepEta,
    alongSweep: alongSweepOf(run, pathZ[grid.tipRow]! - pathZ[0]!),
    tipEta: b.depth > 0 ? (grid.z[tipBase]! + grid.z[tipEnd]!) / 2 / b.depth : 1,
    tipLine: [ts, te],
    tipNormal: normal,
    tipReach: reach,
  };
  sweptCache.set(b, swept);
  return swept;
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

/**
 * How swept back a fin must be for its thickness curve to be read along the sweep (owner
 * testing: on a heavily swept-back fin the arm reaching back to the tip spans little
 * height, so read up the height it kept its full thickness to the tip line and then fell
 * to the minimum in the last 20 mm). Measured by the thickness path's rise over its
 * length: from {@link SWEEP_RISE_UPRIGHT} (and above) read by height, as every fin was,
 * to {@link SWEEP_RISE_SWEPT} (and below) read along the sweep, eased between. The default
 * fins and the owners' rise 0.75–0.79 over their path's length, so read by height exactly
 * as before; the owner's swept-back fin, 0.58.
 */
const SWEEP_RISE_UPRIGHT = 0.72;
const SWEEP_RISE_SWEPT = 0.55;

/** How much the thickness curve is read along the sweep (SweptBlade.alongSweep). */
const alongSweepOf = (length: number, rise: number): number => {
  if (!(length > 0)) return 0;
  const q = rise / length;
  return (
    1 -
    smoother(
      Math.min(1, Math.max(0, (q - SWEEP_RISE_SWEPT) / (SWEEP_RISE_UPRIGHT - SWEEP_RISE_SWEPT))),
    )
  );
};

/** How much a design's thickness curve is read along the sweep, 0 to 1 (alongSweep). */
export const thicknessAlongSweep = (d: FinDesign): number => sweptBlade(designBlade(d)).alongSweep;

/** How soft (cm) the turn in {@link rowThickness} is: about a millimetre. */
const THICKNESS_EASE = 0.1;

/**
 * How thick (cm) sweep row `i` is at height `z`. Read by height: the curve at the height
 * of the row's thickest point, thinning with the curve above it, never thicker below it.
 * Near the tip the sections slant steeply, so read at each point's own height the low end
 * of one came out much thicker than its thickest point (owner testing: a bulge along the
 * hook), and read at the thickest point's height the high end came out thicker than the
 * curve allows up there (a fuller curve fattened the tip). The turn between is eased over
 * {@link THICKNESS_EASE}, so the surface doesn't crease along the thickness path. Or, as
 * far as the fin sweeps back, by how far along the sweep the
 * row is ({@link SweptBlade.sweepEta}; past the tip line, `capV` of the way on to the tip
 * edge).
 */
const rowThickness = (b: PreparedBlade, sw: SweptBlade, i: number, z: number, capV = 0): number => {
  const peak = sw.pathZ[i]!;
  const d = z - peak;
  const h = d > 0 ? peak + (d * d) / (d + THICKNESS_EASE) : peak;
  const a = sw.alongSweep;
  if (!(a > 0)) return thicknessAt(b, h);
  const tip = sw.grid.tipRow;
  const along = i >= tip ? sw.sweepEta[tip]! + (1 - sw.sweepEta[tip]!) * capV : sw.sweepEta[i]!;
  return thicknessAt(b, h + a * (along * b.depth - h));
};

/**
 * Sweep row `i`'s faces at `along` (fraction of its length) and height `z`: its foil,
 * thickest on the thickness path, as thick as the thickness curve says there
 * (rowThickness) times the row's scale, and that times `round` (the tip's rounding).
 */
const rowFaces = (
  b: PreparedBlade,
  sw: SweptBlade,
  i: number,
  along: number,
  z: number,
  round: number,
  capV = 0,
): [number, number] => {
  const m = b.minThickness;
  const t = rowThickness(b, sw, i, z, capV);
  const k = Math.max(0, t - m) * round;
  // The base and tip foils each laid thickest on the path, as fractions of their thickest,
  // then blended. Blending the foils first and finding where the blend is thickest jumped
  // between rows where it had two humps nearly as high (owner testing: a base foil
  // thickest at 32% and a tip foil at 49%, a 1 mm step across the blade).
  const [fa, fb] = sw.ends;
  const w = sw.foilW[i]!;
  const read = (f: Foil): [number, number] => {
    if (!(f.thickest.thickness > 0)) return [0, 0];
    const [o, n] = f.shapeAt(foilFractionAt(along, sw.path[i]!, f.thickest.at));
    return [o / f.thickest.thickness, n / f.thickest.thickness];
  };
  const [oa, na] = read(fa);
  const [o, n] =
    w > 0 && fb !== fa
      ? (([ob, nb]) => [oa + (ob - oa) * w, na + (nb - na) * w])(read(fb))
      : [oa, na];
  const share = sw.foils[i]!.outsideShare;
  return [o * k + m * share, n * k - m * (1 - share)];
};

/**
 * The sweep's faces at (x, z) (tab frame, cm): each section's foil, read where the point
 * falls on it, or the tip past the tip line. Null off the sweep. `edge` marks a point on
 * the outline: the foils' edge there, except along the base, where a raised rear's
 * underside is the base's foil cut off, as thick as the foil there.
 *
 * **The tip** (owner's rules): out from each point of the tip line toward the tip edge,
 * the tip foil there rounds down along a quarter cosine, level at the tip line and down
 * to the minimum at the edge. So it is thickest at the tip foil's high point, rounds off
 * from there to the edge round the middle of the tip, and toward the tip line's ends is
 * the foil's own front and back halves. Level at the tip line, it meets the sweep with
 * no crease (owner testing: spokes from the high point met it at an angle along a long,
 * steep tip line, a square end to every cut crossing it).
 */
const sweepFaces = (
  b: PreparedBlade,
  sw: SweptBlade,
  x: number,
  z: number,
  cells: ReturnType<typeof cellsAtHeight>,
  edge: boolean,
): [number, number] | null => {
  const { grid } = sw;
  const hit = locateOnSweep(grid, x, z, cells);
  if (!hit) return null;
  const tip = grid.tipRow;
  if (hit.row > tip) {
    // Where the point is square to the tip line, and how far out toward the edge. The tip
    // line's sweep row is straight and evenly spaced, so that is its fraction along it.
    const [s, e] = sw.tipLine;
    const lx = e.x - s.x;
    const lz = e.y - s.y;
    const t = ((x - s.x) * lx + (z - s.y) * lz) / (lx * lx + lz * lz || 1);
    const tc = Math.min(1, Math.max(0, t));
    const dist = Math.hypot(x - (s.x + lx * tc), z - (s.y + lz * tc));
    const reach = lerpTable(sw.tipReach, tc);
    // On the tip edge itself, the minimum exactly.
    const v = edge || !(reach > 0) ? 1 : Math.min(1, dist / reach);
    return rowFaces(b, sw, tip, tc, z, v >= 1 ? 0 : Math.cos((Math.PI / 2) * v), v);
  }
  // Off the base, an edge is the foils' own edge: the minimum, where their faces meet
  // (on the chord line, or off it where an edge was moved to blend a twist).
  const onBase = hit.row < 1 && hit.along > 1e-3 && hit.along < 1 - 1e-3;
  const along = edge && !onBase ? (hit.along < 0.5 ? 0 : 1) : hit.along;
  const i0 = Math.min(tip - 1, Math.floor(hit.row));
  const a = hit.row - i0;
  const [o0, n0] = rowFaces(b, sw, i0, along, z, 1);
  const [o1, n1] = rowFaces(b, sw, i0 + 1, along, z, 1);
  return [o0 + (o1 - o0) * a, n0 + (n1 - n0) * a];
};

/** The fin without slices across the chord at `h` (cm): outside and inside faces at `u`. */
const sweptFacesAt = (
  b: PreparedBlade,
  sw: SweptBlade,
  h: number,
): ((u: number) => [number, number]) => {
  const { leading, trailing } = chordAt(b, h);
  const m = b.minThickness;
  const base = sw.foils[0]!;
  const cells = cellsAtHeight(sw.grid, h);
  // The edges are the minimum, except along the base (sweepFaces).
  return (u) =>
    sweepFaces(b, sw, leading + (trailing - leading) * u, h, cells, !(u > 0 && u < 1)) ?? [
      m * base.outsideShare,
      -m * (1 - base.outsideShare),
    ];
};

/**
 * The part of the chord at height `h` (cm) a slice there shapes, [from, to] (fractions,
 * 0 the leading edge): all of it, or the part short of the tip line where the chord
 * crosses it; the tip past it is the tip foil's (owner's rules). Empty above the tip
 * line, where the chord is all tip.
 */
const freeSpanAt = (b: PreparedBlade, grid: SweepGrid, h: number): [number, number] => {
  const { leading, trailing } = chordAt(b, Math.min(b.depth, Math.max(0, h)));
  const t0 = grid.tipRow * grid.cols;
  const t1 = t0 + grid.cols - 1;
  const s = { x: grid.x[t0]!, y: grid.z[t0]! };
  const e = { x: grid.x[t1]!, y: grid.z[t1]! };
  const inTip = (u: number) => {
    const hit = locateOnSweep(grid, leading + (trailing - leading) * u, h);
    return !!hit && hit.row > grid.tipRow;
  };
  const lo = Math.min(s.y, e.y);
  const hi = Math.max(s.y, e.y);
  if (h > lo && h < hi && trailing !== leading) {
    const x = s.x + ((e.x - s.x) * (h - s.y)) / (e.y - s.y);
    const at = Math.min(1, Math.max(0, (x - leading) / (trailing - leading)));
    // The tip is on the trailing edge's side of the crossing, unless the line leans the
    // other way.
    return inTip(at / 2) && !inTip((at + 1) / 2) ? [at, 1] : [0, at];
  }
  return h >= hi && inTip(0.5) ? [0, 0] : [0, 1];
};

/**
 * Chord stations a slice's reference is sampled at ({@link SliceRef}): bunched toward
 * the edges, where a rounded nose turns too fast for even spacing to follow.
 */
const SLICE_STATIONS = cosineStations(200);

/** How much of the chord, toward a thick edge, slices lay their own foil over (slicesAt). */
const SLICE_EDGE_FADE = 0.1;

/**
 * A slice measured against the fin without slices at its height. A slice is kept as the
 * difference between its foil and that, both as fractions of their thickest, so a slice
 * added as the fin's own section changes nothing, and the thickness curve, the tip line
 * and the sweep still shape the fin through it.
 */
interface SliceRef {
  /** The chord the slice shapes, [from, to] ({@link freeSpanAt}). */
  readonly free: readonly [number, number];
  /** The fin without slices at {@link SLICE_STATIONS}, less the minimum (cm). */
  readonly out: Float64Array;
  readonly ins: Float64Array;

  /** Their thickest across `free` (cm). */
  readonly thick: number;
  /** The slice's own thickest across `free`, in its foil's units. */
  readonly own: number;
  /** The thickness curve at the slice, less the minimum (cm). */
  readonly taper: number;
  /**
   * How much more of the minimum thickness the slice puts on the outside face than the
   * fin does there (cm): a symmetric slice on a flat-inside fin shares it half and half.
   */
  readonly shift: number;
  /** Its biggest change to the fin across `free`, either face (cm, at its height). */
  readonly most: number;
}

const sliceRefCache = new WeakMap<SweptBlade, (SliceRef | null)[]>();

/** Linear interpolation in a table sampled evenly over [0, 1]. */
const lerpTable = (t: Float64Array, u: number): number => {
  const n = t.length - 1;
  const f = Math.min(n, Math.max(0, u * n));
  const i = Math.min(n - 1, Math.floor(f));
  return t[i]! + (t[i + 1]! - t[i]!) * (f - i);
};

/** Linear interpolation in a table sampled at {@link SLICE_STATIONS}. */
const lerpStations = (t: Float64Array, u: number): number => {
  const st = SLICE_STATIONS;
  let lo = 0;
  let hi = st.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st[mid]! <= u) lo = mid;
    else hi = mid;
  }
  const f = Math.min(1, Math.max(0, (u - st[lo]!) / (st[hi]! - st[lo]! || 1)));
  return t[lo]! + (t[hi]! - t[lo]!) * f;
};

/** The slice foil less the fin there, at its chord fraction `u` (cm, outside and inside). */
const rawDiff = (r: SliceRef, sec: FinSection, u: number): [number, number] => {
  const [o, n] = sectionShapeAt(sec, u);
  const k = r.own > 0 ? r.thick / r.own : 0;
  return [o * k - lerpStations(r.out, u), n * k - lerpStations(r.ins, u)];
};

const sliceRef = (b: PreparedBlade, sw: SweptBlade, i: number): SliceRef | null => {
  let refs = sliceRefCache.get(sw);
  if (!refs) sliceRefCache.set(sw, (refs = []));
  if (refs[i] !== undefined) return refs[i]!;
  const sl = b.design.slices[i]!;
  const h = sl.height * b.depth;
  const free = freeSpanAt(b, sw.grid, h);
  let ref: SliceRef | null = null;
  if (free[1] - free[0] > 1e-3) {
    const m = b.minThickness;
    const s0 = sw.foils[0]!.outsideShare;
    const at = sweptFacesAt(b, sw, h);
    const out = new Float64Array(SLICE_STATIONS.length);
    const ins = new Float64Array(SLICE_STATIONS.length);
    let thick = 0;
    let own = 0;
    for (let k = 0; k < SLICE_STATIONS.length; k++) {
      const u = SLICE_STATIONS[k]!;
      const [o, n] = at(u);
      out[k] = o - m * s0;
      ins[k] = n + m * (1 - s0);
      if (u >= free[0] && u <= free[1]) {
        thick = Math.max(thick, out[k]! - ins[k]!);
        const [so, si] = sectionShapeAt(sl.section, u);
        own = Math.max(own, so - si);
      }
    }
    const part = {
      free,
      out,
      ins,

      thick,
      own,
      taper: Math.max(0, thicknessAt(b, h) - m),
      shift: m * (share(sl.section) - s0),
      most: 0,
    };
    let most = 0;
    for (const u of SLICE_STATIONS) {
      if (u < free[0] || u > free[1]) continue;
      const [o, n] = rawDiff(part, sl.section, u);
      most = Math.max(most, Math.abs(o), Math.abs(n));
    }
    ref = { ...part, most };
  }
  refs[i] = ref;
  return ref;
};

/**
 * How far from the tip line (a fraction of the depth: 5 mm on a 100 mm fin) the slices
 * fade out toward it (slicesAt), so a slice meets the tip, which is the tip foil's,
 * exactly. Squeezed into the part of each chord short of the tip line instead, a slice
 * changed sharply up a nearly level tip line, where that part shrinks to nothing within
 * a millimetre or so of height (the A4C, owner's rule 3).
 */
const SLICE_TIP_FADE = 0.05;

/**
 * The most a slice's fade toward the tip line may bend a face (rad per cm, 0.4° per mm):
 * the fade is drawn out until it bends the face no more than this, up to
 * {@link SLICE_TIP_FADE_MAX}. Over a fixed 5% of the depth, a slice 0.6 mm fuller than
 * the fin bent the face 0.4° more within a millimetre where a cut crossed the tip line, a
 * crease (owner testing, a hatchet with a slice at the tip line's lower end).
 */
const SLICE_TIP_BEND = 0.07;

/**
 * The longest a slice's fade toward the tip line gets (a fraction of the depth): longer,
 * a slice near the tip line no longer held its own foil at its own height (the hooked
 * hatchet's, 17% too thick at 95% of its chord over the slice's whole reach, 15%).
 */
const SLICE_TIP_FADE_MAX = 0.1;

/** How far in from each end of the tip line (a fraction of it) a longer fade eases in. */
const TIP_FADE_ENDS = 0.15;

/**
 * How far (cm) slice change `most` (cm) fades out over toward the tip line: long enough
 * that the fade (`smoother`, its bend at most 5.77 times its height over its length
 * squared) bends a face no more than {@link SLICE_TIP_BEND}, and at least
 * {@link SLICE_TIP_FADE} of the depth.
 */
const tipFadeLength = (depth: number, most: number): number =>
  Math.min(
    SLICE_TIP_FADE_MAX * depth,
    Math.max(SLICE_TIP_FADE * depth, Math.sqrt((5.77 * most) / SLICE_TIP_BEND)),
  );

/**
 * Slice `i`'s difference to the fin at its chord fraction `u` (cm, at its own height),
 * and its share of the minimum's ({@link SliceRef.shift}).
 */
const sliceDiff = (r: SliceRef, sec: FinSection, u: number): [number, number, number] => {
  const [o, n] = rawDiff(r, sec, u);
  return [o, n, r.shift];
};

/**
 * What the slices add to the fin across the chord at height `h` (cm), or null where they
 * add nothing: each slice's difference ({@link sliceDiff}), laid over the part of the
 * chord short of the tip line here, scaled with the thickness curve, blended between the
 * slices either side and weighted by {@link sliceWeight}.
 */
const slicesAt = (
  b: PreparedBlade,
  sw: SweptBlade,
  h: number,
): ((u: number) => [number, number]) | null => {
  const d = b.design;
  const sl = d.slices;
  const eta = b.depth > 0 ? h / b.depth : 0;
  const weight = sl.length ? sliceWeight(d, eta) : 0;
  if (!(weight > 0)) return null;
  // The slices either side, and how far from the lower to the upper (as foilAt).
  let k = 0;
  while (k < sl.length - 1 && eta >= sl[k + 1]!.height) k++;
  const parts: [number, number][] = [];
  if (k === sl.length - 1 || eta <= sl[k]!.height) parts.push([k, 1]);
  else {
    const w = smoother(Math.min(1, (eta - sl[k]!.height) / (sl[k + 1]!.height - sl[k]!.height)));
    parts.push([k, 1 - w], [k + 1, w]);
  }
  const [a, c] = freeSpanAt(b, sw.grid, h);
  if (!(c - a > 1e-6)) return null;
  const taper = Math.max(0, thicknessAt(b, h) - b.minThickness);
  // The shape scales with the thickness curve; the share of the minimum doesn't.
  const used = parts.flatMap(([i, w]) => {
    const r = sliceRef(b, sw, i);
    if (!(r && w > 0 && r.taper > 0)) return [];
    const k = taper / r.taper;
    return [{ r, sec: sl[i]!.section, w: w * weight, k, fade: tipFadeLength(b.depth, r.most) }];
  });
  if (!used.length) return null;
  // Where this height's edge is thicker than the minimum (a raised rear's underside),
  // toward it the slices lay their own foil, as a horizontal section does, rather than
  // add their difference: carried from a slice's height, that ran into the thick edge as
  // a cliff (the owner's A4C, a slice just over its corner).
  const swept = sweptFacesAt(b, sw, h);
  const m = b.minThickness;
  const s0 = sw.foils[0]!.outsideShare;
  const thickEdge = (u: number) => {
    const [o, n] = swept(u);
    return Math.min(1, Math.max(0, (o - n - m) / m));
  };
  const lead = thickEdge(0);
  const trail = thickEdge(1);
  /** How much the difference counts, against the slice's own foil: 1 clear of thick edges. */
  const asDiff = (u: number) =>
    (1 - lead * (1 - smoother(Math.min(1, u / SLICE_EDGE_FADE)))) *
    (1 - trail * (1 - smoother(Math.min(1, (1 - u) / SLICE_EDGE_FADE))));
  // How far each point is from the tip line: each slice fades out over the last of it,
  // the further the more it changes the fin (tipFadeLength).
  const { leading, trailing } = chordAt(b, h);
  const [ts, te] = sw.tipLine;
  const lx = te.x - ts.x;
  const lz = te.y - ts.y;
  const base = SLICE_TIP_FADE * b.depth;
  /**
   * How far a point is from the tip line, and how much of a slice's longer fade applies
   * there: all of it across the tip line, easing back to the plain fade toward its ends
   * and beyond them. Past an end, the distance runs down an edge, not across the tip line,
   * and a longer fade there reshaped the A4C's raised rear (its STEP fit 0.165 mm off).
   */
  const tipDist = (u: number): [number, number] => {
    const x = leading + (trailing - leading) * u;
    const raw = ((x - ts.x) * lx + (h - ts.y) * lz) / (lx * lx + lz * lz || 1);
    const t = Math.min(1, Math.max(0, raw));
    const inside = smoother(Math.min(1, Math.max(0, Math.min(raw, 1 - raw) / TIP_FADE_ENDS)));
    return [Math.hypot(x - (ts.x + lx * t), h - (ts.y + lz * t)), inside];
  };
  return (u) => {
    if (u < a || u > c) return [0, 0];
    const [dist, inside] = tipDist(u);
    if (!(dist > 0)) return [0, 0];
    const f = lead > 0 || trail > 0 ? asDiff(u) : 1;
    const [fo, fi] = f < 1 ? swept(u) : [0, 0];
    let o = 0;
    let n = 0;
    for (const { r, sec, w: w0, k, fade } of used) {
      const su = u;
      const w = w0 * smoother(Math.min(1, dist / (base + (fade - base) * inside)));
      const [dO, dI, shift] = sliceDiff(r, sec, su);
      let eo = dO * k + shift;
      let ei = dI * k + shift;
      if (f < 1) {
        // The slice's own foil here, less the fin.
        const [so, si] = sectionShapeAt(sec, su);
        const scale = r.own > 0 ? (r.thick / r.own) * k : 0;
        const ao = so * scale + m * s0 + r.shift - fo;
        const ai = si * scale - m * (1 - s0) + r.shift - fi;
        eo = eo * f + ao * (1 - f);
        ei = ei * f + ai * (1 - f);
      }
      o += eo * w;
      n += ei * w;
    }
    return [o, n];
  };
};

/** The tip line's height as a fraction of the depth (its middle). */
export const tipLineEta = (b: PreparedBlade): number => sweptBlade(b).tipEta;

/**
 * The part of the chord a slice at `eta` (fraction of the depth) shapes, [from, to]
 * (fractions, 0 the leading edge): all of it, or the part short of the tip line when the
 * chord crosses it. The rest is the tip's, shown locked in the slice's foil view.
 */
export const sliceFreeSpan = (d: FinDesign, eta: number): readonly [number, number] => {
  const b = designBlade(d);
  return freeSpanAt(b, sweepGrid(d), eta * b.depth);
};

/**
 * Where slice `index` (0-based) crosses the tip line, and the fin's faces there in the
 * slice foil's own units: the point to drag to scale the tip foil's thickness. Null if
 * its chord doesn't cross the tip line.
 */
export const sliceTipPoint = (
  d: FinDesign,
  index: number,
): { at: number; outside: number; inside: number } | null => {
  const sl = d.slices[index];
  if (!sl) return null;
  const b = designBlade(d);
  const sw = sweptBlade(b);
  const r = sliceRef(b, sw, index);
  if (!r) return null;
  const [a, c] = r.free;
  if (a <= 0 && c >= 1) return null;
  const at = a > 0 ? a : c;
  const k = r.thick > 0 ? r.own / r.thick : 0;
  return { at, outside: lerpStations(r.out, at) * k, inside: lerpStations(r.ins, at) * k };
};

/** Where a slice crosses the tip line, as each foil view shows it ({@link sliceTipCrossing}). */
export interface SliceTipCrossing {
  /** Chord fraction along the slice where it crosses the tip line. */
  readonly sliceAt: number;
  /** The tip there in the slice foil's units (its green reference dot). */
  readonly tipInSlice: { readonly outside: number; readonly inside: number };
  /** Chord fraction along the tip foil where the slice crosses it. */
  readonly tipAt: number;
  /** The slice there in the tip foil's units (the tip foil's aqua reference dot). */
  readonly sliceInTip: { readonly outside: number; readonly inside: number };
}

/**
 * Where slice `index` (0-based) crosses the tip line, in both foils (owner's rules): the
 * slice shapes its chord up to there and the tip foil the rest, so each foil view shows
 * the other's faces at the crossing as a reference dot, to match by hand. Null if its
 * chord doesn't cross the tip line.
 */
export const sliceTipCrossing = (d: FinDesign, index: number): SliceTipCrossing | null => {
  const sl = d.slices[index];
  const tp = sliceTipPoint(d, index);
  if (!sl || !tp) return null;
  const b = designBlade(d);
  const sw = sweptBlade(b);
  const r = sliceRef(b, sw, index)!;
  const h = sl.height * b.depth;
  const { leading, trailing } = chordAt(b, h);
  const x = leading + (trailing - leading) * tp.at;
  const [ts, te] = sw.tipLine;
  const lx = te.x - ts.x;
  const lz = te.y - ts.y;
  const tc = Math.min(
    1,
    Math.max(0, ((x - ts.x) * lx + (h - ts.y) * lz) / (lx * lx + lz * lz || 1)),
  );
  const tip = sw.grid.tipRow;
  const f = sw.foils[tip]!;
  // The tip foil's scale (cm per unit of its shape) there, as rowFaces lays it.
  const kTip =
    f.thickest.thickness > 0
      ? Math.max(0, rowThickness(b, sw, tip, h) - b.minThickness) / f.thickest.thickness
      : 0;
  const [so, si] = sectionShapeAt(sl.section, tp.at);
  const toCm = r.own > 0 ? r.thick / r.own : 0;
  return {
    sliceAt: tp.at,
    tipInSlice: { outside: tp.outside, inside: tp.inside },
    tipAt: foilFractionAt(tc, sw.path[tip]!, f.thickest.at),
    sliceInTip: {
      outside: kTip > 0 ? (so * toCm) / kTip : 0,
      inside: kTip > 0 ? (si * toCm) / kTip : 0,
    },
  };
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

const bladeShapeAt = (d: FinDesign, eta: number): BladeShape => {
  const b = designBlade(d);
  const sw = sweptBlade(b);
  const h = Math.min(b.depth, Math.max(0, eta * b.depth));
  const { leading, trailing } = chordAt(b, h);
  const chord = Math.abs(trailing - leading) || 1;
  const m = b.minThickness;
  const s0 = sw.foils[0]!.outsideShare;
  const base = sweptFacesAt(b, sw, h);
  const extra = slicesAt(b, sw, h);
  const us = FOIL_STATIONS;
  const out: number[] = [];
  const ins: number[] = [];
  for (const u of us) {
    const [o, i] = base(u);
    const [eo, ei] = extra ? extra(u) : [0, 0];
    out.push((o + eo - m * s0) / chord);
    ins.push((i + ei + m * (1 - s0)) / chord);
  }
  const symmetric = [d.section, tipFoilOf(d), ...d.slices.map((s) => s.section)].every(
    (s) => s.inside === null,
  );
  return { us, out, ins, free: freeSpanAt(b, sw.grid, h), symmetric };
};

/** Chord stations a section is sampled at to fit a foil to it. */
const FOIL_STATIONS = cosineStations(200);

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
 * The fin's horizontal section at `eta` (fraction of the depth) as a foil, chord
 * fractions both ways, less the minimum thickness: what a new slice starts as, so adding
 * it changes nothing (owner's rules). Fitted with as few points as follow it to within
 * FIT_TOLERANCE of its thickness, with a point where it crosses the tip line.
 */
export const bladeFoilAt = (d: FinDesign, eta: number): FinSection =>
  fitShape(bladeShapeAt(d, eta));

/**
 * How far (a fraction of its thickest, square to the face) a slice must differ from the
 * fin's section to count as reshaped: less is the fit's own error (FIT_TOLERANCE).
 */
const RESHAPED = 0.03;

const sliceEditsCache = new WeakMap<FinSlice, { o: Float64Array; i: Float64Array } | null>();

/**
 * What slice `index` has been reshaped by: its foil less the fin's section (without it)
 * at its height, both as fractions of their thickest, at FOIL_STATIONS, up to the tip
 * line. Null if it hasn't been. Cached per slice.
 */
const sliceEdits = (d: FinDesign, index: number): { o: Float64Array; i: Float64Array } | null => {
  const sl = d.slices[index]!;
  if (sliceEditsCache.has(sl)) return sliceEditsCache.get(sl)!;
  const others = { ...d, slices: d.slices.filter((_, j) => j !== index) };
  const fin = bladeShapeAt(others, sl.height);
  const n = fin.us.length;
  const finMax = Math.max(...fin.out.map((o, j) => o - fin.ins[j]!)) || 1;
  let own = 0;
  const shape = fin.us.map((u) => {
    const [o, i] = sectionShapeAt(sl.section, u);
    own = Math.max(own, o - i);
    return [o, i] as const;
  });
  const o = new Float64Array(n);
  const i = new Float64Array(n);
  // The faces' slopes there: a miss where a face is steep, as at the nose, is mostly height.
  const slopeOf = (ys: readonly number[], j: number): number => {
    const a = Math.max(0, j - 1);
    const b = Math.min(n - 1, j + 1);
    return (ys[b]! - ys[a]!) / (fin.us[b]! - fin.us[a]! || 1);
  };
  let most = 0;
  fin.us.forEach((u, j) => {
    if (u < fin.free[0] || u > fin.free[1]) return; // the tip's: never the slice's
    o[j] = shape[j]![0] / (own || 1) - fin.out[j]! / finMax;
    i[j] = shape[j]![1] / (own || 1) - fin.ins[j]! / finMax;
    most = Math.max(
      most,
      Math.abs(o[j]!) / Math.hypot(1, slopeOf(fin.out, j)),
      Math.abs(i[j]!) / Math.hypot(1, slopeOf(fin.ins, j)),
    );
  });
  const edits = most > RESHAPED ? { o, i } : null;
  sliceEditsCache.set(sl, edits);
  return edits;
};

/**
 * Slice `index`'s foil moved to `eta` (owner's rules: dragging a slice repositions it,
 * as the horizontal analysis cut moves): the fin's own section there, and whatever the
 * slice was reshaped by at its old height on top, as fractions of the thickest. A slice
 * not reshaped comes out as the fin's section at its new height.
 */
export const sliceFoilMovedTo = (d: FinDesign, index: number, eta: number): FinSection => {
  const others = { ...d, slices: d.slices.filter((_, j) => j !== index) };
  const at = bladeShapeAt(others, eta);
  const edits = sliceEdits(d, index);
  if (!edits) return fitShape(at);
  const max = Math.max(...at.out.map((o, j) => o - at.ins[j]!));
  return fitShape({
    ...at,
    out: at.out.map((o, j) => o + edits.o[j]! * max),
    ins: at.ins.map((v, j) => v + edits.i[j]! * max),
    // A symmetric slice stays symmetric, the faces either side of its chord line alike.
    symmetric: d.slices[index]!.section.inside === null,
  });
};

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
 * The horizontal section of the blade at height `h` (cm above the tab top): the swept
 * loft's thickness field (swept-loft.ts) read along the chord there, with what the
 * slices add ({@link slicesAt}).
 */
export const bladeSection = (
  b: PreparedBlade,
  h: number,
  stations: readonly number[] = DEFAULT_CHORD_STATIONS,
): BladeSection => {
  const { leading, trailing } = chordAt(b, h);
  const thickness = thicknessAt(b, h);
  const m = b.minThickness;
  const sw = sweptBlade(b);
  const eta = b.depth > 0 ? h / b.depth : 0;
  const swept = sweptFacesAt(b, sw, h);
  const extra = slicesAt(b, sw, h);
  const faces = (u: number): [number, number] => {
    const [out, ins] = swept(u);
    if (!extra) return [out, ins];
    const [o, n] = extra(u);
    return [out + o, ins + n];
  };
  const { outside: lamOut, inside: lamIn } = b.laminate;
  const lam = lamOut + lamIn;
  const offsets = stations.map((u) => {
    let [out, ins] = faces(u);
    if (lam > 0) {
      // The core: each face in by its laminate. Under the minimum, the face with less
      // laminate makes up the shortfall, so a laminated face stays true.
      const short = Math.max(0, m - (out - ins - lam));
      out += short * (lamIn / lam) - lamOut;
      ins += lamIn - short * (lamOut / lam);
    }
    return [out, ins] as const;
  });

  const turn = toeTurn(b);
  // Cant and toe here: the fin's own, unless a slice changes them (twistAt).
  const tw = hasTwist(b.design) ? twistAt(b.design, eta) : null;
  const slide = tw ? slideAt(b, h) : h * b.lean;
  const widen = tw ? 1 / Math.cos(tw.cant * DEG_TO_RAD) : b.widen;
  // A slice's own toe turns its section about its centre, before the fin's toe.
  const own = tw && tw.toe !== (b.design.toe ?? 0) ? tw.toe - (b.design.toe ?? 0) : 0;
  let pivot: { x: number; y: number; cos: number; sin: number } | null = null;
  if (own) {
    // About its centre of area, the faces' midpoint weighted by thickness along the chord:
    // that moves smoothly up the blade. The thickest point didn't: on a flat-topped foil it
    // ran across a seventh of the chord in 3 mm of height, back and forth, and the turn
    // about it stepped the section sideways (owner testing: grooves up a slice's toe,
    // 0.07 mm deep, in the STEP too).
    let area = 0;
    let ux = 0;
    let my = 0;
    stations.forEach((u, j) => {
      const du =
        (stations[Math.min(stations.length - 1, j + 1)]! - stations[Math.max(0, j - 1)]!) / 2;
      const [o, n] = offsets[j]!;
      const w = (o - n) * du;
      area += w;
      ux += u * w;
      my += ((o + n) / 2) * w;
    });
    const u = area > 0 ? ux / area : 0.5;
    const mid = area > 0 ? my / area : 0;
    const a = -b.outward * own * DEG_TO_RAD;
    pivot = {
      x: leading + (trailing - leading) * u,
      y: b.outward * (slide + mid * widen),
      cos: Math.cos(a),
      sin: Math.sin(a),
    };
  }
  const at = (x0: number, offset: number): Vert3 => {
    let x = x0;
    let y = b.outward * (slide + offset * widen);
    if (pivot) {
      const dx = x - pivot.x;
      const dy = y - pivot.y;
      x = pivot.x + dx * pivot.cos - dy * pivot.sin;
      y = pivot.y + dx * pivot.sin + dy * pivot.cos;
    }
    if (!turn) return { x, y, z: h };
    // Toe: turned about the upright axis through the root's thickest point.
    const dx = x - turn.x;
    const dy = y - turn.y;
    return {
      x: turn.x + dx * turn.cos - dy * turn.sin,
      y: turn.y + dx * turn.sin + dy * turn.cos,
      z: h,
    };
  };
  const outside: Vert3[] = [];
  const inside: Vert3[] = [];
  stations.forEach((u, j) => {
    const x = leading + (trailing - leading) * u;
    outside.push(at(x, offsets[j]![0]));
    inside.push(at(x, offsets[j]![1]));
  });
  return {
    height: h,
    leadingX: leading,
    trailingX: trailing,
    thickness,
    stations,
    outside,
    inside,
  };
};
