// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The blade of a fin as one B-spline surface, for STEP (docs/design/fin-designer.md,
 * step 5). `@openshaper/export`'s `fin-step.ts` encodes it; this module only fits it.
 *
 * ## Shape
 *
 * One bicubic surface wrapped around the blade, closed in u, plus two flat caps:
 *
 * ```
 * u: around the section — outside face LE→TE, trailing-edge cap, inside face TE→LE,
 *    leading-edge cap, back to the start. Row 0 and the last row are the same data,
 *    so the surface closes on a seam.
 * v: up the blade, from the root on the tab top (z = 0) to just under the tip.
 * ```
 *
 * The minimum thickness (0.5 mm in the design) gives the blade blunt edges, so each section is a
 * closed loop with four corners: the ends of the two edge caps. Those are creases
 * (`uBreaks`): C0 there, smooth everywhere else. Corners in the outline or the taper
 * crease along v the same way (`vBreaks`).
 *
 * Why one wrapped surface rather than four faces: every edge it shares with itself
 * or a cap is the surface's own boundary curve, so the shell is watertight by
 * construction, as for the board (see docs/design/step-export.md).
 *
 * ## The tip
 *
 * Sections stop {@link BladeSurfaceOptions.tipGap} below the tip, or higher where the
 * chord there is longer than `FIN_TIP_CAP` (`bladeTop`), and a flat cap closes the
 * blade there. A surface pinched to a point is legal STEP but a common cause of import
 * failures. The cap is a sliver at most 1 mm long and the minimum thickness wide; the
 * CNC cutter rounds it. (Under a rounded top a fixed gap left it 8 mm long on the keel,
 * a flat in the top edge in CAD.)
 *
 * ## Accuracy
 *
 * The fit interpolates its grid exactly. Between grid points it is measured, not
 * assumed: {@link bladeSurfaceDeviation} slices the surface at heights between rows
 * and measures how far it strays from the true section there. The grid is refined
 * until that is within {@link BladeSurfaceOptions.tolerance} (0.05 mm).
 *
 * What remains is in the last fraction of a millimetre under the tip, at the edge
 * corners, where the chord closes faster than a smooth surface can follow: about
 * 0.08 mm on the default fins, against 0.03 mm everywhere below. Tests hold the whole
 * blade to {@link BLADE_CI_TOLERANCE} and all but the top 0.5% to the fit target.
 * The ceiling is the board STEP's (docs/design/step-export.md): CNC finishing passes
 * leave 0.1–0.5 mm.
 */
import {
  evalSurface,
  interpolateSurface,
  type BSplineSurface,
  type SurfaceFitOptions,
} from '../bspline-surface';
import type { Vert3 } from '../loft';
import {
  bladeSection,
  bladeTop,
  bladeRowHeights,
  outlineFeatureHeights,
  bladeTravel,
  cosineStations,
  prepareBlade,
  type BladeSection,
  type FinLaminate,
  type PreparedBlade,
} from './blade';
import type { FinDesign } from './fin-design';

export interface BladeSurfaceOptions {
  /** Height rows on the first pass. */
  readonly rows?: number;
  /** Chord stations per face on the first pass. */
  readonly stations?: number;
  /** How closely the surface must follow the blade (cm). */
  readonly tolerance?: number;
  /** How far below the tip the sections stop at most (cm); see `bladeTop`. */
  readonly tipGap?: number;
  /** Refinement passes after the first. */
  readonly maxRefinements?: number;
  /** Fit the blade as the core under this laminate (blade.ts). */
  readonly laminate?: FinLaminate;
  /** Thinnest the blade gets (cm); the design minimum by default (blade.ts). */
  readonly minThickness?: number;
}

export const BLADE_DEFAULTS = {
  rows: 24,
  stations: 32,
  tolerance: 0.005,
  tipGap: 0.01,
  maxRefinements: 4,
} as const;

/** What tests hold the whole blade to (cm): the board STEP's CI ceiling. */
export const BLADE_CI_TOLERANCE = 0.015;

/** Points added along each blunt edge cap, between its two corners. */
const CAP_INTERIOR = 2;

export interface BladeSurfaceModel {
  /** u around the section (closed: the first and last rows coincide), v up the blade. */
  readonly surface: BSplineSurface;
  /** Height of the root cap (the tab top): 0. */
  readonly rootZ: number;
  /** Height of the tip cap (cm). */
  readonly topZ: number;
  /** Row indices along u where the section has a corner (edge-cap ends). */
  readonly corners: readonly number[];
  /** Measured worst distance from the blade between grid points (cm). */
  readonly deviation: number;
  /** The grid size of the accepted fit: [rows along u, columns along v]. */
  readonly grid: readonly [number, number];
}

const lerp3 = (a: Vert3, b: Vert3, t: number): Vert3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/**
 * One section as a closed loop: outside LE→TE, the trailing-edge cap, inside TE→LE,
 * the leading-edge cap, ending on its first point again.
 */
export const sectionLoop = (s: Pick<BladeSection, 'outside' | 'inside'>): Vert3[] => {
  const n = s.outside.length - 1;
  const cap = (a: Vert3, b: Vert3): Vert3[] =>
    Array.from({ length: CAP_INTERIOR }, (_, i) => lerp3(a, b, (i + 1) / (CAP_INTERIOR + 1)));
  return [
    ...s.outside,
    ...cap(s.outside[n]!, s.inside[n]!),
    ...[...s.inside].reverse(),
    ...cap(s.inside[0]!, s.outside[0]!),
    s.outside[0]!,
  ];
};

/** Corner row indices of a {@link sectionLoop} with `n + 1` stations per face. */
const loopCorners = (n: number): number[] => {
  const teOut = n;
  const teIn = teOut + CAP_INTERIOR + 1;
  const leIn = teIn + n;
  return [teOut, teIn, leIn];
};

/**
 * Heights where the taper has a corner: the thickness kinks right across the section,
 * so the surface creases there. Corners in the outline don't crease it: the foil sweep
 * fades a corner within a few sections (swept-loft.ts), so only the edge itself has
 * the corner, and a crease all the way round would draw a line across the blade (round 2
 * testing).
 */
const creaseHeights = (b: PreparedBlade, topZ: number): number[] => {
  const d = b.design;
  const hs = d.taper.knots
    .slice(1, -1)
    .filter((k) => !k.continuous)
    .map((k) => k.end.x * b.depth);
  return [...new Set(hs)].filter((h) => h > 0 && h < topZ).sort((p, q) => p - q);
};

/**
 * Row heights from the root to `topZ`: each strip between creases gets rows in
 * proportion to how far the edges travel along it (at least 4, enough for a cubic),
 * spaced evenly along that travel ({@link bladeRowHeights}), so a stretch where an edge
 * runs nearly level, and the tip, get rows to match.
 */
const rowHeights = (
  b: PreparedBlade,
  creases: readonly number[],
  topZ: number,
  rows: number,
): { heights: number[]; breaks: number[] } => {
  const bounds = [0, ...creases, topZ];
  const travel = (lo: number, hi: number) => bladeTravel(b, hi) - bladeTravel(b, lo);
  const total = travel(0, topZ);
  const heights: number[] = [0];
  const breaks: number[] = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const lo = bounds[s]!;
    const hi = bounds[s + 1]!;
    const n = Math.max(3, Math.round((rows * travel(lo, hi)) / total));
    heights.push(...bladeRowHeights(b, lo, hi, n).slice(1));
    if (s < bounds.length - 2) breaks.push(heights.length - 1);
  }
  return { heights, breaks };
};

/** Chord stations added at each edge (cosineStations leaves the last 0.2% to one step). */
const EDGE_STATIONS = [
  1e-4, 3e-4, 6e-4, 1e-3, 2e-3, 0.998, 0.999, 0.9992, 0.9994, 0.9996, 0.9998, 0.9999,
];

/** Offsets (cm) of the extra rows either side of an outline point's height. */
const CORNER_ROWS = [0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4];

/**
 * Rows packed tightly around each outline point's height. The surface stays smooth
 * there, so the fit has to turn the edge's corner or tight bend between rows: packing
 * them keeps that turn within a fraction of a millimetre of it. Creases (`breaks`) are
 * kept.
 */
const withEdgeCornerRows = (
  at: { heights: number[]; breaks: number[] },
  corners: readonly number[],
): { heights: number[]; breaks: number[] } => {
  const top = at.heights[at.heights.length - 1]!;
  const creases = at.breaks.map((i) => at.heights[i]!);
  // The root too: where a raised rear's underside leaves the base, the trailing edge
  // turns as sharply as at any corner.
  const extra = [
    ...CORNER_ROWS,
    ...corners.flatMap((c) => [c, ...CORNER_ROWS.flatMap((o) => [c - o, c + o])]),
  ];
  const heights = [...new Set([...at.heights, ...extra.filter((h) => h > 0 && h < top)])].sort(
    (p, q) => p - q,
  );
  // Drop rows closer than the tightest offset to a neighbour, but never a crease, and
  // never the top: a row that crowds it gives way instead.
  const kept: number[] = [];
  for (const h of heights) {
    const last = kept[kept.length - 1];
    if (last === undefined || h - last >= CORNER_ROWS[0]! * 0.99 || creases.includes(h)) {
      kept.push(h);
    } else if (h === top) {
      kept[creases.includes(last) ? kept.length : kept.length - 1] = h;
    }
  }
  return { heights: kept, breaks: creases.map((z) => kept.indexOf(z)) };
};

const fitOnce = (
  b: PreparedBlade,
  topZ: number,
  rows: number,
  stations: number,
): { surface: BSplineSurface; corners: number[]; grid: [number, number] } => {
  const { heights, breaks } = withEdgeCornerRows(
    rowHeights(b, creaseHeights(b, topZ), topZ, rows),
    outlineFeatureHeights(b, topZ),
  );
  // Stations packed into the last of the chord at each edge: a squared-off foil falls to
  // the edge within a fraction of a percent of it (the A4C's, 5 mm in 0.07%), and the fit
  // has to turn that between stations.
  const st = [...new Set([...cosineStations(stations), ...EDGE_STATIONS])].sort((p, q) => p - q);
  // grid[r][c]: r around the section (u), c up the blade (v).
  const loops = heights.map((h) => sectionLoop(bladeSection(b, h, st)));
  const grid = loops[0]!.map((_, r) => loops.map((loop) => loop[r]!));
  const corners = loopCorners(st.length - 1);
  // Parameters along the blade by how far the edges travel (as the rows are spaced), not
  // averaged over every point of the section: most barely move where an edge runs nearly
  // level, and would outvote it.
  const t0 = bladeTravel(b, heights[0]!);
  const span = bladeTravel(b, heights[heights.length - 1]!) - t0;
  const vParams = heights.map((h, i) =>
    i === 0 ? 0 : i === heights.length - 1 ? 1 : (bladeTravel(b, h) - t0) / span,
  );
  const opts: SurfaceFitOptions = { uBreaks: corners, vBreaks: breaks, vParams };
  const fitted = interpolateSurface(grid, opts);
  // The loop starts and ends on the same point, but the solve reproduces its two ends
  // only to rounding (~1e-15 cm). Close the seam exactly: STEP shares its edge.
  const ctrl = fitted.ctrl.slice();
  ctrl[ctrl.length - 1] = ctrl[0]!;
  const surface = { ...fitted, ctrl };
  return { surface, corners, grid: [grid.length, heights.length] };
};

const distToPolyline = (p: Vert3, poly: readonly Vert3[]): number => {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]!;
    const c = poly[i + 1]!;
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
};

/** v along the row at `u` where the surface is at height `z` (z rises with v). */
const vAtHeight = (s: BSplineSurface, u: number, z: number): number => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (evalSurface(s, u, mid).z < z) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/**
 * Worst horizontal distance between the surface and the true blade, sampled at
 * `slices` heights strictly between the root and `upTo`·`topZ`, and `around` points
 * per slice. The truth is a finely sampled section at the same height.
 *
 * A sampled estimate, not a bound: the worst error sits in narrow spikes at the
 * section corners, and a different sampling finds a little more.
 */
export const bladeSurfaceDeviation = (
  b: PreparedBlade,
  surface: BSplineSurface,
  topZ: number,
  slices = 23,
  around = 157,
  upTo = 1,
): number => {
  const fine = cosineStations(800);
  let worst = 0;
  // Spaced like the rows (along the edges' travel), at the odd steps, so the slices
  // fall between grid rows rather than on them.
  const steps = bladeRowHeights(b, 0, upTo * topZ, 2 * (slices + 1));
  for (let i = 1; i < steps.length - 1; i += 2) {
    const z = steps[i]!;
    const truth = sectionLoop(bladeSection(b, z, fine));
    for (let j = 0; j < around; j++) {
      const u = (j + 0.5) / around;
      const p = evalSurface(surface, u, vAtHeight(surface, u, z));
      worst = Math.max(worst, distToPolyline(p, truth));
    }
  }
  return worst;
};

/**
 * Fit the blade of a valid design (see `validateFinDesign`). Refines the grid until
 * the measured deviation is within tolerance, keeping the best pass.
 */
export const fitBladeSurface = (
  d: FinDesign,
  opts: BladeSurfaceOptions = {},
): BladeSurfaceModel => {
  const o = { ...BLADE_DEFAULTS, ...opts };
  const b = prepareBlade(d, o.laminate, o.minThickness);
  const topZ = bladeTop(b, o.tipGap);
  let rows = o.rows;
  let stations = o.stations;
  let best: BladeSurfaceModel | null = null;
  for (let pass = 0; pass <= o.maxRefinements; pass++) {
    const fit = fitOnce(b, topZ, rows, stations);
    const deviation = bladeSurfaceDeviation(b, fit.surface, topZ);
    if (!best || deviation < best.deviation) {
      best = { ...fit, rootZ: 0, topZ, deviation };
    }
    if (deviation <= o.tolerance) break;
    rows = Math.round(rows * 1.5);
    stations = Math.round(stations * 1.5);
  }
  return best!;
};
