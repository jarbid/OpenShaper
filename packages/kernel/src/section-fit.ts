// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A cross-section at an arbitrary station that is fit to be **stored and edited**.
 *
 * `loftCrossSection` answers "what shape is the board here" and answers it at 96 knots,
 * which is right for anything that draws or measures the surface and wrong for anything
 * a person then has to drag. Inserting a station is the second kind: the whole point of
 * adding one is to get a handful of control points to pull on, and a profile carrying
 * ninety-six of them is not an editable station, it is a wall of dots.
 *
 * ## Why not just keep the control-point blend
 *
 * Because `insertCrossSection` promises the board does not change shape when a station is
 * added, and with the blend that promise is false. Measured on the golden longboard with
 * a different rail preset at each station, inserting a blended section moved the lofted
 * surface — the one the 3D view and the STL show — by up to **4.59 mm**. The user asks
 * for a handle and silently gets a different board.
 *
 * ## Why not just fit everything
 *
 * Because in the ordinary case the blend is not merely good, it is **exact**. Where the
 * two bracketing stations carry the same profile, blending them returns that profile
 * unchanged, at its own five or six knots — and that is most boards most of the time.
 * Replacing it with a fit would trade an exact answer at five control points for an
 * approximate one at more.
 *
 * So: measure first, and fit only where the blend has actually gone wrong. The board pays
 * for the fix exactly where the bug is.
 *
 * ## The fit
 *
 * Knots go on the curvature-biased {@link ringFractions} ladder, which is where the shape
 * needs them, and each knot's tangent DIRECTION is read off the lofted curve. Then each
 * span is a least-squares fit of the two handle LENGTHS only — the classic
 * fixed-end-tangent cubic fit. Fixing the directions first is what makes the result C1
 * across every join for free: neighbouring spans share the knot's tangent, so there is no
 * kink to render. Fitting only lengths also keeps each span a two-unknown problem with a
 * closed-form solution, so there is nothing to converge and nothing to fail.
 *
 * Knot count climbs until the fit is inside tolerance, so a section that needs six gets
 * six. A fit beats interpolation badly at the same budget: rebuilding the lofted curve by
 * interpolation needs 16–28 knots to hold 0.2 mm, and at 5–8 it is no better than the
 * blend it replaced.
 */
import { arcLengthTable, pointAtArcFraction, splineFromKnots, type Spline } from './bezier-spline';
import { getInterpolatedCrossSection, type BezierBoard } from './board';
import { crossSection, type CrossSection } from './cross-section';
import { knot, type Knot } from './knot';
import { loftCrossSection, ringFractions } from './loft';
import { vec2, type Vec2 } from './vec2';

/**
 * How far a stored section may sit from the lofted surface (cm). 0.5 mm.
 *
 * Set from the reference's own resolution, not from taste. `loftPoint` reads a
 * fixed-resolution arc-length table, so the lofted curve itself stands 0.07–0.15 mm off
 * the exact blend on the golden boards — a threshold near that is chasing table noise,
 * and it shows: at 0.2 mm the ladder ran an ordinary funboard station from five knots to
 * sixteen to buy 0.16 mm, which is a bad trade for something a person has to drag. At
 * 0.5 mm every ordinary station on the three golden boards keeps its five or six knots
 * and the stations the blend actually gets wrong still fit, at eight to twelve:
 * 4.79 mm → 0.48 mm, 1.49 mm → 0.33 mm, 1.12 mm → 0.21 mm.
 *
 * Worth being clear about what this number is not. It is not a claim that half a
 * millimetre is invisible — it is the point below which the reference cannot tell us
 * anything, so spending control points to go lower buys nothing real.
 */
export const SECTION_FIT_TOL_CM = 0.05;

/**
 * Knot budgets tried in order; the first that meets the tolerance wins.
 *
 * Smallest-that-fits rather than best-available, deliberately: past the bar the extra
 * accuracy is below what the reference resolves, while the extra control points are
 * something the user has to look at and drag every time they touch that station.
 * 24 is a wall, not a target — nothing on the golden boards gets past 12.
 */
const KNOT_LADDER = [6, 8, 10, 12, 16, 20, 24] as const;

/** Samples the candidate is scored against, and the source of the fit's own data. */
const SAMPLES = 400;

/** Dense polyline of a spline, by arc length. */
const dense = (s: Spline, n: number): Vec2[] => {
  const table = arcLengthTable(s);
  return Array.from({ length: n + 1 }, (_, i) => pointAtArcFraction(table, i / n));
};

/**
 * Fraction of the candidate polyline searched around the diagonal. See {@link deviation}.
 *
 * Both curves are sampled by ARC LENGTH over the same profile, so the point of the
 * candidate nearest reference point `i` sits near the same fraction along — the
 * correspondence is close to the diagonal. An eighth of the curve either side is an
 * enormous allowance against that, and it turns the scan from quadratic into a band.
 */
const SEARCH_BAND = 1 / 8;

/** Distance from `p` to the segments of `poly` between `from` and `to`. */
const distToPolyline = (poly: readonly Vec2[], p: Vec2, from: number, to: number): number => {
  let best = Infinity;
  for (let i = Math.max(1, from); i <= to; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
};

/**
 * Worst distance from the reference curve to `candidate` (cm).
 *
 * Banded rather than exhaustive — see {@link SEARCH_BAND}. A band can only ever report a
 * candidate as WORSE than it is, never better, so the one direction the error could
 * matter (letting a bad section through) is closed.
 */
const deviation = (candidate: Spline, reference: readonly Vec2[]): number => {
  const poly = dense(candidate, 1200);
  const half = Math.ceil(poly.length * SEARCH_BAND);
  let worst = 0;
  for (let k = 0; k < reference.length; k++) {
    const centre = Math.round((k / (reference.length - 1)) * (poly.length - 1));
    const d = distToPolyline(poly, reference[k]!, centre - half, Math.min(poly.length - 1, centre + half)); // prettier-ignore
    if (d > worst) worst = d;
  }
  return worst;
};

/** Unit vector, or null where there is no direction to be had. */
const unit = (dx: number, dy: number): Vec2 | null => {
  const len = Math.hypot(dx, dy);
  return len > 1e-12 ? vec2(dx / len, dy / len) : null;
};

/**
 * Fit one cubic to `pts` with both endpoints and both tangent DIRECTIONS fixed, solving
 * only for the two handle lengths (Schneider's `generateBezier`).
 *
 * Falls back to the chord-third rule where the normal equations are singular (a span
 * whose points are collinear with a tangent) or where the solution would put a handle
 * behind its own endpoint, which folds the curve.
 */
const fitHandles = (pts: readonly Vec2[], u0: Vec2, u1: Vec2): { a: number; b: number } => {
  const p0 = pts[0]!;
  const p3 = pts[pts.length - 1]!;
  const fallback = Math.hypot(p3.x - p0.x, p3.y - p0.y) / 3;

  // Chord-length parameters, the same choice `bezier-fit.ts` makes.
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  if (!(total > 0)) return { a: fallback, b: fallback };

  let c11 = 0;
  let c12 = 0;
  let c22 = 0;
  let x1 = 0;
  let x2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = cum[i]! / total;
    const s = 1 - t;
    const b0 = s * s * s;
    const b1 = 3 * s * s * t;
    const b2 = 3 * s * t * t;
    const b3 = t * t * t;
    // What the curve already is once the two endpoints are pinned.
    const baseX = (b0 + b1) * p0.x + (b2 + b3) * p3.x;
    const baseY = (b0 + b1) * p0.y + (b2 + b3) * p3.y;
    const rx = pts[i]!.x - baseX;
    const ry = pts[i]!.y - baseY;
    c11 += b1 * b1;
    c12 += b1 * b2 * (u0.x * u1.x + u0.y * u1.y);
    c22 += b2 * b2;
    x1 += b1 * (rx * u0.x + ry * u0.y);
    x2 += b2 * (rx * u1.x + ry * u1.y);
  }

  const det = c11 * c22 - c12 * c12;
  if (Math.abs(det) < 1e-12) return { a: fallback, b: fallback };
  const a = (x1 * c22 - x2 * c12) / det;
  const b = (c11 * x2 - c12 * x1) / det;
  // A non-positive handle points back through its own endpoint and folds the span.
  const floor = fallback * 1e-3;
  return { a: a > floor ? a : fallback, b: b > floor ? b : fallback };
};

/** Fit a C1 cubic spline through the lofted curve at the given knot fractions. */
const fitToLoft = (
  fractions: readonly number[],
  refTable: ReturnType<typeof arcLengthTable>,
  samples: number,
): Spline | null => {
  // Knot points and their tangent directions, both read off the lofted curve. A central
  // difference over a hair of arc length is exact on a circular arc, which is what a rail
  // zone very nearly is; one-sided at the two ends, where there is no other choice.
  const EPS = 1e-3;
  const knots: { at: Vec2; dir: Vec2 }[] = [];
  const kept: number[] = [];
  for (const f of fractions) {
    const at = pointAtArcFraction(refTable, f);
    const lo = pointAtArcFraction(refTable, Math.max(0, f - EPS));
    const hi = pointAtArcFraction(refTable, Math.min(1, f + EPS));
    const dir = unit(hi.x - lo.x, hi.y - lo.y);
    if (!dir) return null;
    const last = knots[knots.length - 1];
    if (last && Math.hypot(at.x - last.at.x, at.y - last.at.y) < 1e-9) continue;
    knots.push({ at, dir });
    kept.push(f);
  }
  if (knots.length < 2) return null;

  // Handle lengths per span. Each knot's two handles lie along the SAME direction, which
  // is what makes every join C1 without any extra constraint.
  const back = new Array<number>(knots.length).fill(0);
  const fwd = new Array<number>(knots.length).fill(0);
  const perSpan = Math.max(4, Math.floor(samples / (knots.length - 1)));
  for (let k = 0; k < knots.length - 1; k++) {
    const f0 = kept[k]!;
    const f1 = kept[k + 1]!;
    const span = Array.from({ length: perSpan + 1 }, (_, i) =>
      pointAtArcFraction(refTable, f0 + ((f1 - f0) * i) / perSpan),
    );
    const { a, b } = fitHandles(span, knots[k]!.dir, vec2(-knots[k + 1]!.dir.x, -knots[k + 1]!.dir.y)); // prettier-ignore
    fwd[k] = a;
    back[k + 1] = b;
  }

  const out: Knot[] = knots.map((k, i) => {
    const prev = vec2(k.at.x - k.dir.x * back[i]!, k.at.y - k.dir.y * back[i]!);
    const next = vec2(k.at.x + k.dir.x * fwd[i]!, k.at.y + k.dir.y * fwd[i]!);
    // The outermost handles serve no span; stored sections park them on the knot.
    return knot(k.at, i === 0 ? k.at : prev, i === knots.length - 1 ? k.at : next, true, false);
  });
  return splineFromKnots(out);
};

/**
 * A cross-section at `x` that describes the lofted surface and is still editable by hand.
 *
 * Returns the control-point blend where that is already within {@link SECTION_FIT_TOL_CM}
 * of the surface — the ordinary case, where it is exact at five or six knots — and
 * otherwise the smallest fit that gets there. Null wherever the board has no section.
 *
 * The knot count is therefore a property of the board, not a constant: a station between
 * two matching profiles stays as simple as it always was, and only one between genuinely
 * different rails pays for the accuracy.
 */
export const editableCrossSection = (
  b: BezierBoard,
  x: number,
  tolerance = SECTION_FIT_TOL_CM,
): CrossSection | null => {
  const loft = loftCrossSection(b, x);
  const blend = getInterpolatedCrossSection(b, x);
  if (!loft) return blend;

  const refTable = arcLengthTable(loft.spline);
  const reference = Array.from({ length: SAMPLES + 1 }, (_, i) =>
    pointAtArcFraction(refTable, i / SAMPLES),
  );

  const blendDev = blend ? deviation(blend.spline, reference) : Infinity;
  if (blendDev <= tolerance) return blend;

  let best: { spline: Spline; dev: number } | null = null;
  for (const count of KNOT_LADDER) {
    const spline = fitToLoft(ringFractions(b, count), refTable, SAMPLES);
    if (!spline) continue;
    const dev = deviation(spline, reference);
    if (dev <= tolerance) return crossSection(x, spline);
    if (!best || dev < best.dev) best = { spline, dev };
  }
  // Nothing reached the tolerance. Take whichever is closer rather than inventing a third
  // answer, and say nothing about it — a station is not a printed number, so the user can
  // see the shape they got and drag it.
  if (best && best.dev < blendDev) return crossSection(x, best.spline);
  return blend;
};
