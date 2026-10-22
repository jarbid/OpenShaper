// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The S6 exit measurements of a converted board, made independently of the
 * converter (test-only; docs/design/board2.md §14 S6):
 *
 * - **Plan** (`measurePlan`): the classic outline evaluated exactly from its
 *   control points (`splinePoints`, about 0.005 cm apart) against a dense
 *   polyline of the board2 loop, both ways, outside the fillet zones (within
 *   the arc ends' distance of a corner). The polylines over-report a distance
 *   by at most their chord error (`CHORD`), which is taken off. Inside the
 *   zones, both ways: the fillet arcs sampled 0.005 cm apart against the loop,
 *   and the loop against the filleted outline (the fit's target); the loop and
 *   the classic outline against each other as a multiple of the zone's
 *   predicted deviation (§9.3's criterion); each corner's own distance to the
 *   loop against the prediction. The arcs come from the converter's
 *   `filletOutline`, so they are checked against the classic on their own:
 *   every fillet circle touches the classic outline (its centre's distance is
 *   its radius) and a pointed tip on a straight end segment has the closed
 *   form `r (1/sin(θ/2) − 1)` with θ from the classic's end tangent.
 * - **Lines**: the stringer iso-curves of the document's own height fields
 *   (`stringerLines`, so the stringer identity is checked with the line fit)
 *   against the classic bottom and deck curves evaluated exactly, at the
 *   curves' own points, x in `[endGap, L − endGap]`; inside line fillet zones
 *   the classic within the prediction plus `lineTol`, and the fillet arcs
 *   sampled 0.005 cm apart within `lineTol` of the line.
 * - **Surfaces**: the classic loft resampled with the kernel at every other
 *   converter row, membership in the deck-edge and tuck loops by crossings
 *   with dense polygons of the loops (not the converter's row classifier,
 *   which `membership.test.ts` checks against geom's `classifyUV`), windows
 *   recomputed from the classic stations and floors; the vertical residual of
 *   the document's fields there. Also measured on rows halfway between the
 *   converter's rows (never fitted).
 * - **Knife tips**: `validateBoard` reports no `rail-height` issue.
 */
import {
  getLength,
  loftPoint,
  loftSection,
  ringFractions,
  surfaceStations,
} from '@openshaper/kernel';
import type { BezierBoard, Spline } from '@openshaper/kernel';
import { createScratch, curveEvalInto, resolveTolerances } from '@openshaper/geom';
import type { NurbsCurve, PeriodicCurve, Tolerances } from '@openshaper/geom';
import { bandContext, insetPlanCurve } from '../../band/band';
import { stationBasis } from '../../band/stations';
import { heightFieldSurface, heightSampler, stringerLines } from '../../height-field';
import { planCurve } from '../../plan';
import { validateBoard } from '../../validate';
import type { Board2Issue } from '../../types';
import type { ClassicGeometry } from '../convert';
import { filletLine, filletOutline, piecePoint, samplePiece } from '../outline';
import type { FilletedOutline } from '../outline';
import type { ConvertOptions } from '../types';
import { polygonCrossings, polylineDistance, splinePoints } from './oracles';

/** One sample file converted and measured. */
export interface ExitRun {
  readonly geometry: ClassicGeometry;
  readonly measures: ConversionMeasures;
  /** `convertGeometry`'s warnings (S6). */
  readonly warnings: readonly Board2Issue[];
}

export interface ConversionMeasures {
  readonly plan: PlanMeasures;
  readonly rocker: number;
  readonly deckLine: number;
  /** Line fillet zones: largest |line − classic| − predicted (cm; −∞ without line fillets). */
  readonly lineFilletExcess: number;
  /** The line fillet arcs, sampled 0.005 cm apart: largest vertical distance to the line (cm; 0 without). */
  readonly lineArcError: number;
  readonly deckResidual: number;
  readonly bottomResidual: number;
  readonly deckResidualMid: number;
  readonly bottomResidualMid: number;
  readonly judged: number;
  readonly railHeightIssues: readonly Board2Issue[];
  readonly validateErrors: readonly Board2Issue[];
}

/** Spacing of the dense exact samples of the classic curves and the fillet arcs, cm. */
const DENSE = 0.005;
/**
 * The polylines' chord error, taken off every distance: `h²/8ρ` with h ≤ 0.006 cm
 * (the loop at 100,001 points, the classic and arc samples at `DENSE`) and
 * ρ ≥ 0.45 cm (the smallest fillet radius): under 1e-5 cm.
 */
export const CHORD = 1e-5;

/** Points per classic segment so neighbours are at most `h` apart (the control polygon bounds the length). */
function perSegment(s: Spline, h: number): number {
  let worst = 1;
  for (const c of s.curves) {
    const poly =
      Math.hypot(c.c1.x - c.p0.x, c.c1.y - c.p0.y) +
      Math.hypot(c.c2.x - c.c1.x, c.c2.y - c.c1.y) +
      Math.hypot(c.p3.x - c.c2.x, c.p3.y - c.c2.y);
    worst = Math.max(worst, Math.ceil(poly / h));
  }
  return worst;
}

/** `n + 1` points of a curve at equal parameter steps over its domain (one period). */
function curvePoints(c: NurbsCurve<2> | PeriodicCurve<2>, n: number): Float64Array {
  const sc = createScratch({ maxDegree: c.basis.degree, maxDerivs: 0 });
  const q = new Float64Array(2);
  const out = new Float64Array(2 * (n + 1));
  const [a] = c.basis.domain;
  const T = c.basis.kind === 'periodic' ? c.basis.period : c.basis.domain[1] - a;
  for (let k = 0; k <= n; k++) {
    curveEvalInto(c, a + (T * k) / n, 0, q, 0, sc);
    out[2 * k] = q[0]!;
    out[2 * k + 1] = q[1]!;
  }
  return out;
}

/** Zones (centre and radius) round the corners a filleted chain replaced. */
function zones(f: FilletedOutline): { x: number; y: number; r: number; pred: number }[] {
  return f.arcs.map(({ piece, fillet }) => {
    const fl = f.fillets[fillet]!;
    const p = f.pieces[piece]!;
    const r = Math.max(
      ...[0, 1].map((t) => {
        const q = piecePoint(p, t);
        return Math.hypot(q[0] - fl.x, q[1] - fl.y);
      }),
    );
    return { x: fl.x, y: fl.y, r, pred: fl.predictedDeviation };
  });
}

/** What the plan checks measure (cm unless stated). */
export interface PlanMeasures {
  /** Classic outline → loop and loop → classic, outside fillet zones. */
  readonly planToLoop: number;
  readonly loopToPlan: number;
  /** Largest |corner's distance to the loop − predicted deviation|. */
  readonly filletMiss: number;
  /** The fillet arcs, sampled 0.005 cm apart, → loop. */
  readonly arcToLoop: number;
  /** Loop points inside the fillet zones → the filleted outline (arcs and the classic pieces between). */
  readonly zoneLoopToFilleted: number;
  /**
   * §9.3's criterion inside the zones, both ways against the classic outline:
   * the largest distance as a multiple of the zone's predicted deviation
   * (0 without fillets).
   */
  readonly zoneRatio: number;
  /**
   * Pointed tips whose end segment is straight: largest |predicted deviation −
   * r (1/sin(θ/2) − 1)|, θ from the classic end tangent (§9.3's closed form).
   */
  readonly tipFormulaMiss: number;
  /**
   * Every fillet circle is inscribed: largest |its centre's distance to the
   * classic outline − its radius| (tangent to the classic, never crossing it;
   * the check that covers curved neighbours, where the closed form does not hold).
   */
  readonly filletTangency: number;
}

/**
 * The plan checks (module comment) of a loop `plan` in board2 coordinates
 * (board2 x = classic x − `shift`) against the classic `outline`.
 */
export function measurePlan(
  outline: Spline,
  plan: PeriodicCurve<2>,
  shift: number,
  o: ConvertOptions,
  tol: Tolerances,
): PlanMeasures {
  const chord = CHORD;
  const filleted = filletOutline(outline, o, tol);
  const pz = zones(filleted);
  const mirror = (half: Float64Array): Float64Array => {
    const m = half.length / 2;
    const full = new Float64Array(4 * m);
    for (let k = 0; k < m; k++) {
      full[2 * k] = half[2 * k]! - shift;
      full[2 * k + 1] = half[2 * k + 1]!;
      full[2 * (2 * m - 1 - k)] = half[2 * k]! - shift;
      full[2 * (2 * m - 1 - k) + 1] = -half[2 * k + 1]!;
    }
    return full;
  };
  const classic = mirror(splinePoints(outline, perSegment(outline, DENSE)));
  const loopPts = curvePoints(plan, 100000);
  const toLoop = polylineDistance(loopPts, 0.05);
  const toClassic = polylineDistance(classic, 0.05);
  const zoneOf = (x: number, y: number, extra: number): (typeof pz)[number] | undefined =>
    pz.find((z) => Math.hypot(x + shift - z.x, Math.abs(y) - z.y) <= z.r + extra);
  let planToLoop = 0;
  let zoneRatio = 0;
  for (let k = 0; k < classic.length / 2; k++) {
    const x = classic[2 * k]!;
    const y = classic[2 * k + 1]!;
    const z = zoneOf(x, y, 0);
    if (z === undefined) planToLoop = Math.max(planToLoop, toLoop(x, y) - chord);
    else zoneRatio = Math.max(zoneRatio, (toLoop(x, y) - chord) / z.pred);
  }
  // The filleted outline as exact pieces, sampled densely (arcs uniformly in angle).
  const half: number[] = [];
  const arcs: number[] = [];
  filleted.pieces.forEach((p) => {
    const pts = samplePiece(p, DENSE);
    for (let k = half.length === 0 ? 0 : 1; k < pts.length; k++) half.push(pts[k]![0], pts[k]![1]);
    if (p.kind === 'arc') for (const q of pts) arcs.push(q[0], q[1]);
  });
  const toFilleted = polylineDistance(mirror(Float64Array.from(half)), 0.05);
  let loopToPlan = 0;
  let zoneLoopToFilleted = 0;
  for (let k = 0; k < loopPts.length / 2; k++) {
    const x = loopPts[2 * k]!;
    const y = loopPts[2 * k + 1]!;
    const z = zoneOf(x, y, o.lineTol);
    if (z === undefined) loopToPlan = Math.max(loopToPlan, toClassic(x, y) - chord);
    else {
      zoneLoopToFilleted = Math.max(zoneLoopToFilleted, toFilleted(x, y) - chord);
      zoneRatio = Math.max(zoneRatio, (toClassic(x, y) - chord) / z.pred);
    }
  }
  let arcToLoop = 0;
  for (let k = 0; k < arcs.length / 2; k++) {
    // Both halves: the loop is symmetric only as exactly as its symmetrisation.
    for (const sy of [1, -1])
      arcToLoop = Math.max(arcToLoop, toLoop(arcs[2 * k]! - shift, sy * arcs[2 * k + 1]!) - chord);
  }
  let filletMiss = 0;
  for (const z of pz)
    filletMiss = Math.max(filletMiss, Math.abs(toLoop(z.x - shift, z.y) - z.pred));
  let filletTangency = 0;
  for (const { piece } of filleted.arcs) {
    const p = filleted.pieces[piece]!;
    if (p.kind !== 'arc') continue;
    filletTangency = Math.max(filletTangency, Math.abs(toClassic(p.cx - shift, p.cy) - p.r));
  }
  // Pointed tips (the corner on the stringer) on a straight end segment: the
  // design's closed form with the classic's own end tangent.
  let tipFormulaMiss = 0;
  const curves = outline.curves;
  const ends = [
    { at: curves[0]!.p0, dirs: [curves[0]!.c1, curves[0]!.c2, curves[0]!.p3] },
    {
      at: curves.at(-1)!.p3,
      dirs: [curves.at(-1)!.c2, curves.at(-1)!.c1, curves.at(-1)!.p0],
    },
  ];
  for (const fl of filleted.fillets) {
    if (!fl.tip || fl.y !== 0) continue;
    const end = ends.find((e) => Math.abs(e.at.x - fl.x) <= tol.point);
    if (end === undefined) continue;
    const [a, b, c] = end.dirs;
    const chordLen = Math.hypot(c!.x - end.at.x, c!.y - end.at.y);
    if (!(chordLen > tol.point)) continue;
    const off = (d: { x: number; y: number }): number =>
      Math.abs((d.x - end.at.x) * (c!.y - end.at.y) - (d.y - end.at.y) * (c!.x - end.at.x)) /
      chordLen;
    if (off(a!) > tol.point || off(b!) > tol.point) continue;
    const q = end.dirs.find((d) => Math.hypot(d.x - end.at.x, d.y - end.at.y) > tol.point)!;
    const half = Math.atan2(Math.abs(q.y - end.at.y), Math.abs(q.x - end.at.x));
    const formula = fl.radius * (1 / Math.sin(half) - 1);
    tipFormulaMiss = Math.max(tipFormulaMiss, Math.abs(fl.predictedDeviation - formula));
  }
  return {
    planToLoop,
    loopToPlan,
    filletMiss,
    arcToLoop,
    zoneLoopToFilleted,
    zoneRatio,
    tipFormulaMiss,
    filletTangency,
  };
}

export function measureConversion(
  board: BezierBoard,
  g: ClassicGeometry,
  o: ConvertOptions,
): ConversionMeasures {
  const doc = g.doc;
  const tol = resolveTolerances(doc.build.tolerances);
  const L = getLength(board);
  const shift = g.shift;
  const plan = planCurve(doc.plan, tol);
  const planMeasures = measurePlan(board.outline, plan, shift, o, tol);

  // Lines.
  const [x0, x1] = doc.deck.x;
  const surfaces = {
    deck: heightFieldSurface(doc.deck, doc.symmetry, tol),
    bottom: heightFieldSurface(doc.bottom, doc.symmetry, tol),
  };
  const lines = stringerLines(surfaces);
  let lineFilletExcess = -Infinity;
  let lineArcError = 0;
  const lineError = (s: Spline, curve: NurbsCurve<3>): number => {
    const f = filletLine(s, [o.endGap, L - o.endGap], o, tol);
    const fl = zones(f);
    const pts = splinePoints(s, perSegment(s, 0.02));
    const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
    const q = new Float64Array(3);
    let worst = 0;
    for (let k = 0; k < pts.length / 2; k++) {
      const xc = pts[2 * k]!;
      const x = xc - shift;
      if (!(xc >= o.endGap && xc <= L - o.endGap && x >= x0 && x <= x1)) continue;
      curveEvalInto(curve, (x - x0) / (x1 - x0), 0, q, 0, sc);
      const e = Math.abs(q[2]! - pts[2 * k + 1]!);
      const z = fl.find((f) => Math.hypot(xc - f.x, pts[2 * k + 1]! - f.y) <= f.r);
      if (z) lineFilletExcess = Math.max(lineFilletExcess, e - z.pred);
      else worst = Math.max(worst, e);
    }
    // The fillet arcs themselves (the filleted target inside the zones).
    for (const { piece } of f.arcs) {
      for (const [xc, z] of samplePiece(f.pieces[piece]!, DENSE)) {
        const x = xc - shift;
        if (!(x >= x0 && x <= x1)) continue;
        curveEvalInto(curve, (x - x0) / (x1 - x0), 0, q, 0, sc);
        lineArcError = Math.max(lineArcError, Math.abs(q[2]! - z));
      }
    }
    return worst;
  };
  const rocker = lineError(board.bottom, lines.rocker);
  const deckLine = lineError(board.deck, lines.deck);

  // Surfaces.
  const ctx = bandContext(doc);
  const b = stationBasis(ctx.plan, ctx.arc, doc.build, true, tol);
  // The face loops as dense polygons (chord error ≤ 1e-5 cm at 40,000 points);
  // samples within 1e-4 cm of a loop are left out (on the boundary either way).
  const polys = {
    deck: curvePoints(insetPlanCurve(ctx, b, 'deckEdge'), 40000),
    bottom: curvePoints(insetPlanCurve(ctx, b, 'tuck'), 40000),
  };
  const near = {
    deck: polylineDistance(polys.deck, 0.05),
    bottom: polylineDistance(polys.bottom, 0.05),
  };
  const sample = {
    deck: heightSampler(surfaces.deck, doc.deck, tol),
    bottom: heightSampler(surfaces.bottom, doc.bottom, tol),
  };
  const [a, e] = surfaceStations(board).span;
  const stations = board.crossSections.slice(1, -1).map((c) => c.position);
  // The board2 nose centre: the plan at u = ½.
  const nose = curvePoints(plan, 2)[2]!;
  const inWindow = (xc: number): boolean =>
    xc - shift <= o.tipWindow ||
    xc - shift >= nose - o.tipWindow ||
    xc <= a ||
    xc >= e ||
    stations.some((s) => Math.abs(xc - s) <= o.creaseWindow);
  const fr = ringFractions(board, o.ringSamples);
  const n = Math.max(1, Math.ceil((e - a) / o.sampleSpacingX));
  let judged = 0;
  const residual = (offset: number): { deck: number; bottom: number } => {
    const worst = { deck: 0, bottom: 0 };
    for (let r = 0; r < n; r += 2) {
      const xc = a + ((e - a) * (r + offset)) / n;
      if (inWindow(xc)) continue;
      const s = loftSection(board, xc);
      if (s === null) continue;
      const pts = fr.map((f) => loftPoint(s, f));
      let apex = 0;
      pts.forEach((p, k) => {
        if (p.x > pts[apex]!.x) apex = k;
      });
      const x = xc - shift;
      const cross = {
        deck: polygonCrossings(polys.deck, x),
        bottom: polygonCrossings(polys.bottom, x),
      };
      pts.forEach((p, k) => {
        if (k === apex) return;
        const side = k > apex ? 'deck' : 'bottom';
        const inside = cross[side].filter((c) => c > p.x).length % 2 === 1;
        if (!inside || near[side](x, p.x, 1e-4) <= 1e-4) return;
        judged++;
        const res = Math.abs(sample[side](x, p.x).z - (p.y + s.rocker));
        worst[side] = Math.max(worst[side], res);
      });
    }
    return worst;
  };
  const fitted = residual(0);
  const mid = residual(0.5);

  const issues = validateBoard(doc);
  return {
    plan: planMeasures,
    rocker,
    deckLine,
    lineFilletExcess,
    lineArcError,
    deckResidual: fitted.deck,
    bottomResidual: fitted.bottom,
    deckResidualMid: mid.deck,
    bottomResidualMid: mid.bottom,
    judged,
    railHeightIssues: issues.filter((i) => i.code === 'rail-height'),
    validateErrors: issues.filter((i) => i.severity === 'error'),
  };
}
