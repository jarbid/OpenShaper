// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing input of the NURBS engine's DXF and 1:1 PDF exports: plain data, no board model.
 *
 * The classic exporters take a `BezierBoard`. A NURBS document is not one, and faking one would drop
 * what the document has (the second half of an asymmetric board, the notch zone, the bottom
 * features), so the exporters have a second entry point that takes this instead. The app's NURBS
 * worker fills it from the document (`apps/web/src/workers/nurbs-core.ts`); this package never
 * imports the board model.
 *
 * Frame as everywhere: cm, tail at x = 0, nose toward +x, plan y across. The outline, rocker and
 * deck are the document's own Bézier chains (exact); a section is the as-built section sampled from
 * the surface.
 */
import { chainSegs, flattenBeziers, reverseMirrorY, type CurveSeg, type Pt } from './board-curves';
import type { ResolvedFin } from '@openshaper/kernel';

/** One as-built cross-section at a station (`probeSection`, features included). */
export interface CurveSection {
  /** The station coordinate ξ (cm). */
  readonly pos: number;
  /**
   * The plus side from bottom centre over the rail to deck centre: `x` the distance along the
   * station's chord from the stringer, `y` the height above the rocker (cm).
   */
  readonly plus: readonly Pt[];
  /** The minus side, in the same frame (distance from the stringer, positive); null on a mirror board. */
  readonly minus: readonly Pt[] | null;
  /** Where the chord ends on the outline, plan view: the plus side, and the minus side (y ≤ 0). */
  readonly chordPlus: Pt;
  readonly chordMinus: Pt;
  /**
   * The station lies in a notch zone (swallow or fish tail): the section is on a fan chord across
   * the rail, not on an x-plane, and is labelled "rail section".
   */
  readonly rail: boolean;
}

/** Everything the DXF and 1:1 PDF drawings read from a NURBS document. */
export interface BoardCurves {
  /** Board length (cm): the nose x. */
  readonly length: number;
  /** The stringer's extent: 0 (or the notch bottom's x on a notched tail) to the nose. */
  readonly stringer: { readonly from: number; readonly to: number };
  /** The plus half-outline from its stringer point to the nose (y >= 0), as exact Bézier segments. */
  readonly outlinePlus: readonly CurveSeg[];
  /** The minus half-outline in the same form (y >= 0), or null on a mirror board. */
  readonly outlineMinus: readonly CurveSeg[] | null;
  /** The rocker (bottom) and deck as z(x) Bézier segments. */
  readonly bottom: readonly CurveSeg[];
  readonly deck: readonly CurveSeg[];
  /** The rail apex line, plus side: (x, z) at the section's apex along the stringer. */
  readonly apex: readonly Pt[];
  /** The stations, in order along the board. */
  readonly sections: readonly CurveSection[];
  /** Resolved fins to draw on the plan (from the document's fin setup). */
  readonly fins?: readonly ResolvedFin[];
}

/** Whether the two halves differ (so a half template or a mirrored section would hide one). */
export const isAsymmetric = (c: BoardCurves): boolean => c.outlineMinus !== null;

/** The closed plan outline (both halves) as Bézier segments: plus tail to nose, then the minus half back. */
export const curvesOutlineLoop = (c: BoardCurves): CurveSeg[] => {
  const minus = c.outlineMinus ?? c.outlinePlus;
  const back = [...minus].reverse().map(reverseMirrorY);
  return [...c.outlinePlus, ...back];
};

/** The loop closed by straight bridges (one continuous chain), for a SPLINE entity. */
export const curvesOutlineChain = (c: BoardCurves): CurveSeg[] =>
  chainSegs(curvesOutlineLoop(c), true);

/** A section's full lateral ring (minus half mirrored, then the plus half), local section coords. */
export const curvesSectionRing = (s: CurveSection): Pt[] => {
  const minus = s.minus ?? s.plus;
  const left = [...minus].reverse().map((p) => ({ x: -p.x, y: p.y }));
  const ring = [...left, ...s.plus];
  // both halves meet at the deck centre: drop the duplicate so a closed ring has no zero-length edge
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  if (ring.length > 2 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) ring.pop();
  return ring;
};

/** y at `x` along a chain of segments that is a function of x (the rocker or deck). */
export const curveYAtX = (segs: readonly CurveSeg[], x: number): number => {
  let seg = segs[segs.length - 1];
  for (const s of segs) {
    if (x <= s.p3.x) {
      seg = s;
      break;
    }
  }
  if (!seg) return 0;
  const at = (t: number): Pt => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * seg.p0.x + b * seg.c1.x + c * seg.c2.x + d * seg.p3.x,
      y: a * seg.p0.y + b * seg.c1.y + c * seg.c2.y + d * seg.p3.y,
    };
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = 0.5 * (lo + hi);
    if (at(mid).x < x) lo = mid;
    else hi = mid;
  }
  return at(0.5 * (lo + hi)).y;
};

/** Sampled outline points (both halves) for extents. */
export const curvesOutlinePoints = (c: BoardCurves, perSeg: number): Pt[] =>
  flattenBeziers(curvesOutlineLoop(c), perSeg);
