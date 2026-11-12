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
 * that straight line.
 *
 * The kernel reads the same tangent as the fit where three things hold. The panel it is
 * handed (`panelCurve`) is ended on the same half as the fit ends it, mirrored the same way
 * for a deck. It is ended for the blend the kernel builds, measured in the section's plane
 * (`builtWidth`). And the kernel's one-sided slope at the band edge reaches less far inboard
 * than `panelLead`, so it lies on the straight end. They do not hold where `railLaws` narrows a
 * band to the local feature size, nor between the rows of a sampled panel field, which is
 * interpolated.
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
  /** Height of the half's apex, the last sample the fit keeps, in true heights on a deck too. */
  readonly apex: number;
  /**
   * Worst gap between the section and the panel and blend that replace it, cm, and never less
   * than the farthest a sample the fit drops falls back from the last sample it keeps (an
   * undercut; a vertical piece counts nothing).
   */
  readonly gap: number;
}

/**
 * Where a half's band edge goes, walking in from the apex. `slope`: where the half has come
 * down to this many degrees above level. `turn`: where it has come back to within this many
 * degrees of the direction of the panel just inboard, which is where it stops turning; a
 * panel's own slope (a vee, a roll, a concave) does not move that, and a crease is found by
 * itself, because the turn drops to nothing across it. Under `turn` the figure is never more
 * than `TRIM.turnShare` of the turn at the apex, and a half steeper than `TRIM.panelSteepest`
 * is still turning.
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
  /**
   * The farthest a dropped sample falls back from the last sample kept before it, cm (that
   * sample's `y` minus the dropped one's, never negative): how far the half misses an undercut,
   * which no fit to the half can see. A sample straight above or below the last kept one is on
   * the wall the half already has, and counts nothing.
   */
  readonly dropped: number;
}

function makeHalf(pts: ArrayLike<number>, up: 1 | -1): Half {
  const count = pts.length >> 1;
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const arc = new Float64Array(count);
  let n = 0;
  let dropped = 0;
  for (let i = 0; i < count; i++) {
    const py = pts[2 * i]!;
    const pz = up * pts[2 * i + 1]!;
    if (n > 0 && py <= y[n - 1]!) {
      dropped = Math.max(dropped, y[n - 1]! - py);
      continue;
    }
    y[n] = py;
    z[n] = pz;
    arc[n] = n === 0 ? 0 : arc[n - 1]! + Math.hypot(py - y[n - 1]!, pz - z[n - 1]!);
    n++;
  }
  return { n, y: y.subarray(0, n), z: z.subarray(0, n), arc: arc.subarray(0, n), dropped };
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
 * A crease of the half between `from` and `to` cm in from the wall (`from` not included), as a
 * distance in from the wall, or -1: the innermost one, or the `nearest` the wall.
 *
 * A crease is a turn that is all in one place. A tight curve turns as far over a millimetre
 * and a half, but it turns evenly, so across a third of that length it shows a third of the
 * turn; a crease shows nearly all of it. The test passes along a short run of arc either side
 * of a crease, and the crease is placed at the middle of that run.
 */
function creaseBetween(h: Half, from: number, to: number, nearest = false): number {
  const yA = h.y[h.n - 1]!;
  // a run that starts or ends just outside the range is still found whole
  const end = arcAt(h, Math.max(0, yA - from)) + TRIM.creaseBase;
  let start = -1;
  let found = -1;
  for (let a = arcAt(h, Math.max(0, yA - to)) - TRIM.creaseBase; a <= end; a += TRIM.creaseStep) {
    const wide = turnAcross(h, a, TRIM.creaseBase);
    const hit =
      wide >= TRIM.edgeJump && turnAcross(h, a, TRIM.creaseTight) >= TRIM.creaseShare * wide;
    if (hit) {
      if (start < 0) start = a;
      if (a + TRIM.creaseStep <= end) continue;
    }
    if (start < 0) continue;
    pointAt(h, h.arc, (start + (hit ? a : a - TRIM.creaseStep)) / 2, P);
    start = -1;
    const w = yA - P[0]!;
    if (w <= from || w > to) continue;
    if (!nearest) return w;
    found = w;
  }
  return found;
}

/**
 * The panel's end for a blend `width` cm wide, and its direction there.
 *
 * It ends just short of the band edge, so that the kernel, which reads a panel's slope a hair
 * inboard of the band edge, reads the straight stretch. The end never sits in a crease's
 * wobble: a crease within `panelClear` of it moves it that far inboard of the crease. And the
 * stretch its direction is read over is clean: a crease further inboard, within that stretch,
 * shortens it to the part clear of the crease, so a bevel facet between two creases is read
 * as itself. Only a facet too short to leave `panelBaseMin` of clean stretch is given up, and
 * the end moves inboard of it too.
 *
 * Over a full `panelBase` the direction is the end slope of a least-squares parabola, so a
 * panel that is curving (a deck rolling into its rail) is read as truly as a flat one. Over a
 * short stretch a parabola's end slope follows the kinks of the sampled section, and the slope
 * of a least-squares line does not: the direction is the line's, moved towards the parabola's
 * in proportion to the stretch's share of `panelBase`. On a flat facet both are exact; on a
 * curving one the line reads the direction at the middle of the stretch.
 */
function panelEnd(h: Half, width: number): PanelEnd {
  let reach = width + TRIM.panelLead;
  let crease = false;
  let base: number = TRIM.panelBase;
  for (let pass = 0; pass < TRIM.creasePasses; pass++) {
    const near = creaseBetween(
      h,
      reach - TRIM.panelClear + TRIM.creaseApart,
      reach + TRIM.panelClear,
    );
    if (near >= 0) {
      reach = near + TRIM.panelClear;
      crease = true;
      continue;
    }
    const next = creaseBetween(h, reach, reach + TRIM.panelBase + TRIM.panelClear, true);
    if (next < 0) break;
    const clean = next - TRIM.panelClear - reach;
    if (clean >= TRIM.panelBaseMin) {
      base = Math.min(base, clean);
      break;
    }
    reach = next + TRIM.panelClear;
    crease = true;
  }
  const y = Math.max(0, h.y[h.n - 1]! - reach);
  const z = heightAt(h, y);
  if (y < base) base = y;
  // a panel that ends at the stringer has no stretch to read
  if (base <= TRIM.tiny) return { y, z, slope: 0, crease };
  // least squares of z = a + b u (+ c u^2) over even samples u in [-1, 0] of the stretch, the
  // stretch scaled to unit length so the normal equations are the same whatever its length
  const k = TRIM.panelSamples;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let r0 = 0;
  let r1 = 0;
  let r2 = 0;
  for (let i = 0; i < k; i++) {
    const u = -(k - 1 - i) / (k - 1);
    const zz = heightAt(h, y + base * u) - z;
    s1 += u;
    s2 += u * u;
    s3 += u * u * u;
    s4 += u * u * u * u;
    r0 += zz;
    r1 += zz * u;
    r2 += zz * u * u;
  }
  // both determinants are fixed positive numbers: `panelSamples` is at least 3
  const line = (k * r1 - s1 * r0) / (k * s2 - s1 * s1);
  const det = k * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  const parabola =
    (k * (r1 * s4 - s3 * r2) - r0 * (s1 * s4 - s3 * s2) + s2 * (s1 * r2 - r1 * s2)) / det;
  // the parabola's share grows with the stretch, so the slope does not jump as a crease moves
  // into or out of the stretch
  const share = base / TRIM.panelBase;
  return { y, z, slope: (line + share * (parabola - line)) / base, crease };
}

/**
 * The band edge of a half under `rule`, as a width in from the wall: the first place, walking
 * in from the apex, where the rule's angle has come down to its figure. Where it never does
 * within the share of the half a band may take, or the walk runs out of panel to read the
 * inboard direction from, the band edge is where the walk stopped: the widest band the half
 * allows, so a section a little rounder than one that has a band edge gets a band a little
 * wider, never a hard edge.
 *
 * Under the 'slope' rule a half whose apex is already no steeper than the figure is a hard
 * edge. Under the 'turn' rule the figure is never more than `turnShare` of the turn at the
 * apex, so a half that turns up only a little still gets a band over where it turns, and that
 * band changes little as the turn grows or shrinks; only a turn under `turnFloor` is a hard
 * edge, and there a band and a hard edge differ by little: under a hundredth of a millimetre
 * on a curl a centimetre long.
 */
function bandEdge(h: Half, rule: BandRule): number {
  const n = h.n;
  const yA = h.y[n - 1]!;
  const widest = TRIM.fitWidest * yA;
  const angle = (a: number, figure: number): number | null => {
    const here = directionAt(h, a, TRIM.turnBase, TRIM.turnBase);
    if (rule.by === 'slope') return here;
    if (a - TRIM.turnRefNear <= 0) return null;
    pointAt(h, h.arc, a - TRIM.turnRefFar, P);
    pointAt(h, h.arc, a - TRIM.turnRefNear, Q);
    const turn = here - Math.atan2(Q[1]! - P[1]!, Q[0]! - P[0]!) * DEG;
    // on a tall rail the stretch just inboard is rail too, and straight: the turn is nothing
    // there, and it is not panel. Only where the half is no steeper than a panel may be.
    return Math.max(turn, here - TRIM.panelSteepest + figure);
  };
  const first = angle(h.arc[n - 1]!, rule.degrees);
  if (first === null) return widest;
  let figure: number = rule.degrees;
  if (rule.by === 'slope') {
    if (first <= figure) return 0;
  } else {
    if (first < TRIM.turnFloor) return 0;
    figure = Math.min(rule.degrees, TRIM.turnShare * first);
  }
  let outer = angle(h.arc[n - 1]!, figure)!;
  for (let i = n - 2; i >= 1; i--) {
    if (yA - h.y[i]! > widest) return widest;
    const here = angle(h.arc[i]!, figure);
    if (here === null) return yA - h.y[i]!;
    if (here <= figure) {
      // the crossing lies between this sample and the one outboard of it
      const f = outer > here ? (figure - here) / (outer - here) : 0;
      pointAt(h, h.arc, h.arc[i]! + f * (h.arc[i + 1]! - h.arc[i]!), P);
      return yA - P[0]!;
    }
    outer = here;
  }
  return Math.min(widest, yA - h.y[0]!);
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

/** The worst gap between two sets of polylines, each point measured against the nearest of the other set. */
function gapAcross(a: readonly Curve[], b: readonly Curve[]): number {
  const nearest = (py: number, pz: number, cs: readonly Curve[]): number =>
    Math.min(...cs.map((c) => toCurve(py, pz, c)));
  let worst = 0;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const c of from) {
      for (let i = 0; i < c.n; i++) worst = Math.max(worst, nearest(c.y[i]!, c.z[i]!, to));
    }
  }
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

/** A half's panel ended for a blend `width` cm wide, and where its straight end meets the band edge and the wall. */
interface Band {
  readonly panel: PanelEnd;
  /** The band edge, on the panel's straight end. */
  readonly ye: number;
  readonly ze: number;
  /** Height at which the panel's own tangent meets the wall. */
  readonly wall: number;
}

function bandOn(h: Half, width: number): Band {
  const yA = h.y[h.n - 1]!;
  const panel = panelEnd(h, width);
  const ye = yA - width;
  return {
    panel,
    ye,
    ze: panel.z + panel.slope * (ye - panel.y),
    wall: panel.z + panel.slope * (yA - panel.y),
  };
}

/** A polyline for a blend of `steps` segments that starts at the panel's end. */
function blendFrom(panel: PanelEnd, steps: number): Curve {
  const blend: Curve = {
    n: steps + 2,
    y: new Float64Array(steps + 2),
    z: new Float64Array(steps + 2),
  };
  blend.y[0] = panel.y;
  blend.z[0] = panel.z;
  return blend;
}

/**
 * Fills `blend` after its first point with the conic from the band edge, via `shoulder` on the
 * wall at `yA`, to `apex` on the wall, as `solid.ts` builds a strip.
 */
function fillBlend(
  blend: Curve,
  band: Band,
  yA: number,
  shoulder: number,
  apex: number,
  rho: number,
): void {
  const steps = blend.n - 2;
  const w = rho / (1 - rho);
  for (let j = 0; j <= steps; j++) {
    const t = j / steps;
    const s = 1 - t;
    const den = s * s + 2 * w * s * t + t * t;
    const k0 = (s * s) / den;
    const k1 = (2 * w * s * t) / den;
    const k2 = (t * t) / den;
    blend.y[j + 1] = k0 * band.ye + (k1 + k2) * yA;
    blend.z[j + 1] = k0 * band.ze + k1 * shoulder + k2 * apex;
  }
}

/**
 * The best blend from a band edge `width` in from the wall, or `null` when the panel's own
 * tangent meets the wall too close to the apex, or above it, for a blend to stand on.
 */
function fitAt(h: Half, width: number): HalfRail | null {
  const yA = h.y[h.n - 1]!;
  const zA = h.z[h.n - 1]!;
  const band = bandOn(h, width);
  const { panel, wall } = band;
  const rise = zA - wall;
  // the panel's own tangent has to meet the wall below the apex, or there is no wall to blend on
  if (rise <= TRIM.fitRiseMin) return null;
  const section = sectionFrom(h, panel.y);
  const blend = blendFrom(panel, TRIM.fitBlendSteps);
  const gapOf = (shoulder: number, rho: number): number => {
    fillBlend(blend, band, yA, shoulder, zA, rho);
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
    return { width, rho: r.x, wall, shoulder, panel, apex: zA, gap: r.value };
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

/**
 * A hard edge: the panel carried to the wall, with no blend. Its panel is ended for the
 * narrowest blend the kernel builds, `narrowest` cm in the section's plane, so the kernel reads
 * its slope on the same straight stretch.
 */
function hardEdge(h: Half, narrowest: number): HalfRail {
  const yA = h.y[h.n - 1]!;
  const zA = h.z[h.n - 1]!;
  const panel = panelEnd(h, narrowest);
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
    apex: zA,
    gap: gapBetween(sectionFrom(h, panel.y), made),
  };
}

function fitMirrored(h: Half, rule: BandRule, narrowest: number): HalfRail {
  if (h.n < 3) return hardEdge(h, narrowest);
  const width = bandEdge(h, rule);
  // a band edge at the apex itself: the panel runs to the wall
  if (width < TRIM.fitNoBlend) return hardEdge(h, narrowest);
  // no blend stands on a panel whose tangent meets the wall at or above the apex
  return fitAt(h, Math.max(width, narrowest)) ?? hardEdge(h, narrowest);
}

/**
 * The rail of one half of a section. `pts` is `[y0, z0, y1, z1, …]` in the section's plane,
 * from the stringer out to the apex; `up` is 1 on a bottom, where the apex is above the
 * panel, and -1 on a deck. `narrowest` is the narrowest blend the kernel builds, in the
 * section's plane (`builtWidth(0, cosPhi)`): a band edge closer to the apex is fitted at that
 * width, and a hard edge's panel is ended for it.
 */
export function fitHalf(
  pts: ArrayLike<number>,
  up: 1 | -1,
  rule: BandRule,
  narrowest: number = TRIM.bandMin,
): HalfRail {
  const h = makeHalf(pts, up);
  const fit = fitMirrored(h, rule, narrowest);
  const f = { ...fit, gap: Math.max(fit.gap, h.dropped) };
  if (up === 1) return f;
  return {
    ...f,
    wall: -f.wall,
    shoulder: -f.shoulder,
    apex: -f.apex,
    panel: { ...f.panel, z: -f.panel.z, slope: -f.panel.slope },
  };
}

/**
 * The panel of one half as a height over the distance from the stringer, given the width of
 * its blend in the section's plane (`builtWidth`): the section itself as far as the panel's
 * end, its own tangent from there on. `up` is as `fitHalf` takes it; the panel is ended on the
 * half as `fitHalf` reads it, and the heights are true ones.
 */
export function panelCurve(
  pts: ArrayLike<number>,
  up: 1 | -1,
  width: number,
): (y: number) => number {
  const h = makeHalf(pts, up);
  const end = panelEnd(h, Math.max(0, width));
  return (y) => up * (y <= end.y ? heightAt(h, y) : end.z + end.slope * (y - end.y));
}

/**
 * The cosine of the angle between the outline and the stringer, as a section is read at it.
 * A section nearly tangent to the outline sees a band many times wider than it is; it is read
 * as one at `skewMin`.
 */
const skewOf = (cosPhi: number): number => Math.max(TRIM.skewMin, cosPhi);

/**
 * The width, in a section's plane, of the blend the kernel builds for a band `width` cm wide
 * square to the outline: never narrower than `bandMin`, and seen wider by a section that cuts
 * the outline at an angle with cosine `cosPhi`.
 */
export const builtWidth = (width: number, cosPhi: number): number =>
  Math.max(TRIM.bandMin, width) / skewOf(cosPhi);

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
  const cos = skewOf(cosPhi);
  const narrowest = builtWidth(0, cos);
  const b = fitHalf(bottom, 1, rules.bottom, narrowest);
  const d = fitHalf(deck, -1, rules.deck, narrowest);
  const zA = b.apex;
  const tuck = b.width * cos;
  const band = d.width * cos;
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

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * How far the rail the kernel builds from `recipe` stands off a section, cm. `bottom`, `deck`
 * and `cosPhi` are as `sectionRail` takes them. It is the worst gap, over both halves, between
 * the section from the panel's end out to the apex and what replaces it: the panel's straight
 * end to the band edge, then the blend to the kernel's apex; and never less than the farthest
 * a sample that doubles back lies from the half kept. Each half's panel is the one
 * `panelCurve` gives for its blend's `builtWidth`, and the blends, shoulders and apex are built
 * and limited as `solid.ts` and `railLaws` do at one loop sample, in the section's plane. Left
 * out: the limit the local feature size sets on a band, and the opening of a wall shorter
 * than `TRIM.wallMin`.
 */
export function recipeGap(
  bottom: ArrayLike<number>,
  deck: ArrayLike<number>,
  recipe: RailRecipe,
  cosPhi: number,
): number {
  const b = makeHalf(bottom, 1);
  const d = makeHalf(deck, -1);
  // widths as the kernel builds them, square to the outline, and in the section's plane
  const tuck = Math.max(TRIM.bandMin, recipe.tuck);
  const band = Math.max(TRIM.bandMin, recipe.band);
  const bb = bandOn(b, builtWidth(recipe.tuck, cosPhi));
  const db = bandOn(d, builtWidth(recipe.band, cosPhi));
  // the apex in true heights; the deck half's are mirrored
  const apex = clamp(recipe.apex, TRIM.apexInset, 1 - TRIM.apexInset);
  const za = bb.wall + apex * (-db.wall - bb.wall);
  /** One half's section past its panel's end, and the panel end and blend that replace it, in that half's heights. */
  const halfOf = (h: Half, hb: Band, width: number, edge: number, rho: number, top: number) => {
    // an edge's shoulder slides along the wall towards the apex, never past it
    const shoulder = Math.min(
      hb.wall + width * Math.tan(edge / DEG),
      top - TRIM.edgeShort * (top - hb.wall),
    );
    const made = blendFrom(hb.panel, TRIM.fitBlendSteps);
    fillBlend(made, hb, h.y[h.n - 1]!, shoulder, top, clamp(rho, TRIM.rhoInset, 1 - TRIM.rhoInset));
    return { section: sectionFrom(h, hb.panel.y), made };
  };
  const lower = halfOf(b, bb, tuck, recipe.bottomEdge, recipe.tuckShape, za);
  const upper = halfOf(d, db, band, recipe.deckEdge, recipe.hardness, -za);
  // the deck back to true heights
  upper.section.z.forEach((z, i) => (upper.section.z[i] = -z));
  upper.made.z.forEach((z, i) => (upper.made.z[i] = -z));
  // measured across both halves: where the kernel's apex is not the section's, the wall between
  // the two is the other half's blend
  const gap = gapAcross([lower.section, upper.section], [lower.made, upper.made]);
  return Math.max(gap, b.dropped, d.dropped);
}
