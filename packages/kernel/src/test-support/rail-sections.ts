// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cross-sections with closed-form rails, shared by `rail-facets.test.ts` and
 * `rail-facet-fit.test.ts`.
 *
 * There is no legacy oracle for rail bands (`.claude/CLAUDE.md` rule 2 — BoardCAD-LE has
 * none), so the tests lean entirely on analytic ones: a rail that is an exact circle has
 * closed forms for every tangent point, facet vertex, band mark and leftover area.
 */
import { vec2, type Vec2 } from '../vec2';
import { knot } from '../knot';
import { splineFromKnots } from '../bezier-spline';
import { crossSection, type CrossSection } from '../cross-section';
import { DEG_TO_RAD } from '../constants';

export const deg = (d: number): number => d * DEG_TO_RAD;

/**
 * The rail arc is built from **45° cubic segments, not 90° ones**.
 *
 * A cubic bezier quarter-circle is off by 2.7e-4·R, which sounds negligible and is not:
 * these tests locate points by *slope*, and a radial wobble of δ over an arc shifts the
 * place a given slope occurs by roughly R·dδ/ds — about 0.004 cm here, four times the
 * tolerance worth allowing. Halving the arc drops the error by ~2⁶, which buys back the
 * precision to assert at 1e-3 cm and have that mean something.
 *
 * Handle factor for an arc of θ: 4/3·tan(θ/4).
 */
export const handleFactor = (thetaDeg: number): number => (4 / 3) * Math.tan(deg(thetaDeg) / 4);
const K45 = handleFactor(45);

/** Knots along a circle centred (cx, cy) radius R, at the given angles (degrees). */
export const arcKnots = (cx: number, cy: number, R: number, anglesDeg: readonly number[]) =>
  anglesDeg.map((a) => {
    const phi = deg(a);
    const end = vec2(cx + R * Math.cos(phi), cy + R * Math.sin(phi));
    // unit tangent in the direction of increasing φ
    const tx = -Math.sin(phi) * K45 * R;
    const ty = Math.cos(phi) * K45 * R;
    return knot(end, vec2(end.x - tx, end.y - ty), vec2(end.x + tx, end.y + ty), true, false);
  });

/**
 * A section whose rail is an exact half-circle of radius `R`: flat bottom at y = 0,
 * semicircular rail centred on (W−R, R), flat deck at y = 2R. Thickness is 2R and half
 * width is W, so every band mark has a closed form in R alone.
 */
export const circleRailSection = (W: number, R: number, position = 100): CrossSection => {
  const cx = W - R;
  const f = cx / 3;
  const arc = arcKnots(cx, R, R, [-90, -45, 0, 45, 90]);
  const first = arc[0]!;
  const last = arc[arc.length - 1]!;
  return crossSection(
    position,
    splineFromKnots([
      knot(vec2(0, 0), vec2(-f, 0), vec2(f, 0), true, false),
      knot(first.end, vec2(cx - f, 0), first.tangentToNext, true, false),
      ...arc.slice(1, -1),
      knot(last.end, last.tangentToPrev, vec2(cx - f, 2 * R), true, false),
      knot(vec2(0, 2 * R), vec2(f, 2 * R), vec2(-f, 2 * R), true, false),
    ]),
  );
};

/**
 * The same rail, but with a domed deck rising `dome` above the deck tangent point —
 * the shape on which a secant cuts inside and a tangent does not.
 */
export const domedDeckSection = (W: number, R: number, dome: number): CrossSection => {
  const cx = W - R;
  const f = cx / 3;
  const arc = arcKnots(cx, R, R, [-90, -45, 0, 45, 90]);
  const first = arc[0]!;
  const last = arc[arc.length - 1]!;
  return crossSection(
    100,
    splineFromKnots([
      knot(vec2(0, 0), vec2(-f, 0), vec2(f, 0), true, false),
      knot(first.end, vec2(cx - f, 0), first.tangentToNext, true, false),
      ...arc.slice(1, -1),
      knot(last.end, last.tangentToPrev, vec2(cx - f, 2 * R), true, false),
      knot(vec2(0, 2 * R + dome), vec2(f, 2 * R + dome), vec2(-f, 2 * R + dome), true, false),
    ]),
  );
};

/**
 * A rail whose turn is an ellipse quadrant rather than a circle: curvature is packed
 * near the apex when `aspect < 1` and spread toward the deck when it is larger.
 *
 * This is the fixture that can tell the placement objectives apart. On a circle every
 * cap turns on the same radius, so minimising foam and equalising turn are the same
 * problem and both land on equal angular gaps; only a varying radius separates them.
 */
export const ellipseRailSection = (
  W: number,
  rx: number,
  ry: number,
  position = 100,
): CrossSection => {
  const cx = W - rx;
  const f = cx / 3;
  // Same construction as the circular arc, scaled anisotropically — the handles scale
  // with their axis, which keeps the curve an exact ellipse to the same order.
  const angles = [-90, -45, 0, 45, 90];
  const arc = angles.map((a) => {
    const phi = deg(a);
    const end = vec2(cx + rx * Math.cos(phi), ry + ry * Math.sin(phi));
    const tx = -Math.sin(phi) * K45 * rx;
    const ty = Math.cos(phi) * K45 * ry;
    return knot(end, vec2(end.x - tx, end.y - ty), vec2(end.x + tx, end.y + ty), true, false);
  });
  const first = arc[0]!;
  const last = arc[arc.length - 1]!;
  return crossSection(
    position,
    splineFromKnots([
      knot(vec2(0, 0), vec2(-f, 0), vec2(f, 0), true, false),
      knot(first.end, vec2(cx - f, 0), first.tangentToNext, true, false),
      ...arc.slice(1, -1),
      knot(last.end, last.tangentToPrev, vec2(cx - f, 2 * ry), true, false),
      knot(vec2(0, 2 * ry), vec2(f, 2 * ry), vec2(-f, 2 * ry), true, false),
    ]),
  );
};

/** Closed-form facts about the circular rail. Nothing here consults the implementation. */
export const oracle = (W: number, R: number) => {
  const cx = W - R;
  const cy = R;
  /** Surface angle α off the deck plane ⇒ the circle angle φ carrying that slope. */
  const phiForDeckAngle = (alphaDeg: number): number => deg(90 - alphaDeg);
  /** Surface angle β off the bottom plane ⇒ φ (negative, below the apex). */
  const phiForBottomAngle = (betaDeg: number): number => deg(betaDeg - 90);
  const touch = (phi: number): Vec2 => vec2(cx + R * Math.cos(phi), cy + R * Math.sin(phi));
  /** Where the tangent at φ crosses the rail plane x = W. */
  const onRail = (phi: number): Vec2 => vec2(W, cy + (R * (1 - Math.cos(phi))) / Math.sin(phi));
  /** Where the tangent at φ crosses the deck plane y = 2R. */
  const onDeck = (phi: number): Vec2 => vec2(cx + (R * (1 - Math.sin(phi))) / Math.cos(phi), 2 * R);
  /** Where the tangent at φ crosses the bottom plane y = 0. */
  const onBottom = (phi: number): Vec2 => vec2(cx + (R * (1 + Math.sin(phi))) / Math.cos(phi), 0);
  /** Consecutive tangents meet on the bisector, at R/cos(half the angle between them). */
  const vertex = (phiA: number, phiB: number): Vec2 => {
    const d = R / Math.cos((phiB - phiA) / 2);
    const m = (phiA + phiB) / 2;
    return vec2(cx + d * Math.cos(m), cy + d * Math.sin(m));
  };
  /**
   * Foam left between one facet and the arc over an angular gap of `gapDeg`: the classic
   * `R²(tan(Δ/2) − Δ/2)` between two tangents and the arc they enclose.
   */
  const capArea = (gapDeg: number): number => {
    const h = deg(gapDeg) / 2;
    return R * R * (Math.tan(h) - h);
  };
  /** All the foam standing proud of the deck side before any band is cut. */
  const bareDeckArea = (): number => R * R * (1 - Math.PI / 4);
  return {
    cx,
    cy,
    phiForDeckAngle,
    phiForBottomAngle,
    touch,
    onRail,
    onDeck,
    onBottom,
    vertex,
    capArea,
    bareDeckArea,
  };
};
