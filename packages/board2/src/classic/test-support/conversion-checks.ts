// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The S6 exit measurements of a converted board, made independently of the
 * converter (test-only; docs/design/board2.md §14 S6):
 *
 * - **Plan**: the classic outline evaluated exactly from its control points
 *   (`splinePoints`, about 0.005 cm apart) against a dense polyline of the
 *   board2 loop, both ways. The polylines over-report a distance by at most
 *   their chord error `h²/8ρ` (h ≤ 0.006 cm, ρ ≥ 0.45 cm: 1e-5 cm), which is
 *   taken off. Fillet zones (within the arc ends' distance of a corner) are
 *   judged by the corner's own distance to the loop instead, which must equal
 *   the predicted deviation within `lineTol`.
 * - **Lines**: the stringer iso-curves of the document's own height fields
 *   (`stringerLines`, so the stringer identity is checked with the line fit)
 *   against the classic bottom and deck curves evaluated exactly, at the
 *   curves' own points, x in `[endGap, L − endGap]`.
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
import type { NurbsCurve, PeriodicCurve } from '@openshaper/geom';
import { bandContext, insetPlanCurve } from '../../band/band';
import { stationBasis } from '../../band/stations';
import { heightFieldSurface, heightSampler, stringerLines } from '../../height-field';
import { planCurve } from '../../plan';
import { validateBoard } from '../../validate';
import type { Board2Issue } from '../../types';
import type { ClassicGeometry } from '../convert';
import { filletLine, filletOutline, piecePoint } from '../outline';
import type { FilletedOutline } from '../outline';
import type { ConvertOptions } from '../types';
import { polygonCrossings, polylineDistance, splinePoints } from './oracles';

/** One sample file converted and measured. */
export interface ExitRun {
  readonly geometry: ClassicGeometry;
  readonly measures: ConversionMeasures;
  readonly warnings: readonly Board2Issue[];
}

export interface ConversionMeasures {
  /** Classic outline → loop and loop → classic, outside fillet zones (cm). */
  readonly planToLoop: number;
  readonly loopToPlan: number;
  /** Largest |corner's distance to the loop − predicted deviation| (cm). */
  readonly filletMiss: number;
  readonly rocker: number;
  readonly deckLine: number;
  /** Line fillet zones: largest |line − classic| − predicted (cm; −∞ without line fillets). */
  readonly lineFilletExcess: number;
  readonly deckResidual: number;
  readonly bottomResidual: number;
  readonly deckResidualMid: number;
  readonly bottomResidualMid: number;
  readonly judged: number;
  readonly railHeightIssues: readonly Board2Issue[];
  readonly validateErrors: readonly Board2Issue[];
}

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

export function measureConversion(
  board: BezierBoard,
  g: ClassicGeometry,
  o: ConvertOptions,
): ConversionMeasures {
  const doc = g.doc;
  const tol = resolveTolerances(doc.build.tolerances);
  const L = getLength(board);
  const shift = g.shift;
  const chord = 1e-5;

  // Plan.
  const pz = zones(filletOutline(board.outline, o, tol));
  const half = splinePoints(board.outline, perSegment(board.outline, 0.005));
  const m = half.length / 2;
  const classic = new Float64Array(4 * m);
  for (let k = 0; k < m; k++) {
    classic[2 * k] = half[2 * k]! - shift;
    classic[2 * k + 1] = half[2 * k + 1]!;
    classic[2 * (2 * m - 1 - k)] = half[2 * k]! - shift;
    classic[2 * (2 * m - 1 - k) + 1] = -half[2 * k + 1]!;
  }
  const plan = planCurve(doc.plan, tol);
  const loopPts = curvePoints(plan, 100000);
  const toLoop = polylineDistance(loopPts, 0.05);
  const toClassic = polylineDistance(classic, 0.05);
  const inZone = (x: number, y: number, extra: number): boolean =>
    pz.some((z) => Math.hypot(x + shift - z.x, Math.abs(y) - z.y) <= z.r + extra);
  let planToLoop = 0;
  for (let k = 0; k < classic.length / 2; k++) {
    const x = classic[2 * k]!;
    const y = classic[2 * k + 1]!;
    if (!inZone(x, y, 0)) planToLoop = Math.max(planToLoop, toLoop(x, y) - chord);
  }
  let loopToPlan = 0;
  for (let k = 0; k < loopPts.length / 2; k++) {
    const x = loopPts[2 * k]!;
    const y = loopPts[2 * k + 1]!;
    if (!inZone(x, y, o.lineTol)) loopToPlan = Math.max(loopToPlan, toClassic(x, y) - chord);
  }
  let filletMiss = 0;
  for (const z of pz)
    filletMiss = Math.max(filletMiss, Math.abs(toLoop(z.x - shift, z.y) - z.pred));

  // Lines.
  const [x0, x1] = doc.deck.x;
  const surfaces = {
    deck: heightFieldSurface(doc.deck, doc.symmetry, tol),
    bottom: heightFieldSurface(doc.bottom, doc.symmetry, tol),
  };
  const lines = stringerLines(surfaces);
  let lineFilletExcess = -Infinity;
  const lineError = (s: Spline, curve: NurbsCurve<3>): number => {
    const fl = zones(filletLine(s, [o.endGap, L - o.endGap], o, tol));
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
    planToLoop,
    loopToPlan,
    filletMiss,
    rocker,
    deckLine,
    lineFilletExcess,
    deckResidual: fitted.deck,
    bottomResidual: fitted.bottom,
    deckResidualMid: mid.deck,
    bottomResidualMid: mid.bottom,
    judged,
    railHeightIssues: issues.filter((i) => i.code === 'rail-height'),
    validateErrors: issues.filter((i) => i.severity === 'error'),
  };
}
