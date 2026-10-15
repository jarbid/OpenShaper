// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Continuity measures (design §6.18, §11.4; oracle row `continuity` of §16).
 *
 * Oracles:
 *
 * - **Knot insertion split ⇒ G2.** A random wavy rational bicubic patch split at a
 *   non-knot and at an existing knot (P&T A5.1 to full multiplicity, the
 *   halves taken from the refined net, P&T §5.3): the halves are the same
 *   C²-or-better surface, so gap, angle and curvature mismatch are rounding.
 * - **Crease.** Two planes hinged at θ about a common line: the normal angle
 *   is θ at every sample (π − θ with the other orientation), curvatures 0.
 * - **G1, not G2.** A plane tangent to a cylinder (the extrusions of a line
 *   meeting a quarter circle tangentially): angle 0, curvature mismatch
 *   exactly `1/r`. The same join of the profile curves reads the same.
 * - **Lens rail.** Two circular arcs of half-chord `c` and sagitta `h` meeting
 *   at a tip (extruded): the outward normals there differ by
 *   `π − 4·atan(h/c)` (each arc's tangent leaves the chord at `2·atan(h/c)`),
 *   which also equals the angle between the radii to the tip.
 * - **Gap.** A parallel offset δ reads δ everywhere; a gap growing linearly
 *   with arc length (δ·y over y ∈ [0, 1]) on an edge with a non-uniform
 *   parameter reads max δ at the vertex and arc-length RMS exactly δ/√3 (the
 *   default Gauss rule integrates that polynomial exactly), which a plain
 *   sample mean would not.
 * - **RMS convergence** to `√(∫ atan(ku)² du)` (adaptive Gauss–Kronrod
 *   reference, an independent integrator) as the samples per span grow.
 * - **Refinement.** A crease angle `atan(u − u³)` peaks between Gauss points
 *   at `u = 1/√3`; the refined maximum and its parameter match the closed form.
 * - **Sides.** On a roof (a C⁰ knot line), `interior` picks the face.
 * - **Orientation.** The same cylinder continued by an extrusion whose
 *   `+Su × Sv` points inward (and whose boundary runs the other way) is G2
 *   with `sameSense: false`, and reads an S-bend (π, `2/r`) without it.
 * - **Along curves.** `knotContinuity` on designed C⁰ / C¹ / C² / C³
 *   (removable) / G1 (speed change) / G2-not-C1 (a Bézier split by de Casteljau
 *   with its second piece's domain stretched) / G1-not-G2 (arc + line) joins.
 *
 * Tolerances (`ε` = 2.2e-16, scale = 1–10 here):
 *
 * - gaps of exact constructions `64 ε · scale`: ~10 flops per coordinate in
 *   each evaluation (and the projection's foot, converged to rounding);
 *   measured ≤ 0.75 ε · scale on the split patches;
 * - angles `1e-12` rad (§16): `atan2` of normals each good to ~1e-15
 *   (measured ≤ 7e-15 on the split patches);
 * - curvature mismatch `1e-12` relative to the curvature scale (§16): second
 *   derivatives of rational patches lose ~3 digits in the quotient rule
 *   (measured ≤ 2e-14 on the split patches);
 * - closed-form RMS and refined maxima `1e-12` relative: sums of ≤ 10³ terms;
 *   the golden-section maximum is quadratic in a bracket of ~1e-9;
 * - RMS convergence: the 16-point rule's error below `1e-12` (measured ~1e-15).
 */
import { describe, expect, it } from 'vitest';
import {
  bezierCurve,
  bezierSurface,
  boundaryContinuity,
  boundaryCurve,
  circle2,
  circleArc,
  clampedBasis,
  classifyContinuity,
  curveJoinContinuity,
  DEFAULT_CONTINUITY_SAMPLING,
  edgeContinuity,
  extrude,
  findSpan,
  integrate1d,
  isGeomError,
  isoLinePcurve,
  knotContinuity,
  line,
  line2,
  makeCurve,
  makeSurface,
  periodicCircle,
  planeSurface,
  polyline,
  sphere,
  surfaceFromHomogeneous,
  surfacePoint,
} from './index';
import type { ContinuityProfile, NurbsCurve, NurbsSurface, ParamDir } from './index';
import { curveKnotIns } from './book/refine';
import { mulberry32, randomClampedBasis } from './testing';

const EPS = Number.EPSILON;

function throwsCode(f: () => unknown, code: string): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a GeomError ${code}`);
}

const maxOf = (a: ArrayLike<number>): number => {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i]!);
  return m;
};

/**
 * Splits `s` at `x` in direction `dir` by inserting `x` to full multiplicity
 * in every row (P&T A5.1) and taking the two halves of the refined net.
 */
function splitSurface(
  s: NurbsSurface,
  dir: ParamDir,
  x: number,
): readonly [NurbsSurface, NurbsSurface] {
  const b = dir === 'u' ? s.u : s.v;
  const o = dir === 'u' ? s.v : s.u;
  const p = b.degree;
  const n = b.count;
  const U = b.knots;
  const k = findSpan(b, x);
  let mult = 0;
  for (let i = 0; i < U.length; i++) if (U[i] === x) mult++;
  const r = p - mult;
  const nq = n - 1 + r;
  const cut = k - mult; // the refined net's point at x
  const nl = cut + 1;
  const nr = nq - cut + 1;
  const left = new Float64Array(nl * o.count * 4);
  const right = new Float64Array(nr * o.count * 4);
  let UQ = new Float64Array(0);
  // Index of net point (i along `dir`, j along the other) in s.cw / a half's net.
  const at = (i: number, j: number, cnt: number): number =>
    dir === 'u' ? (i * o.count + j) * 4 : (j * cnt + i) * 4;
  for (let j = 0; j < o.count; j++) {
    const Pw = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) Pw[4 * i + c] = s.cw[at(i, j, n) + c]!;
    const ins = r > 0 ? curveKnotIns(n - 1, p, U, Pw, 4, x, k, mult, r) : { UQ: U, Qw: Pw };
    UQ = Float64Array.from(ins.UQ);
    for (let i = 0; i < nl; i++)
      for (let c = 0; c < 4; c++) left[at(i, j, nl) + c] = ins.Qw[4 * i + c]!;
    for (let i = 0; i < nr; i++)
      for (let c = 0; c < 4; c++) right[at(i, j, nr) + c] = ins.Qw[4 * (cut + i) + c]!;
  }
  const kl = [...Array.from(UQ.subarray(0, cut + p + 1)), x];
  const kr = [x, ...Array.from(UQ.subarray(cut + 1))];
  const bl = clampedBasis(p, kl);
  const br = clampedBasis(p, kr);
  const mk = (bb: typeof bl, cw: Float64Array): NurbsSurface =>
    dir === 'u'
      ? surfaceFromHomogeneous({ u: bb, v: s.v, cw })
      : surfaceFromHomogeneous({ u: s.u, v: bb, cw });
  return [mk(bl, left), mk(br, right)];
}

/**
 * A random rational bicubic patch that is well conditioned: a jittered grid
 * over the unit square with heights in ±0.3 and weights in [0.5, 2] (random
 * knots, simple). A fully random net has near-singular points where the
 * curvature is 10⁶ and its rounding swamps any relative tolerance.
 */
function wavyPatch(rng: () => number): NurbsSurface {
  const [nu, nv] = [6, 5];
  const pts: number[] = [];
  const wts: number[] = [];
  const j = (): number => 0.05 * (2 * rng() - 1);
  for (let i = 0; i < nu; i++) {
    for (let k = 0; k < nv; k++) {
      pts.push(i / (nu - 1) + j(), k / (nv - 1) + j(), 0.3 * (2 * rng() - 1));
      wts.push(0.5 + 1.5 * rng());
    }
  }
  return makeSurface({
    u: randomClampedBasis(rng, 3, nu),
    v: randomClampedBasis(rng, 3, nv),
    points: pts,
    weights: wts,
  });
}

/** Bounding-box diagonal of a net. */
function scaleOf(...ss: NurbsSurface[]): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const s of ss) {
    for (let i = 0; i < s.cw.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const x = s.cw[i + k]! / s.cw[i + 3]!;
        lo[k] = Math.min(lo[k]!, x);
        hi[k] = Math.max(hi[k]!, x);
      }
    }
  }
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

function expectAll(p: ContinuityProfile, f: (i: number) => void): void {
  for (let i = 0; i < p.t.length; i++) f(i);
}

describe('a wavy rational patch split by knot insertion is G2 (all measures ~0)', () => {
  for (const seed of [1, 2, 3, 4]) {
    for (const dir of ['u', 'v'] as const) {
      it(`seed ${seed}, split in ${dir}`, () => {
        const rng = mulberry32(seed);
        const S = wavyPatch(rng);
        const b = dir === 'u' ? S.u : S.v;
        // A non-knot inside a span, and an existing simple interior knot.
        const knot = b.knots[b.degree + 1]!;
        for (const x of [0.5 * (b.knots[b.degree]! + knot), knot]) {
          const [L, R] = splitSurface(S, dir, x);
          // The halves reproduce the surface (sanity of the split itself).
          const fixed = dir === 'u' ? S.v.domain : S.u.domain;
          for (const y of [fixed[0], 0.37 * fixed[0] + 0.63 * fixed[1], fixed[1]]) {
            const [uu, vv] = dir === 'u' ? [x, y] : [y, x];
            const P = surfacePoint(S, uu, vv);
            const Q = surfacePoint(L, uu, vv);
            expect(Math.hypot(P.x - Q.x, P.y - Q.y, P.z - Q.z)).toBeLessThan(64 * EPS * 4);
          }
          const scale = scaleOf(L, R);
          const e1 = dir === 'u' ? 'u1' : 'v1';
          const e0 = dir === 'u' ? 'u0' : 'v0';
          const other: ParamDir = dir;
          const profiles = [
            boundaryContinuity(
              { surface: L, edge: e1, sameSense: true },
              { surface: R, edge: e0, sameSense: true },
            ),
            boundaryContinuity(
              { surface: R, edge: e0, sameSense: true },
              { surface: L, edge: e1, sameSense: true },
            ),
            edgeContinuity(
              boundaryCurve(L, e1) as NurbsCurve<3>,
              { surface: L, pcurve: isoLinePcurve(L, other, x), sameSense: true },
              { surface: R, pcurve: isoLinePcurve(R, other, x), sameSense: true },
            ),
          ];
          for (const p of profiles) {
            expect(p.degenerate).toBe(0);
            const kScale = Math.max(p.max.curvature, 1 / scale);
            expect(p.max.gap).toBeLessThan(64 * EPS * scale);
            expect(p.max.normalAngle).toBeLessThan(1e-12);
            expect(p.max.curvatureMismatch).toBeLessThan(1e-12 * kScale);
            expect(p.rms.gap).toBeLessThanOrEqual(p.max.gap);
            expect(p.rms.curvatureMismatch).toBeLessThanOrEqual(p.max.curvatureMismatch);
          }
        }
      });
    }
  }
});

/** Plane A: z = 0 for x ≤ 0, `S_A(u, v) = (−v, u, 0)`, n = +z; its edge `v0` is the y axis. */
const planeA = planeSurface({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 });
/** Plane B hinged at θ: `S_B(u, v) = (v cos θ, u, v sin θ)`; `+Su × Sv` = (sin θ, 0, −cos θ). */
const hinged = (th: number): NurbsSurface =>
  planeSurface(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: Math.cos(th), y: 0, z: Math.sin(th) },
  );
const yAxis = line({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

describe('a crease reads its exact angle', () => {
  for (const th of [1e-3, 0.1, 1, Math.PI / 2, 2.5]) {
    it(`planes hinged at θ = ${th}`, () => {
      const B = hinged(th);
      // B's outward normal is −(+Su × Sv) = (−sin θ, 0, cos θ): θ from A's +z.
      const sides = [
        edgeContinuity(
          yAxis,
          { surface: planeA, pcurve: isoLinePcurve(planeA, 'v', 0), sameSense: true },
          { surface: B, pcurve: isoLinePcurve(B, 'v', 0), sameSense: false },
        ),
        boundaryContinuity(
          { surface: planeA, edge: 'v0', sameSense: true },
          { surface: B, edge: 'v0', sameSense: false },
        ),
      ];
      for (const p of sides) {
        expect(p.degenerate).toBe(0);
        expectAll(p, (i) => {
          expect(Math.abs(p.normalAngle[i]! - th)).toBeLessThan(1e-12);
          expect(p.curvatureMismatch[i]).toBe(0);
          expect(p.gap[i]).toBe(0);
        });
        expect(Math.abs(p.max.normalAngle - th)).toBeLessThan(1e-12);
        expect(Math.abs(p.rms.normalAngle - th)).toBeLessThan(1e-12);
      }
      // The other orientation: π − θ.
      const q = boundaryContinuity(
        { surface: planeA, edge: 'v0', sameSense: true },
        { surface: B, edge: 'v0', sameSense: true },
      );
      expect(Math.abs(q.max.normalAngle - (Math.PI - th))).toBeLessThan(1e-12);
    });
  }

  it('a parallel offset δ reads δ, angle 0', () => {
    const d = 0.0123;
    const B = planeSurface({ x: 0, y: 0, z: d }, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    // +Su × Sv = y × x = −z: sameSense false makes it +z like A.
    const p = boundaryContinuity(
      { surface: planeA, edge: 'v0', sameSense: true },
      { surface: B, edge: 'v0', sameSense: false },
    );
    // |C − S_B| = |0 − δ| exactly at the samples; the refinement's projection may move by an ulp.
    expectAll(p, (i) => expect(p.gap[i]).toBe(d));
    expect(Math.abs(p.max.gap - d)).toBeLessThan(4 * EPS * d);
    expect(Math.abs(p.rms.gap - d)).toBeLessThan(1e-15);
    expect(p.max.normalAngle).toBe(0);
  });

  it('a gap growing along a non-uniformly parameterised edge: max at the vertex, arc-length RMS δ/√3', () => {
    const d = 0.05;
    // Edge y(t) = 0.2t + 0.8t² (degree 2, y′ > 0) along the y axis; A's pcurve the same in u.
    const ys = [0, 0.1, 1];
    const edge = makeCurve({
      dim: 3,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: ys.flatMap((y) => [0, y, 0]),
    });
    const pc = makeCurve({
      dim: 2,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: ys.flatMap((y) => [y, 0]),
    });
    // B(u, v) = (v, u, δu): at the edge, δ·y above it; +Su × Sv = (0, δ, −1).
    const B = planeSurface({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: d }, { x: 1, y: 0, z: 0 });
    const A = { surface: planeA, pcurve: pc, sameSense: true };
    const p = edgeContinuity(edge, A, { surface: B, pcurve: pc, sameSense: false });
    expect(Math.abs(p.max.gap - d)).toBeLessThan(64 * EPS);
    expect(p.argmax.gap).toBe(1);
    expect(Math.abs(p.rms.gap - d / Math.sqrt(3)) / d).toBeLessThan(1e-12);
    // A plain mean of squares over the samples would differ (the parameter is not arc length).
    const plain = Math.sqrt(Array.from(p.gap).reduce((s, g) => s + g * g, 0) / p.gap.length);
    expect(Math.abs(plain - d / Math.sqrt(3)) / d).toBeGreaterThan(1e-3);
    // B's outward normal (0, −δ, 1)/√(1 + δ²) is atan δ from +z everywhere.
    expectAll(p, (i) => expect(Math.abs(p.normalAngle[i]! - Math.atan(d))).toBeLessThan(1e-12));
    // Without refinement the maximum is the arrays' maximum, short of the vertex.
    const q = edgeContinuity(
      edge,
      A,
      { surface: B, pcurve: pc, sameSense: false },
      { refineMax: false },
    );
    expect(q.max.gap).toBe(maxOf(q.gap));
    expect(q.max.gap).toBeLessThan(d * 0.99);
  });
});

/** Extrusion along +z by `h` of a 3D profile curve. */
const up = (c: NurbsCurve<3>, h: number): NurbsSurface => extrude(c, { x: 0, y: 0, z: h });

describe('G1 but not G2: a plane tangent to a cylinder', () => {
  const r = 2.5;
  const h = 3;
  const L = 4;
  const O = { x: 0, y: 0, z: 0 };
  const X = { x: 1, y: 0, z: 0 };
  const Y = { x: 0, y: 1, z: 0 };
  // The quarter circle from (r, 0) to (0, r) (CCW), then the line on to (−L, r).
  const arc = circleArc(O, X, Y, r, 0, Math.PI / 2);
  const ln = line({ x: 0, y: r, z: 0 }, { x: -L, y: r, z: 0 });
  // Both extrusions have +Su × Sv = C′ × z = +y at the join: outward from the cylinder.
  const cyl = up(arc, h);
  const plane = up(ln, h);

  it('angle 0, curvature mismatch exactly 1/r, both orders and both entry points', () => {
    const profiles = [
      boundaryContinuity(
        { surface: cyl, edge: 'u1', sameSense: true },
        { surface: plane, edge: 'u0', sameSense: true },
      ),
      boundaryContinuity(
        { surface: plane, edge: 'u0', sameSense: true },
        { surface: cyl, edge: 'u1', sameSense: true },
      ),
      edgeContinuity(
        line({ x: 0, y: r, z: 0 }, { x: 0, y: r, z: h }),
        { surface: cyl, pcurve: isoLinePcurve(cyl, 'u', 1), sameSense: true },
        { surface: plane, pcurve: isoLinePcurve(plane, 'u', 0), sameSense: true },
      ),
    ];
    for (const p of profiles) {
      expect(p.degenerate).toBe(0);
      expectAll(p, (i) => {
        expect(p.gap[i]).toBeLessThan(64 * EPS * 10);
        expect(p.normalAngle[i]).toBeLessThan(1e-12);
        expect(Math.abs(p.curvatureMismatch[i]! - 1 / r) * r).toBeLessThan(1e-12);
        expect(Math.abs(p.curvature[i]! - 1 / r) * r).toBeLessThan(1e-12);
      });
      expect(Math.abs(p.max.curvatureMismatch - 1 / r) * r).toBeLessThan(1e-12);
      expect(Math.abs(p.rms.curvatureMismatch - 1 / r) * r).toBeLessThan(1e-12);
      expect(
        classifyContinuity(
          {
            gap: p.max.gap,
            angle: p.max.normalAngle,
            curvatureMismatch: p.max.curvatureMismatch,
            curvature: p.max.curvature,
          },
          { gap: 1e-6, angle: 1e-9, curvatureRel: 0.01, curvatureAbs: 1e-9 },
        ),
      ).toBe('G1');
    }
  });

  it('orientation: the same cylinder continued by a flipped, reversed extrusion is G2', () => {
    // The next quarter arc, extruded downwards from z = h: +Su × Sv points inward and
    // its boundary u0 runs from z = h to 0. sameSense false makes it outward again.
    const arc2 = circleArc({ x: 0, y: 0, z: h }, X, Y, r, Math.PI / 2, Math.PI);
    const cyl2 = extrude(arc2, { x: 0, y: 0, z: -h });
    const p = boundaryContinuity(
      { surface: cyl, edge: 'u1', sameSense: true },
      { surface: cyl2, edge: 'u0', sameSense: false },
    );
    expect(p.max.gap).toBeLessThan(64 * EPS * 10);
    expect(p.max.normalAngle).toBeLessThan(1e-12);
    expect(p.max.curvatureMismatch * r).toBeLessThan(1e-12);
    expect(Math.abs(p.max.curvature - 1 / r) * r).toBeLessThan(1e-12);
    // Ignoring the orientation would read an S-bend: angle π, mismatch 2/r.
    const q = boundaryContinuity(
      { surface: cyl, edge: 'u1', sameSense: true },
      { surface: cyl2, edge: 'u0', sameSense: true },
    );
    expect(Math.abs(q.max.normalAngle - Math.PI)).toBeLessThan(1e-12);
    expect(Math.abs(q.max.curvatureMismatch - 2 / r) * r).toBeLessThan(1e-12);
  });

  it('the profile curves join G1 with curvature jump 1/r (2D and 3D)', () => {
    const j3 = curveJoinContinuity(arc, ln);
    const j2 = curveJoinContinuity(
      circle2({ x: 0, y: 0 }, r, [0, Math.PI / 2]),
      line2({ x: 0, y: r }, { x: -L, y: r }),
    );
    for (const j of [j3, j2]) {
      expect(j.degenerate).toBe(false);
      expect(j.gap).toBeLessThan(64 * EPS * r);
      expect(j.tangentAngle).toBeLessThan(1e-12);
      expect(Math.abs(j.curvatureMismatch - 1 / r) * r).toBeLessThan(1e-12);
    }
    // Reversed order: the line's end does not meet the arc's start.
    const k = curveJoinContinuity(ln, arc);
    expect(Math.abs(k.gap - Math.hypot(L + r, r))).toBeLessThan(64 * EPS * 10);
  });
});

describe('lens rail: two arcs meeting at a tip', () => {
  for (const [c, h] of [
    [1, 0.3],
    [2, 0.5],
    [1, 1], // semicircles: a full circle, smooth
  ] as const) {
    it(`half-chord ${c}, sagitta ${h}`, () => {
      const R = (c * c + h * h) / (2 * h);
      const phi = Math.atan2(R - h, c); // the tip's angle seen from the upper arc's centre
      const X = { x: 1, y: 0, z: 0 };
      const Y = { x: 0, y: 1, z: 0 };
      // Upper arc CCW from the right tip over the top; lower arc CCW from the left tip under the bottom.
      const upper = up(circleArc({ x: 0, y: h - R, z: 0 }, X, Y, R, phi, Math.PI - phi), 1);
      const lower = up(
        circleArc({ x: 0, y: R - h, z: 0 }, X, Y, R, Math.PI + phi, 2 * Math.PI - phi),
        1,
      );
      // Both +Su × Sv are radial outward: outward of the lens.
      const p = boundaryContinuity(
        { surface: upper, edge: 'u0', sameSense: true },
        { surface: lower, edge: 'u1', sameSense: true },
      );
      const expected = Math.PI - 4 * Math.atan(h / c);
      // Independent form: the angle between the radii to the tip.
      expect(Math.abs(expected - 2 * phi)).toBeLessThan(1e-14);
      expect(p.gap.every((g) => g < 64 * EPS * 4)).toBe(true);
      expectAll(p, (i) => expect(Math.abs(p.normalAngle[i]! - expected)).toBeLessThan(1e-12));
      // Both faces bend away from their outward normals with curvature 1/R: no mismatch.
      expect(p.max.curvatureMismatch * R).toBeLessThan(1e-12);
      expect(Math.abs(p.max.curvature - 1 / R) * R).toBeLessThan(1e-12);
    });
  }
});

describe('summaries', () => {
  it('the RMS converges to √(∫ m² ds / ∫ ds) as samples per span grow', () => {
    const k = 1.5;
    // B(u, v) = (v, u, k·u·v): at v = 0 the normal (k u, 0, −1) is atan(k u) from −z.
    const B = bezierSurface([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, k], 2, 2);
    const A = { surface: planeA, pcurve: isoLinePcurve(planeA, 'v', 0), sameSense: true };
    const Bs = { surface: B, pcurve: isoLinePcurve(B, 'v', 0), sameSense: false };
    const ref = Math.sqrt(
      integrate1d((u) => Math.atan(k * u) ** 2, 0, 1, { tol: { quadRel: 1e-14 } }).value,
    );
    const errs = [1, 2, 4, 8, 16].map((n) =>
      Math.abs(edgeContinuity(yAxis, A, Bs, { samplesPerSpan: n }).rms.normalAngle - ref),
    );
    for (let i = 1; i < errs.length; i++) expect(errs[i]!).toBeLessThan(errs[i - 1]!);
    expect(errs[4]!).toBeLessThan(1e-12);
    const p = edgeContinuity(yAxis, A, Bs);
    expect(Math.abs(p.max.normalAngle - Math.atan(k))).toBeLessThan(1e-12);
    expect(p.argmax.normalAngle).toBe(1);
  });

  it('refines an interior maximum between the samples', () => {
    // B(u, v) = (v, u, v·g(u)), g = u − u³ (Bernstein coefficients 0, 1/3, 2/3, 0):
    // the crease angle atan g(u) peaks at u = 1/√3, between the Gauss points.
    const g = [0, 1 / 3, 2 / 3, 0];
    const pts: number[] = [];
    for (let i = 0; i < 4; i++) pts.push(0, i / 3, 0, 1, i / 3, g[i]!);
    const B = bezierSurface(pts, 4, 2);
    const A = { surface: planeA, pcurve: isoLinePcurve(planeA, 'v', 0), sameSense: true };
    const Bs = { surface: B, pcurve: isoLinePcurve(B, 'v', 0), sameSense: false };
    const top = Math.atan(2 / (3 * Math.sqrt(3)));
    const raw = edgeContinuity(yAxis, A, Bs, { refineMax: false });
    expect(raw.max.normalAngle).toBe(maxOf(raw.normalAngle));
    expect(top - raw.max.normalAngle).toBeGreaterThan(1e-4);
    const p = edgeContinuity(yAxis, A, Bs);
    expect(Math.abs(p.max.normalAngle - top)).toBeLessThan(1e-12 * top);
    expect(Math.abs(p.argmax.normalAngle - 1 / Math.sqrt(3))).toBeLessThan(1e-6);
    expect(p.max.normalAngle).toBeGreaterThanOrEqual(maxOf(p.normalAngle));
    expect(DEFAULT_CONTINUITY_SAMPLING).toEqual({ refineMax: true, refineSteps: 40 });
  });

  it('samples: Gauss points of every span of the union of the curves’ knots, ascending', () => {
    const B = hinged(0.4);
    // A pcurve with an interior knot at 0.3, an edge with one at 0.6.
    const pcA = makeCurve({
      dim: 2,
      basis: clampedBasis(1, [0, 0, 0.3, 1, 1]),
      points: [0, 0, 0.3, 0, 1, 0],
    });
    const edge = makeCurve({
      dim: 3,
      basis: clampedBasis(1, [0, 0, 0.6, 1, 1]),
      points: [0, 0, 0, 0, 0.6, 0, 0, 1, 0],
    });
    const p = edgeContinuity(
      edge,
      { surface: planeA, pcurve: pcA, sameSense: true },
      { surface: B, pcurve: isoLinePcurve(B, 'v', 0), sameSense: false },
      { samplesPerSpan: 3 },
    );
    expect(p.t.length).toBe(9);
    for (let i = 1; i < p.t.length; i++) expect(p.t[i]!).toBeGreaterThan(p.t[i - 1]!);
    // Three per span: [0, 0.3], [0.3, 0.6], [0.6, 1].
    expect(Array.from(p.t).filter((t) => t < 0.3).length).toBe(3);
    expect(Array.from(p.t).filter((t) => t > 0.6).length).toBe(3);
    for (const a of [p.gap, p.normalAngle, p.curvatureMismatch, p.curvature, p.flags]) {
      expect(a.length).toBe(9);
    }
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.max)).toBe(true);
  });

  it('a collapsed edge (a pole) is flagged degenerate: no angle or curvature', () => {
    const S = sphere({ x: 0, y: 0, z: 0 }, 2);
    const p = boundaryContinuity(
      { surface: S, edge: 'v0', sameSense: true },
      { surface: S, edge: 'v0', sameSense: true },
    );
    expect(p.degenerate).toBe(p.t.length);
    expect(Array.from(p.flags).every((f) => f === 1)).toBe(true);
    expect(p.max.normalAngle).toBe(0);
    expect(p.rms.curvatureMismatch).toBe(0);
    expect(p.max.gap).toBe(0);
  });
});

describe('interior picks the face at a C⁰ knot line', () => {
  // A roof: degree 1 in u with a full-multiplicity knot at 0.5; ridge at height hr.
  const hr = 0.7;
  const roof = makeSurface({
    u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
    v: clampedBasis(1, [0, 0, 1, 1]),
    points: [-1, 0, 0, -1, 1, 0, 0, 0, hr, 0, 1, hr, 1, 0, 0, 1, 1, 0],
  });
  const ridge = line({ x: 0, y: 0, z: hr }, { x: 0, y: 1, z: hr });
  const pc = isoLinePcurve(roof, 'u', 0.5); // t ↦ (0.5, t): the face at u < 0.5 is on its left
  it('left and right faces differ by the roof angle; the same face by nothing', () => {
    const left = { surface: roof, pcurve: pc, sameSense: true, interior: 'left' as const };
    const right = { surface: roof, pcurve: pc, sameSense: true, interior: 'right' as const };
    const p = edgeContinuity(ridge, left, right);
    expectAll(p, (i) =>
      expect(Math.abs(p.normalAngle[i]! - 2 * Math.atan(hr))).toBeLessThan(1e-12),
    );
    expect(edgeContinuity(ridge, left, left).max.normalAngle).toBe(0);
    expect(edgeContinuity(ridge, right, { ...right, interior: undefined }).max.normalAngle).toBe(0);
  });
});

describe('knotContinuity on designed joins', () => {
  const rng = mulberry32(7);
  const rnd = (n: number): number[] => Array.from({ length: n }, () => 2 * rng() - 1);

  it('C⁰ corner: parametric 0, geometric 0, the corner angle', () => {
    const a = 0.8;
    const c = polyline([0, 0, 1, 0, 1 + Math.cos(a), Math.sin(a)], 2);
    const k = knotContinuity(c, 0.5);
    expect(k.parametric).toBe(0);
    expect(k.geometric).toBe(0);
    expect(Math.abs(k.jumps.tangentAngle - a)).toBeLessThan(1e-12);
  });

  it('a speed change on a straight line: G2 (G∞), not C1', () => {
    const c = polyline([0, 0, 0, 1, 0, 0, 3, 0, 0], 3);
    const k = knotContinuity(c, 0.5);
    expect(k.parametric).toBe(0);
    expect(k.geometric).toBe(2);
    expect(Math.abs(k.jumps.d1 - 2)).toBeLessThan(1e-14);
    expect(k.jumps.tangentAngle).toBe(0);
  });

  it('cubic: simple knot C², double knot C¹, removable knot C³', () => {
    const simple = makeCurve({
      dim: 3,
      basis: clampedBasis(3, [0, 0, 0, 0, 0.4, 1, 1, 1, 1]),
      points: rnd(15),
      weights: [1, 1.5, 0.7, 1.2, 1],
    });
    const ks = knotContinuity(simple, 0.4);
    expect([ks.parametric, ks.geometric]).toEqual([2, 2]);
    expect(ks.jumps.d3).toBeGreaterThan(1e-3);
    const dbl = makeCurve({
      dim: 2,
      basis: clampedBasis(3, [0, 0, 0, 0, 0.4, 0.4, 1, 1, 1, 1]),
      points: rnd(12),
    });
    const kd = knotContinuity(dbl, 0.4);
    expect([kd.parametric, kd.geometric]).toEqual([1, 1]);
    expect(kd.jumps.curvature).toBeGreaterThan(1e-3);
    // Insert 0.4 into a rational Bézier cubic: the knot is removable.
    const bz = bezierCurve(3, rnd(12), [1, 0.6, 1.8, 1.1]);
    const ins = curveKnotIns(3, 3, bz.basis.knots, bz.cw, 4, 0.4, 3, 0, 1);
    const rem = makeCurve({
      dim: 3,
      basis: clampedBasis(3, ins.UQ),
      points: Array.from({ length: 5 }, (_, i) =>
        [0, 1, 2].map((k) => ins.Qw[4 * i + k]! / ins.Qw[4 * i + 3]!),
      ).flat(),
      weights: Array.from({ length: 5 }, (_, i) => ins.Qw[4 * i + 3]!),
    });
    const kr = knotContinuity(rem, 0.4);
    expect([kr.parametric, kr.geometric]).toEqual([3, 2]);
  });

  it('G2 but not C1: a Bézier split by de Casteljau, second piece stretched', () => {
    const bz = bezierCurve(3, rnd(12), [1, 1.4, 0.8, 1.2]);
    // Insert 0.3 three times (multiplicity 3 = p: the halves' nets), then stretch [0.3, 1] to [0.3, 2].
    const ins = curveKnotIns(3, 3, bz.basis.knots, bz.cw, 4, 0.3, 3, 0, 3);
    const knots = Array.from(ins.UQ, (u) => (u === 1 ? 2 : u));
    const c = makeCurve({
      dim: 3,
      basis: clampedBasis(3, knots),
      points: Array.from({ length: 7 }, (_, i) =>
        [0, 1, 2].map((k) => ins.Qw[4 * i + k]! / ins.Qw[4 * i + 3]!),
      ).flat(),
      weights: Array.from({ length: 7 }, (_, i) => ins.Qw[4 * i + 3]!),
    });
    const k = knotContinuity(c, 0.3);
    expect(k.parametric).toBe(0);
    expect(k.geometric).toBe(2);
    expect(k.jumps.tangentAngle).toBeLessThan(1e-12);
    expect(k.jumps.d1).toBeGreaterThan(0.1);
  });

  it('G1 but not G2: a quarter circle continued by a line in one curve', () => {
    const r = 1.7;
    const w = Math.SQRT1_2;
    const c = makeCurve({
      dim: 2,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 2, 2, 2]),
      points: [r, 0, r, r, 0, r, -1, r, -2, r],
      weights: [1, w, 1, 1, 1],
    });
    const k = knotContinuity(c, 1);
    expect(k.geometric).toBe(1);
    expect(k.jumps.tangentAngle).toBeLessThan(1e-12);
    expect(Math.abs(k.jumps.curvature - 1 / r) * r).toBeLessThan(1e-12);
  });

  it('the periodic circle is G2 at its seam; a clamped end has one side only', () => {
    const c = periodicCircle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 2);
    const k = knotContinuity(c, 0);
    expect(k.geometric).toBe(2);
    expect(k.parametric).toBeGreaterThanOrEqual(1);
    throwsCode(
      () => knotContinuity(line({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 1),
      'side-unavailable',
    );
  });
});

describe('classifyContinuity', () => {
  const th = { gap: 1e-4, angle: 1e-3, curvatureRel: 0.05, curvatureAbs: 1e-3 };
  const m = { gap: 0, angle: 0, curvatureMismatch: 0, curvature: 1 };
  it('applies the thresholds in order', () => {
    expect(classifyContinuity(m, th)).toBe('G2');
    expect(classifyContinuity({ ...m, curvatureMismatch: 0.04 }, th)).toBe('G2');
    expect(classifyContinuity({ ...m, curvatureMismatch: 0.06 }, th)).toBe('G1');
    expect(classifyContinuity({ ...m, curvatureMismatch: 5e-4, curvature: 0 }, th)).toBe('G2');
    expect(classifyContinuity({ ...m, angle: 2e-3 }, th)).toBe('G0');
    expect(classifyContinuity({ ...m, gap: 2e-4, angle: 1 }, th)).toBe('none');
  });
  it('rejects missing or invalid thresholds and measures', () => {
    throwsCode(() => classifyContinuity(m, { ...th, angle: NaN }), 'non-finite');
    throwsCode(() => classifyContinuity(m, { ...th, gap: -1 }), 'unsupported');
    throwsCode(() => classifyContinuity({ ...m, gap: -1 }, th), 'unsupported');
  });
});

describe('validation', () => {
  const B = hinged(0.3);
  const A = { surface: planeA, pcurve: isoLinePcurve(planeA, 'v', 0), sameSense: true };
  const Bs = { surface: B, pcurve: isoLinePcurve(B, 'v', 0), sameSense: true };
  it('needs same-parameter pcurves inside their surfaces', () => {
    const half = line({ x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 });
    const shortEdge = makeCurve({
      dim: 3,
      basis: clampedBasis(1, [0, 0, 0.5, 0.5]),
      points: [0, 0, 0, 0, 0.5, 0],
    });
    expect(() => edgeContinuity(half, A, Bs)).not.toThrow(); // same domain [0, 1], another shape: a gap
    throwsCode(() => edgeContinuity(shortEdge, A, Bs), 'param-out-of-domain');
    const outside = { ...A, pcurve: line2({ x: 0, y: 0 }, { x: 0, y: 2 }) };
    throwsCode(() => edgeContinuity(yAxis, outside, Bs), 'param-out-of-domain');
    throwsCode(() => edgeContinuity(yAxis, A, Bs, { samplesPerSpan: 0 }), 'unsupported');
    throwsCode(() => edgeContinuity(yAxis, A, Bs, { refineSteps: -1 }), 'unsupported');
    throwsCode(
      () =>
        boundaryContinuity(
          { surface: sphere({ x: 0, y: 0, z: 0 }, 1), edge: 'u0', sameSense: true },
          { surface: B, edge: 'v0', sameSense: true },
        ),
      'unsupported',
    );
  });
  it('a gap between an edge and its faces is measured from the edge too', () => {
    const half = line({ x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 });
    const p = edgeContinuity(half, A, Bs);
    // C(t) = (0, t/2, 0) against S(0, t, 0): |t/2|, largest at t = 1.
    expect(Math.abs(p.max.gap - 0.5)).toBeLessThan(64 * EPS);
  });
});

describe('review of B3: where the samples go', () => {
  /** A bicubic plane over the unit square (x = u, y = v) with a z-bump at u = 0.8 on the v = 0 row. */
  const bumpy = (): NurbsSurface => {
    const uk = [0, 0, 0, 0, 0.76, 0.78, 0.8, 0.82, 0.84, 1, 1, 1, 1];
    const nu = uk.length - 4;
    const pts: number[] = [];
    for (let i = 0; i < nu; i++) {
      const gx = (uk[i + 1]! + uk[i + 2]! + uk[i + 3]!) / 3; // Greville: x(u) = u exactly
      for (let j = 0; j < 4; j++) pts.push(gx, j / 3, i === 5 && j === 0 ? 0.01 : 0);
    }
    return makeSurface({
      u: clampedBasis(3, uk),
      v: clampedBasis(3, [0, 0, 0, 0, 1, 1, 1, 1]),
      points: pts,
    });
  };
  const flat = planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const xAxis = line({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const pcx = line2({ x: 0, y: 0 }, { x: 1, y: 0 });

  it('a pcurve crossing the surface’s knot lines is sampled between them: a narrow bump is not missed', () => {
    const B = bumpy();
    const p = edgeContinuity(
      xAxis,
      { surface: flat, pcurve: pcx, sameSense: true },
      { surface: B, pcurve: pcx, sameSense: true },
    );
    // Independent oracle: the bump height by ternary search on B's own evaluation
    // (the bump z(u) is unimodal on [0.78, 0.9]).
    const zAt = (u: number): number => surfacePoint(B, u, 0).z;
    let [lo, hi] = [0.78, 0.9];
    for (let i = 0; i < 200; i++) {
      const [m1, m2] = [lo + (hi - lo) / 3, hi - (hi - lo) / 3];
      if (zAt(m1) < zAt(m2)) lo = m1;
      else hi = m2;
    }
    const zmax = zAt(0.5 * (lo + hi));
    expect(zmax).toBeGreaterThan(6e-3);
    // Tolerance 1e-9 relative: the golden-section maximum of a smooth peak.
    expect(Math.abs(p.max.gap - zmax)).toBeLessThan(1e-9 * zmax);
    // The samples include B's knot parameters as span ends: 0.76 … 0.84 split the edge into 6 spans.
    const inBump = Array.from(p.t).filter((t) => t > 0.76 && t < 0.84).length;
    expect(inBump).toBe(4 * Math.min(2 * 3 + 1, 64)); // 4 knot spans × the default 7 points
    // |z|² is piecewise degree 6 and the edge has unit speed: the default rule is exact on each
    // span, so the RMS matches an independent adaptive integral with B's knots as breaks.
    const ref = Math.sqrt(
      integrate1d((t) => surfacePoint(B, t, 0).z ** 2, 0, 1, {
        breaks: [0, 0.76, 0.78, 0.8, 0.82, 0.84, 1],
        tol: { quadRel: 1e-14 },
      }).value,
    );
    expect(Math.abs(p.rms.gap - ref)).toBeLessThan(1e-12 * ref);
    // The same geometry through the boundary route agrees (it maps B's knots).
    const q = boundaryContinuity(
      { surface: flat, edge: 'v0', sameSense: true },
      { surface: B, edge: 'v0', sameSense: true },
    );
    expect(Math.abs(q.max.gap - p.max.gap)).toBeLessThan(1e-9 * zmax);
  });

  it('the default rule follows the composed degree: RMS gap √(1/7) exactly for gap = u(t)³', () => {
    // B: z = u³ (a cubic Bézier in u, linear x, y); A: z = 0. The edge is A's pcurve image
    // with u(t) = 0.4t + 0.6t² (quadratic, increasing): gap = u³, speed = u′ (v is constant),
    // so RMS² = ∫u⁶u′dt / ∫u′dt = 1/7. The integrand has degree 13: the default
    // D + 1 = (3 + 3)·2 + 1 = 13 points are exact; the old max-degree rule (4 points) is not.
    const B = makeSurface({
      u: clampedBasis(3, [0, 0, 0, 0, 1, 1, 1, 1]),
      v: clampedBasis(3, [0, 0, 0, 0, 1, 1, 1, 1]),
      points: Array.from({ length: 16 }, (_, k) => {
        const [i, j] = [Math.floor(k / 4), k % 4];
        return [i / 3, j / 3, i === 3 ? 1 : 0];
      }).flat(),
    });
    const pc = makeCurve({
      dim: 2,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: [0, 0.5, 0.2, 0.5, 1, 0.5],
    });
    const edge = makeCurve({
      dim: 3,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: [0, 0.5, 0, 0.2, 0.5, 0, 1, 0.5, 0],
    });
    const A = { surface: flat, pcurve: pc, sameSense: true };
    const Bs = { surface: B, pcurve: pc, sameSense: true };
    const exact = Math.sqrt(1 / 7);
    // Tolerance 1e-13 relative: 13-point rule, sums of ≤ 13 terms.
    expect(Math.abs(edgeContinuity(edge, A, Bs).rms.gap - exact)).toBeLessThan(1e-13 * exact);
    // 4 points: error of ~1e-2 relative (the test could fail).
    const coarse = edgeContinuity(edge, A, Bs, { samplesPerSpan: 4 }).rms.gap;
    expect(Math.abs(coarse - exact)).toBeGreaterThan(1e-6 * exact);
  });

  it('a collapsed edge has gap RMS = the measured gap (weighted by parameter), not 0', () => {
    const pt = { x: 0.5, y: 0.5, z: 0 };
    const hi = planeSurface({ x: 0, y: 0, z: 0.1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const pc = line2({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 });
    const p = edgeContinuity(
      line(pt, pt),
      { surface: flat, pcurve: pc, sameSense: true },
      { surface: hi, pcurve: pc, sameSense: true },
    );
    expect(p.degenerate).toBe(p.t.length);
    expect(Math.abs(p.max.gap - 0.1)).toBeLessThan(64 * EPS);
    expect(Math.abs(p.rms.gap - 0.1)).toBeLessThan(64 * EPS);
    expect(p.rms.normalAngle).toBe(0);
  });
});

describe('review of B3: boundaries of unequal extent', () => {
  it('max gap is symmetric: an overhanging B does not read G0 in one order', () => {
    const along = (len: number): NurbsSurface =>
      planeSurface({ x: 0, y: 0, z: 0 }, { x: 0, y: len, z: 0 }, { x: 1, y: 0, z: 0 });
    const short = { surface: along(1), edge: 'v0', sameSense: true } as const;
    const long = { surface: along(2), edge: 'v0', sameSense: true } as const;
    // Edge v0 of each is the y axis, over [0, 1] and [0, 2]: B's far half is 1 away from A's end.
    const ab = boundaryContinuity(short, long);
    const ba = boundaryContinuity(long, short);
    expect(Math.abs(ab.max.gap - 1)).toBeLessThan(64 * EPS);
    expect(Math.abs(ba.max.gap - 1)).toBeLessThan(64 * EPS);
    // The reverse distance is reached at the far end of the long boundary: A's parameter 1 (its end).
    expect(Math.abs(ab.argmax.gap - 1)).toBeLessThan(1e-9);
    // Per-sample gaps stay measured from A: zero for the short A, the overhang for the long A.
    expect(maxOf(ab.gap)).toBeLessThan(64 * EPS);
    expect(maxOf(ba.gap)).toBeGreaterThan(0.4);
    // Equal boundaries are still exactly G0.
    expect(boundaryContinuity(short, short).max.gap).toBeLessThan(64 * EPS);
  });
});

describe('review of B3: G1 is not stricter than C1 far from the origin', () => {
  it('a periodic circle centred at 1e7 is G2 at its seam when C1 holds within rounding', () => {
    const c = periodicCircle({ x: 1e7, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1);
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const k = knotContinuity(c, t * c.basis.domain[1]);
      if (k.parametric >= 1) expect(k.geometric).toBeGreaterThanOrEqual(1);
    }
    const k0 = knotContinuity(c, 0);
    expect(k0.parametric).toBeGreaterThanOrEqual(1);
    expect(k0.geometric).toBe(2);
    // A real corner far from the origin is still a corner.
    const corner = polyline([1e7, 0, 1e7 + 1, 0, 1e7 + 1, 1], 2);
    expect(knotContinuity(corner, 0.5).geometric).toBe(0);
  });
});

describe('review of B3 (second round): rounding floor of rational derivatives of order > degree', () => {
  /** Inserts `x` once (P&T A5.1) into the rational Bézier curve of degree `p`: a removable knot. */
  const withRemovableKnot = (p: number, pts: number[], w: number[], x: number): NurbsCurve<2> => {
    const bz = bezierCurve(2, pts, w);
    const ins = curveKnotIns(p, p, bz.basis.knots, bz.cw, 3, x, p, 0, 1);
    const n = p + 2;
    return makeCurve({
      dim: 2,
      basis: clampedBasis(p, ins.UQ),
      points: Array.from({ length: n }, (_, i) =>
        [0, 1].map((k) => ins.Qw[3 * i + k]! / ins.Qw[3 * i + 2]!),
      ).flat(),
      weights: Array.from({ length: n }, (_, i) => ins.Qw[3 * i + 2]!),
    });
  };

  it('a rational quadratic arc with a removable knot reads C3 (N‴ ≡ 0 for p = 2, the rational C‴ is not)', () => {
    const arc = [1, 0, 1, Math.tan(0.3), Math.cos(0.6), Math.sin(0.6)];
    const wts = [1, Math.cos(0.3), 1];
    // Several parameters: the one-sided C‴ differ by ~1e-14 of rounding at each (measured 1e-15 … 4e-14),
    // far below the floor degenerateRel · scale = 1e-12, and the exact value is 0.
    for (const x of [0.4, 0.123, 0.5, 0.77]) {
      const k = knotContinuity(withRemovableKnot(2, arc, wts, x), x);
      expect([k.parametric, k.geometric], `x = ${x}`).toEqual([3, 2]);
      expect(k.jumps.d3).toBeLessThan(1e-12);
    }
  });

  it('a rational linear segment with a removable knot reads C3 (N″ ≡ 0 for p = 1)', () => {
    const k = knotContinuity(withRemovableKnot(1, [0, 0, 2, 1], [1, 3], 0.37), 0.37);
    expect([k.parametric, k.geometric]).toEqual([3, 2]);
  });

  it('a real jump in a rational quadratic is still seen: a weight change at the knot is not C3', () => {
    // Different weights on the two sides of a simple knot of a quadratic: C¹ but not C².
    const c = makeCurve({
      dim: 2,
      basis: clampedBasis(2, [0, 0, 0, 0.4, 1, 1, 1]),
      points: [0, 0, 1, 2, 2, 1, 3, 0],
      weights: [1, 1, 3, 1],
    });
    const k = knotContinuity(c, 0.4);
    expect(k.parametric).toBe(1);
    expect(k.jumps.d2).toBeGreaterThan(0.1);
  });

  it('the roof (degree 1, C⁰ knot at 0.3 crossed by the pcurve) has arc-length RMS gap exact at every density', () => {
    // Review case: the pcurve crosses a surface knot line the edge and pcurves lack.
    // z(x) is 0 → 0.3 on [0, 0.3] and 0.3 → 0 on [0.3, 1]; ∫z² = 0.3²·(0.3 + 0.7)/3.
    const xs = [0, 0.3, 1];
    const zs = [0, 0.3, 0];
    const pts: number[] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) pts.push(xs[i]!, j, zs[i]!);
    const roof = makeSurface({
      u: clampedBasis(1, [0, 0, 0.3, 1, 1]),
      v: clampedBasis(1, [0, 0, 1, 1]),
      points: pts,
    });
    const flat = planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const pc = line2({ x: 0, y: 0 }, { x: 1, y: 0 });
    const exact = Math.sqrt(0.09 / 3);
    for (const n of [2, 4, 8, undefined]) {
      const p = edgeContinuity(
        line({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
        { surface: flat, pcurve: pc, sameSense: true },
        { surface: roof, pcurve: pc, sameSense: true },
        n === undefined ? {} : { samplesPerSpan: n },
      );
      // Tolerance 1e-14 relative: with the break at 0.3 each piece is a quadratic, integrated exactly by n ≥ 2.
      expect(Math.abs(p.rms.gap - exact), `n = ${String(n)}`).toBeLessThan(1e-14 * exact);
    }
  });
});
