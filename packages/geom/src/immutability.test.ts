// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cross-cutting properties of every public operation (design §4.8, §8, §16):
 *
 * - **Immutability.** The checksum of every input (curves, bases, arrays,
 *   points, tolerance records) is the same before and after the call, on random
 *   clamped and periodic, polynomial and rational geometry. Typed arrays cannot
 *   be frozen, so this is the runtime proof that geom never writes an input.
 * - **Finiteness.** Every number in every output is finite (never NaN).
 * - **Frozen results.** Validated records (bases, curves, tables) are frozen.
 *
 * Scratch buffers and `*Into` output buffers are written by contract, so they
 * are not checksummed; everything else passed in is.
 *
 * The table must list every runtime export of the main entry (checked below),
 * so a new public function cannot skip these properties.
 */
import { describe, expect, it } from 'vitest';
import * as geom from './index';
import {
  arcLengthTable,
  basisDersInto,
  basisFunction,
  basisFunsInto,
  bezierCurve,
  breakpoints,
  circle,
  circle2,
  circleArc,
  clampedBasis,
  clampedUniformKnots,
  clampUnclamped,
  conicArc,
  controlPoint,
  controlPointsInto,
  controlWeight,
  createScratch,
  curveBounds,
  curveCurvature,
  curveCurvatureBatchInto,
  curveDerivatives,
  curveDomain,
  curveEvalBatchInto,
  curveEvalInto,
  curveFrame,
  curveFromHomogeneous,
  curveLength,
  curvePoint,
  curveSignedCurvature,
  curveTangent,
  curveToJSON,
  DEFAULT_TOLERANCES,
  findSpan,
  GeomError,
  gaussLegendre,
  integrate1d,
  isClosed,
  isGeomError,
  issueOf,
  knotMultiplicities,
  knotsFromBreaks,
  lengthAtParam,
  line,
  line2,
  makeCurve,
  mergeNearKnots,
  paramAtLength,
  periodicBasis,
  periodicCircle,
  periodicUniformKnots,
  polyline,
  resolveTolerances,
  reviveCurve,
  scaleTolerances,
  transformCurve,
  transformCurve2,
  vec,
  weightsInto,
  withControlPoints,
  withWeights,
  bezierSurface,
  bilinearPatch,
  boundaryCurve,
  changedControlPoints,
  cylinder,
  evalCurvePlan,
  evalCurvePlanDirty,
  evalSurfacePlan,
  evalSurfacePlanDirty,
  extrude,
  fundamentalForms,
  fundamentalFormsInto,
  isoCurve,
  limitNormal,
  makeSurface,
  normalCurvature,
  planCurveSamples,
  planMatches,
  planSurfaceSamples,
  planeSurface,
  principalCurvatures,
  reviveSurface,
  revolve,
  SAMPLE_DEGENERATE,
  SAMPLE_UMBILIC,
  sphere,
  surfaceBounds,
  surfaceControlPoint,
  surfaceControlWeight,
  surfaceDerivatives,
  surfaceDomain,
  surfaceEvalGridInto,
  surfaceEvalInto,
  surfaceFromHomogeneous,
  surfaceNormal,
  surfacePoint,
  surfaceToJSON,
  torus,
  transformSurface,
  withSurfaceControlNet,
  withSurfaceControlPoints,
  withSurfaceWeights,
  closestPointOnCurve,
  closestPointOnSurface,
  curveOnSurface,
  curveOnSurfaceDerivatives,
  curveOnSurfaceEvalInto,
  curveOnSurfacePoint,
  DEFAULT_PROJECTION_SEEDING,
  isoLinePcurve,
  projectCurveSamplesToSurface,
  projectPointsToCurveInto,
  projectPointsToSurfaceInto,
  checkTriangulation,
  checkTrimLoops,
  classifyUV,
  closestPointOnTrimmed,
  constrainedDelaunay,
  DEFAULT_TESSELLATION,
  enclosedVolume,
  incircle,
  integrateTrimmed,
  makeTrimLoop,
  makeTrimmedSurface,
  naturalBoundaryLoop,
  orient2d,
  retargetTessellation,
  surfaceArea,
  tessellateTrimmedSurface,
  boundaryContinuity,
  classifyContinuity,
  curveJoinContinuity,
  DEFAULT_CONTINUITY_SAMPLING,
  edgeContinuity,
  knotContinuity,
} from './index';
import type { Affine2, Affine3, NurbsCurve, Result, TrimLoop } from './index';
import { checksum, mulberry32, randomCurve, randomSurface } from './testing';

/** Every number reachable from `v` (typed arrays included). */
function numbers(v: unknown, out: number[] = [], seen = new Set<object>()): number[] {
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'object' && v !== null && !seen.has(v)) {
    seen.add(v);
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      // A loop, not a spread: a mesh's arrays exceed the call-stack argument limit.
      const a = v as unknown as ArrayLike<number>;
      for (let i = 0; i < a.length; i++) out.push(Number(a[i]));
    } else for (const x of Object.values(v)) numbers(x, out, seen);
  }
  return out;
}

interface Case {
  /** Public export exercised. */
  readonly name: string;
  /** Inputs that must not change. */
  readonly inputs: readonly unknown[];
  /** Runs the operation on those inputs (plus any scratch or output buffers). */
  readonly run: () => unknown;
  /** Result records that must be frozen (default: none checked). */
  readonly frozen?: (r: unknown) => readonly unknown[];
}

const same = (r: unknown): readonly unknown[] => [r];

function valueOf<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

/** The operation table for one random geometry seed. */
function cases(seed: number): Case[] {
  const rng = mulberry32(seed);
  const rational = seed % 2 === 1;
  const kind = seed % 3 === 0 ? 'periodic' : 'clamped';
  const weightRange = rational ? ([0.4, 2.5] as const) : undefined;
  const c3 = randomCurve(rng, {
    dim: 3,
    degree: 3,
    count: 8,
    kind,
    maxMult: 2,
    weightRange,
  }) as NurbsCurve<3>;
  const c2 = randomCurve(rng, { dim: 2, degree: 2, count: 7, kind, weightRange }) as NurbsCurve<2>;
  const c1 = randomCurve(rng, { dim: 1, degree: 4, count: 9, kind, weightRange }) as NurbsCurve<1>;
  const b = c3.basis;
  const [a, e] = curveDomain(c3);
  const t = a + rng() * (e - a);
  const ts = Float64Array.from({ length: 16 }, () => a + rng() * (e - a)).sort();
  const knots = Float64Array.from(b.knots);
  const s = createScratch({ maxDegree: 4 });
  const out = new Float64Array(256);
  const out32 = new Float32Array(256);
  const pts3 = Float64Array.from({ length: 24 }, () => 2 * rng() - 1);
  const w8 = Float64Array.from({ length: 8 }, () => 0.5 + rng());
  const m3: Affine3 = [1, 2, 0, 1, 0, 1, 3, -1, 2, 0, 1, 0.5];
  const m2: Affine2 = [2, 1, 0, -1, 1, 3];
  const P = { x: 1, y: 2, z: 3 };
  const Q = { x: -1, y: 0.5, z: 2 };
  const X = { x: 1, y: 0, z: 0 };
  const Y = { x: 0.2, y: 1, z: 0 };
  const P2 = { x: 1, y: -1 };
  const Q2 = { x: 3, y: 2 };
  const tol = { quadRel: 1e-9 };
  const table = arcLengthTable(c3);
  const err = new GeomError('knot-count', 'x', { index: 1 });
  const unclamped = Float64Array.from({ length: 12 }, (_, i) => i + 0.25 * rng());
  const homog = Float64Array.from(c3.cw as Float64Array);
  const json = curveToJSON(c2);
  const clone = structuredClone(c3);
  const f = (x: number): number => Math.sin(x) + x * x;
  const breaks = [0.3, 0.7];
  const pkt = periodicUniformKnots(5, 2);
  // Surfaces (F2).
  const S = randomSurface(rng, {
    degreeU: 3,
    degreeV: 2,
    countU: 6,
    countV: 5,
    kindU: kind,
    kindV: seed % 4 === 1 ? 'periodic' : 'clamped',
    basis: { maxMult: 2 },
    weightRange,
  });
  const clampedS = randomSurface(rng, {
    degreeU: 2,
    degreeV: 2,
    countU: 4,
    countV: 4,
    weightRange,
  });
  const [su0, su1] = S.u.domain;
  const [sv0, sv1] = S.v.domain;
  const u = su0 + rng() * (su1 - su0);
  const v = sv0 + rng() * (sv1 - sv0);
  const us = Float64Array.from({ length: 5 }, () => su0 + rng() * (su1 - su0)).sort();
  const vs = Float64Array.from({ length: 4 }, () => sv0 + rng() * (sv1 - sv0));
  const sPts = Float64Array.from({ length: 90 }, () => 2 * rng() - 1);
  const sW = Float64Array.from({ length: 30 }, () => 0.5 + rng());
  const sCw = Float64Array.from(S.cw as Float64Array);
  const sJson = JSON.parse(JSON.stringify(geom.surfaceToJSON(S))) as unknown;
  const sClone = structuredClone(S);
  const uvs = Float64Array.from({ length: 24 }, (_, k) =>
    k % 2 ? sv0 + rng() * (sv1 - sv0) : su0 + rng() * (su1 - su0),
  );
  const plan = planSurfaceSamples(S, uvs, 2);
  const cplan = planCurveSamples(c3, ts, 2);
  const S2 = withSurfaceControlPoints(S, [0.1, 0.2, 0.3], [7]);
  const changed = changedControlPoints(S, S2);
  const touched = new Int32Array(64);
  const dir = { x: 0.3, y: -1, z: 2 };
  // Projection and curves on surfaces (B1).
  const pcurve = geom.line2(
    { x: su0 + 0.2 * (su1 - su0), y: sv0 + 0.7 * (sv1 - sv0) },
    { x: su0 + 0.9 * (su1 - su0), y: sv0 + 0.1 * (sv1 - sv0) },
  );
  const cos = curveOnSurface(S, pcurve);
  const seeding = { oversample: 3 };
  const pts2 = Float64Array.from({ length: 8 }, () => 2 * rng() - 1);
  const uvSeeds = Float64Array.from({ length: 16 }, (_, k) => (k % 2 ? v : u));
  const iso = isoCurve(S, 'v', v);
  const sOut = (): Record<string, Float64Array | Uint8Array> => ({
    position: new Float64Array(36),
    normal: new Float64Array(36),
    curvature: new Float64Array(24),
    derivatives: new Float64Array(216),
    flags: new Uint8Array(12),
  });
  const cOut = (): Record<string, Float64Array | Uint8Array> => ({
    position: new Float64Array(48),
    derivatives: new Float64Array(144),
    curvature: new Float64Array(16),
    flags: new Uint8Array(16),
  });
  // Trimmed surfaces, integration and tessellation (B2), on the clamped surface:
  // a circle (rational) outer loop and a clockwise triangle (polynomial) hole.
  const [cu0, cu1] = clampedS.u.domain;
  const [cv0, cv1] = clampedS.v.domain;
  const at = (x: number, y: number): { x: number; y: number } => ({
    x: cu0 + x * (cu1 - cu0),
    y: cv0 + y * (cv1 - cv0),
  });
  const circ = geom.transformCurve2(geom.circle2({ x: 0, y: 0 }, 1), [
    0.4 * (cu1 - cu0),
    0,
    at(0.5, 0.5).x,
    0,
    0.4 * (cv1 - cv0),
    at(0.5, 0.5).y,
  ]);
  const tri = [at(0.45, 0.45), at(0.5, 0.6), at(0.6, 0.45)];
  const triCurves = [0, 1, 2].map((k) => geom.line2(tri[k]!, tri[(k + 1) % 3]!));
  const outerLoop: TrimLoop = valueOf(makeTrimLoop([circ]));
  const holeLoop: TrimLoop = valueOf(makeTrimLoop(triCurves));
  const trimmed = valueOf(makeTrimmedSurface(clampedS, outerLoop, [holeLoop]));
  const natural = valueOf(makeTrimmedSurface(S, null));
  const meshOpts = { chordTol: 0.05, angleTol: 0.5 };
  const faceMesh = valueOf(tessellateTrimmedSurface(trimmed, meshOpts));
  const cdtIn = {
    points: Float64Array.from([0, 0, 4, 0, 4, 3, 0, 3, 1, 1, 2, 2, 3, 1]),
    segments: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 4]), // outer CCW, hole CW
  };
  const cdt = valueOf(constrainedDelaunay(cdtIn));
  // Continuity (B3): a crease along an interior iso-line of the clamped surface
  // (the two sides of the same line), and a boundary against itself.
  const cMid = cv0 + 0.4 * (cv1 - cv0);
  const isoEdge = isoCurve(clampedS, 'v', cMid) as NurbsCurve<3>;
  const sideL = {
    surface: clampedS,
    pcurve: isoLinePcurve(clampedS, 'v', cMid),
    sameSense: true,
    interior: 'left' as const,
  };
  const sideR = { ...sideL, sameSense: false, interior: 'right' as const };
  const contOpts = { samplesPerSpan: 2, refineSteps: 6 };
  const bSide = { surface: clampedS, edge: 'u1' as const, sameSense: true };
  const thresholds = { gap: 1e-3, angle: 1e-2, curvatureRel: 0.1, curvatureAbs: 1e-3 };

  return [
    {
      name: 'DEFAULT_TOLERANCES',
      inputs: [DEFAULT_TOLERANCES],
      run: () => DEFAULT_TOLERANCES,
      frozen: same,
    },
    { name: 'resolveTolerances', inputs: [tol], run: () => resolveTolerances(tol), frozen: same },
    {
      name: 'scaleTolerances',
      inputs: [DEFAULT_TOLERANCES],
      run: () => scaleTolerances(DEFAULT_TOLERANCES, 10),
      frozen: same,
    },
    {
      name: 'GeomError',
      inputs: [],
      run: () => new GeomError('unsupported', 'x', { value: 1 }).details,
      frozen: same,
    },
    { name: 'isGeomError', inputs: [err], run: () => isGeomError(err, 'knot-count') },
    { name: 'issueOf', inputs: [err], run: () => issueOf(err) },
    { name: 'createScratch', inputs: [], run: () => createScratch({ maxDegree: 3 }), frozen: same },
    {
      name: 'vec',
      inputs: [P, Q, P2, Q2, m3, m2],
      run: () => [
        vec.add(P, Q),
        vec.sub(P2, Q2),
        vec.scale(P, 2),
        vec.dot(P, Q),
        vec.cross(P, Q),
        vec.norm(P),
        vec.distance(P, Q),
        vec.lerp(P2, Q2, 0.3),
        vec.normalize(Q),
        vec.angleBetween(P, Q),
        vec.applyAffine3(m3, P),
        vec.applyAffine2(m2, P2),
        vec.affineDeterminant(m3),
        vec.composeAffine3(m3, m3),
      ],
    },
    {
      name: 'clampedBasis',
      inputs: [knots],
      run: () => (kind === 'clamped' ? clampedBasis(3, knots) : null),
      frozen: same,
    },
    { name: 'periodicBasis', inputs: [pkt], run: () => periodicBasis(2, pkt, 2), frozen: same },
    { name: 'clampedUniformKnots', inputs: [], run: () => clampedUniformKnots(3, 9, [-1, 2]) },
    { name: 'periodicUniformKnots', inputs: [], run: () => periodicUniformKnots(7, 3) },
    {
      name: 'knotsFromBreaks',
      inputs: [breaks],
      run: () => knotsFromBreaks([0, ...breaks, 1], [3, 1, 2, 3]),
    },
    { name: 'knotMultiplicities', inputs: [b], run: () => knotMultiplicities(b), frozen: same },
    { name: 'mergeNearKnots', inputs: [knots], run: () => mergeNearKnots(knots), frozen: same },
    { name: 'breakpoints', inputs: [b], run: () => breakpoints(b) },
    { name: 'findSpan', inputs: [b], run: () => findSpan(b, t, 'left') },
    {
      name: 'basisFunsInto',
      inputs: [b],
      run: () => {
        basisFunsInto(b, findSpan(b, t), t, out, 0, s);
        return out.slice(0, 4);
      },
    },
    {
      name: 'basisDersInto',
      inputs: [b],
      run: () => {
        basisDersInto(b, findSpan(b, t), t, 3, out, 0, s);
        return out.slice(0, 16);
      },
    },
    { name: 'basisFunction', inputs: [b], run: () => basisFunction(b, 2, t) },
    {
      name: 'makeCurve',
      inputs: [b, pts3, w8],
      run: () => makeCurve({ dim: 3, basis: b, points: pts3, weights: w8 }),
      frozen: same,
    },
    {
      name: 'curveFromHomogeneous',
      inputs: [b, homog],
      run: () => curveFromHomogeneous({ dim: 3, basis: b, cw: homog }),
      frozen: same,
    },
    { name: 'bezierCurve', inputs: [pts3, w8], run: () => bezierCurve(3, pts3, w8), frozen: same },
    {
      name: 'clampUnclamped',
      inputs: [unclamped, pts3, w8],
      run: () =>
        clampUnclamped({
          dim: 2,
          degree: 3,
          knots: unclamped,
          points: pts3.subarray(0, 16),
          weights: w8,
        }),
      frozen: same,
    },
    {
      name: 'reviveCurve',
      inputs: [clone, json],
      run: () => [reviveCurve(clone), reviveCurve(json)],
      frozen: (r) => r as unknown[],
    },
    { name: 'curveToJSON', inputs: [c2], run: () => curveToJSON(c2), frozen: same },
    { name: 'controlPoint', inputs: [c3], run: () => controlPoint(c3, 1) },
    { name: 'controlWeight', inputs: [c3], run: () => controlWeight(c3, 1) },
    {
      name: 'controlPointsInto',
      inputs: [c2],
      run: () => {
        controlPointsInto(c2, out, 3);
        return out.slice(3, 3 + 14);
      },
    },
    {
      name: 'weightsInto',
      inputs: [c2],
      run: () => {
        weightsInto(c2, out);
        return out.slice(0, 7);
      },
    },
    {
      name: 'withControlPoints',
      inputs: [c3, pts3],
      run: () => [withControlPoints(c3, pts3), withControlPoints(c3, pts3.subarray(0, 6), [2, 5])],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'withWeights',
      inputs: [c3, w8],
      run: () => [withWeights(c3, w8), withWeights(c3, w8.subarray(0, 1), [4])],
      frozen: (r) => r as unknown[],
    },
    { name: 'curveDomain', inputs: [c3], run: () => curveDomain(c3), frozen: same },
    { name: 'isClosed', inputs: [c3], run: () => isClosed(c3, { point: 1e-3 }) },
    { name: 'curvePoint', inputs: [c1, c3], run: () => [curvePoint(c1, t), curvePoint(c3, t)] },
    {
      name: 'curveDerivatives',
      inputs: [c3],
      run: () => curveDerivatives(c3, t, 3, 'left'),
      frozen: same,
    },
    {
      name: 'curveEvalInto',
      inputs: [c3],
      run: () => {
        curveEvalInto(c3, t, 3, out, 0, s);
        return out.slice(0, 12);
      },
    },
    {
      name: 'curveEvalBatchInto',
      inputs: [c3, ts],
      run: () => {
        curveEvalBatchInto(c3, ts, 2, out32, s);
        return out32.slice(0, ts.length * 9);
      },
    },
    { name: 'transformCurve', inputs: [c3, m3], run: () => transformCurve(c3, m3), frozen: same },
    { name: 'transformCurve2', inputs: [c2, m2], run: () => transformCurve2(c2, m2), frozen: same },
    { name: 'curveTangent', inputs: [c3], run: () => curveTangent(c3, t) },
    { name: 'curveCurvature', inputs: [c3], run: () => curveCurvature(c3, t) },
    { name: 'curveSignedCurvature', inputs: [c2], run: () => curveSignedCurvature(c2, t) },
    {
      name: 'curveCurvatureBatchInto',
      inputs: [c2, ts],
      run: () => {
        curveCurvatureBatchInto(c2, ts, out, s);
        return out.slice(0, ts.length);
      },
    },
    { name: 'curveFrame', inputs: [c3, tol], run: () => curveFrame(c3, t, tol) },
    {
      name: 'curveLength',
      inputs: [c3, tol],
      run: () => curveLength(c3, [a, t], tol),
      frozen: same,
    },
    { name: 'arcLengthTable', inputs: [c2], run: () => arcLengthTable(c2), frozen: same },
    { name: 'lengthAtParam', inputs: [c3, table], run: () => lengthAtParam(c3, table, t) },
    {
      name: 'paramAtLength',
      inputs: [c3, table],
      run: () => paramAtLength(c3, table, table.total / 3),
    },
    { name: 'curveBounds', inputs: [c3], run: () => curveBounds(c3), frozen: same },
    { name: 'GL_MAX_ORDER', inputs: [], run: () => geom.GL_MAX_ORDER },
    {
      name: 'gaussLegendre',
      inputs: [gaussLegendre(9)],
      run: () => gaussLegendre(9),
      frozen: same,
    },
    {
      name: 'integrate1d',
      inputs: [breaks, tol],
      run: () => integrate1d(f, 0, 1, { breaks, tol }),
      frozen: same,
    },
    { name: 'line', inputs: [P, Q], run: () => line(P, Q), frozen: same },
    { name: 'line2', inputs: [P2, Q2], run: () => line2(P2, Q2), frozen: same },
    { name: 'polyline', inputs: [pts3], run: () => polyline(pts3, 3, true), frozen: same },
    { name: 'circleArc', inputs: [P, X, Y], run: () => circleArc(P, X, Y, 2, -1, 3), frozen: same },
    { name: 'circle', inputs: [P, X, Y], run: () => circle(P, X, Y, 2), frozen: same },
    {
      name: 'circle2',
      inputs: [P2],
      run: () => [circle2(P2, 2), circle2(P2, 2, [0, 1])],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'periodicCircle',
      inputs: [P, X, Y],
      run: () => periodicCircle(P, X, Y, 2),
      frozen: same,
    },
    { name: 'conicArc', inputs: [P, Q, X], run: () => conicArc(P, Q, X, 0.3), frozen: same },
    // Surfaces (F2)
    {
      name: 'makeSurface',
      inputs: [S.u, S.v, sPts, sW],
      run: () => makeSurface({ u: S.u, v: S.v, points: sPts, weights: sW }),
      frozen: same,
    },
    {
      name: 'surfaceFromHomogeneous',
      inputs: [S.u, sCw],
      run: () => surfaceFromHomogeneous({ u: S.u, v: S.v, cw: sCw }),
      frozen: same,
    },
    {
      name: 'reviveSurface',
      inputs: [sJson, sClone],
      run: () => [reviveSurface(sJson), reviveSurface(sClone)],
      frozen: (r) => r as unknown[],
    },
    { name: 'surfaceToJSON', inputs: [S], run: () => surfaceToJSON(S), frozen: same },
    { name: 'surfaceControlPoint', inputs: [S], run: () => surfaceControlPoint(S, 1, 2) },
    { name: 'surfaceControlWeight', inputs: [S], run: () => surfaceControlWeight(S, 1, 2) },
    {
      name: 'withSurfaceControlPoints',
      inputs: [S, sPts],
      run: () => [
        withSurfaceControlPoints(S, sPts),
        withSurfaceControlPoints(S, sPts.subarray(0, 6), [3, 9]),
      ],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'withSurfaceWeights',
      inputs: [S, sW],
      run: () => [withSurfaceWeights(S, sW), withSurfaceWeights(S, sW.subarray(0, 1), [4])],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'withSurfaceControlNet',
      inputs: [S, sCw],
      run: () => withSurfaceControlNet(S, sCw),
      frozen: same,
    },
    { name: 'surfaceDomain', inputs: [S], run: () => surfaceDomain(S), frozen: same },
    { name: 'surfacePoint', inputs: [S], run: () => surfacePoint(S, u, v) },
    {
      name: 'surfaceDerivatives',
      inputs: [S],
      run: () => [surfaceDerivatives(S, u, v, 2, { u: 'left' }), surfaceDerivatives(S, u, v, 1)],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'surfaceEvalInto',
      inputs: [S],
      run: () => {
        surfaceEvalInto(S, u, v, 2, out, 1, s, { v: 'left' });
        return out.slice(1, 19);
      },
    },
    {
      name: 'surfaceEvalGridInto',
      inputs: [S, us, vs],
      run: () => {
        const g = new Float64Array(360);
        const g32 = new Float32Array(180);
        surfaceEvalGridInto(S, us, vs, 2, g, s);
        surfaceEvalGridInto(S, us, vs, 1, g32, s);
        return [g, g32];
      },
    },
    {
      name: 'isoCurve',
      inputs: [S],
      run: () => [isoCurve(S, 'u', u), isoCurve(S, 'v', v)],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'boundaryCurve',
      inputs: [clampedS],
      run: () => [boundaryCurve(clampedS, 'u0'), boundaryCurve(clampedS, 'v1')],
      frozen: (r) => r as unknown[],
    },
    { name: 'transformSurface', inputs: [S, m3], run: () => transformSurface(S, m3), frozen: same },
    { name: 'surfaceBounds', inputs: [S], run: () => surfaceBounds(S), frozen: same },
    {
      name: 'surfaceNormal',
      inputs: [S, tol],
      run: () => surfaceNormal(S, u, v, tol),
      frozen: same,
    },
    { name: 'limitNormal', inputs: [clampedS], run: () => limitNormal(clampedS, 'v0', 0.4) },
    { name: 'fundamentalForms', inputs: [S], run: () => fundamentalForms(S, u, v) },
    {
      name: 'fundamentalFormsInto',
      inputs: [S],
      run: () => [fundamentalFormsInto(S, u, v, out, 2, s), out.slice(2, 8)],
    },
    { name: 'principalCurvatures', inputs: [S], run: () => principalCurvatures(S, u, v) },
    { name: 'normalCurvature', inputs: [S, P], run: () => normalCurvature(S, u, v, P) },
    { name: 'SAMPLE_DEGENERATE', inputs: [], run: () => SAMPLE_DEGENERATE },
    { name: 'SAMPLE_UMBILIC', inputs: [], run: () => SAMPLE_UMBILIC },
    {
      name: 'planSurfaceSamples',
      inputs: [S, uvs],
      run: () => planSurfaceSamples(S, uvs, 1),
      frozen: same,
    },
    {
      name: 'planCurveSamples',
      inputs: [c3, ts],
      run: () => planCurveSamples(c3, ts, 3),
      frozen: same,
    },
    { name: 'planMatches', inputs: [plan, S2], run: () => planMatches(plan, S2) },
    { name: 'changedControlPoints', inputs: [S, S2], run: () => changedControlPoints(S, S2) },
    {
      name: 'evalSurfacePlan',
      inputs: [plan, S],
      run: () => {
        const o = sOut();
        evalSurfacePlan(plan, S, o, s);
        return o;
      },
    },
    {
      name: 'evalSurfacePlanDirty',
      inputs: [plan, S2, changed],
      run: () => {
        const o = sOut();
        const n = evalSurfacePlanDirty(plan, S2, changed, o, touched, s);
        return [o, touched.slice(0, n)];
      },
    },
    {
      name: 'evalCurvePlan',
      inputs: [cplan, c3],
      run: () => {
        const o = cOut();
        evalCurvePlan(cplan, c3, o, s);
        return o;
      },
    },
    {
      name: 'evalCurvePlanDirty',
      inputs: [cplan, c3],
      run: () => {
        const o = cOut();
        const n = evalCurvePlanDirty(cplan, c3, Int32Array.of(0, 3), o, touched, s);
        return [o, touched.slice(0, n)];
      },
    },
    {
      name: 'planeSurface',
      inputs: [P, X, Y],
      run: () => planeSurface(P, X, Y, { u: [-1, 1], v: [0, 2] }),
      frozen: same,
    },
    {
      name: 'bilinearPatch',
      inputs: [P, Q, X, Y],
      run: () => bilinearPatch(P, Q, X, Y),
      frozen: same,
    },
    {
      name: 'bezierSurface',
      inputs: [sPts, sW],
      run: () => bezierSurface(sPts, 6, 5, sW),
      frozen: same,
    },
    {
      name: 'revolve',
      inputs: [c3, P, dir],
      run: () => [revolve(c3, P, dir), revolve(c3, P, dir, 2)],
      frozen: (r) => r as unknown[],
    },
    { name: 'sphere', inputs: [P], run: () => sphere(P, 2), frozen: same },
    { name: 'torus', inputs: [P, dir], run: () => torus(P, dir, 3, 1), frozen: same },
    { name: 'cylinder', inputs: [P, dir], run: () => cylinder(P, dir, 1, 2), frozen: same },
    { name: 'extrude', inputs: [c3, dir], run: () => extrude(c3, dir), frozen: same },
    // Projection and curves on surfaces (B1)
    { name: 'DEFAULT_PROJECTION_SEEDING', inputs: [], run: () => DEFAULT_PROJECTION_SEEDING },
    {
      name: 'closestPointOnCurve',
      inputs: [c3, P, c2, P2, tol, seeding],
      run: () => [
        closestPointOnCurve(c3, P, { tol, seeding }),
        closestPointOnCurve(c3, P, { seed: t }),
        closestPointOnCurve(c2, P2, { range: curveDomain(c2) }),
      ],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'closestPointOnSurface',
      inputs: [S, P, tol, seeding],
      run: () => [
        closestPointOnSurface(S, P, { tol, seeding }),
        closestPointOnSurface(S, Q, { seed: { u, v } }),
      ],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'projectPointsToCurveInto',
      inputs: [c3, pts3, c2, pts2],
      run: () => {
        const ot = new Float64Array(8);
        const od = new Float64Array(8);
        const n = projectPointsToCurveInto(c3, pts3, ot, od, { warmStart: true });
        const n2 = projectPointsToCurveInto(c2, pts2, ot, od);
        return [n, n2, ot, od];
      },
    },
    {
      name: 'projectPointsToSurfaceInto',
      inputs: [S, pts3, uvSeeds],
      run: () => {
        const ouv = new Float64Array(16);
        const od = new Float64Array(8);
        const n = projectPointsToSurfaceInto(S, pts3, ouv, od, { warmStart: true });
        const n2 = projectPointsToSurfaceInto(S, pts3, ouv, od, { seeds: uvSeeds });
        return [n, n2, ouv, od];
      },
    },
    {
      name: 'curveOnSurface',
      inputs: [S, pcurve],
      run: () => curveOnSurface(S, pcurve),
      frozen: same,
    },
    {
      name: 'curveOnSurfacePoint',
      inputs: [cos],
      run: () => curveOnSurfacePoint(cos, 0.3),
      frozen: same,
    },
    {
      name: 'curveOnSurfaceDerivatives',
      inputs: [cos],
      run: () => curveOnSurfaceDerivatives(cos, 0.6, 2),
      frozen: same,
    },
    {
      name: 'curveOnSurfaceEvalInto',
      inputs: [cos],
      run: () => {
        curveOnSurfaceEvalInto(cos, 0.4, 2, out, 5, s);
        return out.slice(5, 14);
      },
    },
    {
      name: 'isoLinePcurve',
      inputs: [S],
      run: () => [isoLinePcurve(S, 'u', u), isoLinePcurve(S, 'v', v)],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'projectCurveSamplesToSurface',
      inputs: [iso, S, us, tol],
      run: () => projectCurveSamplesToSurface(iso as NurbsCurve<3>, S, us, { tol }),
      frozen: same,
    },
    // Trimmed surfaces, integration, triangulation and tessellation (B2)
    {
      name: 'makeTrimLoop',
      inputs: [circ, ...triCurves, tol],
      run: () => [valueOf(makeTrimLoop([circ], { tol })), valueOf(makeTrimLoop(triCurves))],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'naturalBoundaryLoop',
      inputs: [clampedS],
      run: () => naturalBoundaryLoop(clampedS),
      frozen: same,
    },
    {
      name: 'makeTrimmedSurface',
      inputs: [clampedS, outerLoop, holeLoop, tol],
      run: () => valueOf(makeTrimmedSurface(clampedS, outerLoop, [holeLoop], tol)),
      frozen: same,
    },
    {
      name: 'checkTrimLoops',
      inputs: [trimmed],
      run: () => checkTrimLoops(trimmed),
    },
    {
      name: 'classifyUV',
      inputs: [trimmed, natural],
      run: () => [
        classifyUV(trimmed, { u: at(0.2, 0.5).x, v: at(0.2, 0.5).y }),
        classifyUV(trimmed, { u: at(0.5, 0.5).x, v: at(0.5, 0.5).y }),
        classifyUV(natural, { u, v }),
      ],
    },
    {
      name: 'closestPointOnTrimmed',
      inputs: [trimmed, P, seeding],
      run: () => [
        closestPointOnTrimmed(trimmed, P, { seeding }),
        closestPointOnTrimmed(trimmed, Q),
      ],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'integrateTrimmed',
      inputs: [trimmed, natural],
      run: () => [
        integrateTrimmed(trimmed, (_u, _v, d) => d[2]!, { tol }),
        integrateTrimmed(natural, (x, y) => x * y, { polynomialDegree: [1, 1], nDer: 0 }),
      ],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'surfaceArea',
      inputs: [trimmed, clampedS],
      run: () => [surfaceArea(trimmed, tol), surfaceArea(clampedS, tol)],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'enclosedVolume',
      inputs: [trimmed, clampedS],
      run: () => enclosedVolume([{ face: trimmed }, { face: clampedS, sameSense: false }], tol),
      frozen: same,
    },
    {
      name: 'orient2d',
      inputs: [],
      run: () => [orient2d(0, 0, 1, 0, 0, 1), orient2d(0, 0, 1, 1, 2, 2)],
    },
    {
      name: 'incircle',
      inputs: [],
      run: () => [incircle(0, 0, 1, 0, 0, 1, 0.2, 0.2), incircle(0, 0, 1, 0, 1, 1, 0, 1)],
    },
    {
      name: 'constrainedDelaunay',
      inputs: [cdtIn],
      run: () => valueOf(constrainedDelaunay(cdtIn, { removeExterior: true })),
      frozen: same,
    },
    {
      name: 'checkTriangulation',
      inputs: [cdt, cdtIn],
      run: () => checkTriangulation(cdt, cdtIn.segments),
    },
    { name: 'DEFAULT_TESSELLATION', inputs: [], run: () => DEFAULT_TESSELLATION, frozen: same },
    {
      name: 'tessellateTrimmedSurface',
      inputs: [trimmed, meshOpts],
      run: () => valueOf(tessellateTrimmedSurface(trimmed, meshOpts)),
      frozen: same,
    },
    {
      name: 'DEFAULT_CONTINUITY_SAMPLING',
      inputs: [],
      run: () => DEFAULT_CONTINUITY_SAMPLING,
      frozen: same,
    },
    {
      name: 'edgeContinuity',
      inputs: [isoEdge, sideL, sideR, contOpts],
      run: () => edgeContinuity(isoEdge, sideL, sideR, contOpts),
      frozen: (r) => [r, (r as { max: unknown }).max],
    },
    {
      name: 'boundaryContinuity',
      inputs: [bSide, contOpts],
      run: () => boundaryContinuity(bSide, bSide, contOpts),
      frozen: same,
    },
    {
      name: 'knotContinuity',
      inputs: [c3, c2],
      run: () => [
        knotContinuity(c3, t),
        knotContinuity(c2, 0.5 * (curveDomain(c2)[0] + curveDomain(c2)[1])),
      ],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'curveJoinContinuity',
      inputs: [c3, c2],
      run: () => [curveJoinContinuity(c3, c3), curveJoinContinuity(c2, c2)],
      frozen: (r) => r as unknown[],
    },
    {
      name: 'classifyContinuity',
      inputs: [thresholds],
      run: () =>
        classifyContinuity({ gap: 0, angle: 0.1, curvatureMismatch: 0, curvature: 1 }, thresholds),
    },
    {
      name: 'retargetTessellation',
      inputs: [faceMesh, trimmed],
      run: () => retargetTessellation(faceMesh, trimmed),
      frozen: same,
    },
  ];
}

describe('every public operation', () => {
  it('is covered by the table', () => {
    const names = new Set(cases(1).map((c) => c.name));
    const missing = Object.keys(geom).filter((k) => !names.has(k));
    expect(missing).toEqual([]);
  });

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`leaves its inputs unchanged, returns finite numbers and frozen records (seed ${seed})`, () => {
      for (const c of cases(seed)) {
        const before = c.inputs.map((x) => checksum(x));
        const result = c.run();
        const after = c.inputs.map((x) => checksum(x));
        expect(after, `${c.name} wrote an input (seed ${seed})`).toEqual(before);
        const bad = numbers(result).filter((x) => !Number.isFinite(x));
        expect(bad, `${c.name} returned a non-finite number (seed ${seed})`).toEqual([]);
        for (const r of c.frozen?.(result) ?? []) {
          if (r !== null) expect(Object.isFrozen(r), `${c.name} result not frozen`).toBe(true);
        }
      }
    });
  }

  it('detects a write into an input (the checksum sees it)', () => {
    const c = cases(1).find((x) => x.name === 'makeCurve')!;
    const before = c.inputs.map((x) => checksum(x));
    (c.inputs[1] as Float64Array)[0]! += 1e-15;
    expect(c.inputs.map((x) => checksum(x))).not.toEqual(before);
  });
});
