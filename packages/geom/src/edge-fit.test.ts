// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Edge fitting (design §6.15, integration milestone; oracle row
 * `curve-on-surface` of §16): `projectCurveToSurface` and `curveOnSurfaceTo3d`.
 *
 * Oracles, none of them the code under test:
 *
 * - **A single cubic span on a plane is reproduced exactly.** The surface is
 *   affine, so the 3D curve is the affine image of a known pcurve; one Bézier
 *   span lies in the fit's starting space (4 control points), so the least
 *   squares solution is that pcurve up to rounding.
 * - **A circle on a cylinder has a closed-form pcurve.** `circle(...)` at
 *   height `z0` is the iso-line `v = z0/h` of `cylinder(...)`, with
 *   `u(t) = atan2(y(t), x(t)) / 2π` (unwrapped) from the exact rational
 *   circle: `u` is not polynomial in `t`, so the fit is a real approximation
 *   with a known target. The cylinder's metric is `2πr` in u and `h` in v.
 * - **Honesty.** The reported deviation is measured on the returned curve at
 *   `verifyFactor ×` denser samples; an independent measurement at other
 *   parameters (a seeded random set, none of them a fit or verification
 *   sample) must agree: never above the reported value by more than a stated
 *   margin, and never above `fit` when `withinTolerance`.
 * - **Convergence.** Tightening `fit` by 10² lowers the measured deviation
 *   and raises the control-point count; every run meets its own `fit`.
 *
 * Tolerances:
 *
 * - exact single-span reproduction `1e-9 · scale`: the normal equations are
 *   centred and scaled, condition ≲ 10³, so ~10⁶ ε loses at most 7 digits of 16;
 * - plane, closed-form circle pcurve: the 3D error is `|U Δu + V Δv|` or
 *   `2πr |Δu|`, bounded by the reported deviation, which is `≤ fit`;
 * - independent honesty margin 1.05 × the reported value: between verification
 *   samples (4 per fit sample, 32 per span) the error of a cubic fit varies on
 *   the scale of the span; the worst ratio of 20,000 random parameters to the
 *   reported value measured 1.0018 over fits from 1e-2 to 1e-5 on the sheared
 *   circle below, so 5% leaves margin without hiding a real gap;
 * - boundary containment `1e-12` of the domain (`paramRel`): control points
 *   are clamped to it exactly, so only rounding in the evaluation is left.
 */
import { describe, expect, it } from 'vitest';
import {
  bezierCurve,
  reparameterize,
  circle,
  clampedBasis,
  clampedUniformKnots,
  curveDomain,
  curveEvalInto,
  curveOnSurface,
  curveOnSurfaceEvalInto,
  curveOnSurfaceTo3d,
  curveOnSurfacePoint,
  curvePoint,
  cylinder,
  DEFAULT_EDGE_FIT,
  bezierSurface,
  createScratch,
  isGeomError,
  isoCurve,
  line,
  line2,
  makeCurve,
  makeSurface,
  periodicCircle,
  planeSurface,
  projectCurveToSurface,
  surfaceDomain,
  surfacePoint,
  transformCurve,
  vec,
} from './index';
import type { ClampedCurve, GeomErrorCode, NurbsCurve, NurbsSurface, Point3 } from './index';
import { checksum, mulberry32 } from './testing';

const EPS = Number.EPSILON;

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

/** `|C(t) − S(P(t))|` at `n` seeded random parameters (independent of every sample the fit used). */
function independentDeviation(
  c: NurbsCurve<3>,
  s: NurbsSurface,
  pc: NurbsCurve<2>,
  seed: number,
  n = 997,
): number {
  const rng = mulberry32(seed);
  const [a, b] = curveDomain(c);
  const sc = createScratch({ maxDegree: 5, maxDerivs: 2 });
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const t = a + rng() * (b - a);
    curveEvalInto(c, t, 0, p, 0, sc);
    curveOnSurfaceEvalInto({ surface: s, pcurve: pc }, t, 0, q, 0, sc);
    worst = Math.max(worst, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!));
  }
  return worst;
}

describe('projectCurveToSurface: exact cases', () => {
  // A non-orthogonal plane: S(u, v) = O + u·U + v·V on [−1, 3] × [−2, 2].
  const O = { x: 0.5, y: -1, z: 2 };
  const U = { x: 1, y: 0.2, z: 0 };
  const V = { x: 0.1, y: 1, z: 0.3 };
  const plane = planeSurface(O, U, V, { u: [-1, 3], v: [-2, 2] });
  const image = (x: number, y: number): Point3 => ({
    x: O.x + x * U.x + y * V.x,
    y: O.y + x * U.y + y * V.y,
    z: O.z + x * U.z + y * V.z,
  });
  // One cubic Bézier span on [2, 5]: in the fit's starting space.
  const uv = [0, -1, 1, 1.5, 2, -1.5, 3, 1];
  const pcurve = reparameterize(bezierCurve(2, uv), [2, 5]);
  const c3 = reparameterize(
    bezierCurve(
      3,
      Array.from({ length: 4 }, (_, i) => {
        const p = image(uv[2 * i]!, uv[2 * i + 1]!);
        return [p.x, p.y, p.z];
      }).flat(),
    ),
    [2, 5],
  );

  it('reproduces a single cubic span on an affine plane up to rounding', () => {
    const r = projectCurveToSurface(c3, plane);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { pcurve: fit, maxDeviation, withinTolerance } = r.value;
    expect(withinTolerance).toBe(true);
    expect(fit.basis.count).toBe(4);
    // Same parameter: the domain is the curve's, bitwise.
    expect(fit.basis.domain).toEqual([2, 5]);
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const t = 2 + (3 * i) / 200;
      const a = curvePoint(fit, t);
      const b = curvePoint(pcurve, t);
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    expect(worst).toBeLessThanOrEqual(1e-9 * 3);
    expect(maxDeviation).toBeLessThanOrEqual(1e-9 * 3);
  });

  it('ends exactly where the curve ends, so a closed curve gives a closed pcurve', () => {
    // A rational circle in the plane: closed, its pcurve not a polynomial (the ends must still meet).
    const ring = circle(O, U, V, 1);
    const r = projectCurveToSurface(ring, plane);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p0 = curvePoint(r.value.pcurve, 0);
    const p1 = curvePoint(r.value.pcurve, 1);
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeLessThanOrEqual(1e-13);
    // And the ends are the curve's ends, mapped into (u, v): O is the origin of (u, v) = (0, 0).
    const start = curvePoint(ring, 0);
    const q = vec.sub(start, O);
    // Solve q = u·U + v·V (the plane's affine frame) for the expected uv of the start.
    const det = U.x * V.y - U.y * V.x;
    const eu = (q.x * V.y - q.y * V.x) / det;
    const ev = (U.x * q.y - U.y * q.x) / det;
    expect(Math.hypot(p0.x - eu, p0.y - ev)).toBeLessThanOrEqual(1e-13);
  });

  it('reports a curve off the surface honestly: the offset, as a warning', () => {
    // The same curve lifted along the plane's normal by 0.01: unreachable by any pcurve.
    const n = vec.normalize(vec.cross(U, V));
    if (n === null) throw new Error('unreachable');
    const lifted = reparameterize(
      bezierCurve(
        3,
        Array.from({ length: 4 }, (_, i) => {
          const p = image(uv[2 * i]!, uv[2 * i + 1]!);
          return [p.x + 0.01 * n.x, p.y + 0.01 * n.y, p.z + 0.01 * n.z];
        }).flat(),
      ),
      [2, 5],
    );
    const r = projectCurveToSurface(lifted, plane);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.withinTolerance).toBe(false);
    // The best pcurve is the orthogonal projection: the deviation is the offset.
    expect(Math.abs(r.value.maxDeviation - 0.01)).toBeLessThanOrEqual(1e-9);
    const warning = r.issues.find((i) => i.severity === 'warning');
    expect(warning?.code).toBe('not-converged');
    expect(Math.abs((warning?.value ?? 0) - 0.01)).toBeLessThanOrEqual(1e-9);
  });

  it('puts the control points of a curve running along the boundary inside the domain', () => {
    // The v = −2 edge of the plane: a line along u at the domain's boundary.
    const e = line(image(-1, -2), image(3, -2));
    const r = projectCurveToSurface(e, plane);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i <= 50; i++) {
      const p = curvePoint(r.value.pcurve, r.value.pcurve.basis.domain[0] + i / 50);
      expect(Math.abs(p.y + 2)).toBeLessThanOrEqual(1e-12);
    }
    // Containment is what `curveOnSurface` checks (it throws otherwise).
    expect(() => curveOnSurface(plane, r.value.pcurve)).not.toThrow();
  });
});

describe('projectCurveToSurface: circles on a cylinder', () => {
  const r0 = 3;
  const h = 5;
  const z0 = 2;
  const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, r0, h);
  const ring = circle({ x: 0, y: 0, z: z0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, r0);
  // The ring sheared in z by 0.4·x: an ellipse on the same cylinder (x, y unchanged). The
  // surface's u is the rational circle's own parameter, so the exact pcurve is u(t) = t and
  // v(t) = z(t)/h with z(t) rational in t: not a polynomial, a genuine approximation.
  const slant = transformCurve(ring, [1, 0, 0, 0, 0, 1, 0, 0, 0.4, 0, 1, 0]);

  it('recovers u = t and the constant v of a circle exactly, one full period unwrapped', () => {
    const r = projectCurveToSurface(ring, side);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { pcurve, maxDeviation, withinTolerance } = r.value;
    expect(withinTolerance).toBe(true);
    expect(maxDeviation).toBeLessThanOrEqual(1e-9);
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const p = curvePoint(pcurve, t);
      expect(Math.abs(p.x - t)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(p.y - z0 / h)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('matches the closed-form pcurve of an ellipse on the cylinder', () => {
    const r = projectCurveToSurface(slant, side);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { pcurve, maxDeviation, withinTolerance } = r.value;
    expect(withinTolerance).toBe(true);
    expect(maxDeviation).toBeLessThanOrEqual(1e-4);
    let worst = 0;
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const p = curvePoint(pcurve, t);
      // 3D metric of the cylinder: 2πr in u, 1 in v (the height is the v extent h).
      const du = (p.x - t) * 2 * Math.PI * r0;
      const dv = (p.y - curvePoint(slant, t).z / h) * h;
      worst = Math.max(worst, Math.hypot(du, dv));
    }
    // The oracle sees what the fit measured (module comment: 1.05 ×).
    expect(worst).toBeLessThanOrEqual(1.05 * maxDeviation + 64 * EPS * r0);
  });

  it('measures the deviation honestly: independent samples agree with the report', () => {
    for (const seed of [1, 2, 3]) {
      const r = projectCurveToSurface(slant, side);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const indep = independentDeviation(slant, side, r.value.pcurve, seed);
      expect(indep).toBeLessThanOrEqual(1.05 * r.value.maxDeviation + 64 * EPS * r0);
      if (r.value.withinTolerance) expect(indep).toBeLessThanOrEqual(1.05e-4);
    }
  });

  it('converges: a tighter fit lowers the deviation and raises the control-point count', () => {
    const runs = [1e-2, 1e-4, 1e-6].map((fit) => {
      const r = projectCurveToSurface(slant, side, { fit });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.value.maxDeviation).toBeLessThanOrEqual(fit);
      expect(r.value.withinTolerance).toBe(true);
      return { dev: r.value.maxDeviation, n: r.value.pcurve.basis.count };
    });
    expect(runs[1]!.dev).toBeLessThan(runs[0]!.dev);
    expect(runs[2]!.dev).toBeLessThan(runs[1]!.dev);
    expect(runs[1]!.n).toBeGreaterThan(runs[0]!.n);
    expect(runs[2]!.n).toBeGreaterThan(runs[1]!.n);
  });

  it('fits a periodic curve over its closed period', () => {
    const per = periodicCircle(
      { x: 0, y: 0, z: z0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      r0,
    );
    const r = projectCurveToSurface(per, side);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.withinTolerance).toBe(true);
    // The domain is [t0, t0 + T]: the closed period.
    expect(r.value.pcurve.basis.domain).toEqual([per.basis.domain[0], per.basis.domain[1]]);
    const [t0, t1] = r.value.pcurve.basis.domain;
    expect(
      Math.abs(curvePoint(r.value.pcurve, t1).x - curvePoint(r.value.pcurve, t0).x - 1),
    ).toBeLessThanOrEqual(1e-6);
  });

  it('is deterministic and leaves its inputs alone', () => {
    const before = checksum([ring, side]);
    const a = projectCurveToSurface(ring, side);
    const b = projectCurveToSurface(ring, side);
    expect(checksum([ring, side])).toBe(before);
    expect(checksum(a)).toBe(checksum(b));
  });
});

describe('projectCurveToSurface: kinks from the surface parameterisation', () => {
  // A flat strip whose u parameterisation changes speed at the knot u = 0.5 (x = 1.6u, then
  // 0.8 + 0.4(u − 0.5)): geometrically a plane, parametrically C⁰ across that knot line. A
  // straight line across it is smooth in space and kinked in (u, v).
  const strip = makeSurface({
    u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
    v: clampedBasis(1, [0, 0, 1, 1]),
    points: [0, 0, 0, 0, 1, 0, 0.8, 0, 0, 0.8, 1, 0, 1, 0, 0, 1, 1, 0],
  });
  const across = line({ x: 0.05, y: 0.3, z: 0 }, { x: 0.95, y: 0.3, z: 0 });
  const uOf = (x: number): number => (x <= 0.8 ? x / 1.6 : 0.5 + (x - 0.8) / 0.4);

  it('puts a knot where the pcurve crosses the surface knot line, and reproduces it', () => {
    const r = projectCurveToSurface(across, strip);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.withinTolerance).toBe(true);
    // The exact pcurve is piecewise linear with one kink: a few spans, not a brute-force refinement.
    expect(r.value.pcurve.basis.count).toBeLessThanOrEqual(12);
    // The kink is where the line meets u = 0.5 (x = 0.8, t = 0.75 / 0.9), located on the exact
    // projections to bisection resolution, not on an earlier fit: a triple knot (C⁰) there.
    const kink = 0.75 / 0.9;
    // The crossing is located to kinkFraction · fit / speed (speed = |ΔC|/Δt = 0.9 here).
    const width = (DEFAULT_EDGE_FIT.kinkFraction * 1e-4) / 0.9;
    const at = Array.from(r.value.pcurve.basis.knots).filter((k) => Math.abs(k - kink) <= width);
    expect(at.length).toBe(3);
    const [t0, t1] = r.value.pcurve.basis.domain;
    for (let i = 0; i <= 200; i++) {
      const t = t0 + ((t1 - t0) * i) / 200;
      const x = 0.05 + 0.9 * t;
      const p = curvePoint(r.value.pcurve, t);
      // 3D metric: du scales by the local speed (1.6 or 0.4) in x.
      const dx = Math.abs(p.x - uOf(x)) * (x <= 0.8 ? 1.6 : 0.4);
      expect(dx).toBeLessThanOrEqual(1e-4);
    }
  });
});

describe('projectCurveToSurface: the kink is located as precisely as the target needs', () => {
  const strip = makeSurface({
    u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
    v: clampedBasis(1, [0, 0, 1, 1]),
    points: [0, 0, 0, 0, 1, 0, 0.8, 0, 0, 0.8, 1, 0, 1, 0, 0, 1, 1, 0],
  });
  const across = line({ x: 0.05, y: 0.3, z: 0 }, { x: 0.95, y: 0.3, z: 0 });

  it('a tighter fit locates the C⁰ kink tighter (width = kinkFraction · fit / speed)', () => {
    for (const fit of [1e-4, 1e-6, 1e-9]) {
      const r = projectCurveToSurface(across, strip, { fit });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.withinTolerance, `fit ${fit}`).toBe(true);
      const width = (DEFAULT_EDGE_FIT.kinkFraction * fit) / 0.9;
      const at = Array.from(r.value.pcurve.basis.knots).filter(
        (k) => Math.abs(k - 0.75 / 0.9) <= width + 4 * EPS,
      );
      expect(at.length, `fit ${fit}`).toBe(3);
    }
  });

  it('rejects a kinkFraction outside (0, 1]', () => {
    expectCode(
      () => projectCurveToSurface(across, strip, undefined, { kinkFraction: 0 }),
      'unsupported',
    );
    expectCode(
      () => projectCurveToSurface(across, strip, undefined, { kinkFraction: 2 }),
      'unsupported',
    );
  });
});

describe('projectCurveToSurface: options and failures', () => {
  const plane = planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const c = line({ x: 0.1, y: 0.2, z: 0 }, { x: 0.8, y: 0.6, z: 0 });

  it('rejects sampling parameters that are not whole counts', () => {
    expectCode(
      () => projectCurveToSurface(c, plane, undefined, { samplesPerSpan: 1 }),
      'unsupported',
    );
    expectCode(
      () => projectCurveToSurface(c, plane, undefined, { verifyFactor: 0 }),
      'unsupported',
    );
    expectCode(() => projectCurveToSurface(c, plane, undefined, { degree: 0.5 }), 'unsupported');
    expectCode(() => projectCurveToSurface(c, plane, undefined, { maxPasses: -1 }), 'unsupported');
    expectCode(() => projectCurveToSurface(c, plane, undefined, { safety: 0 }), 'unsupported');
  });

  it('uses the stated defaults', () => {
    expect(DEFAULT_EDGE_FIT).toEqual({
      degree: 3,
      samplesPerSpan: 8,
      verifyFactor: 4,
      maxPasses: 8,
      safety: 0.5,
      kinkFraction: 0.1,
    });
    expect(Object.isFrozen(DEFAULT_EDGE_FIT)).toBe(true);
  });

  it('fits a straight line exactly with a degree-1 pcurve', () => {
    const r = projectCurveToSurface(c, plane, undefined, { degree: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.withinTolerance).toBe(true);
    expect(r.value.pcurve.basis.degree).toBe(1);
  });

  it('rejects a 2D curve', () => {
    expectCode(
      () => projectCurveToSurface(line2({ x: 0, y: 0 }, { x: 1, y: 1 }) as never, plane),
      'dimension-mismatch',
    );
  });
});

describe('projectCurveToSurface: a curved, rational surface', () => {
  // A mildly curved rational bicubic patch (control net within ±0.15 of a plane).
  const rng = mulberry32(11);
  const pts: number[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) pts.push(i / 3, j / 3, 0.15 * (2 * rng() - 1));
  }
  const patch = bezierSurface(
    pts,
    4,
    4,
    Array.from({ length: 16 }, () => 0.8 + 0.4 * rng()),
  );
  const pcTrue = makeCurve({
    dim: 2,
    basis: clampedBasis(3, clampedUniformKnots(3, 6)),
    points: [0.1, 0.2, 0.3, 0.8, 0.5, 0.1, 0.6, 0.7, 0.8, 0.3, 0.9, 0.9],
  });

  it('recovers a pcurve through the 3D curve it defines (round trip, both directions)', () => {
    const edge = curveOnSurfaceTo3d(curveOnSurface(patch, pcTrue), { fit: 1e-6 });
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;
    expect(edge.value.withinTolerance).toBe(true);
    const back = projectCurveToSurface(edge.value.curve, patch, { fit: 1e-5 });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.withinTolerance).toBe(true);
    // The recovered pcurve defines the original 3D curve within both fits.
    let worst = 0;
    const [a, b] = curveDomain(pcTrue);
    const sc = createScratch({ maxDegree: 5, maxDerivs: 2 });
    const p = new Float64Array(3);
    const q = new Float64Array(3);
    for (let i = 0; i <= 300; i++) {
      const t = a + ((b - a) * i) / 300;
      curveOnSurfaceEvalInto({ surface: patch, pcurve: pcTrue }, t, 0, p, 0, sc);
      curveOnSurfaceEvalInto({ surface: patch, pcurve: back.value.pcurve }, t, 0, q, 0, sc);
      worst = Math.max(worst, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!));
    }
    expect(worst).toBeLessThanOrEqual(1e-6 + 1e-5 + 1e-9);
  });

  it('puts a boundary iso-curve exactly on the boundary', () => {
    const iso = isoCurve(patch, 'v', surfaceDomain(patch).v[0]);
    const r = projectCurveToSurface(iso, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i <= 40; i++) {
      const t = r.value.pcurve.basis.domain[0] + i / 40;
      expect(Math.abs(curvePoint(r.value.pcurve, t).y)).toBeLessThanOrEqual(1e-12);
    }
    expect(r.value.maxDeviation).toBeLessThanOrEqual(1e-9);
  });
});

describe('edges across the simple knot lines of a smooth spline surface', () => {
  // A cubic spline surface with interior knots (C² across them): S(P(t)) is C² at each crossing,
  // as smooth as the cubic fit's own simple knot, so no knot is needed at the crossings and none
  // is searched for (the cost of the search is what the benchmark P18 measures).
  const rng = mulberry32(31);
  const nu = 9;
  const nv = 7;
  const pts: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++)
      pts.push(i, j, 0.3 * Math.sin(i * 0.9) * Math.cos(j * 0.7) + 0.05 * rng());
  }
  const surf = makeSurface({
    u: clampedBasis(3, clampedUniformKnots(3, nu)),
    v: clampedBasis(3, clampedUniformKnots(3, nv)),
    points: pts,
  });
  const sine = makeCurve({
    dim: 2,
    basis: clampedBasis(3, clampedUniformKnots(3, 20)),
    points: Array.from({ length: 20 }, (_, i) => [
      0.12 + (0.76 * i) / 19,
      0.5 + 0.3 * Math.sin((2 * Math.PI * i) / 19),
    ]).flat(),
  });

  it('round-trips a pcurve through its 3D image within the fit, honestly measured', () => {
    for (const fit of [1e-3, 1e-5]) {
      const edge = curveOnSurfaceTo3d(curveOnSurface(surf, sine), { fit });
      expect(edge.ok).toBe(true);
      if (!edge.ok) return;
      expect(edge.value.withinTolerance).toBe(true);
      expect(edge.value.maxError).toBeLessThanOrEqual(fit);
      const back = projectCurveToSurface(edge.value.curve, surf, { fit });
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.value.withinTolerance).toBe(true);
      const indep = independentDeviation(edge.value.curve, surf, back.value.pcurve, 7);
      expect(indep).toBeLessThanOrEqual(1.05 * back.value.maxDeviation + 64 * EPS * 10);
      expect(back.value.maxDeviation).toBeLessThanOrEqual(fit);
    }
  });
});

describe('curveOnSurfaceTo3d', () => {
  const O = { x: 0.5, y: -1, z: 2 };
  const U = { x: 1, y: 0.2, z: 0 };
  const V = { x: 0.1, y: 1, z: 0.3 };
  const plane = planeSurface(O, U, V, { u: [-1, 3], v: [-2, 2] });

  it('reproduces a single cubic span on a plane up to rounding, with the pcurve parameter', () => {
    const pc = reparameterize(bezierCurve(2, [0, -1, 1, 1.5, 2, -1.5, 3, 1]), [2, 5]);
    const r = curveOnSurfaceTo3d(curveOnSurface(plane, pc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.curve.basis.domain).toEqual([2, 5]);
    expect(r.value.withinTolerance).toBe(true);
    expect(r.value.maxError).toBeLessThanOrEqual(1e-9 * 4);
    for (let i = 0; i <= 100; i++) {
      const t = 2 + (3 * i) / 100;
      const x = curvePoint(pc, t);
      const want = {
        x: O.x + x.x * U.x + x.y * V.x,
        y: O.y + x.x * U.y + x.y * V.y,
        z: O.z + x.x * U.z + x.y * V.z,
      };
      const got = curvePoint(r.value.curve, t);
      expect(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z)).toBeLessThanOrEqual(
        1e-9 * 4,
      );
    }
  });

  it('approximates an exact circle on a cylinder, converging as the fit tightens', () => {
    const rad = 3;
    const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, rad, 5);
    const ring = curveOnSurface(side, line2({ x: 0, y: 0.4 }, { x: 1, y: 0.4 }));
    const exactRing = circle({ x: 0, y: 0, z: 2 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, rad);
    const errs = [1e-2, 1e-4, 1e-6].map((fit) => {
      const r = curveOnSurfaceTo3d(ring, { fit });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.value.withinTolerance).toBe(true);
      expect(r.value.maxError).toBeLessThanOrEqual(fit);
      // The closed-form edge: the exact rational circle at z = 2, same parameter (u = t).
      let worst = 0;
      const rng = mulberry32(5);
      for (let i = 0; i < 997; i++) {
        const t = rng();
        const got = curvePoint(r.value.curve, t);
        const want = curvePoint(exactRing, t);
        worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z));
      }
      // Honest: independent samples are within 1.05 × the reported maximum.
      expect(worst).toBeLessThanOrEqual(1.05 * r.value.maxError + 64 * EPS * rad);
      return r.value.maxError;
    });
    expect(errs[1]!).toBeLessThan(errs[0]!);
    expect(errs[2]!).toBeLessThan(errs[1]!);
  });

  it('starts and ends exactly on the composition at the pcurve ends', () => {
    const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2, 1);
    const cs = curveOnSurface(side, line2({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.9 }));
    const r = curveOnSurfaceTo3d(cs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = cs.pcurve.basis.domain;
    for (const t of [a, b]) {
      const want = curveOnSurfacePoint(cs, t);
      const got = curvePoint(r.value.curve, t);
      expect(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z)).toBeLessThanOrEqual(
        64 * EPS * 2,
      );
    }
  });

  it('is a polynomial curve over the pcurve domain and keeps inputs intact', () => {
    const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2, 1);
    const cs = curveOnSurface(side, line2({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.9 }));
    const before = checksum(cs);
    const r = curveOnSurfaceTo3d(cs);
    expect(checksum(cs)).toBe(before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c: ClampedCurve<3> = r.value.curve;
    expect(c.dim).toBe(3);
    expect(c.rational).toBe(false);
    expect(c.basis.domain).toEqual(cs.pcurve.basis.domain);
    const p0 = surfacePoint(side, 0.1, 0.1);
    const g0 = curvePoint(c, c.basis.domain[0]);
    expect(Math.hypot(g0.x - p0.x, g0.y - p0.y, g0.z - p0.z)).toBeLessThanOrEqual(1e-4);
  });
});
