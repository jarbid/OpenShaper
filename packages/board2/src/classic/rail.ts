// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The converter's rail stage (docs/design/board2.md §9.7; step S7): from the
 * geometry of `convertGeometry` (plan, lines, insets, deck and bottom) to the
 * document with its rail laws and offset layer. "S7 as built" in board2.md
 * records where this departs from §9.7.
 *
 * 1. **Initial band** (§9.7 item 1). The profile lanes start constant at
 *    `DEFAULT_RAIL_LAWS`, except the apex height, which starts at the
 *    classic's own apex at every station (the widest point of the loft
 *    section there, `sample.ts`, as a fraction from the tuck to the deck
 *    edge), kept inside the profile's feasible interval (`extract.ts`,
 *    `apexBounds`): with a constant 0.4 the steep nose rocker of the funboard
 *    and longboard lifts the bottom's tangent corner above the apex (S6 as
 *    built, item 14). A column that is still invalid gets an apex key at its
 *    σ inside its interval (both insets halved there first while no interval
 *    exists), at most `maxRefinePasses` rounds. The band is then built by
 *    `buildBand`, whose refinement (§5.4) gives the **fit's basis**; from
 *    there on the document carries that basis as its plan's knots (the same
 *    curve, refined exactly), so every later pass and the final document's
 *    build compute the same columns, σ and frames bitwise.
 * 2. **The apex law** (item 4 for the apex lane). The apex row is the plan
 *    silhouette, so its height is a datum, not a fit unknown: the classic
 *    apex curve (the rows' widest points, linear in x between rows) at every
 *    column outside the tip windows, as a fraction of the column's rail
 *    height, is the target, and `adaptiveLaw` keys it within
 *    `lawTolerance.apexHeight` at every column. The apex row has no offset
 *    (§6.1), so the law must carry it.
 * 3. **Data and the fit** (items 2–3, `band-fit.ts`): the band built on that
 *    apex law is the initial band; the fit moves rows 1, 2, 4 and 5.
 * 4. **The other lanes** at the stations and tips (§5.7 on the fitted band),
 *    clamped to their ranges; insets as §9.5.
 * 5. **Offsets** (item 5): the law-only band on the same basis, the
 *    difference interpolated over σ (`extract.ts`). The document builds with
 *    `maxBandRefinePasses` 0, so its band is the fitted band on the fit's
 *    basis (item 6; `convertClassic` measures the identity on its build).
 */
import {
  controlPointsInto,
  createScratch,
  curveEvalInto,
  makeCurve,
  resolveTolerances,
} from '@openshaper/geom';
import type { NurbsSurface, PeriodicCurve, Tolerances } from '@openshaper/geom';
import { bandContext, bandPass, buildBand, columnAt, insetRadiusAt } from '../band/band';
import type { BandContext, BandPass } from '../band/band';
import { bandColumns, stationBasis } from '../band/stations';
import type { BandBasis, Column } from '../band/stations';
import { lawEvaluator } from '../law';
import { makeIssue } from '../issues';
import { paramAtSigma, planFrame } from '../plan';
import type { Board2Issue, BoardDoc, LawCurve, RailLaws, RailLawValues } from '../types';
import { bandFitFrame, bandSamples, bandSurface, fitBand, projectSamples } from './band-fit';
import type { BandFit } from './band-fit';
import type { ClassicGeometry } from './convert';
import {
  adaptiveLaw,
  apexBounds,
  clampTo,
  columnInputs,
  inLane,
  keyedLaw,
  measuredLanes,
  offsetLayer,
  stationKeys,
  windowTest,
} from './extract';
import { planLoopJSON } from './lines';
import { rowClassifier } from './membership';
import type { ConvertOptions } from './types';

/** What the rail stage produced and measured. */
export interface RailStage {
  readonly doc: BoardDoc;
  /** The refitted band's net (apex at its law) and the basis it is on. */
  readonly fitted: Float64Array;
  readonly basis: BandBasis;
  readonly fit: BandFit;
  readonly samples: number;
  readonly data: import('./band-fit').BandSamples;
  /** Apex keys added to the initial law (repairs) and by the extraction; inset keys the repairs added. */
  readonly initialApexKeysAdded: number;
  readonly insetKeysAdded: number;
  readonly apexKeysAdded: number;
  /** Laws measured (§5.7) on the refitted band at the station keys. */
  readonly stationLaws: readonly {
    readonly sigma: number;
    readonly x: number;
    readonly laws: RailLawValues;
  }[];
  readonly timings: { readonly [stage: string]: number };
}

/** The xyz control net of a band surface (polynomial: weights 1). */
export function netOf(s: NurbsSurface): Float64Array {
  const n = s.cw.length / 4;
  const out = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[3 * i] = s.cw[4 * i]!;
    out[3 * i + 1] = s.cw[4 * i + 1]!;
    out[3 * i + 2] = s.cw[4 * i + 2]!;
  }
  return out;
}

/** The plan curve of a band row. */
function planOf(row: PeriodicCurve<3>): PeriodicCurve<2> {
  const n = row.basis.count;
  const pts = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    pts[2 * i] = row.cw[4 * i]!;
    pts[2 * i + 1] = row.cw[4 * i + 1]!;
  }
  return makeCurve({ dim: 2, basis: row.basis, points: pts }) as PeriodicCurve<2>;
}

/** The feasible apex interval of a virtual column at `u` (§5.3, `apexBounds`). */
function boundsAt(ctx: BandContext, u: number, sigma: number): readonly [number, number] | null {
  const frame = planFrame(ctx.plan, u, ctx.symmetric);
  if (frame === null) return null;
  const q = new Float64Array(2);
  curveEvalInto(
    ctx.plan,
    u,
    0,
    q,
    0,
    createScratch({ maxDegree: ctx.plan.basis.degree, maxDerivs: 0 }),
  );
  const col = columnAt(ctx, q[0]!, q[1]!, frame, u, sigma);
  const p = col.profile;
  return apexBounds(
    p.points[2]!,
    p.points[20]!,
    p.sd,
    p.sb,
    col.laws.deckInset,
    col.laws.tuckInset,
    ctx.doc.build,
  );
}

/**
 * The feasible apex interval at loop parameter `u` for the effective insets
 * `wd`, `wt` (law values, capped by the curvature limit as the build caps them).
 */
function boundsWith(
  ctx: BandContext,
  u: number,
  wdLaw: number,
  wtLaw: number,
): readonly [number, number] | null {
  const frame = planFrame(ctx.plan, u, ctx.symmetric);
  if (frame === null) return null;
  const cap = ctx.doc.build.insetCurvatureFraction * insetRadiusAt(ctx.plan, u);
  const wd = Math.min(wdLaw, cap);
  const wt = Math.min(wtLaw, cap);
  const q = new Float64Array(2);
  curveEvalInto(
    ctx.plan,
    u,
    0,
    q,
    0,
    createScratch({ maxDegree: ctx.plan.basis.degree, maxDerivs: 0 }),
  );
  const n = frame.inward;
  try {
    const D = ctx.deckAt(q[0]! + wd * n.x, q[1]! + wd * n.y);
    const B = ctx.bottomAt(q[0]! + wt * n.x, q[1]! + wt * n.y);
    const sd = -(D.dzdx * n.x + D.dzdy * n.y);
    const sb = -(B.dzdx * n.x + B.dzdy * n.y);
    return apexBounds(D.z, B.z, sd, sb, wd, wt, ctx.doc.build);
  } catch {
    return null;
  }
}

function withLaws(doc: BoardDoc, laws: Partial<RailLaws>): BoardDoc {
  return { ...doc, laws: { ...doc.laws, ...laws } };
}

function pass(doc: BoardDoc, b: BandBasis): { ctx: BandContext; p: BandPass } {
  const ctx = bandContext(doc);
  return { ctx, p: bandPass(ctx, b) };
}

/** The errors of `issues`, their messages prefixed with the rail stage that met them. */
const errorsOf = (issues: readonly Board2Issue[], stage = ''): Board2Issue[] =>
  issues
    .filter((i) => i.severity === 'error')
    .map((i) => (stage === '' ? i : { ...i, message: `${stage}: ${i.message}` }));

/**
 * The rail stage (module comment) on the geometry of `convertGeometry`.
 * `board`'s classic loft gives the initial apex; returns the document or the
 * issues that stopped it.
 */
export function fitRail(
  g: ClassicGeometry,
  o: ConvertOptions,
): { ok: true; value: RailStage } | { ok: false; issues: readonly Board2Issue[] } {
  const timings: Record<string, number> = {};
  let clock = performance.now();
  const lap = (name: string): void => {
    const now = performance.now();
    timings[name] = now - clock;
    clock = now;
  };
  const draft = g.doc;
  const build = draft.build;
  const tol: Tolerances = resolveTolerances(build.tolerances);
  const ctx0 = bandContext(draft);
  const b0 = stationBasis(ctx0.plan, ctx0.arc, build, ctx0.symmetric, tol);
  const keys = stationKeys(ctx0.plan, g.stations, tol);
  const sigmas = [0, ...keys.map((k) => k.s), 0.5];
  const us = [0, ...keys.map((k) => k.u), 0.5];

  // 1. Initial apex law from the classic's apex at the stations.
  const loft = g.loft;
  /** The classic apex z at board2 x: the rows' exact apexes, linear in x between rows; null outside them. */
  const classicApex = (x: number): number | null => {
    const xc = x + g.shift;
    const n = loft.x.length;
    if (n === 0 || !(xc >= loft.x[0]! && xc <= loft.x[n - 1]!)) return null;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (loft.x[mid]! <= xc) lo = mid;
      else hi = mid;
    }
    const x0 = loft.x[lo]!;
    const x1 = loft.x[hi]!;
    const t = x1 > x0 ? (xc - x0) / (x1 - x0) : 0;
    return loft.apexZ[lo]! + t * (loft.apexZ[hi]! - loft.apexZ[lo]!);
  };
  const range = build.apexHeightRange as readonly [number, number];
  const keyValues = keys.map((k) => {
    const frame = planFrame(ctx0.plan, k.u, true)!;
    const q = new Float64Array(2);
    curveEvalInto(ctx0.plan, k.u, 0, q, 0, createScratch({ maxDegree: 3, maxDerivs: 0 }));
    const col = columnAt(ctx0, q[0]!, q[1]!, frame, k.u, k.s);
    const ez = col.profile.points[2]!;
    const tz = col.profile.points[20]!;
    const bounds = boundsAt(ctx0, k.u, k.s) ?? range;
    const z = classicApex(k.x);
    const alpha = z === null ? 0.5 * (bounds[0] + bounds[1]) : (z - tz) / (ez - tz);
    return clampTo(alpha, bounds);
  });
  const tipValue = (u: number, s: number, neighbour: number | undefined): number => {
    const bounds = boundsAt(ctx0, u, s) ?? range;
    return clampTo(neighbour ?? 0.5 * (bounds[0] + bounds[1]), bounds);
  };
  const keyed = (law: LawCurve): { s: number; value: number }[] =>
    law.keys.map((k) => ({ s: k.s, value: k.value }));
  const lanes = {
    apexHeight: [
      { s: 0, value: tipValue(0, 0, keyValues[0]) },
      ...keys.map((k, i) => ({ s: k.s, value: keyValues[i]! })),
      { s: 0.5, value: tipValue(0.5, 0.5, keyValues[keyValues.length - 1]) },
    ],
    deckInset: keyed(draft.laws.deckInset),
    tuckInset: keyed(draft.laws.tuckInset),
  };
  const lawsOf = (): Partial<RailLaws> => ({
    apexHeight: { domain: 'half', keys: lanes.apexHeight.map((k) => ({ ...k })) },
    deckInset: { domain: 'half', keys: lanes.deckInset.map((k) => ({ ...k })) },
    tuckInset: { domain: 'half', keys: lanes.tuckInset.map((k) => ({ ...k })) },
  });
  const setKey = (lane: keyof typeof lanes, s: number, value: number): boolean => {
    const l = lanes[lane];
    const same = l.find((k) => k.s === s);
    if (same !== undefined) {
      same.value = value;
      return false;
    }
    l.push({ s, value });
    l.sort((p, q) => p.s - q.s);
    return true;
  };
  let doc1 = withLaws(draft, lawsOf());
  let initial = pass(doc1, b0);
  let initialApexKeysAdded = 0;
  let insetKeysAdded = 0;
  for (let round = 0; ; round++) {
    const errors = errorsOf(initial.p.issues);
    if (errors.length === 0) break;
    const bad = errors.filter(
      (e) => e.code === 'rail-profile-invalid' && e.at?.sigma !== undefined,
    );
    if (bad.length < errors.length || round >= o.maxRefinePasses)
      return { ok: false, issues: errorsOf(errors, 'initial band') };
    const apexAt = lawEvaluator(doc1.laws.apexHeight, tol);
    const deckAt = lawEvaluator(doc1.laws.deckInset, tol);
    const tuckAt = lawEvaluator(doc1.laws.tuckInset, tol);
    for (const s of new Set(bad.map((e) => e.at!.sigma!))) {
      const u = paramAtSigma(initial.ctx.arc, s, tol);
      // No apex height fits between the corner triangles: halve both insets
      // there until one does (or both reach minInset), then the apex.
      let wd = deckAt(s);
      let wt = tuckAt(s);
      let bounds = boundsWith(initial.ctx, u, wd, wt);
      while (bounds === null && (wd > build.minInset || wt > build.minInset)) {
        wd = Math.max(build.minInset, wd / 2);
        wt = Math.max(build.minInset, wt / 2);
        bounds = boundsWith(initial.ctx, u, wd, wt);
      }
      if (wd !== deckAt(s)) {
        setKey('deckInset', s, wd);
        setKey('tuckInset', s, wt);
        insetKeysAdded++;
      }
      if (setKey('apexHeight', s, clampTo(apexAt(s), bounds ?? range))) initialApexKeysAdded++;
    }
    doc1 = withLaws(draft, lawsOf());
    initial = pass(doc1, b0);
  }
  // The fit's basis: the initial design's, refined by the build until its band
  // meets the build's targets (§5.4): the boundary rows' z-fits among them, which
  // the fitted band shares (rows 0 and 6 are fixed). From here on the document
  // carries that basis as its plan's knots (the same curve, refined exactly), so
  // every later pass, and the final document's build, computes the same columns
  // (σ, frames) bitwise from the same plan JSON.
  const refined = buildBand(doc1);
  const planDoc: BoardDoc = {
    ...doc1,
    plan: planLoopJSON(refined.ok ? refined.value.basis.apexPlan : b0.apexPlan),
  };
  const fitCtx = bandContext(planDoc);
  const b = stationBasis(fitCtx.plan, fitCtx.arc, build, fitCtx.symmetric, tol);
  const columns: readonly Column[] = bandColumns(b, fitCtx.arc);
  lap('initial band');

  // 2. The apex law: the classic apex curve (the outline's height) at every
  // column outside the tip windows, keyed adaptively.
  const inWindow = windowTest(g.stations, g.zones, g.length, o);
  const inTip = (x: number): boolean => x <= o.tipWindow || x >= g.length - o.tipWindow;
  const inp = columnInputs(fitCtx, b, columns);
  const apexPlan = new Float64Array(2 * b.basis.count);
  controlPointsInto(b.apexPlan, apexPlan, 0);
  const targets: { sigma: number; value: number }[] = [];
  columns.forEach((c, i) => {
    const x = apexPlan[2 * i]!;
    const z = c.role === 'partner' || inTip(x) ? null : classicApex(x);
    if (z === null) return;
    const bounds =
      apexBounds(inp.ez[i]!, inp.tz[i]!, inp.sd[i]!, inp.sb[i]!, inp.wd[i]!, inp.wt[i]!, build) ??
      range;
    targets.push({
      sigma: c.sigma,
      value: clampTo((z - inp.tz[i]!) / (inp.ez[i]! - inp.tz[i]!), bounds),
    });
  });
  const apex = adaptiveLaw(lanes.apexHeight, targets, build.lawTolerance.apexHeight, tol);
  const doc2 = withLaws(planDoc, { apexHeight: apex.law });
  const second = pass(doc2, b);
  if (errorsOf(second.p.issues).length > 0)
    return { ok: false, issues: errorsOf(second.p.issues, 'apex law') };
  lap('apex law');

  // 3. Data and the fit, the apex fixed at its law.
  const samples = bandSamples(
    loft,
    g.shift,
    rowClassifier(planOf(second.p.deckEdge), tol),
    rowClassifier(planOf(second.p.tuck), tol),
    inWindow,
    inTip,
    fitCtx.plan,
  );
  const uv0 = projectSamples(second.p.band, samples.points, samples.seeds, tol).uv;
  lap('band data');
  const fMin = build.fullnessRange[0];
  // Displacements vary no faster than the data rows can see (band-fit.ts).
  const minSigma = o.sampleSpacingX / fitCtx.arc.total;
  const frame2 = bandFitFrame(
    b,
    columns,
    netOf(second.p.band),
    inp,
    fMin,
    tol.point,
    minSigma,
    inTip,
  );
  const fit2 = fitBand(
    frame2,
    samples,
    uv0,
    { maxPasses: o.maxBandCorrectionPasses, stallRel: o.bandCorrectionStall },
    o,
    tol,
  );
  lap('band fit');

  // 4. The other lanes at the stations and tips.
  const band2 = bandSurface(frame2, fit2.net);
  const measured = us.map((u) => measuredLanes(second.ctx, band2, u));
  const lane = (name: 'upperFullness' | 'lowerFullness' | 'edgeHardness'): LawCurve =>
    keyedLaw(
      sigmas,
      measured.map((m) => inLane(name, m[name], build)),
    );
  const doc3 = withLaws(doc2, {
    upperFullness: lane('upperFullness'),
    lowerFullness: lane('lowerFullness'),
    edgeHardness: lane('edgeHardness'),
  });
  const third = pass(doc3, b);
  if (errorsOf(third.p.issues).length > 0)
    return { ok: false, issues: errorsOf(third.p.issues, 'profile laws') };

  // 5. Offsets. The document builds without refinement, so its band is the
  // fitted band on that basis (§9.7 item 6; S7 as built): `convertClassic`
  // measures the identity on its build.
  const offsets = offsetLayer(columns, inp, fit2.net, netOf(third.p.band), fitCtx.symmetric, tol);
  const doc: BoardDoc = {
    ...doc3,
    offsets,
    build: { ...doc3.build, maxBandRefinePasses: 0 },
  };
  lap('laws and offsets');

  return {
    ok: true,
    value: {
      doc,
      fitted: fit2.net,
      basis: b,
      fit: fit2,
      samples: samples.judged.length,
      data: samples,
      initialApexKeysAdded,
      insetKeysAdded,
      apexKeysAdded: apex.added,
      stationLaws: keys.map((k, i) => ({ sigma: k.s, x: k.x, laws: measured[i + 1]! })),
      timings,
    },
  };
}

/** A `not-converged` warning when the refitted band misses `surfaceTol` on its judged samples. */
export function bandIssues(r: RailStage, o: ConvertOptions): readonly Board2Issue[] {
  return r.fit.judgedMax > o.surfaceTol
    ? [
        makeIssue(
          'not-converged',
          `rail band (judged samples): distance ${r.fit.judgedMax} cm above the target ${o.surfaceTol} cm`,
          { severity: 'warning', value: r.fit.judgedMax },
        ),
      ]
    : [];
}
