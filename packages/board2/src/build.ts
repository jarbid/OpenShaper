// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `buildBoard`: a document to a {@link BuiltBoard}, in the fixed order of
 * docs/design/board2.md §6.3.
 *
 * 1. Validate the document (`validateDocument`: everything but the geometric
 *    checks of stages 4–8, which the stages below report as they build).
 * 2–3. The plan loop, σ and the deck and base bottom (`bandContext`).
 * 4–5. The station basis and, on it, the tuck plan curve (`insetPlanCurve`).
 * 6. The bottom features against that tuck curve, fitted and added
 *    (`bottomWithFeatures`).
 * 7–12. The band on the bottom with its features, refined until its laws,
 *    deck join and edge fits meet their targets (`buildBand`).
 * 13. The B-rep: assembled, oriented and checked (`boardBrep`).
 *
 * Each stage reads only the document and the stages above it. Errors of any
 * stage are returned (never thrown); warnings (`not-converged`) ride on the
 * result and in `report.issues`. Stage 14 (specs, STEP, tessellation) runs on
 * demand (`writeBoardStep`; specs are step S5's).
 */
import { resolveTolerances } from '@openshaper/geom';
import { bandContext, buildBand, geomIssue, insetPlanCurve } from './band/band';
import type { BuildBandOptions } from './band/band';
import { stationBasis } from './band/stations';
import { boardBrep } from './brep';
import { bottomWithFeatures } from './features';
import { board2Err, board2Ok, hasErrors } from './issues';
import type { Board2Issue, Board2Result, BoardDoc, BuildReport, BuiltBoard } from './types';
import { validateDocument } from './validate';

/**
 * Builds a validated document (§6.3). The same as {@link assembleBoard} after
 * the document checks; errors of either are returned as a failed result.
 */
export function buildBoard(doc: BoardDoc): Board2Result<BuiltBoard> {
  const issues = validateDocument(doc);
  if (hasErrors(issues)) return board2Err(issues);
  const r = assembleBoard(doc);
  return r.ok ? board2Ok(r.value, [...issues, ...r.issues]) : board2Err([...issues, ...r.issues]);
}

/**
 * Stages 2–13 without the document checks: the band builder and B-rep
 * assembly on a document `validateBoard` would refuse, such as the notched
 * loop of §3.8 (internal; tests). `opts` passes the band builder's test
 * options through.
 */
export function assembleBoard(
  doc: BoardDoc,
  opts: Omit<BuildBandOptions, 'bottom'> = {},
): Board2Result<BuiltBoard> {
  let feature: ReturnType<typeof bottomWithFeatures>;
  try {
    const ctx = bandContext(doc);
    const b = stationBasis(ctx.plan, ctx.arc, doc.build, ctx.symmetric, ctx.tol);
    feature = bottomWithFeatures(doc, ctx.bottom, insetPlanCurve(ctx, b, 'tuck'), ctx.tol);
  } catch (e) {
    return board2Err([geomIssue(e, 'bottom features')]);
  }
  const fb = feature.value;
  if (fb === null || hasErrors(feature.issues)) return board2Err(feature.issues);

  const band = buildBand(doc, { ...opts, bottom: fb.surface });
  if (!band.ok) return board2Err([...feature.issues, ...band.issues]);
  const bb = band.value;

  const tol = resolveTolerances(doc.build.tolerances);
  const brep = boardBrep({
    band: bb.band,
    deck: bb.deck,
    bottom: fb.surface,
    deckEdge: bb.deckEdge,
    tuck: bb.tuck,
    deckField: doc.deck,
    bottomField: doc.bottom,
    tol,
  });
  if (!brep.ok) return board2Err([...feature.issues, ...bb.report.issues, ...brep.issues]);
  const br = brep.value;

  const issues: Board2Issue[] = [...feature.issues, ...bb.report.issues];
  const report: BuildReport = Object.freeze({
    issues: Object.freeze(issues),
    apexJoinAngle: bb.report.apexJoinAngle,
    deckJoinAngle: bb.report.deckJoinAngle,
    tuckCreaseError: bb.report.tuckCreaseError,
    lawFidelity: bb.report.lawFidelity,
    // The B-rep's own measurement of the two trimmed edges (geom checkBrep, §5.5, §7).
    edgeGaps: Object.freeze({
      deckEdge: br.check.edgeGaps[br.edges.deckEdge]!,
      tuck: br.check.edgeGaps[br.edges.tuck]!,
    }),
    featureFitError: fb.error,
    refinePasses: bb.report.refinePasses,
    insetLimited: bb.report.insetLimited,
  });
  return board2Ok(
    Object.freeze({
      doc,
      plan: bb.plan,
      apex: bb.apex,
      deckEdge: bb.deckEdge,
      tuck: bb.tuck,
      deck: bb.deck,
      bottom: fb.surface,
      band: bb.band,
      stations: bb.stations,
      brep: br.brep,
      faces: br.faces,
      report,
    }),
    issues,
  );
}
