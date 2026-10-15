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
  decomposeBezier,
  elevateDegree,
  elevateDegreeSurface,
  insertKnot,
  insertKnotSurface,
  makeCompatible,
  normalizeDomain,
  normalizeSurfaceDomain,
  refineKnots,
  refineKnotsSurface,
  removeKnot,
  reparameterize,
  reparameterizeSurface,
  reverseCurve,
  reverseSurface,
  ruled,
  splitCurve,
  splitSurface,
  subCurve,
  swapUV,
  toClamped,
  toClampedSurface,
  approximateCurve,
  approximateSurface,
  averagedKnots,
  interpolateCurve,
  interpolatePeriodic,
  interpolateSurface,
  lsqKnots,
  parameterize,
  skinCurves,
  fairInfluenceInto,
  fairnessEnergy,
  makeDofMap,
  prepareFairSolver,
  solveFair,
  solveFairInto,
} from './index';
import type { Affine2, Affine3, ClampedCurve, NurbsCurve, PeriodicCurve } from './index';
import { checksum, mulberry32, randomCurve, randomSurface } from './testing';

/** Every number reachable from `v` (typed arrays included). */
function numbers(v: unknown, out: number[] = [], seen = new Set<object>()): number[] {
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'object' && v !== null && !seen.has(v)) {
    seen.add(v);
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      out.push(...Array.from(v as unknown as ArrayLike<number>, Number));
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
  // Curve and surface operations (A1).
  const cc =
    c3.basis.kind === 'clamped'
      ? (c3 as ClampedCurve<3>)
      : toClamped(c3 as PeriodicCurve<3>, c3.basis.domain[0]);
  const [ca, cb] = cc.basis.domain;
  const tm = ca + 0.43 * (cb - ca);
  const ins = insertKnot(cc, tm, 2);
  const xs = Float64Array.of(a + 0.31 * (e - a), a + 0.62 * (e - a), a + 0.62 * (e - a));
  const pc = randomCurve(rng, {
    dim: 2,
    degree: 3,
    count: 7,
    kind: 'periodic',
    weightRange,
  }) as PeriodicCurve<2>;
  const c3b = randomCurve(rng, { dim: 3, degree: 2, count: 6, kind, weightRange }) as NurbsCurve<3>;
  const tor = torus(P, dir, 3, 1);
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

  // Fitting (A2).
  const fitPts = Float64Array.from({ length: 30 }, (_, k) =>
    k % 3 === 0 ? k / 3 + 0.2 * rng() : k % 3 === 1 ? Math.sin(k) + 0.1 * rng() : 0.3 * rng(),
  );
  const ringPts = Float64Array.from({ length: 24 }, (_, k) => {
    const a = (2 * Math.PI * Math.floor(k / 3)) / 8;
    return k % 3 === 0 ? Math.cos(a) : k % 3 === 1 ? Math.sin(a) : 0.1 * rng();
  });
  const fitParams = Float64Array.from({ length: 10 }, (_, k) => k / 9);
  const fitW = Float64Array.from({ length: 10 }, () => 0.5 + rng());
  const fitCons = [{ kind: 'point', t: 0.5, value: { x: 4, y: 0, z: 0 } }] as const;
  const fitGrid = Float64Array.from({ length: 5 * 4 * 3 }, (_, k) => {
    const i = Math.floor(k / 12);
    const j = Math.floor(k / 3) % 4;
    return k % 3 === 0 ? i : k % 3 === 1 ? j : Math.sin(i + j) + 0.1 * rng();
  });
  const fitBu = clampedBasis(2, clampedUniformKnots(2, 4));
  const fitBv = clampedBasis(2, clampedUniformKnots(2, 3));
  const fitUV = Float64Array.from({ length: 40 }, () => rng());
  const fitScattered = Float64Array.from({ length: 60 }, () => rng());
  const sec = [0, 1, 2].map((z) => circle({ x: 0, y: 0, z }, X, Y, 1 + z)) as NurbsCurve<3>[];
  // Constrained fair solver (A3).
  const rules = [
    { kind: 'fix', cp: 0 },
    { kind: 'fixAxes', cp: 1, axes: 4 },
  ] as const;
  const dof = makeDofMap(S, rules);
  const solverCons = [{ kind: 'point', uv: { u, v }, value: P }] as const;
  const stiff = Float64Array.from({ length: S.u.count * S.v.count }, () => 0.5 + rng());
  const fairness = { bend: 1, stretch: 0.1 } as const;
  const problem = { target: S, dof, fairness, stiffness: stiff, constraints: solverCons };
  const solverOf = () => {
    const r = prepareFairSolver(problem);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  };
  const solver = solverOf();
  const moved = Float64Array.of(P.x + 0.1, P.y - 0.2, P.z + 0.3);
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
    // Curve operations (A1)
    { name: 'insertKnot', inputs: [c3], run: () => insertKnot(c3, t, 1), frozen: same },
    { name: 'refineKnots', inputs: [c3, xs], run: () => refineKnots(c3, xs), frozen: same },
    {
      name: 'removeKnot',
      inputs: [ins],
      run: () => removeKnot(ins, tm, 2),
      frozen: (r) => [r, (r as { curve: unknown }).curve],
    },
    { name: 'elevateDegree', inputs: [c2], run: () => elevateDegree(c2, 2), frozen: same },
    {
      name: 'splitCurve',
      inputs: [cc],
      run: () => splitCurve(cc, tm),
      frozen: (r) => [r, ...(r as unknown[])],
    },
    {
      name: 'subCurve',
      inputs: [c3],
      // Periodic: from 0.7 across the seam to 0.2; clamped: [0.2, 0.7].
      run: () =>
        kind === 'clamped'
          ? subCurve(c3, a + 0.2 * (e - a), a + 0.7 * (e - a))
          : subCurve(c3, a + 0.7 * (e - a), a + 0.2 * (e - a)),
      frozen: same,
    },
    { name: 'reverseCurve', inputs: [c3], run: () => reverseCurve(c3), frozen: same },
    {
      name: 'reparameterize',
      inputs: [c3],
      run: () => reparameterize(c3, [2, 5]),
      frozen: same,
    },
    { name: 'normalizeDomain', inputs: [c1], run: () => normalizeDomain(c1), frozen: same },
    { name: 'toClamped', inputs: [pc], run: () => toClamped(pc, 0.3), frozen: same },
    {
      name: 'decomposeBezier',
      inputs: [cc],
      run: () => decomposeBezier(cc),
      frozen: (r) => [r, ...(r as unknown[])],
    },
    {
      name: 'makeCompatible',
      inputs: [c3, c3b],
      run: () => makeCompatible([c3, c3b]),
      frozen: (r) => {
        const x = r as { curves: readonly unknown[] };
        return [x, x.curves, ...x.curves];
      },
    },
    { name: 'ruled', inputs: [c3, c3b], run: () => ruled(c3, c3b), frozen: same },
    // Surface operations (A1)
    {
      name: 'insertKnotSurface',
      inputs: [S],
      run: () => insertKnotSurface(S, 'u', u),
      frozen: same,
    },
    {
      name: 'refineKnotsSurface',
      inputs: [S, vs],
      run: () => refineKnotsSurface(S, 'v', vs),
      frozen: same,
    },
    {
      name: 'elevateDegreeSurface',
      inputs: [S],
      run: () => elevateDegreeSurface(S, 'v', 1),
      frozen: same,
    },
    {
      name: 'splitSurface',
      inputs: [clampedS],
      run: () => splitSurface(clampedS, 'v', 0.55),
      frozen: (r) => [r, ...(r as unknown[])],
    },
    { name: 'reverseSurface', inputs: [S], run: () => reverseSurface(S, 'u'), frozen: same },
    { name: 'swapUV', inputs: [S], run: () => swapUV(S), frozen: same },
    {
      name: 'reparameterizeSurface',
      inputs: [S],
      run: () => reparameterizeSurface(S, 'v', [-1, 1]),
      frozen: same,
    },
    {
      name: 'normalizeSurfaceDomain',
      inputs: [S],
      run: () => normalizeSurfaceDomain(S),
      frozen: same,
    },
    {
      name: 'toClampedSurface',
      inputs: [tor],
      run: () => toClampedSurface(tor, 'v', 0.2),
      frozen: same,
    },
    // Fitting (A2)
    { name: 'parameterize', inputs: [fitPts], run: () => parameterize(fitPts, 3, 'centripetal') },
    { name: 'averagedKnots', inputs: [fitParams], run: () => averagedKnots(fitParams, 3) },
    { name: 'lsqKnots', inputs: [fitParams], run: () => lsqKnots(fitParams, 2, 6) },
    {
      name: 'interpolateCurve',
      inputs: [fitPts, P],
      run: () => interpolateCurve(fitPts, 3, { endDerivatives: [P, null] }),
      frozen: same,
    },
    {
      name: 'interpolatePeriodic',
      inputs: [ringPts],
      run: () => interpolatePeriodic(ringPts, 3),
      frozen: same,
    },
    {
      name: 'interpolateSurface',
      inputs: [fitGrid],
      run: () => interpolateSurface(fitGrid, 5, 4, { degreeV: 2, periodicU: rational }),
      frozen: same,
    },
    {
      name: 'approximateCurve',
      inputs: [fitPts, fitParams, fitW, fitCons],
      run: () =>
        approximateCurve(fitPts, 3, {
          count: 6,
          params: fitParams,
          dataWeights: fitW,
          constraints: fitCons,
          parameterCorrection: 1,
        }),
      frozen: (r) => [r, (r as { ok: true; value: unknown }).value],
    },
    {
      name: 'approximateSurface',
      inputs: [fitScattered, fitUV, fitBu, fitBv],
      run: () => approximateSurface(fitScattered, { uv: fitUV }, { u: fitBu, v: fitBv }),
      frozen: (r) => [(r as { ok: true; value: unknown }).value],
    },
    {
      name: 'skinCurves',
      inputs: [sec],
      run: () => skinCurves(sec),
      frozen: same,
    },
    // Constrained fair solver (A3). The solver keeps drag-session work buffers,
    // so it is not checksummed as an input of the solves.
    {
      name: 'fairnessEnergy',
      inputs: [S, S2, fairness],
      run: () => fairnessEnergy(S2, fairness, S),
    },
    { name: 'makeDofMap', inputs: [S, rules], run: () => makeDofMap(S, rules), frozen: same },
    {
      name: 'prepareFairSolver',
      inputs: [S, dof, stiff, solverCons, fairness],
      run: () => prepareFairSolver(problem),
      frozen: (r) => [r, (r as { ok: true; value: unknown }).value],
    },
    {
      name: 'solveFairInto',
      inputs: [S, moved],
      run: () => solveFairInto(solver, moved, new Float64Array(S.cw.length)),
      frozen: same,
    },
    {
      name: 'solveFair',
      inputs: [S, moved],
      run: () => solveFair(solver, moved),
      frozen: (r) => [r, (r as { result: unknown }).result],
    },
    {
      name: 'fairInfluenceInto',
      inputs: [S],
      run: () => {
        const o = new Float64Array(S.u.count * S.v.count * 3);
        fairInfluenceInto(solver, 0, 2, o);
        return o;
      },
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
