// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail of one section, in the kernel's own terms (docs/design/trim-blend-plan.md,
 * "Converting a sections board").
 *
 * A half section runs from the stringer out to the apex. Somewhere along it the panel ends
 * and the rail begins. This finds that place, and the one blend that replaces everything
 * outboard of it, built the way `solid.ts` builds a rail: from a band edge on the panel to
 * the apex on the wall, with its shoulder on the wall between the two.
 *
 * Where the shoulder sits is measured from the point the panel's own tangent meets the wall.
 * A blend is up to a few centimetres wide, so a degree of error in that tangent is half a
 * millimetre on the wall, and a sampled section cannot give its direction to a degree at a
 * crease: its last half millimetre wobbles. So a panel ends a hair short of its band edge
 * where the section is smooth there, and a millimetre short of a crease where it is not; its
 * direction is read over a length of clean panel before that; and from there on the panel is
 * that straight line. The fit and the kernel then read the same tangent, because the panel
 * they are both given has exactly one.
 *
 * Where the band edge goes is decided by the shape of the section alone, so that it moves
 * smoothly along a board whose sections change smoothly: a band line that jumps from one
 * station to the next cannot be interpolated, and cannot be edited either. And a blend leaves
 * its panel at an angle only where the section itself has a crease there. A smooth rail comes
 * out tangent.
 */
import { TRIM } from '../params';
import type { RailRecipe } from './rails';

const DEG = 180 / Math.PI;

/** Where a panel stops following its section, and the slope it carries on at to the wall. */
export interface PanelEnd {
  /** Distance from the stringer, cm. */
  readonly y: number;
  readonly z: number;
  /** Rise per cm outward. */
  readonly slope: number;
  /** The panel was ended short of a crease. Only then may a blend leave it at an angle. */
  readonly crease: boolean;
}

/** The rail of one half of a section. */
export interface HalfRail {
  /** Width of the blend in the section's plane, cm. Zero: the panel runs to the wall, a hard edge. */
  readonly width: number;
  /** The blend's rho. */
  readonly rho: number;
  /** Height at which the panel's own tangent meets the wall. */
  readonly wall: number;
  /** Height of the blend's shoulder on the wall. At `wall` the blend leaves the panel tangent. */
  readonly shoulder: number;
  readonly panel: PanelEnd;
  /** Worst gap between the section and the panel and blend that replace it, cm. */
  readonly gap: number;
}

/**
 * Where a half's band edge goes, walking in from the apex. `slope`: where the half has come
 * down to this many degrees above level. `turn`: where it has come back to within this many
 * degrees of the direction of the panel just inboard, which is where it stops turning; a
 * panel's own slope (a vee, a roll, a concave) does not move that, and a crease is found by
 * itself, because the turn drops to nothing across it.
 */
export interface BandRule {
  readonly by: 'slope' | 'turn';
  readonly degrees: number;
}

/**
 * A half section with the samples that double back dropped, so `y` rises strictly. On a deck
 * `z` is mirrored, so the apex is above the panel on either half.
 */
interface Half {
  readonly n: number;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Distance along the half from the stringer. */
  readonly arc: Float64Array;
}

function makeHalf(pts: ArrayLike<number>, up: 1 | -1): Half {
  const count = pts.length >> 1;
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const arc = new Float64Array(count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const py = pts[2 * i]!;
    if (n > 0 && py <= y[n - 1]!) continue;
    y[n] = py;
    z[n] = up * pts[2 * i + 1]!;
    arc[n] = n === 0 ? 0 : arc[n - 1]! + Math.hypot(py - y[n - 1]!, z[n]! - z[n - 1]!);
    n++;
  }
  return { n, y: y.subarray(0, n), z: z.subarray(0, n), arc: arc.subarray(0, n) };
}

/** Index of the span of the rising array `a` that holds `v`. */
function spanOf(a: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The half at `v` of `along` (its `y` or its `arc`), into `out` as `[y, z]`. */
function pointAt(h: Half, along: Float64Array, v: number, out: Float64Array): void {
  if (h.n < 2) {
    out[0] = h.n === 1 ? h.y[0]! : 0;
    out[1] = h.n === 1 ? h.z[0]! : 0;
    return;
  }
  const k = spanOf(along, h.n, v);
  const d = along[k + 1]! - along[k]!;
  const f = d > 0 ? Math.min(1, Math.max(0, (v - along[k]!) / d)) : 0;
  out[0] = h.y[k]! + f * (h.y[k + 1]! - h.y[k]!);
  out[1] = h.z[k]! + f * (h.z[k + 1]! - h.z[k]!);
}

const P = new Float64Array(2);
const Q = new Float64Array(2);

const heightAt = (h: Half, y: number): number => {
  pointAt(h, h.y, y, P);
  return P[1]!;
};

/** Direction of the half at arc `a`, degrees above level, read from `before` behind it to `after` ahead. */
function directionAt(h: Half, a: number, before: number, after: number): number {
  pointAt(h, h.arc, a - before, P);
  pointAt(h, h.arc, a + after, Q);
  return Math.atan2(Q[1]! - P[1]!, Q[0]! - P[0]!) * DEG;
}

/** Distance along the half at distance `y` from the stringer. */
const arcAt = (h: Half, y: number): number => {
  if (h.n < 2) return 0;
  const k = spanOf(h.y, h.n, y);
  const d = h.y[k + 1]! - h.y[k]!;
  const f = d > 0 ? Math.min(1, Math.max(0, (y - h.y[k]!) / d)) : 0;
  return h.arc[k]! + f * (h.arc[k + 1]! - h.arc[k]!);
};

/** How far the half turns towards its apex at arc `a`, degrees, measured across `base` of arc either side. */
const turnAcross = (h: Half, a: number, base: number): number =>
  directionAt(h, a, 0, base) - directionAt(h, a, base, 0);

/**
 * The innermost crease of the half between `from` and `to` cm in from the wall (`from` not
 * included), as a distance in from the wall, or -1.
 *
 * A crease is a turn that is all in one place. A tight curve turns as far over a millimetre
 * and a half, but it turns evenly, so across a third of that length it shows a third of the
 * turn; a crease shows nearly all of it.
 */
function creaseBetween(h: Half, from: number, to: number): number {
  const yA = h.y[h.n - 1]!;
  const end = arcAt(h, yA - from);
  for (let a = arcAt(h, Math.max(0, yA - to)); a < end; a += TRIM.creaseStep) {
    const wide = turnAcross(h, a, TRIM.creaseBase);
    if (wide < TRIM.edgeJump) continue;
    if (turnAcross(h, a, TRIM.creaseTight) < TRIM.creaseShare * wide) continue;
    pointAt(h, h.arc, a, P);
    const w = yA - P[0]!;
    if (w > from) return w;
  }
  return -1;
}

/**
 * The panel's end for a blend `width` cm wide. It ends just short of the band edge, so that
 * the kernel, which reads a panel's slope a hair inboard of the band edge, reads the straight
 * stretch; and clear of any crease near it, so the panel its direction is read over is clean.
 * That direction is the end slope of a parabola through that stretch of panel, so a panel
 * that is curving (a deck rolling into its rail) is read as truly as a flat one.
 */
function panelEnd(h: Half, width: number): PanelEnd {
  let reach = width + TRIM.panelLead;
  let crease = false;
  for (let pass = 0; pass < TRIM.creasePasses; pass++) {
    const c = creaseBetween(h, reach - TRIM.panelClear + TRIM.creaseApart, reach + TRIM.panelBase);
    if (c < 0) break;
    reach = c + TRIM.panelClear;
    crease = true;
  }
  const y = Math.max(0, h.y[h.n - 1]! - reach);
  const z = heightAt(h, y);
  const base = Math.min(TRIM.panelBase, y);
  if (base <= TRIM.tiny) return { y, z, slope: 0, crease };
  // least squares of z = a + b t + c t^2 over even samples of the base, t measured from the end
  const k = TRIM.panelSamples;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let r0 = 0;
  let r1 = 0;
  let r2 = 0;
  for (let i = 0; i < k; i++) {
    const tt = (-base * (k - 1 - i)) / (k - 1);
    const zz = heightAt(h, y + tt) - z;
    s1 += tt;
    s2 += tt * tt;
    s3 += tt * tt * tt;
    s4 += tt * tt * tt * tt;
    r0 += zz;
    r1 += zz * tt;
    r2 += zz * tt * tt;
  }
  // Cramer's rule on the normal equations [[k s1 s2] [s1 s2 s3] [s2 s3 s4]] (a b c) = (r0 r1 r2)
  const det = k * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) <= TRIM.tiny)
    return { y, z, slope: (z - heightAt(h, y - base)) / base, crease };
  const slope =
    (k * (r1 * s4 - s3 * r2) - r0 * (s1 * s4 - s3 * s2) + s2 * (s1 * r2 - r1 * s2)) / det;
  return { y, z, slope, crease };
}

/**
 * The band edge of a half under `rule`, as a width in from the wall: the first place, walking
 * in from the apex, where the rule's angle has come down to its figure. `null` when it never
 * does within the share of the half a band may take.
 */
function bandEdge(h: Half, rule: BandRule): number | null {
  const n = h.n;
  const yA = h.y[n - 1]!;
  const widest = TRIM.fitWidest * yA;
  const angle = (a: number): number | null => {
    const here = directionAt(h, a, TRIM.turnBase, TRIM.turnBase);
    if (rule.by === 'slope') return here;
    if (a - TRIM.turnRefNear <= 0) return null;
    pointAt(h, h.arc, a - TRIM.turnRefFar, P);
    pointAt(h, h.arc, a - TRIM.turnRefNear, Q);
    const turn = here - Math.atan2(Q[1]! - P[1]!, Q[0]! - P[0]!) * DEG;
    // on a tall rail the stretch just inboard is rail too, and straight: the turn is nothing
    // there, and it is not panel. Only where the half is no steeper than a panel may be.
    return Math.max(turn, here - TRIM.panelSteepest + rule.degrees);
  };
  let outer = angle(h.arc[n - 1]!);
  if (outer === null) return null;
  if (outer <= rule.degrees) return 0;
  for (let i = n - 2; i >= 1; i--) {
    if (yA - h.y[i]! > widest) return null;
    const here = angle(h.arc[i]!);
    if (here === null) return null;
    if (here <= rule.degrees) {
      // the crossing lies between this sample and the one outboard of it
      const f = outer > here ? (rule.degrees - here) / (outer - here) : 0;
      pointAt(h, h.arc, h.arc[i]! + f * (h.arc[i + 1]! - h.arc[i]!), P);
      return yA - P[0]!;
    }
    outer = here;
  }
  return null;
}

/** A polyline as two arrays. */
interface Curve {
  n: number;
  readonly y: Float64Array;
  readonly z: Float64Array;
}

/** The section from the panel's cut out to the apex, thinned to a spacing the gap is measured at. */
function sectionFrom(h: Half, cutY: number): Curve {
  const y = new Float64Array(h.n + 1);
  const z = new Float64Array(h.n + 1);
  y[0] = cutY;
  z[0] = heightAt(h, cutY);
  let n = 1;
  for (let i = 0; i < h.n; i++) {
    if (h.y[i]! <= cutY) continue;
    const last = i === h.n - 1;
    if (!last && Math.hypot(h.y[i]! - y[n - 1]!, h.z[i]! - z[n - 1]!) < TRIM.fitSpacing) continue;
    y[n] = h.y[i]!;
    z[n] = h.z[i]!;
    n++;
  }
  return { n, y, z };
}

/** Square of the distance from a point to a polyline. */
function toCurve(py: number, pz: number, c: Curve): number {
  if (c.n === 1) return (py - c.y[0]!) ** 2 + (pz - c.z[0]!) ** 2;
  let best = Infinity;
  for (let i = 0; i + 1 < c.n; i++) {
    const ay = c.y[i]!;
    const az = c.z[i]!;
    const ey = c.y[i + 1]! - ay;
    const ez = c.z[i + 1]! - az;
    const ee = ey * ey + ez * ez;
    const f = ee > 0 ? Math.min(1, Math.max(0, ((py - ay) * ey + (pz - az) * ez) / ee)) : 0;
    const dy = py - ay - f * ey;
    const dz = pz - az - f * ez;
    const d = dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return best;
}

/** The worst gap between two polylines, each measured against the other. */
function gapBetween(a: Curve, b: Curve): number {
  let worst = 0;
  for (let i = 0; i < a.n; i++) worst = Math.max(worst, toCurve(a.y[i]!, a.z[i]!, b));
  for (let i = 0; i < b.n; i++) worst = Math.max(worst, toCurve(b.y[i]!, b.z[i]!, a));
  return Math.sqrt(worst);
}

/** Minimum of `f` on `[a, b]` by golden section. */
function golden(
  f: (x: number) => number,
  a: number,
  b: number,
  steps: number,
): { x: number; value: number } {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < steps; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return fc < fd ? { x: c, value: fc } : { x: d, value: fd };
}

/** The best blend from a band edge `width` in from the wall, or `null` when none can be built there. */
function fitAt(h: Half, width: number): HalfRail | null {
  const yA = h.y[h.n - 1]!;
  const zA = h.z[h.n - 1]!;
  const panel = panelEnd(h, width);
  // a panel that has turned further than this is rail, not panel
  if (Math.abs(Math.atan(panel.slope)) * DEG > TRIM.panelSteepest) return null;
  const ye = yA - width;
  const ze = panel.z + panel.slope * (ye - panel.y);
  const wall = panel.z + panel.slope * (yA - panel.y);
  const rise = zA - wall;
  // the panel's own tangent has to meet the wall below the apex, or there is no wall to blend on
  if (rise <= TRIM.fitRiseMin) return null;
  const section = sectionFrom(h, panel.y);
  const steps = TRIM.fitBlendSteps;
  const blend: Curve = {
    n: steps + 2,
    y: new Float64Array(steps + 2),
    z: new Float64Array(steps + 2),
  };
  blend.y[0] = panel.y;
  blend.z[0] = panel.z;
  const gapOf = (shoulder: number, rho: number): number => {
    const w = rho / (1 - rho);
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      const s = 1 - t;
      const den = s * s + 2 * w * s * t + t * t;
      const k0 = (s * s) / den;
      const k1 = (2 * w * s * t) / den;
      const k2 = (t * t) / den;
      blend.y[j + 1] = k0 * ye + (k1 + k2) * yA;
      blend.z[j + 1] = k0 * ze + k1 * shoulder + k2 * zA;
    }
    return gapBetween(section, blend);
  };
  const at = (frac: number): HalfRail => {
    const shoulder = wall + frac * rise;
    const r = golden(
      (rho) => gapOf(shoulder, rho),
      TRIM.rhoInset,
      1 - TRIM.rhoInset,
      TRIM.fitRhoSteps,
    );
    return { width, rho: r.x, wall, shoulder, panel, gap: r.value };
  };
  const tangent = at(0);
  // an edge needs a crease
  if (!panel.crease) return tangent;
  const ladder = [0, ...TRIM.fitShoulders];
  let best = tangent;
  let rung = 0;
  for (let k = 1; k < ladder.length; k++) {
    const f = at(ladder[k]!);
    if (f.gap < best.gap) {
      best = f;
      rung = k;
    }
  }
  // the shoulder between the best rung's neighbours
  const lo = ladder[Math.max(0, rung - 1)]!;
  const hi = ladder[Math.min(ladder.length - 1, rung + 1)]!;
  const fine = golden((frac) => at(frac).gap, lo, hi, TRIM.fitShoulderSteps);
  if (fine.value < best.gap) best = at(fine.x);
  // an edge has to earn its place: the blend leaves tangent unless an edge is clearly closer
  return tangent.gap - best.gap < TRIM.fitEdgeGain ? tangent : best;
}

/** A hard edge: the panel carried to the wall, with no blend. */
function hardEdge(h: Half): HalfRail {
  const yA = h.y[h.n - 1]!;
  const zA = h.z[h.n - 1]!;
  const panel = panelEnd(h, 0);
  const wall = panel.z + panel.slope * (yA - panel.y);
  const made: Curve = {
    n: 3,
    y: Float64Array.of(panel.y, yA, yA),
    z: Float64Array.of(panel.z, wall, zA),
  };
  return {
    width: 0,
    rho: 0.5,
    wall,
    shoulder: wall,
    panel,
    gap: gapBetween(sectionFrom(h, panel.y), made),
  };
}

function fitMirrored(h: Half, rule: BandRule): HalfRail {
  if (h.n < 3) return hardEdge(h);
  const width = bandEdge(h, rule);
  // no band edge, or one at the apex itself: the panel runs to the wall
  if (width === null || width < TRIM.fitNoBlend) return hardEdge(h);
  return fitAt(h, width) ?? hardEdge(h);
}

/**
 * The rail of one half of a section. `pts` is `[y0, z0, y1, z1, …]` in the section's plane,
 * from the stringer out to the apex; `up` is 1 on a bottom, where the apex is above the
 * panel, and -1 on a deck.
 */
export function fitHalf(pts: ArrayLike<number>, up: 1 | -1, rule: BandRule): HalfRail {
  const f = fitMirrored(makeHalf(pts, up), rule);
  if (up === 1) return f;
  return {
    ...f,
    wall: -f.wall,
    shoulder: -f.shoulder,
    panel: { ...f.panel, z: -f.panel.z, slope: -f.panel.slope },
  };
}

/**
 * The panel of one half as a height over the distance from the stringer, given the width of
 * its blend: the section itself as far as the panel's end, its own tangent from there on.
 */
export function panelCurve(pts: ArrayLike<number>, width: number): (y: number) => number {
  const h = makeHalf(pts, 1);
  const end = panelEnd(h, Math.max(0, width));
  return (y) => (y <= end.y ? heightAt(h, y) : end.z + end.slope * (y - end.y));
}

/**
 * The rules a conversion uses. A bottom's band reaches in to where the bottom stops turning,
 * because the turn belongs to the rail. A deck never stops turning, so its band starts where
 * the deck has rolled to a set slope.
 */
export const BAND_RULES: { readonly bottom: BandRule; readonly deck: BandRule } = {
  bottom: { by: 'turn', degrees: TRIM.bottomTurn },
  deck: { by: 'slope', degrees: TRIM.deckSlope },
};

/** A section's rail: the kernel's seven numbers, and the two fits they came from. */
export interface SectionRail {
  readonly recipe: RailRecipe;
  readonly bottom: HalfRail;
  readonly deck: HalfRail;
}

/**
 * The rail of a section, from its bottom half and its deck half (each from the stringer out
 * to the apex). `cosPhi` is the cosine of the angle between the outline and the stringer at
 * the section: a band is measured square to the outline, and a section cuts it at that angle.
 */
export function sectionRail(
  bottom: ArrayLike<number>,
  deck: ArrayLike<number>,
  cosPhi: number,
  rules: { readonly bottom: BandRule; readonly deck: BandRule } = BAND_RULES,
): SectionRail {
  const b = fitHalf(bottom, 1, rules.bottom);
  const d = fitHalf(deck, -1, rules.deck);
  const zA = bottom[bottom.length - 1]!;
  const tuck = b.width * cosPhi;
  const band = d.width * cosPhi;
  const edge = (rise: number, run: number): number =>
    run > 0 ? Math.max(0, Math.atan2(rise, run) * DEG) : 0;
  const span = d.wall - b.wall;
  return {
    recipe: {
      band,
      hardness: d.rho,
      tuck,
      tuckShape: b.rho,
      bottomEdge: edge(b.shoulder - b.wall, tuck),
      deckEdge: edge(d.wall - d.shoulder, band),
      apex: span > TRIM.tiny ? Math.min(1, Math.max(0, (zA - b.wall) / span)) : 0.5,
    },
    bottom: b,
    deck: d,
  };
}
