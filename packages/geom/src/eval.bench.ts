// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Evaluation, knot-operation, interpolation, solver, projection and meshing
 * benchmarks P1–P24 (docs/design/geom-core.md §17), run with
 * `pnpm --filter @openshaper/geom bench` (not part of `pnpm test`).
 *
 * Each case prints its measured rate or time next to the design's target. A
 * missed target is reported, not failed (§17): the numbers go into the Phase 1
 * report and the branch's QUALITY_REPORT.md, and a miss triggers the tier-2
 * options of §9. Point-rate cases evaluate a fixed batch per call, so the rate
 * is not dominated by the harness's per-call overhead.
 */
import { test } from 'vitest';
import {
  approximateCurve,
  approximateSurface,
  circle2,
  checkBrep,
  constrainedDelaunay,
  curveOnSurface,
  curveOnSurfaceTo3d,
  massProperties,
  projectCurveToSurface,
  tessellateBrep,
  writeStep,
  makeTrimLoop,
  makeTrimmedSurface,
  retargetTessellation,
  tessellateTrimmedSurface,
  transformCurve2,
  clampedBasis,
  clampedUniformKnots,
  closestPointOnSurface,
  projectPointsToSurfaceInto,
  surfaceNormal,
  createScratch,
  curveEvalBatchInto,
  curvePoint,
  elevateDegree,
  evalSurfacePlan,
  evalSurfacePlanDirty,
  interpolateCurve,
  interpolateSurface,
  makeCurve,
  makeDofMap,
  makeSurface,
  periodicCircle,
  planSurfaceSamples,
  prepareFairSolver,
  principalCurvatures,
  refineKnotsSurface,
  solveFairInto,
  surfaceEvalGridInto,
  surfacePoint,
  withSurfaceControlPoints,
} from './index';
import type {
  DofRule,
  FairProblem,
  FairSolver,
  LinearConstraint,
  NurbsCurve,
  NurbsSurface,
  Result,
  TrimmedSurface,
} from './index';
import { checkFairness, surfaceFairnessMatrix } from './solver/fairness';
import { resolveTolerances } from './tolerance';
import { ellipticPuckSolid, mulberry32 } from './testing';

interface BenchRun {
  latency: { mean: number; p50: number; p99: number; rme: number };
  throughput: { mean: number };
}
/** tinybench run options (a few iterations for cases that take seconds). */
interface RunOptions {
  readonly iterations: number;
  readonly time: number;
  readonly warmupIterations: number;
  readonly warmupTime: number;
}
type Bench = (name: string, fn: () => void) => { run: (opts?: RunOptions) => Promise<BenchRun> };

/** A case: its function, how many units one call does, and the target. */
interface Case {
  readonly id: string;
  readonly name: string;
  readonly fn: () => void;
  /** Units (points, samples) per call, for a rate target; 0 for a time target. */
  readonly units: number;
  /** `rate`: at least this many units per second; `time`: at most this many ms per call. */
  readonly target: { readonly kind: 'rate' | 'time'; readonly value: number };
  /** Run options, for cases too slow for the default sample count. */
  readonly run?: RunOptions;
}

/** Few samples, for cases that take on the order of a second. */
const SLOW: RunOptions = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 };

const fmtRate = (r: number): string =>
  r >= 1e6 ? `${(r / 1e6).toFixed(2)} M/s` : `${(r / 1e3).toFixed(1)} k/s`;

/**
 * Runs each case and prints one table: Vitest 5 benchmarks are a test
 * fixture, its own table is not printed in a non-interactive run, and
 * `console` is swallowed in bench mode, so this writes straight to stdout
 * (the pattern of packages/store/src/perf.bench.ts).
 */
async function runGroup(bench: Bench, title: string, cases: readonly Case[]): Promise<void> {
  const rows: string[][] = [['', 'mean ms', 'p99 ms', '±%', 'measured', 'target', '']];
  for (const c of cases) {
    const r = await bench(c.name, c.fn).run(c.run);
    const l = r.latency;
    const rate = c.units * r.throughput.mean;
    const met = c.target.kind === 'rate' ? rate >= c.target.value : l.mean <= c.target.value;
    rows.push([
      `${c.id} ${c.name}`,
      l.mean.toFixed(4),
      l.p99.toFixed(4),
      l.rme.toFixed(2),
      c.target.kind === 'rate' ? fmtRate(rate) : `${l.mean.toFixed(3)} ms`,
      c.target.kind === 'rate' ? `≥ ${fmtRate(c.target.value)}` : `≤ ${c.target.value} ms`,
      met ? 'met' : 'MISSED',
    ]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  const line = (row: string[]): string =>
    row
      .map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join('  ');
  process.stdout.write(`\n${title}\n${rows.map(line).join('\n')}\n`);
}

/** A bicubic surface on uniform clamped knots with random control points. */
function bicubic(nu: number, nv: number, rational: boolean, seed: number): NurbsSurface {
  const rng = mulberry32(seed);
  const pts: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      pts.push((300 * i) / nu, (60 * j) / nv, 10 * rng());
      w.push(rational ? 0.7 + 0.6 * rng() : 1);
    }
  }
  return makeSurface({
    u: clampedBasis(3, clampedUniformKnots(3, nu)),
    v: clampedBasis(3, clampedUniformKnots(3, nv)),
    points: pts,
    weights: w,
  });
}

const BATCH = 1000;

test('curves and surfaces: P1–P5, P9', async ({ bench }) => {
  const rng = mulberry32(1);
  const ts = Float64Array.from({ length: BATCH }, () => rng());
  const cubic = makeCurve({
    dim: 3,
    basis: clampedBasis(3, clampedUniformKnots(3, 50)),
    points: Array.from({ length: 150 }, () => rng()),
  });
  const circle = periodicCircle(
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    1,
  );
  const ratCubic = makeCurve({
    dim: 3,
    basis: clampedBasis(3, clampedUniformKnots(3, 50)),
    points: Array.from({ length: 150 }, () => rng()),
    weights: Array.from({ length: 50 }, () => 0.5 + rng()),
  });
  const ts10k = Float64Array.from({ length: 10_000 }, (_, i) => i / 9999);
  const out10k = new Float64Array(10_000 * 9);
  const sc = createScratch({ maxDegree: 3 });
  const s4020 = bicubic(40, 20, false, 2);
  const uvs = Float64Array.from({ length: 2 * BATCH }, () => rng());
  const grid = Float64Array.from({ length: 64 }, (_, i) => i / 63);
  const gridOut = new Float64Array(64 * 64 * 9);
  const normals = new Float64Array(64 * 64 * 3);
  let sink = 0;
  await runGroup(bench, 'geom evaluation (F2)', [
    {
      id: 'P1',
      name: 'curvePoint, cubic, 50 control points',
      units: BATCH,
      target: { kind: 'rate', value: 10e6 },
      fn: () => {
        for (let i = 0; i < BATCH; i++) sink += curvePoint(cubic, ts[i]!).x;
      },
    },
    {
      id: 'P2',
      name: 'curvePoint, rational periodic circle',
      units: BATCH,
      target: { kind: 'rate', value: 5e6 },
      fn: () => {
        for (let i = 0; i < BATCH; i++) sink += curvePoint(circle, ts[i]!).x;
      },
    },
    {
      id: 'P3',
      name: 'curveEvalBatchInto, C″, rational cubic, 10k params',
      units: 0,
      target: { kind: 'time', value: 1.5 },
      fn: () => curveEvalBatchInto(ratCubic, ts10k, 2, out10k, sc),
    },
    {
      id: 'P4',
      name: 'surfacePoint, bicubic 40 × 20',
      units: BATCH,
      target: { kind: 'rate', value: 2e6 },
      fn: () => {
        for (let i = 0; i < BATCH; i++) sink += surfacePoint(s4020, uvs[2 * i]!, uvs[2 * i + 1]!).x;
      },
    },
    {
      id: 'P5',
      name: 'point + normal + principal curvatures, bicubic 40 × 20',
      units: BATCH,
      target: { kind: 'rate', value: 0.5e6 },
      fn: () => {
        for (let i = 0; i < BATCH; i++) {
          sink += principalCurvatures(s4020, uvs[2 * i]!, uvs[2 * i + 1]!)?.k1 ?? 0;
        }
      },
    },
    {
      id: 'P9',
      name: 'surfaceEvalGridInto + normals, 64 × 64',
      units: 0,
      target: { kind: 'time', value: 1.5 },
      fn: () => {
        surfaceEvalGridInto(s4020, grid, grid, 1, gridOut, sc);
        for (let k = 0; k < 64 * 64; k++) {
          const o = 9 * k;
          const [ux, uy, uz] = [gridOut[o + 3]!, gridOut[o + 4]!, gridOut[o + 5]!];
          const [vx, vy, vz] = [gridOut[o + 6]!, gridOut[o + 7]!, gridOut[o + 8]!];
          const nx = uy * vz - uz * vy;
          const ny = uz * vx - ux * vz;
          const nz = ux * vy - uy * vx;
          const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          normals[3 * k] = nx * inv;
          normals[3 * k + 1] = ny * inv;
          normals[3 * k + 2] = nz * inv;
        }
      },
    },
  ]);
  if (Number.isNaN(sink)) process.stdout.write('unreachable\n');
});

test('sample plans: P6–P8', async ({ bench }) => {
  const rng = mulberry32(3);
  const s = bicubic(64, 8, true, 4);
  const count = 5000;
  const uv = Float64Array.from({ length: 2 * count }, () => rng());
  const sc = createScratch({ maxDegree: 3 });
  const plan = planSurfaceSamples(s, uv, 2);
  const out = {
    position: new Float32Array(3 * count),
    normal: new Float32Array(3 * count),
    curvature: new Float32Array(2 * count),
  };
  evalSurfacePlan(plan, s, out, sc);
  // A rail-band-like edit: one interior control point moved back and forth.
  const cp = 30 * 8 + 4;
  const moved = withSurfaceControlPoints(s, [150, 35, 12], [cp]);
  const changed = Int32Array.of(cp);
  const touched = new Int32Array(count);
  let flip = false;
  let touchedCount = 0;
  await runGroup(bench, 'sample plans (F2)', [
    {
      id: 'P6',
      name: 'planSurfaceSamples, nDer = 2, 5k samples, 64 × 8',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => void planSurfaceSamples(s, uv, 2),
    },
    {
      id: 'P7',
      name: 'evalSurfacePlan: position, normal, k1/k2, rational, 5k',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => evalSurfacePlan(plan, s, out, sc),
    },
    {
      id: 'P8',
      name: 'evalSurfacePlanDirty, one control point, 5k',
      units: 0,
      target: { kind: 'time', value: 0.15 },
      fn: () => {
        flip = !flip;
        touchedCount = evalSurfacePlanDirty(plan, flip ? moved : s, changed, out, touched, sc);
      },
    },
  ]);
  process.stdout.write(
    `P8 touched ${touchedCount} of ${count} samples (${((100 * touchedCount) / count).toFixed(1)}%)\n`,
  );
});

test('knot operations: P10', async ({ bench }) => {
  const rng = mulberry32(4);
  const s = bicubic(40, 20, true, 5);
  // 40 new u-knots (k + ½)/40: never equal to the uniform knots i/37 (odd vs even numerators).
  const xs = Float64Array.from({ length: 40 }, (_, k) => (k + 0.5) / 40);
  const curve = makeCurve({
    dim: 3,
    basis: clampedBasis(3, clampedUniformKnots(3, 100)),
    points: Array.from({ length: 300 }, () => rng()),
    weights: Array.from({ length: 100 }, () => 0.5 + rng()),
  });
  let count = 0;
  await runGroup(bench, 'knot operations (A1)', [
    {
      id: 'P10a',
      name: 'refineKnotsSurface, 40 u-knots, rational bicubic 40 × 20',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => {
        count += refineKnotsSurface(s, 'u', xs).u.count;
      },
    },
    {
      id: 'P10b',
      name: 'elevateDegree 3 → 5, rational, 100 control points',
      units: 0,
      target: { kind: 'time', value: 1 },
      fn: () => {
        count += elevateDegree(curve, 2).basis.count;
      },
    },
  ]);
  if (count < 0) process.stdout.write('unreachable\n');
});

test('interpolation: P11', async ({ bench }) => {
  const rng = mulberry32(5);
  // 200 points along a noisy helix; a 60 × 30 grid on a wavy sheet.
  const pts = Float64Array.from({ length: 600 }, (_, i) => {
    const k = Math.floor(i / 3);
    const a = k * 0.2;
    return i % 3 === 0 ? Math.cos(a) : i % 3 === 1 ? Math.sin(a) + 0.01 * rng() : 0.05 * k;
  });
  const grid = Float64Array.from({ length: 60 * 30 * 3 }, (_, i) => {
    const k = Math.floor(i / 90);
    const l = Math.floor(i / 3) % 30;
    return i % 3 === 0 ? k : i % 3 === 1 ? l : Math.sin(0.2 * k) * Math.cos(0.3 * l) + 0.01 * rng();
  });
  let count = 0;
  await runGroup(bench, 'interpolation (A2)', [
    {
      id: 'P11a',
      name: 'interpolateCurve, 200 points, cubic, centripetal',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => {
        count += interpolateCurve(pts, 3).curve.basis.count;
      },
    },
    {
      id: 'P11b',
      name: 'interpolateSurface, 60 × 30 grid, bicubic',
      units: 0,
      target: { kind: 'time', value: 20 },
      fn: () => {
        count += interpolateSurface(grid, 60, 30).surface.u.count;
      },
    },
  ]);
  if (count < 0) process.stdout.write('unreachable\n');
});

/** The Euclidean control points of a surface, interleaved. */
function euclideanPoints(S: NurbsSurface): Float64Array {
  const n = S.cw.length / 4;
  const out = new Float64Array(3 * n);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) out[3 * i + c] = S.cw[4 * i + c]! / S.cw[4 * i + 3]!;
  return out;
}

/** A 64 × 8 bicubic board-sized band (512 control points), polynomial. */
function band(): NurbsSurface {
  return bicubic(64, 8, false, 6);
}

/** `count` point handles spread over the domain, on the axes in `axes`. */
function handles(count: number, axes: number): LinearConstraint[] {
  return Array.from({ length: count }, (_, k) => ({
    kind: 'point' as const,
    uv: { u: (k + 0.5) / count, v: 0.25 + (0.5 * ((k * 7) % count)) / count },
    value: { x: 0, y: 0, z: 0 },
    axes,
  }));
}

/** Three orthonormal directions of a frame turned about z by `a` and about x by `b`. */
function frame(a: number, b: number): { x: number; y: number; z: number }[] {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  return [
    { x: ca, y: sa, z: 0 },
    { x: -sa * cb, y: ca * cb, z: sb },
    { x: sa * sb, y: -ca * sb, z: cb },
  ];
}

/** Values moving every handle by a fixed small step from 0 (the solve is affine in them). */
function moves(m: number, step: number): Float64Array {
  return Float64Array.from({ length: 3 * m }, (_, i) => step * Math.sin(i + 1));
}

function prepare(p: FairProblem): FairSolver {
  const r = prepareFairSolver(p);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

test('projection: P17', async ({ bench }) => {
  const rng = mulberry32(5);
  const s = bicubic(40, 20, false, 6);
  const count = 1000;
  // A path near the surface (a pcurve-like sweep, 0.1 cm off it) for the warm batch,
  // and scattered points near it for the cold queries.
  const near = (u: number, v: number, d: number): [number, number, number] => {
    const p = surfacePoint(s, u, v);
    const n = surfaceNormal(s, u, v);
    const k = n.kind === 'regular' ? n.n : { x: 0, y: 0, z: 1 };
    return [p.x + d * k.x, p.y + d * k.y, p.z + d * k.z];
  };
  const path = new Float64Array(3 * count);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    path.set(near(0.05 + 0.9 * t, 0.5 + 0.3 * Math.sin(6 * t), 0.1), 3 * i);
  }
  // 100 cold queries per call keep one call short enough for the harness.
  const scattered = Array.from({ length: 100 }, () => {
    const [x, y, z] = near(rng(), rng(), 2 * (rng() - 0.5));
    return { x, y, z };
  });
  const uv = new Float64Array(2 * count);
  const dist = new Float64Array(count);
  let sink = 0;
  await runGroup(bench, 'projection (B1)', [
    {
      id: 'P17',
      name: 'projectPointsToSurfaceInto warm, 1k points, bicubic 40 × 20',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => void projectPointsToSurfaceInto(s, path, uv, dist, { warmStart: true }),
    },
    {
      id: 'P17',
      name: 'closestPointOnSurface cold, bicubic 40 × 20 (per point)',
      units: scattered.length,
      target: { kind: 'rate', value: 50_000 }, // ≤ 20 µs mean
      fn: () => {
        for (const p of scattered) sink += closestPointOnSurface(s, p).distance;
      },
    },
  ]);
  if (Number.isNaN(sink)) process.stdout.write('unreachable\n');
});

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

test('fair solver and fitting with fairness: P12–P16, P24', async ({ bench }) => {
  const S = band();
  const n = 64 * 8;
  const tol = resolveTolerances();
  const fwScaled = checkFairness({ bend: 1, stretch: 0.01 }, 'surface', 'displacement');
  const xRef = new Float64Array(3 * n); // polynomial: the Euclidean points
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) xRef[3 * i + c] = S.cw[4 * i + c]!;
  // The end rows u = 0 and u = 1 partly fixed in the coupled many-row case (12 points).
  const fixed: DofRule[] = Array.from({ length: 12 }, (_, k) => ({
    kind: 'fix' as const,
    cp: k < 6 ? k : n - 1 - (k - 6),
  }));
  // Rail-frame handle axes: every 8th control point slides in a turned frame (coupled, no DOF lost).
  const slides: DofRule[] = Array.from({ length: n / 8 }, (_, k) => ({
    kind: 'slide' as const,
    cp: 8 * k + 3,
    dirs: frame(0.3 + 0.01 * k, 0.2),
  }));
  const base = { target: S, fairness: { bend: 1, stretch: 0.01 }, stiffness: 0.01 };
  const pSep: FairProblem = { ...base, dof: makeDofMap(S, []), constraints: handles(20, 4) };
  const pCoupled: FairProblem = {
    ...base,
    dof: makeDofMap(S, slides),
    constraints: handles(20, 4),
  };
  const pMany: FairProblem = {
    ...base,
    dof: makeDofMap(S, [...fixed, ...slides.filter((r) => !fixed.some((f) => f.cp === r.cp))]),
    constraints: handles(50, 7),
  };
  // Rational targets: the same band with weights in [0.7, 1.3], and one whose
  // weights alternate 50 / 1 by v-row (a large ratio: the adaptive rational
  // quadrature, fairness.ts, refines towards the peaks of its integrands).
  const SR = bicubic(64, 8, true, 6);
  const SR50 = makeSurface({
    u: S.u,
    v: S.v,
    points: euclideanPoints(S),
    weights: Float64Array.from({ length: n }, (_, i) => ((i % 8) % 2 === 0 ? 50 : 1)),
  });
  const xRefR = euclideanPoints(SR);
  const xRefR50 = euclideanPoints(SR50);
  const pSepR: FairProblem = { ...pSep, target: SR, dof: makeDofMap(SR, []) };
  const pSepR50: FairProblem = { ...pSep, target: SR50, dof: makeDofMap(SR50, []) };
  const sSep = prepare(pSep);
  const sCoupled = prepare(pCoupled);
  const sMany = prepare(pMany);
  const shape = (s: FairSolver): string =>
    `${s.dofCount} DOF, m = ${s.constraintCount}, ${s.separable ? 'separable' : 'coupled'}`;
  process.stdout.write(`\nP13 problems: ${shape(sSep)}; ${shape(sCoupled)}; ${shape(sMany)}\n`);
  const out = new Float64Array(S.cw.length);
  const v20 = moves(20, 0.5);
  const v150 = moves(50, 0.5);

  // P15: 2k noisy points along a rocker-like curve → 80 control points, ends pinned.
  const rng = mulberry32(8);
  const m = 2000;
  const ts = Float64Array.from({ length: m }, (_, k) => k / (m - 1));
  const cpts = Float64Array.from({ length: 2 * m }, (_, i) => {
    const t = ts[i >> 1]!;
    return i % 2 ? 8 * t * t * t + 2 * (1 - t) ** 2 + 0.01 * rng() : 240 * t;
  });
  const cknots = clampedBasis(3, clampedUniformKnots(3, 80)).knots;
  const ccons = [
    { kind: 'point' as const, t: 0, value: { x: cpts[0]!, y: cpts[1]! } },
    { kind: 'point' as const, t: 1, value: { x: cpts[2 * m - 2]!, y: cpts[2 * m - 1]! } },
    { kind: 'tangentDirection' as const, t: 0, direction: { x: 1, y: -0.5 } },
  ];
  // P16: 8k scattered samples of a deck-like sheet → 64 × 8 bicubic, 2 correction passes.
  const ns = 8000;
  const uv = Float64Array.from({ length: 2 * ns }, () => rng());
  const spts = Float64Array.from({ length: 3 * ns }, (_, i) => {
    const k = Math.floor(i / 3);
    const u = uv[2 * k]!;
    const v = uv[2 * k + 1]!;
    return i % 3 === 0
      ? 240 * u
      : i % 3 === 1
        ? 55 * (v - 0.5)
        : 6 * Math.sin(Math.PI * u) - 3 * (v - 0.5) ** 2;
  });
  const bu = clampedBasis(3, clampedUniformKnots(3, 64));
  const bv = clampedBasis(3, clampedUniformKnots(3, 8));

  let count = 0;
  await runGroup(bench, 'fair solver and fitting with fairness (A3)', [
    {
      id: 'P12',
      name: 'thin-plate + membrane Gram, scaled metric, bicubic 64 × 8',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => {
        const F = surfaceFairnessMatrix(
          S.u,
          S.v,
          S.cw,
          false,
          fwScaled,
          {
            kind: 'geometry',
            points: xRef,
            dim: 3,
          },
          tol,
        );
        count += F.rows;
      },
    },
    {
      id: 'P12r',
      name: 'the same, rational: weights in [0.7, 1.3]',
      units: 0,
      target: { kind: 'time', value: 2 },
      run: SLOW,
      fn: () => {
        const sp = { kind: 'geometry', points: xRefR, dim: 3 } as const;
        count += surfaceFairnessMatrix(SR.u, SR.v, SR.cw, true, fwScaled, sp, tol).rows;
      },
    },
    {
      id: 'P12r50',
      name: 'the same, rational: weights 50 / 1 by v-row',
      units: 0,
      target: { kind: 'time', value: 2 },
      run: SLOW,
      fn: () => {
        const sp = { kind: 'geometry', points: xRefR50, dim: 3 } as const;
        count += surfaceFairnessMatrix(SR50.u, SR50.v, SR50.cw, true, fwScaled, sp, tol).rows;
      },
    },
    {
      id: 'P13a',
      name: `prepareFairSolver, ${shape(sSep)}`,
      units: 0,
      target: { kind: 'time', value: 3 },
      fn: () => {
        count += prepare(pSep).rank;
      },
    },
    {
      id: 'P13r',
      name: 'prepareFairSolver, the same, rational: weights in [0.7, 1.3]',
      units: 0,
      target: { kind: 'time', value: 3 },
      run: SLOW,
      fn: () => {
        count += prepare(pSepR).rank;
      },
    },
    {
      id: 'P13r50',
      name: 'prepareFairSolver, the same, rational: weights 50 / 1 by v-row',
      units: 0,
      target: { kind: 'time', value: 3 },
      run: SLOW,
      fn: () => {
        count += prepare(pSepR50).rank;
      },
    },
    {
      id: 'P13b',
      name: `prepareFairSolver, ${shape(sCoupled)}`,
      units: 0,
      target: { kind: 'time', value: 15 },
      fn: () => {
        count += prepare(pCoupled).rank;
      },
    },
    {
      id: 'P13c',
      name: `prepareFairSolver, ${shape(sMany)}`,
      units: 0,
      target: { kind: 'time', value: 100 },
      fn: () => {
        count += prepare(pMany).rank;
      },
    },
    {
      id: 'P14a',
      name: 'solveFairInto per move, coupled, m = 20',
      units: 0,
      target: { kind: 'time', value: 0.1 },
      fn: () => {
        count += solveFairInto(sCoupled, v20, out).dependent.length;
      },
    },
    {
      id: 'P14b',
      name: 'solveFairInto per move, coupled, m = 150',
      units: 0,
      target: { kind: 'time', value: 2 },
      fn: () => {
        count += solveFairInto(sMany, v150, out).dependent.length;
      },
    },
    {
      id: 'P15',
      name: 'approximateCurve, 2k points → 80 cps, 3 constraints, fairness',
      units: 0,
      target: { kind: 'time', value: 3 },
      fn: () => {
        const r = approximateCurve(cpts, 2, {
          knots: cknots,
          params: ts,
          constraints: ccons,
          fairness: { bend: 1 },
        });
        if (!r.ok) throw new Error(JSON.stringify(r.issues));
        count += 1;
      },
    },
    {
      id: 'P16',
      name: 'approximateSurface, 8k points → 64 × 8, fairness, 2 corrections',
      units: 0,
      target: { kind: 'time', value: 30 },
      fn: () => {
        const r = approximateSurface(
          spts,
          { uv },
          {
            u: bu,
            v: bv,
            fairness: { bend: 1 },
            parameterCorrection: 2,
          },
        );
        if (!r.ok) throw new Error(JSON.stringify(r.issues));
        count += 1;
      },
    },
  ]);

  // P24: 10k simulated drag frames on the coupled m = 20 solver. Allocation
  // is the per-frame report only (two Float64Array(m), two small Int32Array);
  // printed as heap growth, which a GC may hide (measure with --expose-gc).
  const frames = 10_000;
  const vals = new Float64Array(v20.length);
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < vals.length; k++) vals[k] = v20[k]! * Math.sin(f * 0.001);
    count += solveFairInto(sCoupled, vals, out).dependent.length;
  }
  const t1 = performance.now();
  const heap1 = process.memoryUsage().heapUsed;
  process.stdout.write(
    `P24 ${frames} drag frames (coupled, m = 20): ${(t1 - t0).toFixed(1)} ms total, ` +
      `${((t1 - t0) / frames).toFixed(4)} ms/frame, heap ${((heap1 - heap0) / 1024).toFixed(0)} KiB net\n`,
  );
  if (count < 0) process.stdout.write('unreachable\n');
  // The rational cases (P12r, P13r) take seconds each: past the 60 s default.
}, 300_000);

/** `n` random points in the unit disc and a counter-clockwise `m`-gon round them (radius 1.01). */
function discInput(
  n: number,
  m: number,
  seed: number,
): { points: Float64Array; segments: Uint32Array } {
  const rng = mulberry32(seed);
  const points = new Float64Array(2 * (n + m));
  for (let k = 0; k < m; k++) {
    const a = (2 * Math.PI * k) / m;
    points[2 * k] = 1.01 * Math.cos(a);
    points[2 * k + 1] = 1.01 * Math.sin(a);
  }
  for (let k = m; k < n + m; ) {
    const x = 2 * rng() - 1;
    const y = 2 * rng() - 1;
    if (x * x + y * y >= 1) continue;
    points[2 * k] = x;
    points[2 * k + 1] = y;
    k++;
  }
  const segments = new Uint32Array(2 * m);
  for (let k = 0; k < m; k++) {
    segments[2 * k] = k;
    segments[2 * k + 1] = (k + 1) % m;
  }
  return { points, segments };
}

/**
 * A board-size deck: 300 × 60 cm, bicubic 40 × 20 on the smooth rocker-and-crown
 * height `z = 8 (x/150 − 1)² + 3 (y/30)²`, trimmed by an elliptical outline
 * (half-axes 0.45 and 0.4 of the domain) centred at `cx`.
 */
function deck(cx: number): TrimmedSurface {
  const nu = 40;
  const nv = 20;
  const pts: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const x = (300 * i) / (nu - 1);
      const y = -30 + (60 * j) / (nv - 1);
      pts.push(x, y, 8 * (x / 150 - 1) ** 2 + 3 * (y / 30) ** 2);
    }
  }
  const s = makeSurface({
    u: clampedBasis(3, clampedUniformKnots(3, nu)),
    v: clampedBasis(3, clampedUniformKnots(3, nv)),
    points: pts,
  });
  const outline = transformCurve2(circle2({ x: 0, y: 0 }, 1), [0.45, 0, cx, 0, 0.4, 0.5]);
  return value(makeTrimmedSurface(s, value(makeTrimLoop([outline]))));
}

test('triangulation and tessellation: P19–P21', async ({ bench }) => {
  const small = discInput(5000, 400, 7);
  const large = discInput(20_000, 1000, 8);
  const board = deck(0.5);
  const moved = deck(0.5005);
  // The deck at the design's 0.005 cm is also P20's "≈ 3k triangles" size.
  const opts = { chordTol: 0.005, angleTol: 0.1 };
  const mesh = value(tessellateTrimmedSurface(board, opts));
  const nTri = mesh.triangles.length / 3;
  let sink = 0;
  await runGroup(bench, 'triangulation and tessellation (B2)', [
    {
      id: 'P19',
      name: 'constrainedDelaunay, 5k points + 400 segments, exterior removed',
      units: 0,
      target: { kind: 'time', value: 5 },
      fn: () => void constrainedDelaunay(small, { removeExterior: true }),
    },
    {
      id: 'P19',
      name: 'constrainedDelaunay, 20k points + 1k segments, exterior removed',
      units: 0,
      target: { kind: 'time', value: 40 },
      fn: () => void constrainedDelaunay(large, { removeExterior: true }),
    },
    {
      id: 'P20',
      name: `tessellateTrimmedSurface, 300 × 60 cm deck at 0.005 cm, ${nTri} triangles`,
      units: 0,
      target: { kind: 'time', value: 15 },
      fn: () => void tessellateTrimmedSurface(board, opts),
    },
    {
      id: 'P21',
      name: `retargetTessellation, no flip, ${nTri} triangles`,
      units: 0,
      target: { kind: 'time', value: 0.5 },
      fn: () => {
        sink += retargetTessellation(mesh, moved)?.triangles.length ?? 0;
      },
    },
  ]);
  if (Number.isNaN(sink)) process.stdout.write('unreachable\n');
});

/**
 * A gentle one-period sine pcurve through the interior of the board-size deck's
 * domain (63 control points, cubic): P18's input.
 */
function wavyPcurve(): NurbsCurve<2> {
  const n = 63;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    pts.push(0.2 + (0.5 * i) / (n - 1), 0.5 + 0.2 * Math.sin((2 * Math.PI * i) / (n - 1)));
  }
  return makeCurve({ dim: 2, basis: clampedBasis(3, clampedUniformKnots(3, n)), points: pts });
}

test('edge fitting, mass properties and STEP: P18, P22, P23', async ({ bench }) => {
  const surface = deck(0.5).surface;
  const onSurface = curveOnSurface(surface, wavyPcurve());
  // The 3D image of that pcurve, fitted to 0.3 × the default fit (about 70 spans): it lies on the
  // surface to well under the default fit that projecting it back is asked for.
  const edge = value(curveOnSurfaceTo3d(onSurface, { fit: 0.3 * resolveTolerances().fit })).curve;
  // A board-size 3-face B-rep: elliptic outline 300 × 60 cm, 10 cm high, fitted bicubic deck.
  const t0 = performance.now();
  const board = ellipticPuckSolid(150, 30, 10, { bicubicDeck: true, tilt: 0.02 });
  const buildMs = performance.now() - t0;
  const gap = checkBrep(board).maxEdgeGap;
  const roundTrip = writeStep(board);
  const digits9 = writeStep(board, { precision: 9 });
  const fitted = value(projectCurveToSurface(edge, surface));
  process.stdout.write(
    `\nP18 input: edge ${edge.basis.count} control points (${edge.basis.count - 3} spans); ` +
      `pcurve ${fitted.pcurve.basis.count} control points, deviation ${fitted.maxDeviation.toExponential(2)} cm\n` +
      `P23 input: board-size puck built in ${buildMs.toFixed(1)} ms (includes its deck pcurve fit, ` +
      `${board.faces[2]!.outer.coedges[0]!.pcurve.basis.count} control points, edge gap ${gap.toExponential(2)} cm); ` +
      `STEP ${roundTrip.text.length} bytes roundTrip (${roundTrip.stats.entities} entities), ` +
      `${digits9.text.length} bytes at 9 digits; declared uncertainty ${roundTrip.stats.uncertainty.toExponential(2)} mm\n`,
  );
  let sink = 0;
  await runGroup(bench, 'edge fitting, mass properties and STEP (integration)', [
    {
      id: 'P18',
      name: `projectCurveToSurface, ${edge.basis.count - 3}-span curve, default fit`,
      units: 0,
      target: { kind: 'time', value: 30 },
      fn: () => {
        sink += value(projectCurveToSurface(edge, surface)).pcurve.basis.count;
      },
    },
    {
      id: 'P18b',
      name: 'curveOnSurfaceTo3d, 63-control-point pcurve, default fit',
      units: 0,
      target: { kind: 'time', value: 30 },
      fn: () => {
        sink += value(curveOnSurfaceTo3d(onSurface)).curve.basis.count;
      },
    },
    {
      id: 'P18c',
      name: 'ellipticPuckSolid, board size, fitted bicubic deck (build + deck pcurve fit)',
      units: 0,
      target: { kind: 'time', value: 30 },
      fn: () => {
        sink += ellipticPuckSolid(150, 30, 10, { bicubicDeck: true, tilt: 0.02 }).faces.length;
      },
    },
    {
      id: 'P22',
      name: 'massProperties, 3 faces (band, planar bottom, trimmed bicubic deck), quadRel',
      units: 0,
      target: { kind: 'time', value: 50 },
      fn: () => {
        sink += massProperties(board).volume.value;
      },
    },
    {
      id: 'P23',
      name: 'writeStep, board-size 3-face B-rep, precision roundTrip',
      units: 0,
      target: { kind: 'time', value: 100 },
      fn: () => {
        sink += writeStep(board).text.length;
      },
    },
    {
      id: 'P23',
      name: 'writeStep, board-size 3-face B-rep, precision 9 digits (re-reads and re-checks)',
      units: 0,
      target: { kind: 'time', value: 100 },
      fn: () => {
        sink += writeStep(board, { precision: 9 }).text.length;
      },
    },
    {
      id: 'P20b',
      name: 'tessellateBrep, board-size 3-face B-rep, chord 0.05 cm',
      units: 0,
      target: { kind: 'time', value: 100 },
      fn: () => {
        sink += value(tessellateBrep(board, { chordTol: 0.05, angleTol: 0.1 })).indices.length;
      },
    },
  ]);
  if (Number.isNaN(sink)) process.stdout.write('unreachable\n');
}, 300_000);
