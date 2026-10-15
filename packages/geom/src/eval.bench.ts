// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Evaluation, projection and meshing benchmarks P1–P9, P17 and P19–P21
 * (docs/design/geom-core.md §17), run with
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
  circle2,
  constrainedDelaunay,
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
  evalSurfacePlan,
  evalSurfacePlanDirty,
  makeCurve,
  makeSurface,
  periodicCircle,
  planSurfaceSamples,
  principalCurvatures,
  surfaceEvalGridInto,
  surfacePoint,
  withSurfaceControlPoints,
} from './index';
import type { NurbsSurface, Result, TrimmedSurface } from './index';
import { mulberry32 } from './testing';

interface BenchRun {
  latency: { mean: number; p50: number; p99: number; rme: number };
  throughput: { mean: number };
}
type Bench = (name: string, fn: () => void) => { run: () => Promise<BenchRun> };

/** A case: its function, how many units one call does, and the target. */
interface Case {
  readonly id: string;
  readonly name: string;
  readonly fn: () => void;
  /** Units (points, samples) per call, for a rate target; 0 for a time target. */
  readonly units: number;
  /** `rate`: at least this many units per second; `time`: at most this many ms per call. */
  readonly target: { readonly kind: 'rate' | 'time'; readonly value: number };
}

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
    const r = await bench(c.name, c.fn).run();
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
