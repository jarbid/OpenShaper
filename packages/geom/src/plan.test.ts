// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sample-plan oracles (design §16, `plan` row). All exact: a plan replays the
 * same arithmetic in the same order as the direct evaluators.
 *
 * - `evalSurfacePlan` equals `surfaceEvalInto` (positions, derivatives),
 *   `surfaceNormal` (normals, degenerate flag) and `principalCurvatures`
 *   (k₁, k₂, umbilic flag) bit for bit; Float32 outputs are the rounded values;
 * - a dirty update after random edits equals a full re-evaluation bit for bit;
 * - the touched set equals the brute-force support (samples whose span pair
 *   reads a changed control point, computed from `findSpan` independently of
 *   the plan's arrays), sorted;
 * - `planMatches` is false after a new basis (a revived copy), true after
 *   control-point and weight edits;
 * - curve plans equal `curveEvalInto` and `curveCurvatureBatchInto` bit for
 *   bit, dirty updates included.
 */
import { describe, expect, it } from 'vitest';
import {
  changedControlPoints,
  createScratch,
  curveCurvatureBatchInto,
  curveEvalInto,
  evalCurvePlan,
  evalCurvePlanDirty,
  evalSurfacePlan,
  evalSurfacePlanDirty,
  findSpan,
  isGeomError,
  makeCurve,
  clampedBasis,
  planCurveSamples,
  planMatches,
  planSurfaceSamples,
  principalCurvatures,
  reviveSurface,
  SAMPLE_DEGENERATE,
  SAMPLE_UMBILIC,
  sphere,
  surfaceEvalInto,
  surfaceNormal,
  withControlPoints,
  withSurfaceControlPoints,
  withSurfaceWeights,
  withWeights,
} from './index';
import type { GeomErrorCode, NurbsCurve, NurbsSurface, SampleOutputs } from './index';
import type { ScratchImpl } from './array';
import { mulberry32, randomCurve, randomSurface } from './testing';

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected GeomError '${code}'`);
}

/** Random parameters including knots, both domain ends and out-of-domain values (clamped or wrapped). */
function params(rng: () => number, s: NurbsSurface, n: number): Float64Array {
  const pick = (b: NurbsSurface['u']): number => {
    const [a, e] = b.domain;
    const r = rng();
    if (r < 0.1) return b.knots[Math.floor(rng() * b.knots.length)]!;
    if (r < 0.15) return a;
    if (r < 0.2) return e;
    if (r < 0.25) return a - 0.3 * (e - a);
    return a + rng() * (e - a);
  };
  const uv = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    uv[2 * k] = pick(s.u);
    uv[2 * k + 1] = pick(s.v);
  }
  return uv;
}

function surfaces(seed: number): NurbsSurface[] {
  const rng = mulberry32(seed);
  const out: NurbsSurface[] = [sphere({ x: 1, y: 2, z: 3 }, 2)];
  for (let t = 0; t < 8; t++) {
    out.push(
      randomSurface(rng, {
        degreeU: 1 + (t % 4),
        degreeV: 1 + ((t + 2) % 3),
        countU: 6 + (t % 3),
        countV: 5,
        kindU: t % 3 === 0 ? 'periodic' : 'clamped',
        kindV: t % 4 === 1 ? 'periodic' : 'clamped',
        basis: { maxMult: 2 },
        weightRange: t % 2 ? [0.4, 2.5] : undefined,
      }),
    );
  }
  return out;
}

function outputs(n: number, nDer: number): Required<SampleOutputs> {
  return {
    position: new Float64Array(3 * n),
    normal: new Float64Array(3 * n),
    curvature: new Float64Array(2 * n),
    derivatives: new Float64Array([3, 9, 18][nDer]! * n),
    flags: new Uint8Array(n),
  };
}

function forNDer(o: Required<SampleOutputs>, nDer: number): SampleOutputs {
  if (nDer === 0) return { position: o.position, derivatives: o.derivatives, flags: o.flags };
  if (nDer === 1)
    return { position: o.position, derivatives: o.derivatives, normal: o.normal, flags: o.flags };
  return o;
}

describe('evalSurfacePlan', () => {
  it('equals surfaceEvalInto, surfaceNormal and principalCurvatures bit for bit', () => {
    const rng = mulberry32(101);
    const sc = createScratch({ maxDegree: 4 });
    const one = new Float64Array(18);
    for (const s of surfaces(7)) {
      const uv = params(rng, s, 60);
      for (const nDer of [0, 1, 2] as const) {
        const plan = planSurfaceSamples(s, uv, nDer);
        expect(planMatches(plan, s)).toBe(true);
        const o = outputs(plan.count, nDer);
        const out = forNDer(o, nDer);
        evalSurfacePlan(plan, s, out, sc);
        const st = [3, 9, 18][nDer]!;
        for (let k = 0; k < plan.count; k++) {
          surfaceEvalInto(s, uv[2 * k]!, uv[2 * k + 1]!, nDer, one, 0, sc);
          expect(Array.from(o.derivatives.slice(k * st, (k + 1) * st))).toEqual(
            Array.from(one.slice(0, st)),
          );
          expect(Array.from(o.position.slice(3 * k, 3 * k + 3))).toEqual(
            Array.from(one.slice(0, 3)),
          );
          // The plan stored the parameters the kernels evaluate.
          surfaceEvalInto(s, plan.uv[2 * k]!, plan.uv[2 * k + 1]!, nDer, one, 0, sc);
          expect(Array.from(o.position.slice(3 * k, 3 * k + 3))).toEqual(
            Array.from(one.slice(0, 3)),
          );
          if (nDer === 0) {
            expect(o.flags[k]).toBe(0);
            continue;
          }
          const u = plan.uv[2 * k]!;
          const v = plan.uv[2 * k + 1]!;
          const n = surfaceNormal(s, u, v);
          const nrm = Array.from(o.normal.slice(3 * k, 3 * k + 3));
          if (n.kind === 'regular') {
            expect(nrm).toEqual([n.n.x, n.n.y, n.n.z]);
            expect(o.flags[k]! & SAMPLE_DEGENERATE).toBe(0);
          } else {
            expect(nrm).toEqual([0, 0, 0]);
            expect(o.flags[k]! & SAMPLE_DEGENERATE).toBe(SAMPLE_DEGENERATE);
          }
          if (nDer === 2) {
            const c = principalCurvatures(s, u, v);
            const crv = Array.from(o.curvature.slice(2 * k, 2 * k + 2));
            if (c === null) expect(crv).toEqual([0, 0]);
            else {
              expect(crv).toEqual([c.k1, c.k2]);
              expect((o.flags[k]! & SAMPLE_UMBILIC) !== 0).toBe(c.d1 === null);
            }
          }
        }
      }
    }
  });

  it('flags the sphere’s poles degenerate and its other samples umbilic', () => {
    const s = sphere({ x: 0, y: 0, z: 0 }, 1);
    const plan = planSurfaceSamples(s, [0.3, 0, 0.3, 0.5, 0.7, 1], 2);
    const flags = new Uint8Array(3);
    const normal = new Float64Array(9);
    evalSurfacePlan(plan, s, { flags, normal }, createScratch({ maxDegree: 2 }));
    expect(Array.from(flags)).toEqual([SAMPLE_DEGENERATE, SAMPLE_UMBILIC, SAMPLE_DEGENERATE]);
    expect(Array.from(normal.slice(0, 3))).toEqual([0, 0, 0]);
  });

  it('Float32 outputs receive the Float64 values rounded', () => {
    const s = surfaces(9)[3]!;
    const uv = params(mulberry32(3), s, 40);
    const plan = planSurfaceSamples(s, uv, 2);
    const sc = createScratch({ maxDegree: 4 });
    const a = {
      position: new Float64Array(120),
      normal: new Float64Array(120),
      curvature: new Float64Array(80),
    };
    const b = {
      position: new Float32Array(120),
      normal: new Float32Array(120),
      curvature: new Float32Array(80),
    };
    evalSurfacePlan(plan, s, a, sc);
    evalSurfacePlan(plan, s, b, sc);
    expect(Array.from(b.position)).toEqual(Array.from(Float32Array.from(a.position)));
    expect(Array.from(b.normal)).toEqual(Array.from(Float32Array.from(a.normal)));
    expect(Array.from(b.curvature)).toEqual(Array.from(Float32Array.from(a.curvature)));
  });
});

/** Brute force: samples whose span pair reads control point (i, j), from findSpan and modular indices. */
function support(s: NurbsSurface, uv: ArrayLike<number>, cps: Iterable<number>): number[] {
  const nv = s.v.count;
  const set = new Set(cps);
  const hits: number[] = [];
  for (let k = 0; k < uv.length / 2; k++) {
    const su = findSpan(
      s.u,
      Math.min(
        Math.max(uv[2 * k]!, s.u.kind === 'clamped' ? s.u.domain[0] : -Infinity),
        s.u.kind === 'clamped' ? s.u.domain[1] : Infinity,
      ),
    );
    const sv = findSpan(
      s.v,
      Math.min(
        Math.max(uv[2 * k + 1]!, s.v.kind === 'clamped' ? s.v.domain[0] : -Infinity),
        s.v.kind === 'clamped' ? s.v.domain[1] : Infinity,
      ),
    );
    let touched = false;
    for (let r = 0; r <= s.u.degree && !touched; r++) {
      const i = (su - s.u.degree + r + s.u.count) % s.u.count;
      for (let c = 0; c <= s.v.degree; c++) {
        const j = (sv - s.v.degree + c + nv) % nv;
        if (set.has(i * nv + j)) touched = true;
      }
    }
    if (touched) hits.push(k);
  }
  return hits;
}

describe('evalSurfacePlanDirty', () => {
  it('after random edits equals a full re-evaluation bit for bit, touching exactly the support', () => {
    const rng = mulberry32(103);
    const sc = createScratch({ maxDegree: 4 });
    for (const s0 of surfaces(11)) {
      const uv = params(rng, s0, 80);
      const plan = planSurfaceSamples(s0, uv, 2);
      const live = outputs(plan.count, 2);
      evalSurfacePlan(plan, s0, live, sc);
      const touched = new Int32Array(plan.count);
      let s = s0;
      for (let edit = 0; edit < 6; edit++) {
        const n = s.u.count * s.v.count;
        const idx = Array.from({ length: 1 + (edit % 3) }, () => Math.floor(rng() * n));
        const next =
          edit % 3 === 2
            ? withSurfaceWeights(
                s,
                idx.map(() => 0.5 + rng()),
                idx,
              )
            : withSurfaceControlPoints(
                s,
                idx.flatMap(() => [rng(), rng(), rng()]),
                idx,
              );
        expect(planMatches(plan, next)).toBe(true);
        const changed = changedControlPoints(s, next);
        expect(Array.from(changed)).toEqual(
          s.rational === next.rational
            ? [...new Set(idx)].sort((a, b) => a - b)
            : Array.from({ length: n }, (_, i) => i),
        );
        const count = evalSurfacePlanDirty(plan, next, changed, live, touched, sc);
        expect(Array.from(touched.slice(0, count))).toEqual(support(s0, uv, changed));
        const full = outputs(plan.count, 2);
        evalSurfacePlan(plan, next, full, sc);
        for (const key of ['position', 'normal', 'curvature', 'derivatives', 'flags'] as const) {
          expect(Array.from(live[key]), `${key} after edit ${edit}`).toEqual(Array.from(full[key]));
        }
        s = next;
      }
    }
  });

  it('keeps deduplicating after the generation counter wraps', () => {
    const s = surfaces(13)[2]!;
    const uv = params(mulberry32(5), s, 30);
    const plan = planSurfaceSamples(s, uv, 1);
    const sc = createScratch({ maxDegree: 4 });
    const out = { position: new Float64Array(90) };
    const touched = new Int32Array(30);
    const all = Int32Array.from({ length: s.u.count * s.v.count }, (_, i) => i);
    expect(evalSurfacePlanDirty(plan, s, all, out, touched, sc)).toBe(30);
    (sc as ScratchImpl).grow.gen = 0xffffffff;
    expect(evalSurfacePlanDirty(plan, s, all, out, touched, sc)).toBe(30);
    expect(Array.from(touched)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(evalSurfacePlanDirty(plan, s, Int32Array.of(), out, touched, sc)).toBe(0);
  });

  it('builds a CSR whose lists are the brute-force support of each control point', () => {
    for (const s of surfaces(17).slice(0, 5)) {
      const uv = params(mulberry32(7), s, 50);
      const plan = planSurfaceSamples(s, uv, 0);
      for (let cp = 0; cp < s.u.count * s.v.count; cp++) {
        const list = Array.from(plan.cpSamples.slice(plan.cpStart[cp]!, plan.cpStart[cp + 1]!));
        expect(list).toEqual(support(s, uv, [cp]));
      }
    }
  });
});

describe('plan validity and contracts', () => {
  it('planMatches compares bases by identity', () => {
    const s = surfaces(19)[1]!;
    const plan = planSurfaceSamples(s, [0.5, 0.5], 1);
    expect(planMatches(plan, withSurfaceControlPoints(s, [1, 2, 3], [0]))).toBe(true);
    expect(planMatches(plan, withSurfaceWeights(s, [2], [0]))).toBe(true);
    const copy = reviveSurface(structuredClone(s));
    expect(planMatches(plan, copy)).toBe(false);
    expectCode(
      () => evalSurfacePlan(plan, copy, {}, createScratch({ maxDegree: 4 })),
      'size-mismatch',
    );
    const c = randomCurve(mulberry32(1), { dim: 3, degree: 3, count: 6 });
    expect(planMatches(plan, c)).toBe(false);
    expect(planMatches(planCurveSamples(c, [0.5], 1), s)).toBe(false);
  });

  it('rejects bad inputs and outputs with the documented codes', () => {
    const s = surfaces(23)[2]!;
    const sc = createScratch({ maxDegree: 4 });
    expectCode(() => planSurfaceSamples(s, [0.5], 1), 'size-mismatch');
    expectCode(() => planSurfaceSamples(s, [0.5, NaN], 1), 'non-finite');
    expectCode(() => planSurfaceSamples(s, [0.5, 0.5], 3 as 2), 'unsupported');
    const p0 = planSurfaceSamples(s, [0.5, 0.5, 0.2, 0.1], 0);
    const p1 = planSurfaceSamples(s, [0.5, 0.5, 0.2, 0.1], 1);
    expectCode(() => evalSurfacePlan(p0, s, { normal: new Float64Array(6) }, sc), 'unsupported');
    expectCode(() => evalSurfacePlan(p1, s, { curvature: new Float64Array(4) }, sc), 'unsupported');
    expectCode(
      () => evalSurfacePlan(p1, s, { position: new Float64Array(5) }, sc),
      'size-mismatch',
    );
    expectCode(
      () => evalSurfacePlan(p1, s, { derivatives: new Float64Array(17) }, sc),
      'size-mismatch',
    );
    expectCode(
      () => evalSurfacePlan(p1, s, {}, createScratch({ maxDegree: 1 })),
      'scratch-too-small',
    );
    const t = new Int32Array(2);
    expectCode(() => evalSurfacePlanDirty(p1, s, Int32Array.of(-1), {}, t, sc), 'size-mismatch');
    expectCode(() => evalSurfacePlanDirty(p1, s, Int32Array.of(999), {}, t, sc), 'size-mismatch');
    expectCode(
      () => evalSurfacePlanDirty(p1, s, Int32Array.of(0), {}, new Int32Array(1), sc),
      'size-mismatch',
    );
    const c = randomCurve(mulberry32(1), { dim: 3, degree: 3, count: 6 });
    expectCode(() => changedControlPoints(s, c), 'size-mismatch');
    expectCode(() => changedControlPoints(s, surfaces(23)[3]!), 'size-mismatch');
    expectCode(
      () => changedControlPoints(c, randomCurve(mulberry32(2), { dim: 2, degree: 3, count: 6 })),
      'size-mismatch',
    );
  });
});

describe('curve plans', () => {
  const curves = (): NurbsCurve[] => {
    const rng = mulberry32(107);
    const out: NurbsCurve[] = [];
    for (let t = 0; t < 9; t++) {
      out.push(
        randomCurve(rng, {
          dim: (1 + (t % 3)) as 1 | 2 | 3,
          degree: 1 + (t % 4),
          count: 7,
          kind: t % 3 === 1 ? 'periodic' : 'clamped',
          maxMult: 2,
          weightRange: t % 2 ? [0.4, 2.5] : undefined,
        }),
      );
    }
    return out;
  };

  it('equal curveEvalInto and curveCurvatureBatchInto bit for bit, dirty updates included', () => {
    const rng = mulberry32(109);
    const sc = createScratch({ maxDegree: 4 });
    for (const c0 of curves()) {
      const [a, e] = c0.basis.domain;
      const ts = Float64Array.from({ length: 40 }, (_, k) =>
        k % 10 === 0 ? c0.basis.knots[k % c0.basis.knots.length]! : a - 0.1 + 1.2 * (e - a) * rng(),
      );
      for (const nDer of [0, 1, 2, 3] as const) {
        const plan = planCurveSamples(c0, ts, nDer);
        const dim = c0.dim;
        const st = (nDer + 1) * dim;
        const mk = (): SampleOutputs => ({
          position: new Float64Array(40 * dim),
          derivatives: new Float64Array(40 * st),
          flags: new Uint8Array(40),
          ...(nDer >= 2 && dim > 1 ? { curvature: new Float64Array(40) } : {}),
        });
        const live = mk();
        evalCurvePlan(plan, c0, live, sc);
        let c = c0;
        for (let edit = 0; edit < 3; edit++) {
          const one = new Float64Array(st);
          const kap = new Float64Array(40);
          if (live.curvature) curveCurvatureBatchInto(c as NurbsCurve<2>, plan.t, kap, sc);
          for (let k = 0; k < 40; k++) {
            curveEvalInto(c, ts[k]!, nDer, one, 0, sc);
            expect(Array.from(live.derivatives!.slice(k * st, (k + 1) * st))).toEqual(
              Array.from(one),
            );
            expect(Array.from(live.position!.slice(k * dim, (k + 1) * dim))).toEqual(
              Array.from(one.slice(0, dim)),
            );
            if (live.curvature) expect(live.curvature[k]).toBe(kap[k]);
          }
          const idx = [Math.floor(rng() * c.basis.count)];
          const next =
            edit === 1
              ? withWeights(c, [0.5 + rng()], idx)
              : withControlPoints(
                  c,
                  Array.from({ length: dim }, () => rng()),
                  idx,
                );
          const changed = changedControlPoints(c, next);
          const touched = new Int32Array(40);
          const n = evalCurvePlanDirty(plan, next, changed, live, touched, sc);
          const full = mk();
          evalCurvePlan(plan, next, full, sc);
          for (const key of ['position', 'derivatives', 'flags', 'curvature'] as const) {
            if (live[key]) expect(Array.from(live[key]!)).toEqual(Array.from(full[key]!));
          }
          // Touched = samples whose span reads a changed control point.
          const p = c.basis.degree;
          const want: number[] = [];
          const set = new Set(changed);
          for (let k = 0; k < 40; k++) {
            const sp = plan.span[k]!;
            for (let r = 0; r <= p; r++) {
              if (set.has((sp - p + r + c.basis.count) % c.basis.count)) {
                want.push(k);
                break;
              }
            }
          }
          expect(Array.from(touched.slice(0, n))).toEqual(want);
          c = next;
        }
      }
    }
  });

  it('flags degenerate tangents and rejects outputs a curve does not have', () => {
    // C′(½) ∝ P3 + P2 − P1 − P0 = 0: a cusp at t = ½.
    const c = makeCurve({
      dim: 2,
      basis: clampedBasis(3, [0, 0, 0, 0, 1, 1, 1, 1]),
      points: [0, 0, 1, 1, 0, 1, 1, 0],
    });
    const plan = planCurveSamples(c, [0.25, 0.5], 2);
    const flags = new Uint8Array(2);
    const curvature = new Float64Array(2);
    const sc = createScratch({ maxDegree: 3 });
    evalCurvePlan(plan, c, { flags, curvature }, sc);
    expect(Array.from(flags)).toEqual([0, SAMPLE_DEGENERATE]);
    expect(curvature[1]).toBe(0);
    expectCode(() => evalCurvePlan(plan, c, { normal: new Float64Array(6) }, sc), 'unsupported');
    expectCode(
      () => evalCurvePlan(planCurveSamples(c, [0.5], 1), c, { curvature: new Float64Array(1) }, sc),
      'unsupported',
    );
    const c1 = randomCurve(mulberry32(3), { dim: 1, degree: 2, count: 4 });
    expectCode(
      () =>
        evalCurvePlan(planCurveSamples(c1, [0.5], 2), c1, { curvature: new Float64Array(1) }, sc),
      'dimension-mismatch',
    );
    expectCode(() => planCurveSamples(c, [Infinity], 1), 'non-finite');
    expectCode(() => planCurveSamples(c, [0.5], 4 as 3), 'unsupported');
  });
});
