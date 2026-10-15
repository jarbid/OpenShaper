// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Oracles for the constrained fair solver (design §16 `solver`):
 *
 * - **Range space ↔ dense null space.** `prepareFairSolver` / `solveFairInto`
 *   against `solveFairReference` (column-pivoted QR null-space method, an
 *   independent algorithm) on random curves (1D–3D) and surfaces, clamped
 *   and periodic, polynomial and rational, with random DOF rules, every
 *   constraint kind, data and per-point stiffness: control points,
 *   multipliers, energy, the dependent/inconsistent classification, and the
 *   KKT stationarity residual.
 * - **Independent of the assembly.** The reference shares the Gram matrices,
 *   data and constraint rows and `T` with the solver, so rational curves of
 *   degree 1–3 are also checked against an objective built from
 *   `curvePoint` / `curveDerivatives` only: `report.energy` equals it, the
 *   solution is its constrained minimiser (zero first-order change along
 *   feasible directions), and the handles hold by evaluation of the result.
 * - **Holladay.** Bending on the shape with knots at the data sites and
 *   point constraints there is the natural cubic spline, solved here by its
 *   own tridiagonal system (also exercises the singular-`K` path).
 * - **Constraints met** and checked by independent evaluation
 *   (`surfacePoint`, `surfaceDerivatives`) at board scale; a zero move
 *   returns the target (bitwise without constraints).
 * - **Structure.** DOF rules bitwise where §10.3 says so; `offsetFrom`
 *   neighbours keep the apex normal horizontal; rigid motions commute with
 *   the solve; mirror-symmetric input gives symmetric output; the separable
 *   and coupled formulations of the same problem agree; dependent and
 *   inconsistent rows are reported with their indices.
 * - **Influence** equals the exact difference of two solves (the solve is
 *   affine in the values).
 *
 * Tolerances (design §16): range space vs reference `1e-9` relative to the
 * net's size (the Schur path's error is ~cond·ε ≈ 2e-10 at condition 1e6;
 * the problems here are better conditioned); constraint residuals ≤
 * `constraint` (1e-9 cm) at board scale; bitwise where stated; derived
 * quantities (multipliers, influence) `1e-7` relative, since a multiplier is
 * a difference quotient of the energy and loses the digits the condition
 * number of `S` costs (≤ 1e2 here).
 */
import { describe, expect, it } from 'vitest';
import {
  clampedBasis,
  clampedUniformKnots,
  curveDerivatives,
  curvePoint,
  DEFAULT_TOLERANCES,
  fairInfluenceInto,
  fairnessEnergy,
  gaussLegendre,
  isGeomError,
  knotsFromBreaks,
  makeCurve,
  makeDofMap,
  makeSurface,
  prepareFairSolver,
  solveFair,
  solveFairInto,
  surfaceControlPoint,
  surfaceDerivatives,
  surfacePoint,
  transformSurface,
} from '../index';
import type {
  Affine3,
  Basis,
  DofRule,
  FairProblem,
  FairSolver,
  LinearConstraint,
  NurbsCurve,
  NurbsSurface,
  Point3,
  SolveReport,
} from '../index';
import { mulberry32, randomCurve, randomSurface, solveFairReference } from '../testing';

const REF = 1e-9;
/** KKT stationarity residual relative to the force scale (see `compare`). */
const STAT = 1e-10;
const DERIVED = 1e-7;
const TOL = DEFAULT_TOLERANCES;

function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
}

function ok(p: FairProblem): FairSolver {
  const r = prepareFairSolver(p);
  if (!r.ok) throw new Error(`prepare failed: ${JSON.stringify(r.issues)}`);
  return r.value;
}

function solveCw(
  s: FairSolver,
  values: ArrayLike<number>,
  n: number,
): { cw: Float64Array; report: SolveReport } {
  const cw = new Float64Array(n);
  const report = solveFairInto(s, values, cw);
  return { cw, report };
}

/** A smooth bicubic sheet at board scale (cm) with some relief. */
function board(nu = 10, nv = 8, rng = mulberry32(1)): NurbsSurface {
  const bu = clampedBasis(3, clampedUniformKnots(3, nu));
  const bv = clampedBasis(3, clampedUniformKnots(3, nv));
  const pts: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const x = (i / (nu - 1)) * 240;
      const y = (j / (nv - 1) - 0.5) * 55;
      pts.push(x, y, 4 * Math.sin((i / (nu - 1)) * Math.PI) + 0.002 * y * y + 0.3 * rng());
    }
  }
  return makeSurface({ u: bu, v: bv, points: pts });
}

/** The current value of each constraint at the target (stride 3), as a no-op drag. */
function currentValues(t: NurbsSurface, cons: readonly LinearConstraint[]): Float64Array {
  const out = new Float64Array(cons.length * 3);
  cons.forEach((c, k) => {
    if (!('uv' in c)) return;
    if (c.kind === 'point') {
      const p = surfacePoint(t, c.uv.u, c.uv.v);
      out.set([p.x, p.y, p.z], 3 * k);
    } else if (c.kind === 'derivative') {
      const d = surfaceDerivatives(t, c.uv.u, c.uv.v, 2);
      const key = (['S', 'Su', 'Suu'] as const)[c.du]!;
      const v = c.dv === 0 ? d[key] : c.dv === 1 ? (c.du === 0 ? d.Sv : d.Suv) : d.Svv;
      out.set([v.x, v.y, v.z], 3 * k);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Random problems for the reference comparison
// ---------------------------------------------------------------------------

function randomDir(rng: () => number): Point3 {
  return { x: 2 * rng() - 1, y: 2 * rng() - 1, z: 2 * rng() - 1 };
}

/** Random rules on distinct control points (each point used once as cp; masters free). */
function randomRules(rng: () => number, n: number, dim: number): DofRule[] {
  const order = Array.from({ length: n }, (_, i) => i).sort(() => rng() - 0.5);
  const rules: DofRule[] = [];
  const masters = new Set<number>();
  let k = 0;
  const next = (): number => order[k++]!;
  const take = Math.min(6, Math.floor(n / 3));
  for (let r = 0; r < take; r++) {
    const kind = Math.floor(rng() * 6);
    const cp = next();
    if (masters.has(cp)) continue;
    if (kind === 0) rules.push({ kind: 'fix', cp });
    else if (kind === 1)
      rules.push({ kind: 'fixAxes', cp, axes: 1 + Math.floor(rng() * ((1 << dim) - 1)) });
    else if (kind === 2) rules.push({ kind: 'slide', cp, dirs: [randomDir(rng)] });
    else {
      const master = next();
      masters.add(master);
      if (kind === 3) rules.push({ kind: 'offsetFrom', cp, master, dirs: [randomDir(rng)] });
      else if (kind === 4)
        rules.push({ kind: 'mirror', cp, master, plane: { normal: randomDir(rng), d: rng() } });
      else rules.push({ kind: 'copy', cp, master, offset: randomDir(rng) });
    }
  }
  return rules;
}

function compare(
  name: string,
  p: FairProblem,
  values: Float64Array,
): { a: { cw: Float64Array; report: SolveReport }; b: { cw: Float64Array; report: SolveReport } } {
  const s = ok(p);
  const a = solveCw(s, values, p.target.cw.length);
  const b = solveFairReference(p, values);
  const scale = Math.max(1, maxAbs(p.target.cw), maxAbs(b.cw));
  for (let i = 0; i < a.cw.length; i++) {
    expect(Math.abs(a.cw[i]! - b.cw[i]!), `${name}: cw[${i}]`).toBeLessThanOrEqual(REF * scale);
  }
  expect([...a.report.dependent], `${name}: dependent`).toEqual([...b.report.dependent]);
  expect([...a.report.inconsistent], `${name}: inconsistent`).toEqual([...b.report.inconsistent]);
  // Multipliers are in energy per unit of the row (tiny at board scale with
  // the scaled metric): relative to their own size, no floor.
  const ms = maxAbs(b.report.multipliers) || 1;
  for (let k = 0; k < a.report.multipliers.length; k++) {
    expect(
      Math.abs(a.report.multipliers[k]! - b.report.multipliers[k]!),
      `${name}: multiplier ${k}`,
    ).toBeLessThanOrEqual(DERIVED * ms);
  }
  // KKT stationarity (design §16): ‖Tᵀ(∇E + Cᵀλ)‖∞ against the size of the
  // forces at the solution, the multipliers' or 2E/‖δ‖ (E ~ ½|H|δ², force
  // ~ |H|δ). Measured ≤ 6e-15 of that on these problems; STAT leaves room
  // for condition numbers up to ~1e4 above them.
  let dmax = 1;
  for (let i = 0; i < a.cw.length; i++) dmax = Math.max(dmax, Math.abs(a.cw[i]! - p.target.cw[i]!));
  const force = Math.max(1, maxAbs(a.report.multipliers), (2 * Math.abs(a.report.energy)) / dmax);
  expect(a.report.stationarityResidual, `${name}: stationarity`).toBeLessThanOrEqual(STAT * force);
  expect(Math.abs(a.report.energy - b.report.energy), `${name}: energy`).toBeLessThanOrEqual(
    REF * (Math.abs(b.report.energy) || 1),
  );
  return { a, b };
}

describe('range space ↔ dense null-space reference', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`random surfaces with rules, constraints, data and stiffness (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      const rational = seed % 2 === 0;
      const t = randomSurface(rng, {
        degreeU: 3,
        degreeV: 2,
        countU: 7,
        countV: 6,
        kindU: seed % 3 === 0 ? 'periodic' : 'clamped',
        kindV: seed % 4 === 0 ? 'periodic' : 'clamped',
        weightRange: rational ? [0.6, 1.8] : undefined,
        extent: 20,
      });
      const n = t.u.count * t.v.count;
      const dof = makeDofMap(t, randomRules(rng, n, 3));
      const cons: LinearConstraint[] = [
        { kind: 'point', uv: { u: 0.3 + 0.2 * rng(), v: 0.4 }, value: { x: 0, y: 0, z: 0 } },
        {
          kind: 'derivative',
          uv: { u: 0.7, v: 0.2 + 0.5 * rng() },
          du: 1,
          dv: 0,
          value: { x: 0, y: 0, z: 0 },
          axes: 5,
        },
        {
          kind: 'raw',
          terms: [
            { cp: 3, axis: 1, coeff: 1 },
            { cp: 9, axis: 2, coeff: -0.5 },
          ],
          rhs: 0,
        },
      ];
      const values = new Float64Array(cons.length * 3);
      const cur = currentValues(t, cons);
      for (let i = 0; i < values.length; i++) values[i] = cur[i]! + 3 * (rng() - 0.5);
      values[6] = rng();
      const withData = seed % 3 !== 1;
      const p: FairProblem = {
        target: t,
        dof,
        fairness: {
          bend: 1,
          stretch: seed % 2 ? 0.1 : 0,
          metric: seed % 4 < 2 ? 'scaled' : 'parametric',
          on: seed % 5 === 0 ? 'shape' : 'displacement',
        },
        stiffness: seed % 2 ? 0.05 : Float64Array.from({ length: n }, () => 0.01 + 0.1 * rng()),
        constraints: cons,
        ...(withData
          ? {
              data: {
                params: Float64Array.from({ length: 40 }, () => rng()),
                points: Float64Array.from({ length: 60 }, () => 40 * rng() - 20),
                weights: Float64Array.from({ length: 20 }, () => rng()),
              },
            }
          : {}),
      };
      const { a } = compare(`surface ${seed}`, p, values);
      expect(a.report.constraintResidual).toBeLessThanOrEqual(TOL.constraint * 100);
    });

    it(`random curves of dimension 1–3 with tangent and derivative rows (seed ${seed})`, () => {
      const rng = mulberry32(50 + seed);
      const dim = ((seed % 3) + 1) as 1 | 2 | 3;
      const t = randomCurve(rng, {
        dim,
        degree: 3,
        count: 10,
        kind: seed % 2 ? 'periodic' : 'clamped',
        weightRange: seed % 4 < 2 ? [0.6, 1.7] : undefined,
        extent: 10,
      });
      const dof = makeDofMap(t, randomRules(rng, 10, dim));
      const zero = dim === 1 ? 0 : dim === 2 ? { x: 0, y: 0 } : { x: 0, y: 0, z: 0 };
      const dir = dim === 1 ? 1 : dim === 2 ? { x: 1, y: 0.5 } : { x: 1, y: 0.5, z: -0.2 };
      const cons = [
        { kind: 'point', t: 0.35, value: zero },
        { kind: 'derivative', t: 0.6, order: 2, value: zero },
        ...(dim > 1 ? [{ kind: 'tangentDirection', t: 0.8, direction: dir }] : []),
      ] as LinearConstraint[];
      const values = Float64Array.from({ length: cons.length * 3 }, () => 4 * rng() - 2);
      const p: FairProblem = {
        target: t,
        dof,
        fairness: { bend: 1, stretch: 0.2, jerk: seed % 2 ? 0.01 : 0 },
        stiffness: 0.1,
        constraints: cons,
      };
      compare(`curve ${seed}`, p, values);
    });
  }

  it('the singular-K path (no stiffness, no data) agrees with the reference', () => {
    // Bending alone leaves the affine motions (1, u, v per coordinate) free: K is
    // singular, and three non-collinear handles determine them.
    const t = board(8, 6);
    const base = { target: t, dof: makeDofMap(t, []), fairness: { bend: 1 }, stiffness: 0 };
    expect(prepareFairSolver({ ...base, constraints: [] }).ok).toBe(false);
    const cons: LinearConstraint[] = [
      { kind: 'point', uv: { u: 0.2, v: 0.2 }, value: { x: 0, y: 0, z: 0 } },
      { kind: 'point', uv: { u: 0.8, v: 0.3 }, value: { x: 0, y: 0, z: 0 } },
      { kind: 'point', uv: { u: 0.5, v: 0.9 }, value: { x: 0, y: 0, z: 0 } },
      { kind: 'point', uv: { u: 0.5, v: 0.5 }, value: { x: 0, y: 0, z: 0 }, axes: 4 },
      { kind: 'point', uv: { u: 0.2, v: 0.2 }, value: { x: 0, y: 0, z: 0 }, axes: 4 }, // duplicates row 2
    ];
    const values = currentValues(t, cons);
    values[2] = values[2]! + 5;
    values[5] = values[5]! - 2;
    values[9] = values[9]! + 1;
    values[14] = values[2]!;
    const a = compare('singular K', { ...base, constraints: cons }, values);
    expect(a.a.report.constraintResidual).toBeLessThanOrEqual(TOL.constraint);
    expect([...a.a.report.dependent]).toEqual([10]);
    // A contradictory duplicate does not pull the solution: same net, reported inconsistent.
    values[14] = values[2]! + 1;
    const b = compare('singular K, inconsistent', { ...base, constraints: cons }, values);
    expect([...b.a.report.inconsistent]).toEqual([10]);
    for (let i = 0; i < a.a.cw.length; i++) {
      expect(Math.abs(b.a.cw[i]! - a.a.cw[i]!)).toBeLessThanOrEqual(REF * 240);
    }
  });
});

// ---------------------------------------------------------------------------
// Independent oracles: nothing below goes through the solver's assembly
// (Gram matrices, data rows, constraint rows, T), which `solveFairReference`
// shares.
// ---------------------------------------------------------------------------

/** Gauss–Legendre points per span of the direct quadrature (self-checked against fewer below). */
const ORACLE_ORDER = 40;
/**
 * Energy vs direct quadrature: rational spans are integrated to `quadRel`
 * (1e-10) per block by the solver and the oracle is converged far below
 * that, so `1e-9` relative, as in fairness.test.ts.
 */
const ENERGY_REL = 1e-9;
/**
 * Optimality: the first-order change of the objective along a feasible `v`
 * against its second-order change `½ vᵀHv` (both from the independent
 * objective). Zero at the minimiser up to the objective's quadrature error
 * (~1e-10 of E; measured ≤ 8e-13 of `½ vᵀHv`); a fairness term missing
 * from the solver's matrix shifts it by O(1) of `½ vᵀHv` (measured
 * 0.013–1.2 on the rational degree-1 and -2 curves below when the Gram
 * matrix dropped bend and jerk above the degree).
 */
const OPT_REL = 1e-7;

/** Non-empty spans of a clamped basis. */
function clampedSpans(b: Basis): [number, number][] {
  const out: [number, number][] = [];
  for (let k = b.degree; k < b.count; k++) {
    if (b.knots[k + 1]! > b.knots[k]!) out.push([b.knots[k]!, b.knots[k + 1]!]);
  }
  return out;
}

/** Euclidean control coordinates (interleaved) and weights of a homogeneous net. */
function split(cw: ArrayLike<number>, dim: number): { x: Float64Array; w: Float64Array } {
  const h = dim + 1;
  const n = cw.length / h;
  const x = new Float64Array(n * dim);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = cw[i * h + dim]!;
    for (let c = 0; c < dim; c++) x[i * dim + c] = cw[i * h + c]! / w[i]!;
  }
  return { x, w };
}

interface Objective {
  /** The FairProblem objective (module comment of solver.ts, with its ½ factors) at Euclidean `x`. */
  readonly E: (x: Float64Array) => number;
  /** Constraint functionals on one coordinate axis: row `k` holds the coefficient of each control point. */
  readonly rows: Float64Array[];
}

/**
 * The objective of a curve problem with the parametric metric, fairness on
 * the displacement: data by `curvePoint`, fairness by Gauss–Legendre of
 * `curveDerivatives` of the displacement curve (the target's weights,
 * control points `x − x_ref`), stiffness by hand. Constraint rows from
 * indicator nets (control point `j` at 1, the rest 0, same weights).
 */
function curveObjective(
  t: NurbsCurve<3>,
  coef: readonly [number, number, number],
  mu: Float64Array,
  data: { params: Float64Array; points: Float64Array; weights: Float64Array },
  cons: readonly { t: number; order: 0 | 1 | 2 }[],
  order = ORACLE_ORDER,
): Objective {
  const { x: xRef, w } = split(t.cw, 3);
  const n = w.length;
  const gl = gaussLegendre(order);
  const sp = clampedSpans(t.basis);
  const E = (x: Float64Array): number => {
    const c = makeCurve({ dim: 3, basis: t.basis, points: x, weights: w });
    const y = makeCurve({
      dim: 3,
      basis: t.basis,
      points: x.map((v, i) => v - xRef[i]!),
      weights: w,
    });
    let e = 0;
    for (let k = 0; k < data.weights.length; k++) {
      const p = curvePoint(c, data.params[k]!);
      const dx = p.x - data.points[3 * k]!;
      const dy = p.y - data.points[3 * k + 1]!;
      const dz = p.z - data.points[3 * k + 2]!;
      e += 0.5 * data.weights[k]! * (dx * dx + dy * dy + dz * dz);
    }
    for (const [a, b] of sp) {
      const hh = (b - a) / 2;
      for (let g = 0; g < order; g++) {
        const d = curveDerivatives(y, a + hh * (gl.nodes[g]! + 1), 3);
        for (let o = 1; o <= 3; o++) {
          const v = d[o]!;
          e += 0.5 * hh * gl.weights[g]! * coef[o - 1]! * (v.x * v.x + v.y * v.y + v.z * v.z);
        }
      }
    }
    for (let i = 0; i < 3 * n; i++) e += 0.5 * mu[Math.floor(i / 3)]! * (x[i]! - xRef[i]!) ** 2;
    return e;
  };
  const rows = cons.map(({ t: at, order: o }) =>
    Float64Array.from({ length: n }, (_, j) => {
      const ind = makeCurve({
        dim: 1,
        basis: t.basis,
        points: Float64Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
        weights: w,
      });
      return o === 0 ? curvePoint(ind, at) : curveDerivatives(ind, at, o)[o]!;
    }),
  );
  return { E, rows };
}

/** `v` with its component along the span of `rows` removed, per axis (normal equations, Gaussian elimination). */
function projectOut(v: Float64Array, rows: readonly Float64Array[], dim: number): void {
  const m = rows.length;
  const n = v.length / dim;
  for (let c = 0; c < dim; c++) {
    const A = rows.map((r) => rows.map((q) => r.reduce((s, x, j) => s + x * q[j]!, 0)));
    const b = rows.map((r) => r.reduce((s, x, j) => s + x * v[j * dim + c]!, 0));
    for (let k = 0; k < m; k++) {
      for (let i = k + 1; i < m; i++) {
        const f = A[i]![k]! / A[k]![k]!;
        for (let j = k; j < m; j++) A[i]![j] = A[i]![j]! - f * A[k]![j]!;
        b[i] = b[i]! - f * b[k]!;
      }
    }
    const lam = new Array<number>(m).fill(0);
    for (let k = m - 1; k >= 0; k--) {
      let s = b[k]!;
      for (let j = k + 1; j < m; j++) s -= A[k]![j]! * lam[j]!;
      lam[k] = s / A[k]![k]!;
    }
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += lam[k]! * rows[k]![j]!;
      v[j * dim + c] = v[j * dim + c]! - s;
    }
  }
}

/**
 * Checks `report.energy` against the independent objective and that the
 * solution is its constrained minimiser: along feasible directions `v`
 * (orthogonal to every constraint row) the central difference
 * `(E(x+v) − E(x−v))/2` (exact for a quadratic) vanishes against
 * `(E(x+v) + E(x−v))/2 − E(x) = ½ vᵀHv`.
 */
function checkIndependent(
  name: string,
  obj: Objective,
  x: Float64Array,
  energy: number,
  rng: () => number,
  directions: number,
  dim: number,
): void {
  const e0 = obj.E(x);
  expect(Math.abs(energy - e0), `${name}: energy ${energy} vs ${e0}`).toBeLessThanOrEqual(
    ENERGY_REL * Math.abs(e0),
  );
  for (let d = 0; d < directions; d++) {
    const v = Float64Array.from(x, () => 2 * rng() - 1);
    projectOut(v, obj.rows, dim);
    for (const r of obj.rows) {
      for (let c = 0; c < dim; c++) {
        let s = 0;
        for (let j = 0; j < r.length; j++) s += r[j]! * v[j * dim + c]!;
        // Feasible: the projection leaves rounding of an O(n)-term dot product.
        expect(Math.abs(s)).toBeLessThanOrEqual(1e-12 * maxAbs(r) * r.length);
      }
    }
    const ep = obj.E(x.map((xi, i) => xi + v[i]!));
    const em = obj.E(x.map((xi, i) => xi - v[i]!));
    const first = (ep - em) / 2;
    const second = (ep + em) / 2 - e0;
    expect(second, `${name}: curvature`).toBeGreaterThan(0);
    expect(Math.abs(first), `${name}: first-order change along v ${d}`).toBeLessThanOrEqual(
      OPT_REL * second,
    );
  }
}

describe('independent oracles: energy, optimality and handles without the solver’s assembly', () => {
  for (const degree of [1, 2, 3]) {
    it(`rational clamped curve of degree ${degree}: stretch, bend and jerk, data, falloff, handles`, () => {
      const rng = mulberry32(700 + degree);
      const t = randomCurve(rng, {
        dim: 3,
        degree,
        count: 9,
        weightRange: [0.6, 1.7],
        extent: 10,
      }) as NurbsCurve<3>;
      const n = 9;
      const coef = [0.2, 1, 0.5] as const;
      const mu = Float64Array.from({ length: n }, () => 0.02 + 0.1 * rng());
      const data = {
        params: Float64Array.from({ length: 6 }, () => rng()),
        points: Float64Array.from({ length: 18 }, () => 20 * rng() - 10),
        weights: Float64Array.from({ length: 6 }, () => 0.2 + rng()),
      };
      const zero = { x: 0, y: 0, z: 0 };
      const cons: LinearConstraint[] = [
        { kind: 'point', t: 0.3, value: zero },
        { kind: 'derivative', t: 0.75, order: 1, value: zero },
      ];
      const s = ok({
        target: t,
        dof: makeDofMap(t, []),
        fairness: { stretch: coef[0], bend: coef[1], jerk: coef[2], metric: 'parametric' },
        stiffness: mu,
        data,
        constraints: cons,
      });
      const values = Float64Array.from({ length: 6 }, () => 6 * rng() - 3);
      const { result, report } = solveFair<NurbsCurve<3>>(s, values);
      // Handles, by evaluation of the result.
      const p = curvePoint(result, 0.3);
      const d1 = curveDerivatives(result, 0.75, 1)[1]!;
      [p.x, p.y, p.z, d1.x, d1.y, d1.z].forEach((v, k) =>
        expect(Math.abs(v - values[k]!), `handle ${k}`).toBeLessThanOrEqual(TOL.constraint),
      );
      const objOf = (order: number): Objective =>
        curveObjective(
          t,
          coef,
          mu,
          data,
          [
            { t: 0.3, order: 0 },
            { t: 0.75, order: 1 },
          ],
          order,
        );
      const obj = objOf(ORACLE_ORDER);
      const { x } = split(result.cw, 3);
      // The oracle is converged: 32 and 40 points agree far below ENERGY_REL.
      const e32 = objOf(32).E(x);
      expect(Math.abs(e32 - obj.E(x))).toBeLessThanOrEqual((ENERGY_REL / 10) * Math.abs(e32));
      checkIndependent(`degree ${degree}`, obj, x, report.energy, rng, 6, 3);
    });
  }
});

describe('Holladay: bending on the shape through the data is the natural cubic spline', () => {
  it('matches the tridiagonal natural-spline solution on non-uniform sites', () => {
    const rng = mulberry32(9);
    const sites = [0, 0.07, 0.2, 0.31, 0.5, 0.55, 0.71, 0.9, 1];
    const ys = sites.map(() => 10 * rng() - 5);
    const m = sites.length - 1;
    const basis = clampedBasis(3, knotsFromBreaks(sites, [4, ...Array<number>(m - 1).fill(1), 4]));
    // Any starting shape: with fairness on the shape and no stiffness it does not matter.
    for (const start of [0, 1]) {
      const target = makeCurve({
        dim: 1,
        basis,
        points: Array.from({ length: basis.count }, () => start * (rng() - 0.5) * 30),
      });
      const cons: LinearConstraint[] = sites.map((t) => ({ kind: 'point', t, value: 0 }));
      const s = ok({
        target,
        dof: makeDofMap(target, []),
        fairness: { bend: 1, on: 'shape', metric: 'parametric' },
        stiffness: 0,
        constraints: cons,
      });
      const values = new Float64Array(3 * cons.length);
      ys.forEach((y, k) => (values[3 * k] = y));
      const { result, report } = solveFair<NurbsCurve<1>>(s, values);
      expect(report.constraintResidual).toBeLessThanOrEqual(TOL.constraint);
      // Natural spline: h_{i−1} M_{i−1} + 2(h_{i−1} + h_i) M_i + h_i M_{i+1} = 6 (Δ_i − Δ_{i−1}), M_0 = M_m = 0.
      const h = sites.slice(1).map((x, i) => x - sites[i]!);
      const M = new Float64Array(m + 1);
      const a = new Float64Array(m + 1);
      const b = new Float64Array(m + 1);
      const c = new Float64Array(m + 1);
      const r = new Float64Array(m + 1);
      for (let i = 1; i < m; i++) {
        a[i] = h[i - 1]!;
        b[i] = 2 * (h[i - 1]! + h[i]!);
        c[i] = h[i]!;
        r[i] = 6 * ((ys[i + 1]! - ys[i]!) / h[i]! - (ys[i]! - ys[i - 1]!) / h[i - 1]!);
      }
      for (let i = 2; i < m; i++) {
        const f = a[i]! / b[i - 1]!;
        b[i] = b[i]! - f * c[i - 1]!;
        r[i] = r[i]! - f * r[i - 1]!;
      }
      for (let i = m - 1; i >= 1; i--) M[i] = (r[i]! - c[i]! * M[i + 1]!) / b[i]!;
      const spline = (t: number): number => {
        let i = 0;
        while (i < m - 1 && t > sites[i + 1]!) i++;
        const hi = h[i]!;
        const A = (sites[i + 1]! - t) / hi;
        const B = (t - sites[i]!) / hi;
        return (
          A * ys[i]! +
          B * ys[i + 1]! +
          (((A * A * A - A) * M[i]! + (B * B * B - B) * M[i + 1]!) * (hi * hi)) / 6
        );
      };
      for (let k = 0; k <= 200; k++) {
        const t = k / 200;
        expect(Math.abs(curvePoint(result, t) - spline(t)), `t = ${t}`).toBeLessThanOrEqual(
          1e-10 * 5,
        );
      }
    }
  });
});

describe('constraints and zero moves', () => {
  it('a drag moves the handle exactly where asked (independent evaluation), at board scale', () => {
    const t = board();
    const cons: LinearConstraint[] = [
      { kind: 'point', uv: { u: 0.43, v: 0.37 }, value: { x: 0, y: 0, z: 0 } },
      {
        kind: 'derivative',
        uv: { u: 0.43, v: 0.37 },
        du: 0,
        dv: 1,
        value: { x: 0, y: 0, z: 0 },
        axes: 4,
      },
    ];
    const s = ok({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 1e-3,
      constraints: cons,
    });
    const values = currentValues(t, cons);
    values[0] = values[0]! + 2.5;
    values[2] = values[2]! - 4;
    values[5] = 0; // flatten the cross slope at the handle
    const { result, report } = solveFair<NurbsSurface>(s, values);
    const p = surfacePoint(result, 0.43, 0.37);
    expect(Math.abs(p.x - values[0]!)).toBeLessThanOrEqual(TOL.constraint);
    expect(Math.abs(p.y - values[1]!)).toBeLessThanOrEqual(TOL.constraint);
    expect(Math.abs(p.z - values[2]!)).toBeLessThanOrEqual(TOL.constraint);
    expect(Math.abs(surfaceDerivatives(result, 0.43, 0.37, 1).Sv.z)).toBeLessThanOrEqual(
      TOL.constraint * 100,
    );
    expect(report.constraintResidual).toBeLessThanOrEqual(TOL.constraint);
    expect(report.dependent.length + report.inconsistent.length).toBe(0);
    // The displacement is fair: energy positive, and the report's energy is ½ the
    // displacement's fairness energy plus the stiffness term.
    const d = new Float64Array((t.cw.length / 4) * 3);
    let stiff = 0;
    for (let i = 0; i < d.length / 3; i++)
      for (let c = 0; c < 3; c++) {
        const v = result.cw[i * 4 + c]! - t.cw[i * 4 + c]!;
        stiff += v * v;
      }
    const e = 0.5 * fairnessEnergy(result, { bend: 1 }, t) + 0.5 * 1e-3 * stiff;
    expect(Math.abs(report.energy - e)).toBeLessThanOrEqual(1e-9 * e);
  });

  it('refinement holds 20 handles to `constraint` on an ill-conditioned 40 × 16 drag', () => {
    // Stiffness 1e-9 against a scaled thin plate at 300 cm: K's condition is
    // large enough that the first range-space pass misses by 6e-9 cm
    // (measured); the refinement step brings it to ~1e-13.
    const rng = mulberry32(3);
    const nu = 40;
    const nv = 16;
    const bu = clampedBasis(3, clampedUniformKnots(3, nu));
    const bv = clampedBasis(3, clampedUniformKnots(3, nv));
    const pts: number[] = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++)
        pts.push((300 * i) / (nu - 1) + 100, (60 * j) / (nv - 1) - 30, 5 * Math.sin(i) + rng());
    const t = makeSurface({ u: bu, v: bv, points: pts });
    const cons: LinearConstraint[] = Array.from({ length: 20 }, () => ({
      kind: 'point',
      uv: { u: rng(), v: rng() },
      value: { x: 0, y: 0, z: 0 },
    }));
    const s = ok({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 1e-9,
      constraints: cons,
    });
    const v = currentValues(t, cons);
    for (let i = 0; i < v.length; i++) v[i] = v[i]! + (i % 3 === 2 ? 5 : 1) * rng();
    const { report } = solveCw(s, v, t.cw.length);
    expect(report.constraintResidual).toBeLessThanOrEqual(TOL.constraint);
  });

  it('a zero move returns the target: bitwise without constraints, to rounding with them', () => {
    const t = board();
    const free = ok({
      target: t,
      dof: makeDofMap(t, [{ kind: 'fix', cp: 3 }]),
      fairness: { bend: 1 },
      stiffness: 0.1,
      constraints: [],
    });
    const a = solveCw(free, [], t.cw.length);
    expect([...a.cw]).toEqual([...t.cw]);
    expect(a.report.energy).toBe(0);
    const cons: LinearConstraint[] = [
      { kind: 'point', uv: { u: 0.5, v: 0.5 }, value: { x: 0, y: 0, z: 0 } },
    ];
    const s = ok({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0.1,
      constraints: cons,
    });
    const b = solveCw(s, currentValues(t, cons), t.cw.length);
    for (let i = 0; i < t.cw.length; i++)
      expect(Math.abs(b.cw[i]! - t.cw[i]!)).toBeLessThanOrEqual(1e-12 * 240);
  });
});

describe('structure', () => {
  it('fix, fixAxes, copy and coordinate-plane mirrors hold bitwise after a drag', () => {
    // The plane y = d: at d ≠ 0 `x_fixed + T z` alone rounds differently from
    // the reflection `2d − y`, so this also pins the solver's re-application.
    for (const d of [0, 7.3]) {
      const t = transformSurface(board(8, 7), [1, 0, 0, 0, 0, 1, 0, d, 0, 0, 1, 0]);
      const nv = 7;
      const cp = (i: number, j: number): number => i * nv + j;
      const rules: DofRule[] = [
        { kind: 'fix', cp: cp(0, 0) },
        { kind: 'fixAxes', cp: cp(4, 3), axes: 2 },
        { kind: 'copy', cp: cp(7, 6), master: cp(6, 6) },
        ...Array.from({ length: 8 }, (_, i) =>
          [0, 1, 2].map(
            (j) =>
              ({
                kind: 'mirror',
                cp: cp(i, 6 - j),
                master: cp(i, j),
                plane: { normal: { x: 0, y: 1, z: 0 }, d },
              }) as DofRule,
          ),
        ).flat(),
      ];
      // copy and mirror conflict on cp(7, 6): drop the mirror there.
      const rs = rules.filter((r) => !(r.kind === 'mirror' && r.cp === cp(7, 6)));
      const s = ok({
        target: t,
        dof: makeDofMap(t, rs),
        fairness: { bend: 1 },
        stiffness: 0.01,
        constraints: [{ kind: 'point', uv: { u: 0.3, v: 0.2 }, value: { x: 0, y: 0, z: 0 } }],
      });
      const v0 = surfacePoint(t, 0.3, 0.2);
      const { result } = solveFair<NurbsSurface>(s, [v0.x + 3, v0.y - 2, v0.z + 6]);
      const P = (i: number, j: number): Point3 => surfaceControlPoint(result, i, j);
      const R = (i: number, j: number): Point3 => surfaceControlPoint(t, i, j);
      expect(P(0, 0)).toEqual(R(0, 0));
      expect(P(4, 3).y).toBe(R(4, 3).y);
      expect(P(7, 6)).toEqual(P(6, 6));
      for (let i = 0; i < 7; i++) {
        for (const j of [0, 1, 2]) {
          expect(P(i, 6 - j).x).toBe(P(i, j).x);
          expect(P(i, 6 - j).y).toBe(2 * d - P(i, j).y);
          expect(P(i, 6 - j).z).toBe(P(i, j).z);
        }
      }
      expect(P(2, 1)).not.toEqual(R(2, 1)); // something moved
    }
  });

  it('rational net: `===` at unit weight, copied coordinates at equal weights, else to rounding', () => {
    // The stored net is homogeneous, so a point reads back as `(w·v)/w`,
    // which need not be `v` (measured on these 20 drags: 1–7 weighted
    // reflections per drag, and the unequal-weight copy in 3, are off by an
    // ulp). The contract (dof.ts, design §10.3): the solver's Euclidean
    // values hold with `===`; read back, a copied coordinate is bitwise when
    // the two weights are equal (the same `(w·v)/w` on both sides), a
    // reflected one when both weights are 1; otherwise each side is off by
    // the rounding of `w·v` and `/w` (≤ ε relative) plus the test's own
    // subtraction: ≤ 4ε·(2|d| + |y|).
    const d = 3.3;
    const t0 = transformSurface(board(8, 7), [1, 0, 0, 0, 0, 1, 0, d, 0, 0, 1, 0]);
    const nv = 7;
    const cp = (i: number, j: number): number => i * nv + j;
    const wOf = (i: number, j: number): number => 1 + 0.37 * ((i + Math.abs(j - 3)) % 3);
    const pts: number[] = [];
    const ws: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < nv; j++) {
        const p = surfaceControlPoint(t0, i, j);
        pts.push(p.x, p.y, p.z);
        ws.push(wOf(i, j));
      }
    }
    const t = makeSurface({ u: t0.u, v: t0.v, points: pts, weights: ws });
    expect(t.rational).toBe(true);
    const rules: DofRule[] = [
      { kind: 'copy', cp: cp(4, 3), master: cp(1, 3) }, // both weight 1.37
      { kind: 'copy', cp: cp(5, 3), master: cp(3, 3) }, // weights 1.74 and 1
      ...Array.from({ length: 8 }, (_, i) =>
        [0, 1, 2].map(
          (j) =>
            ({
              kind: 'mirror',
              cp: cp(i, 6 - j),
              master: cp(i, j),
              plane: { normal: { x: 0, y: 1, z: 0 }, d },
            }) as DofRule,
        ),
      ).flat(),
    ];
    const s = ok({
      target: t,
      dof: makeDofMap(t, rules),
      fairness: { bend: 1 },
      stiffness: 0.01,
      constraints: [{ kind: 'point', uv: { u: 0.3, v: 0.2 }, value: { x: 0, y: 0, z: 0 } }],
    });
    const v0 = surfacePoint(t, 0.3, 0.2);
    let weighted = 0;
    for (let drag = 0; drag < 20; drag++) {
      const { result } = solveFair<NurbsSurface>(s, [
        v0.x + 0.3 * drag,
        v0.y - 0.17 * drag,
        v0.z + 0.61 * drag,
      ]);
      const P = (i: number, j: number): Point3 => surfaceControlPoint(result, i, j);
      expect(P(4, 3)).toEqual(P(1, 3));
      const [a53, a33] = [P(5, 3), P(3, 3)];
      for (const c of ['x', 'y', 'z'] as const) {
        expect(Math.abs(a53[c] - a33[c])).toBeLessThanOrEqual(
          4 * Number.EPSILON * Math.abs(a33[c]),
        );
      }
      for (let i = 0; i < 8; i++) {
        for (const j of [0, 1, 2]) {
          const a = P(i, 6 - j);
          const b = P(i, j);
          expect(a.x).toBe(b.x);
          expect(a.z).toBe(b.z);
          if (wOf(i, j) === 1) expect(a.y).toBe(2 * d - b.y);
          else {
            weighted++;
            expect(Math.abs(a.y - (2 * d - b.y))).toBeLessThanOrEqual(
              4 * Number.EPSILON * (2 * Math.abs(d) + Math.abs(b.y)),
            );
          }
        }
      }
    }
    expect(weighted).toBeGreaterThan(0);
  });

  it('offsetFrom neighbours keep the apex normal horizontal (within `angle`)', () => {
    // v has a triple knot at 0.5: the apex row j = 4 is interpolated, and S_v on
    // either side is a multiple of its neighbours' offsets, which are vertical.
    const bu = clampedBasis(3, clampedUniformKnots(3, 8));
    const bv = clampedBasis(3, [0, 0, 0, 0, 0.25, 0.5, 0.5, 0.5, 0.75, 1, 1, 1, 1]);
    const nv = bv.count;
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < nv; j++) {
        const x = i * 30;
        const y = j === 3 || j === 5 ? 20 : (j - 4) * 6 + 20;
        const z = j === 3 ? 4 : j === 5 ? 8 : (j - 4) * 3 + 6;
        pts.push(x, j === 4 ? 25 + Math.sin(i) : y, j === 4 ? 6 : z);
      }
    }
    // Make 3 and 5 exactly above/below the apex point of their column.
    for (let i = 0; i < 8; i++) {
      for (const j of [3, 5]) {
        pts[(i * nv + j) * 3] = pts[(i * nv + 4) * 3]!;
        pts[(i * nv + j) * 3 + 1] = pts[(i * nv + 4) * 3 + 1]!;
      }
    }
    const t = makeSurface({ u: bu, v: bv, points: pts });
    const zhat = { x: 0, y: 0, z: 1 };
    const rules: DofRule[] = [];
    for (let i = 0; i < 8; i++) {
      for (const j of [3, 5])
        rules.push({ kind: 'offsetFrom', cp: i * nv + j, master: i * nv + 4, dirs: [zhat] });
    }
    const s = ok({
      target: t,
      dof: makeDofMap(t, rules),
      fairness: { bend: 1 },
      stiffness: 0.01,
      constraints: [{ kind: 'point', uv: { u: 0.45, v: 0.5 }, value: { x: 0, y: 0, z: 0 } }],
    });
    const v0 = surfacePoint(t, 0.45, 0.5);
    const { result } = solveFair<NurbsSurface>(s, [v0.x + 2, v0.y + 3, v0.z - 1.5]);
    for (let k = 0; k <= 20; k++) {
      const u = k / 20;
      for (const side of ['left', 'right'] as const) {
        const d = surfaceDerivatives(result, u, 0.5, 1, { v: side });
        const n = {
          x: d.Su.y * d.Sv.z - d.Su.z * d.Sv.y,
          y: d.Su.z * d.Sv.x - d.Su.x * d.Sv.z,
          z: d.Su.x * d.Sv.y - d.Su.y * d.Sv.x,
        };
        const len = Math.hypot(n.x, n.y, n.z);
        expect(Math.abs(n.z) / len, `u = ${u} ${side}`).toBeLessThanOrEqual(Math.sin(TOL.angle));
      }
    }
    expect(surfacePoint(result, 0.45, 0.5).y).toBeCloseTo(v0.y + 3, 9);
  });

  it('commutes with rigid motions (scaled metric)', () => {
    const t = board(9, 7);
    const c = Math.cos(0.7);
    const sn = Math.sin(0.7);
    const M: Affine3 = [c, -sn, 0, 12, sn, c, 0, -40, 0, 0, 1, 3];
    const rot = (p: Point3): Point3 => ({ x: c * p.x - sn * p.y, y: sn * p.x + c * p.y, z: p.z });
    const mv = (p: Point3): Point3 => {
      const r = rot(p);
      return { x: r.x + 12, y: r.y - 40, z: r.z + 3 };
    };
    const solve = (s: NurbsSurface, dir: Point3, handle: Point3, slope: Point3): NurbsSurface => {
      const cons: LinearConstraint[] = [
        { kind: 'point', uv: { u: 0.6, v: 0.3 }, value: { x: 0, y: 0, z: 0 } },
        { kind: 'derivative', uv: { u: 0.6, v: 0.3 }, du: 1, dv: 0, value: { x: 0, y: 0, z: 0 } },
      ];
      const sv = ok({
        target: s,
        dof: makeDofMap(s, [
          { kind: 'slide', cp: 20, dirs: [dir] },
          { kind: 'fix', cp: 0 },
        ]),
        fairness: { bend: 1, stretch: 0.01 },
        stiffness: 0.02,
        constraints: cons,
      });
      return solveFair<NurbsSurface>(sv, [handle.x, handle.y, handle.z, slope.x, slope.y, slope.z])
        .result;
    };
    const h = surfacePoint(t, 0.6, 0.3);
    const handle = { x: h.x + 4, y: h.y - 1, z: h.z + 3 };
    const slope = { x: 200, y: 10, z: 30 };
    const dir = { x: 0.3, y: 0.8, z: 0.1 };
    const a = transformSurface(solve(t, dir, handle, slope), M);
    const b = solve(transformSurface(t, M), rot(dir), mv(handle), rot(slope));
    const scale = maxAbs(a.cw);
    for (let i = 0; i < a.cw.length; i++)
      expect(Math.abs(a.cw[i]! - b.cw[i]!)).toBeLessThanOrEqual(REF * scale);
  });

  it('mirror-symmetric input gives symmetric output (no mirror rules)', () => {
    const nu = 8;
    const nv = 7;
    const bu = clampedBasis(3, clampedUniformKnots(3, nu));
    const bv = clampedBasis(3, clampedUniformKnots(3, nv));
    const rng = mulberry32(12);
    const pts = new Float64Array(nu * nv * 3);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j <= 3; j++) {
        const x = i * 25 + rng();
        const y = (j - 3) * 8 - (j === 3 ? 0 : rng());
        const z = 3 * rng();
        pts.set([x, y, z], (i * nv + j) * 3);
        pts.set([x, -y, z], (i * nv + (nv - 1 - j)) * 3);
      }
    }
    const t = makeSurface({ u: bu, v: bv, points: pts });
    const s = ok({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0.05,
      constraints: [{ kind: 'point', uv: { u: 0.4, v: 0.5 }, value: { x: 0, y: 0, z: 0 } }],
    });
    const v0 = surfacePoint(t, 0.4, 0.5);
    const { result } = solveFair<NurbsSurface>(s, [v0.x + 3, 0, v0.z + 5]);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = surfaceControlPoint(result, i, j);
        const b = surfaceControlPoint(result, i, nv - 1 - j);
        expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(REF * 200);
        expect(Math.abs(a.y + b.y)).toBeLessThanOrEqual(REF * 200);
        expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(REF * 200);
      }
    }
  });

  it('the separable and a coupled formulation of the same problem agree', () => {
    const t = board(8, 6);
    const cons: LinearConstraint[] = [
      { kind: 'point', uv: { u: 0.5, v: 0.5 }, value: { x: 0, y: 0, z: 0 } },
    ];
    const v = currentValues(t, cons);
    v[2] = v[2]! + 4;
    v[0] = v[0]! - 1;
    const base = { target: t, fairness: { bend: 1 }, stiffness: 0.05, constraints: cons } as const;
    const sep = ok({ ...base, dof: makeDofMap(t, [{ kind: 'fix', cp: 0 }]) });
    // Three orthonormal, non-axis directions span every motion: the same feasible set, coupled T.
    const q = 1 / Math.sqrt(2);
    const r3 = 1 / Math.sqrt(3);
    const r6 = 1 / Math.sqrt(6);
    const dirs = [
      { x: q, y: -q, z: 0 },
      { x: r6, y: r6, z: -2 * r6 },
      { x: r3, y: r3, z: r3 },
    ];
    const rules: DofRule[] = [{ kind: 'fix', cp: 0 }];
    for (let i = 1; i < 48; i++) rules.push({ kind: 'slide', cp: i, dirs });
    const cpl = ok({ ...base, dof: makeDofMap(t, rules) });
    expect(sep.separable).toBe(true);
    expect(cpl.separable).toBe(false);
    const a = solveFair<NurbsSurface>(sep, v).result;
    const b = solveFair<NurbsSurface>(cpl, v).result;
    for (let i = 0; i < a.cw.length; i++)
      expect(Math.abs(a.cw[i]! - b.cw[i]!)).toBeLessThanOrEqual(REF * 240);
  });

  it('reports dependent (consistent) and inconsistent rows by index and meets the others', () => {
    const t = board(8, 6);
    const P = { kind: 'point', uv: { u: 0.5, v: 0.5 }, value: { x: 0, y: 0, z: 0 } } as const;
    const Q = {
      kind: 'point',
      uv: { u: 0.2, v: 0.7 },
      value: { x: 0, y: 0, z: 0 },
      axes: 4,
    } as const;
    const cons: LinearConstraint[] = [P, Q, P]; // rows 0–2: P; 3: Q.z; 4–6: P again
    const s = ok({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0.05,
      constraints: cons,
    });
    expect(s.constraintCount).toBe(7);
    expect(s.rank).toBe(4);
    const r = prepareFairSolver({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0.05,
      constraints: cons,
    });
    expect(r.issues.map((x) => x.code)).toEqual(['dependent-constraints']);
    const v = currentValues(t, cons);
    v[2] = v[2]! + 3;
    v[8] = v[8]! + 3; // the duplicate agrees
    v[5] = v[5]! - 1;
    const a = solveFair<NurbsSurface>(s, v).report;
    expect(a.inconsistent.length).toBe(0);
    expect(a.dependent.length).toBe(3);
    expect(a.constraintResidual).toBeLessThanOrEqual(TOL.constraint);
    v[7] = v[7]! + 0.5; // the duplicate's y now disagrees
    const b = solveFair<NurbsSurface>(s, v).report;
    expect(b.dependent.length + b.inconsistent.length).toBe(3);
    // Whichever copy of P.y was dropped is the inconsistent one; the kept rows hold.
    expect(b.inconsistent.length).toBe(1);
    expect([1, 5]).toContain(b.inconsistent[0]);
    expect(b.residuals[b.inconsistent[0]!]).toBeCloseTo(0.5, 9);
    expect(b.constraintResidual).toBeLessThanOrEqual(TOL.constraint);
  });
});

describe('influence and contract', () => {
  it('fairInfluenceInto equals the exact difference of two solves', () => {
    const t = board(8, 6);
    const cons: LinearConstraint[] = [
      { kind: 'point', uv: { u: 0.3, v: 0.4 }, value: { x: 0, y: 0, z: 0 } },
      { kind: 'point', uv: { u: 0.7, v: 0.6 }, value: { x: 0, y: 0, z: 0 }, axes: 6 },
    ];
    const s = ok({
      target: t,
      dof: makeDofMap(t, [
        { kind: 'mirror', cp: 1, master: 2, plane: { normal: { x: 1, y: 1, z: 0 }, d: 3 } },
      ]),
      fairness: { bend: 1 },
      stiffness: 0.05,
      constraints: cons,
    });
    const v = currentValues(t, cons);
    const n = t.cw.length;
    const base = solveCw(s, v, n).cw;
    const out = new Float64Array(48 * 3);
    for (const [k, axis] of [
      [0, 0],
      [0, 2],
      [1, 1],
      [1, 2],
    ] as const) {
      fairInfluenceInto(s, k, axis, out);
      const w = v.slice();
      w[3 * k + axis] = w[3 * k + axis]! + 1;
      const moved = solveCw(s, w, n).cw;
      for (let i = 0; i < 48; i++) {
        for (let c = 0; c < 3; c++) {
          expect(
            Math.abs(moved[i * 4 + c]! - base[i * 4 + c]! - out[i * 3 + c]!),
          ).toBeLessThanOrEqual(DERIVED);
        }
      }
    }
    fairInfluenceInto(s, 1, 0, out); // x is not selected by constraint 1
    expect(maxAbs(out)).toBe(0);
  });

  it('an undetermined system is an error result, not a throw', () => {
    const t = board(6, 5);
    const r = prepareFairSolver({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0,
      constraints: [],
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('not-positive-definite');
    // Fairness alone plus two points: the affine motions are still free (a
    // surface needs three non-collinear points per coordinate).
    const r2 = prepareFairSolver({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0,
      constraints: [
        { kind: 'point', uv: { u: 0, v: 0 }, value: { x: 0, y: 0, z: 0 } },
        { kind: 'point', uv: { u: 1, v: 1 }, value: { x: 0, y: 0, z: 0 } },
      ],
    });
    expect(r2.ok).toBe(false);
  });

  it('solveFair equals solveFairInto bitwise; contract violations throw', () => {
    const t = board(6, 5);
    const cons: LinearConstraint[] = [
      { kind: 'point', uv: { u: 0.5, v: 0.5 }, value: { x: 0, y: 0, z: 0 } },
    ];
    const s = ok({
      target: t,
      dof: makeDofMap(t, []),
      fairness: { bend: 1 },
      stiffness: 0.1,
      constraints: cons,
    });
    const v = currentValues(t, cons);
    v[2] = v[2]! + 1;
    const a = solveFair<NurbsSurface>(s, v).result.cw;
    const b = solveCw(s, v, t.cw.length).cw;
    expect([...a]).toEqual([...b]);
    expect(() => solveFairInto(s, [1, 2], new Float64Array(t.cw.length))).toThrow(/values/);
    expect(() => solveFairInto(s, v, new Float64Array(3))).toThrow(/outCw/);
    expect(() => solveFairInto(s, [1, Number.NaN, 0], new Float64Array(t.cw.length))).toThrow(
      /finite/,
    );
    const c = makeCurve({
      dim: 2,
      basis: clampedBasis(2, clampedUniformKnots(2, 5)),
      points: [0, 0, 1, 1, 2, 0, 3, 1, 4, 0],
    });
    let code = '';
    try {
      prepareFairSolver({
        target: t,
        dof: makeDofMap(c, []),
        fairness: { bend: 1 },
        stiffness: 1,
        constraints: [],
      });
    } catch (e) {
      code = isGeomError(e) ? e.code : 'other';
    }
    expect(code).toBe('size-mismatch');
    expect(() =>
      prepareFairSolver({
        target: c,
        dof: makeDofMap(c, []),
        fairness: { bend: 1 },
        stiffness: 1,
        constraints: [{ kind: 'point', t: 2, value: { x: 0, y: 0 } }],
      }),
    ).toThrow(/outside the domain/);
  });
});
