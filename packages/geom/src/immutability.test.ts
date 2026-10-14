// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cross-cutting properties of every public F1 operation (design §4.8, §8, §16):
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
} from './index';
import type { Affine2, Affine3, NurbsCurve } from './index';
import { checksum, mulberry32, randomCurve } from './testing';

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
