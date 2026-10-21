// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Symmetry as DOF rules (docs/design/board2.md §3.7, §13.2 `symmetry` and
 * `plan`).
 *
 * Oracles:
 * - **Pairing** on random symmetric periodic bases (seeded): the partner's
 *   Greville abscissa is the mirror `−ū (mod 1)` within geom's `paramRel`, the
 *   map is an involution, and the roles agree with it (master ↔ partner, self
 *   exactly at fixed points). Which points are masters and self-paired is
 *   pinned on hand-worked cases: the stadium (self at n/2 − 2 and n − 2) and
 *   the off-knot uniform set (i + ½)/8 (no self point; masters 6, 7, 0, 1).
 *   Asymmetric knot sets are refused.
 * - **Through geom's solver, bitwise**: `makeDofMap` accepts the rule set of
 *   every net (plan, height field, band), and a random drag solved by
 *   `prepareFairSolver`/`solveFair` leaves every partner the exact mirror of its
 *   master (`===`, geom's contract for coordinate-plane mirrors) and every
 *   self-paired y at exactly 0, whether the dragged point is a master or a
 *   partner. Something must move (a negative control on the solve itself).
 * - **The mirror overwrite** changes a symmetric-to-rounding curve by rounding
 *   only (`4ε × scale`), after which `checkPlanSymmetry` passes. Point evaluation
 *   at mirrored parameters `C(1 − u)` vs `mirror(C(u))` is **not** bitwise
 *   (Cox–de Boor rounds `u − t_k` and `(1 − u) − t'_k` differently): it agrees
 *   within `16ε × scale` (measured ≤ 4ε × scale), and bitwise at the
 *   self-paired control points' data.
 */
import {
  controlPointsInto,
  curvePoint,
  makeCurve,
  makeDofMap,
  makeSurface,
  periodicBasis,
  prepareFairSolver,
  solveFair,
  surfaceControlPoint,
  surfacePoint,
  clampedBasis,
} from '@openshaper/geom';
import type {
  DofRule,
  NurbsCurve,
  NurbsSurface,
  PeriodicBasis,
  PeriodicCurve,
} from '@openshaper/geom';
import { checksum, mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { apexAngleAt, buildBand } from './band/band';
import { grevilleAbscissae, heightFieldSurface } from './height-field';
import { planCurve } from './plan';
import {
  checkHeightFieldSymmetry,
  checkPlanSymmetry,
  clampedPairing,
  mirrorOverwriteColumns,
  mirrorOverwriteCurve,
  periodicPairing,
  symmetryRules,
} from './symmetry';
import type { Pairing } from './symmetry';
import { sampleDoc, stadiumBoard, stadiumPlan } from './testing/index';

const EPS = Number.EPSILON;
const PARAM_REL = 1e-12;

/** A random symmetric periodic knot set of period 1 (optionally with knots at 0 and ½). */
function randomSymmetricBasis(rng: () => number): PeriodicBasis {
  const m = 2 + Math.floor(rng() * 6);
  const inner = new Set<number>();
  while (inner.size < m) inner.add(0.04 + 0.42 * rng());
  const ks = [...inner];
  const all = [...ks, ...ks.map((t) => 1 - t)];
  if (rng() < 0.5) all.push(0);
  if (rng() < 0.5) all.push(0.5);
  // Store the period from the smallest knot: [t0, t0 + 1).
  all.sort((a, b) => a - b);
  while (all.length < 4) {
    // Degree 3 needs ≥ 4 knots per period: add a symmetric pair.
    const t = 0.05 + 0.4 * rng();
    all.push(t, 1 - t);
    all.sort((a, b) => a - b);
  }
  return periodicBasis(3, all, 1);
}

/** A plan curve on `b` with random control points, made symmetric by the overwrite. */
function symmetricCurve(rng: () => number, b: PeriodicBasis, pairing: Pairing): PeriodicCurve<2> {
  const pts = Array.from({ length: b.count * 2 }, () => 100 * rng() - 50);
  return mirrorOverwriteCurve(makeCurve({ dim: 2, basis: b, points: pts }), pairing);
}

function pairingOf(b: PeriodicBasis): Pairing {
  const r = periodicPairing(b);
  if (!r.ok) throw new Error(r.message);
  return r.pairing;
}

const circ = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

describe('pairing', () => {
  it('random symmetric bases: Greville mirrors, involution, roles by half', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const b = randomSymmetricBasis(rng);
      const r = periodicPairing(b);
      expect(r.ok, `seed ${seed}`).toBe(true);
      if (!r.ok) continue;
      const { partner, role } = r.pairing;
      const g = grevilleAbscissae(b).map((x) => ((x % 1) + 1) % 1);
      for (let i = 0; i < b.count; i++) {
        const j = partner[i]!;
        expect(partner[j], `seed ${seed}`).toBe(i);
        expect(circ(g[j]!, 1 - g[i]!), `seed ${seed}`).toBeLessThanOrEqual(PARAM_REL);
        // Roles agree with the involution: a master's partner is a partner, and only
        // fixed points are self-paired.
        const pair = `${role[i]}/${role[j]}`;
        expect(['master/partner', 'partner/master', 'self/self'], `seed ${seed}`).toContain(pair);
        expect(role[i] === 'self', `seed ${seed}`).toBe(i === j);
      }
      expect(role.filter((x) => x === 'master').length).toBe(
        role.filter((x) => x === 'partner').length,
      );
    }
  });

  it('a hand-worked off-knot case: knots (i + ½)/8 have no self-paired point', () => {
    // Uniform cubic: control point i has Greville (t_{i+1} + t_{i+2} + t_{i+3})/3 =
    // t_{i+2} = (i + 2.5)/8 (mod 1). None is at 0 or ½; the mirror 1 − (i + 2.5)/8 =
    // ((3 − i) + 2.5)/8 pairs i ↔ 3 − i (mod 8): 0↔3, 1↔2, 4↔7, 5↔6. The −y half
    // (0, ½) holds the abscissae 0.5/8 … 3.5/8, i.e. i = 6, 7, 0, 1.
    const b = periodicBasis(
      3,
      Array.from({ length: 8 }, (_, i) => (i + 0.5) / 8),
      1,
    );
    const r = periodicPairing(b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.pairing.partner)).toEqual([3, 2, 1, 0, 7, 6, 5, 4]);
    expect(r.pairing.role).toEqual([
      'master',
      'master',
      'partner',
      'partner',
      'partner',
      'partner',
      'master',
      'master',
    ]);
  });

  it('the stadium and sample plans pair their tail and nose points with themselves', () => {
    const r = periodicPairing(planCurve(stadiumPlan()).basis);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const n = r.pairing.partner.length;
      const self = r.pairing.role.flatMap((x, i) => (x === 'self' ? [i] : []));
      expect(self).toEqual([n / 2 - 2, n - 2]);
      expect(r.pairing.role.filter((x) => x === 'master')).toHaveLength(n / 2 - 1);
    }
  });

  it('refuses asymmetric knot sets', () => {
    const b = periodicBasis(3, [0, 0.1, 0.3, 0.6, 0.85], 1);
    const r = periodicPairing(b);
    expect(r.ok).toBe(false);
    // Symmetric to within far more than paramRel is still refused.
    const near = periodicBasis(3, [0, 0.2, 0.4, 0.6 + 1e-9, 0.8], 1);
    expect(periodicPairing(near).ok).toBe(false);
  });

  it('clamped: j ↔ m − 1 − j on symmetric knots, refused otherwise', () => {
    const r = clampedPairing(clampedBasis(3, [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1]));
    expect(r.ok && Array.from(r.pairing.partner)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(r.ok && r.pairing.role).toEqual([
      'master',
      'master',
      'master',
      'self',
      'partner',
      'partner',
      'partner',
    ]);
    expect(clampedPairing(clampedBasis(3, [0, 0, 0, 0, 0.3, 1, 1, 1, 1])).ok).toBe(false);
  });
});

describe('DOF rules through geom’s solver: partners stay exact mirrors', () => {
  /** Partners `===` mirrors of their masters and self-paired y `=== 0`, on a curve net. */
  function expectMirrored(c: NurbsCurve, p: Pairing, label: string): void {
    const d = c.dim;
    const pts = new Float64Array(c.basis.count * d);
    controlPointsInto(c, pts, 0);
    for (let i = 0; i < p.partner.length; i++) {
      const m = p.partner[i]!;
      if (p.role[i] === 'self') expect(pts[i * d + 1] === 0, label).toBe(true);
      if (p.role[i] === 'partner') {
        expect(pts[i * d], label).toBe(pts[m * d]);
        expect(pts[i * d + 1] === -pts[m * d + 1]!, label).toBe(true);
        if (d === 3) expect(pts[i * d + 2], label).toBe(pts[m * d + 2]);
      }
    }
  }

  it('plan loop: random symmetric loops, drags on a master and on a partner', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const b = randomSymmetricBasis(rng);
      const p = pairingOf(b);
      const c = symmetricCurve(rng, b, p);
      const rules = symmetryRules({ plan: c }, 'plan');
      expect(rules.ok).toBe(true);
      if (!rules.ok) continue;
      const dof = makeDofMap(c, rules.value);
      for (const u of [0.05 + 0.4 * rng(), 0.55 + 0.4 * rng()]) {
        const s = prepareFairSolver({
          target: c,
          dof,
          fairness: { bend: 1 },
          stiffness: 0.01,
          constraints: [{ kind: 'point', t: u, value: { x: 0, y: 0 } }],
        });
        expect(s.ok, `seed ${seed}`).toBe(true);
        if (!s.ok) continue;
        const q = curvePoint(c, u);
        const { result } = solveFair<PeriodicCurve<2>>(s.value, [
          q.x + 10 * rng() - 5,
          q.y + 10 * rng() - 5,
          0,
        ]);
        expectMirrored(result, p, `seed ${seed}, u ${u}`);
        expect(checksum(result), `seed ${seed}: something moved`).not.toBe(checksum(c));
      }
    }
  });

  it('height fields: z free on masters, x, y fixed, partners mirrored', () => {
    const d = stadiumBoard();
    const deck = heightFieldSurface(d.deck, d.symmetry);
    const rules = symmetryRules({ deck }, 'deck');
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;
    const dof = makeDofMap(deck, rules.value);
    // Only the masters' and the middle row's z are free.
    const nv = deck.v.count;
    expect(dof.dofCount).toBe(deck.u.count * ((nv + 1) / 2));
    const rng = mulberry32(5);
    for (let k = 0; k < 10; k++) {
      const uv = { u: rng(), v: rng() };
      const s = prepareFairSolver({
        target: deck,
        dof,
        fairness: { bend: 1 },
        stiffness: 0.01,
        constraints: [{ kind: 'point', uv, value: { x: 0, y: 0, z: 0 }, axes: 4 }],
      });
      expect(s.ok).toBe(true);
      if (!s.ok) continue;
      const z = surfacePoint(deck, uv.u, uv.v).z;
      const { result } = solveFair<NurbsSurface>(s.value, [0, 0, z + 2 * rng() - 1]);
      for (let i = 0; i < deck.u.count; i++) {
        for (let j = 0; j < nv; j++) {
          const a = surfaceControlPoint(result, i, j);
          const ref = surfaceControlPoint(deck, i, j);
          const m = surfaceControlPoint(result, i, nv - 1 - j);
          expect(a.x).toBe(ref.x);
          expect(a.y === ref.y).toBe(true);
          expect(a.z).toBe(m.z);
          expect(a.y === -m.y).toBe(true);
        }
      }
      expect(checksum(result)).not.toBe(checksum(deck));
    }
  });

  it('height fields: an unpaired x, y grid (asymmetric extent) gets no mirror rules', () => {
    // With symmetric v knots but y ∈ [−10, 30], mirror rules would overwrite each
    // partner row's y with −y_master, moving it off the affine grid: refused.
    const d = stadiumBoard();
    const asym = { ...d.deck, y: [-10, 30] as const };
    const r = symmetryRules({ deck: heightFieldSurface(asym, 'none') }, 'deck');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['symmetry-broken']);
    // A stringer row off y = 0: one ulp on the middle row's y.
    const deck = heightFieldSurface(d.deck, 'mirror-y');
    const nv = deck.v.count;
    const pts = new Float64Array(deck.u.count * nv * 3);
    for (let i = 0; i < deck.u.count; i++) {
      for (let j = 0; j < nv; j++) {
        const p = surfaceControlPoint(deck, i, j);
        pts.set([p.x, p.y, p.z], (i * nv + j) * 3);
      }
    }
    pts[((nv - 1) / 2) * 3 + 1] = 1e-300;
    const off = makeSurface({ u: deck.u, v: deck.v, points: pts });
    expect(symmetryRules({ deck: off }, 'deck').ok).toBe(false);
    // The symmetric build of the same document is accepted (the positive control).
    expect(symmetryRules({ deck }, 'deck').ok).toBe(true);
    expect(symmetryRules({ bottom: heightFieldSurface(d.bottom, 'mirror-y') }, 'bottom').ok).toBe(
      true,
    );
  });

  it('band: every row of a partner column mirrors its master column; stringer columns keep y = 0', () => {
    const plan = planCurve(stadiumPlan());
    const pu = pairingOf(plan.basis);
    const v = clampedBasis(3, [0, 0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1]);
    const rows = v.count;
    const n = plan.basis.count;
    const planPts = new Float64Array(n * 2);
    controlPointsInto(plan, planPts, 0);
    // A plausible band net: each column a profile in its station's plane.
    const pts = new Float64Array(n * rows * 3);
    for (let i = 0; i < n; i++) {
      const x = planPts[2 * i]!;
      const y = planPts[2 * i + 1]!;
      const len = Math.hypot(x - 90, y) || 1;
      for (let r = 0; r < rows; r++) {
        const inset = [3, 1.5, 0, 0, 0, 1, 2][r]!;
        const o = (i * rows + r) * 3;
        pts[o] = x - (inset * (x - 90)) / len;
        pts[o + 1] = y - (inset * y) / len;
        pts[o + 2] = [6, 5.5, 4, 3, 2, 0.5, 0][r]!;
      }
    }
    mirrorOverwriteColumns(pts, rows, pu);
    const band = makeSurface({ u: plan.basis, v, points: pts });
    const rules = symmetryRules({ band }, 'band');
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;
    const dof = makeDofMap(band, rules.value);
    const rng = mulberry32(9);
    for (let k = 0; k < 6; k++) {
      const uv = { u: rng(), v: rng() };
      const s = prepareFairSolver({
        target: band,
        dof,
        fairness: { bend: 1 },
        stiffness: 0.01,
        constraints: [{ kind: 'point', uv, value: { x: 0, y: 0, z: 0 } }],
      });
      expect(s.ok).toBe(true);
      if (!s.ok) continue;
      const q = surfacePoint(band, uv.u, uv.v);
      const { result } = solveFair<NurbsSurface>(s.value, [
        q.x + rng() - 0.5,
        q.y + rng() - 0.5,
        q.z + rng() - 0.5,
      ]);
      for (let i = 0; i < n; i++) {
        for (let r = 0; r < rows; r++) {
          const a = surfaceControlPoint(result, i, r);
          if (pu.role[i] === 'self') expect(a.y === 0).toBe(true);
          if (pu.role[i] === 'partner') {
            const m = surfaceControlPoint(result, pu.partner[i]!, r);
            expect(a.x).toBe(m.x);
            expect(a.y === -m.y).toBe(true);
            expect(a.z).toBe(m.z);
          }
        }
      }
      expect(checksum(result)).not.toBe(checksum(band));
    }
  });

  it("band (step S3): the §3.5 row rules on a built band, through geom's solver", () => {
    // The crowned stadium: a real band with sloped deck edges and rocker.
    const r = buildBand(stadiumBoard({ crown: 1.5, rocker: 8 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const band = r.value.band;
    const rules = symmetryRules({ band }, 'band');
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;
    const pu = pairingOf(band.u as PeriodicBasis);
    const n = band.u.count;
    const dof = makeDofMap(band, rules.value);
    // Free per master or self column: row 1 (1), row 2 (1), row 3 z (1), row 4 (1), row 5 (2).
    const free = pu.role.filter((x) => x !== 'partner').length;
    expect(dof.dofCount).toBe(6 * free);
    const rng = mulberry32(21);
    for (let k = 0; k < 6; k++) {
      const uv = { u: rng(), v: 0.15 + 0.7 * rng() };
      const s = prepareFairSolver({
        target: band,
        dof,
        fairness: { bend: 1 },
        stiffness: 0.01,
        constraints: [{ kind: 'point', uv, value: { x: 0, y: 0, z: 0 } }],
      });
      expect(s.ok).toBe(true);
      if (!s.ok) continue;
      const q = surfacePoint(band, uv.u, uv.v);
      const { result } = solveFair<NurbsSurface>(s.value, [q.x + 0.3, q.y - 0.2, q.z + 0.4]);
      expect(checksum(result)).not.toBe(checksum(band));
      for (let i = 0; i < n; i++) {
        const P = (r: number) => surfaceControlPoint(result, i, r);
        const R = (r: number) => surfaceControlPoint(band, i, r);
        if (pu.role[i] === 'partner') {
          const m = (r: number) => surfaceControlPoint(result, pu.partner[i]!, r);
          for (let r = 0; r < 7; r++) {
            expect(P(r).x).toBe(m(r).x);
            expect(P(r).y === -m(r).y).toBe(true);
            expect(P(r).z).toBe(m(r).z);
          }
          continue;
        }
        if (pu.role[i] === 'self') for (let r = 0; r < 7; r++) expect(P(r).y === 0).toBe(true);
        // Rows 0 and 6 fixed; the apex keeps x, y; rows 2 and 4 stay on its vertical.
        expect(P(0)).toEqual(R(0));
        expect(P(6)).toEqual(R(6));
        expect([P(3).x, P(3).y]).toEqual([R(3).x, R(3).y]);
        for (const r of [2, 4]) {
          expect(Math.abs(P(r).x - P(3).x)).toBeLessThanOrEqual(1e-12 * 200);
          expect(Math.abs(P(r).y - P(3).y)).toBeLessThanOrEqual(1e-12 * 200);
        }
        // Row 1 slides along the deck handle (cross product with the old handle ≈ 0).
        const a = [R(1).x - R(0).x, R(1).y - R(0).y, R(1).z - R(0).z];
        const b = [P(1).x - P(0).x, P(1).y - P(0).y, P(1).z - P(0).z];
        const cr = Math.hypot(
          a[1]! * b[2]! - a[2]! * b[1]!,
          a[2]! * b[0]! - a[0]! * b[2]!,
          a[0]! * b[1]! - a[1]! * b[0]!,
        );
        expect(cr).toBeLessThanOrEqual(1e-12 * 200 * Math.hypot(a[0]!, a[1]!, a[2]!));
      }
      // The apex join stays G1 after the solve.
      let worst = 0;
      for (let k2 = 0; k2 < 400; k2++) worst = Math.max(worst, apexAngleAt(result, k2 / 400));
      expect(worst).toBeLessThanOrEqual(1e-9);
    }
  });

  it('rule sets: masters carry no rule; missing nets and asymmetric bases are error results', () => {
    const plan = planCurve(stadiumPlan());
    const r = symmetryRules({ plan }, 'plan');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = pairingOf(plan.basis);
      const ruled = new Set(r.value.map((x: DofRule) => x.cp));
      for (let i = 0; i < p.partner.length; i++) {
        expect(ruled.has(i)).toBe(p.role[i] !== 'master');
      }
    }
    expect(symmetryRules({}, 'band').ok).toBe(false);
    expect(symmetryRules({ plan }, 'deck').ok).toBe(false);
    const asym = makeCurve({
      dim: 2,
      basis: periodicBasis(3, [0, 0.1, 0.3, 0.6, 0.85], 1),
      points: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
    });
    const bad = symmetryRules({ plan: asym }, 'plan');
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]!.code).toBe('symmetry-broken');
    // Inputs untouched.
    const before = checksum(plan);
    symmetryRules({ plan }, 'plan');
    expect(checksum(plan)).toBe(before);
  });
});

describe('the mirror overwrite and the document checks', () => {
  it('the overwrite only removes rounding; afterwards the plan check passes', () => {
    const c = planCurve(stadiumPlan());
    const p = pairingOf(c.basis);
    // Perturb by rounding-sized amounts, then overwrite.
    const pts = new Float64Array(c.basis.count * 2);
    controlPointsInto(c, pts, 0);
    const rng = mulberry32(3);
    const noisy = pts.map((v) => v * (1 + 2 * EPS * (rng() - 0.5)));
    const nc = makeCurve({ dim: 2, basis: c.basis, points: noisy });
    expect(checkPlanSymmetry(nc).length).toBeGreaterThan(0);
    const fixed = mirrorOverwriteCurve(nc, p);
    expect(checkPlanSymmetry(fixed)).toEqual([]);
    const out = new Float64Array(pts.length);
    controlPointsInto(fixed, out, 0);
    for (let k = 0; k < pts.length; k++) {
      expect(Math.abs(out[k]! - pts[k]!)).toBeLessThanOrEqual(4 * EPS * 200);
    }
  });

  it('C(1 − u) = mirror(C(u)) to rounding (not bitwise: Cox–de Boor rounds differently)', () => {
    const c = planCurve(stadiumPlan());
    let worst = 0;
    let bitwise = 0;
    const N = 999;
    for (let k = 1; k < N; k++) {
      const u = k / N / 2;
      const a = curvePoint(c, u);
      const b = curvePoint(c, 1 - u);
      worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y + b.y));
      if (a.x === b.x && a.y === -b.y) bitwise++;
    }
    expect(worst).toBeLessThanOrEqual(16 * EPS * 200);
    // Recorded: most pairs differ in the last bits (see board2.md, S2 deviations).
    expect(bitwise).toBeLessThan(N - 1);
  });

  it('checkPlanSymmetry: one ulp on a partner, or y ≠ 0 on the stringer, is symmetry-broken', () => {
    const json = sampleDoc().plan;
    const c = planCurve(json);
    expect(checkPlanSymmetry(c)).toEqual([]);
    const p = pairingOf(c.basis);
    const partner = p.role.indexOf('partner');
    const pts = [...json.points];
    pts[2 * partner] = pts[2 * partner]! + 2 * EPS * Math.abs(pts[2 * partner]!);
    const issues = checkPlanSymmetry(planCurve({ ...json, points: pts }));
    expect(issues.map((i) => i.code)).toEqual(['symmetry-broken']);
    const self = p.role.indexOf('self');
    const pts2 = [...json.points];
    pts2[2 * self + 1] = 1e-300;
    expect(checkPlanSymmetry(planCurve({ ...json, points: pts2 })).map((i) => i.code)).toEqual([
      'symmetry-broken',
    ]);
  });

  it('checkHeightFieldSymmetry: extent, knots and heights, each a negative control', () => {
    const d = stadiumBoard();
    expect(checkHeightFieldSymmetry(d.deck, 'deck')).toEqual([]);
    const y = { ...d.deck, y: [d.deck.y[0], d.deck.y[1] + 1e-9] as const };
    expect(checkHeightFieldSymmetry(y, 'deck').map((i) => i.at?.face)).toEqual(['deck']);
    const kv = [...d.deck.knotsV];
    kv[4] = 0.3;
    expect(checkHeightFieldSymmetry({ ...d.deck, knotsV: kv }, 'deck')).toHaveLength(1);
    const z = [...d.deck.z];
    z[1] = z[1]! + 1e-12;
    const zi = checkHeightFieldSymmetry({ ...d.deck, z }, 'bottom');
    expect(zi.map((i) => [i.code, i.at?.face, i.value])).toEqual([
      ['symmetry-broken', 'bottom', 1],
    ]);
  });
});
