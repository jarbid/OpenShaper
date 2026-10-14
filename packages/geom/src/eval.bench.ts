// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Evaluation and knot-operation benchmarks P1–P10 (docs/design/geom-core.md
 * §17), run with
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
  clampedBasis,
  clampedUniformKnots,
  createScratch,
  curveEvalBatchInto,
  curvePoint,
  elevateDegree,
  evalSurfacePlan,
  evalSurfacePlanDirty,
  makeCurve,
  makeSurface,
  periodicCircle,
  planSurfaceSamples,
  principalCurvatures,
  refineKnotsSurface,
  surfaceEvalGridInto,
  surfacePoint,
  withSurfaceControlPoints,
} from './index';
import type { NurbsSurface } from './index';
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
