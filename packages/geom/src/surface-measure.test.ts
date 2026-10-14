// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Surface-measure oracles (design §16, `surface-measure` row):
 *
 * - exact rational sphere: `k₁ = k₂ = −1/r`, `K = 1/r²`, outward normal
 *   `(S − c)/r`, umbilic everywhere (no principal directions); degenerate
 *   normal at the collapsed poles, where `limitNormal` gives `∓z`;
 * - exact torus: `k = −1/r` round the tube and `−cos φ/(R + r cos φ)` along the
 *   parallels, `K = cos φ/(r(R + r cos φ))`, the directions along the meridian
 *   and the parallel;
 * - cylinder `(0, −1/r)` with the zero direction along the axis; plane 0;
 * - polynomial nets with closed forms: `z = xy` (every form coefficient),
 *   the paraboloid `z = x² + y²` (umbilic apex), the saddle `z = x² − y²` and
 *   the elliptic paraboloid `z = x² + 3y²` (graph formulas for K and H);
 * - identities on random NURBS: Weingarten (`L = −Su·n_u`, `M = −Su·n_v =
 *   −Sv·n_u`, `N = −Sv·n_v`) against finite differences of the normal; Euler's
 *   theorem `κ(cos θ d₁ + sin θ d₂) = k₁ cos²θ + k₂ sin²θ`; `d₁ ⊥ d₂ ⊥ n`;
 * - kernels equal their wrappers bit for bit.
 *
 * Tolerances: curvatures `1e-12` relative to the largest |k| (design: second
 * derivatives of rational patches lose ~3 digits to the quotient rule, and one
 * more division forms K and H); normals `1e-13` (one cross product and a
 * normalisation of first derivatives); principal directions `1e-10` (an
 * eigenvector errs by rounding/gap, gap ≥ 0.5/r here); finite differences
 * `1e-8` of the local scale (as the surface derivative test).
 */
import { describe, expect, it } from 'vitest';
import {
  bezierSurface,
  bilinearPatch,
  createScratch,
  cylinder,
  fundamentalForms,
  fundamentalFormsInto,
  isGeomError,
  limitNormal,
  normalCurvature,
  planeSurface,
  principalCurvatures,
  SAMPLE_DEGENERATE,
  SAMPLE_UMBILIC,
  sphere,
  surfaceDerivatives,
  surfaceNormal,
  surfacePoint,
  torus,
  vec,
} from './index';
import type { Curvatures, GeomErrorCode, NurbsSurface, Point3 } from './index';
import { mulberry32, randomSurface } from './testing';

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

const dist = (a: Point3, b: Point3): number => vec.distance(a, b);
const unit = (a: Point3): Point3 => vec.normalize(a)!;

function curv(s: NurbsSurface, u: number, v: number): Curvatures {
  const c = principalCurvatures(s, u, v);
  expect(c, `curvatures at (${u}, ${v})`).not.toBeNull();
  return c!;
}

/** `|a − b| ≤ rel · scale`. */
function near(a: number, b: number, rel: number, scale: number, what = ''): void {
  expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(rel * scale);
}

/** Principal directions are unit, tangent, orthogonal and right-handed with n. */
function checkFrame(c: Curvatures): void {
  const { d1, d2, n } = c;
  expect(d1).not.toBeNull();
  expect(d2).not.toBeNull();
  near(vec.norm(d1!), 1, 1e-13, 1);
  near(vec.norm(d2!), 1, 1e-13, 1);
  near(vec.dot(d1!, n), 0, 1e-13, 1);
  near(vec.dot(d1!, d2!), 0, 1e-13, 1);
  expect(dist(vec.cross(d1!, d2!), n)).toBeLessThanOrEqual(1e-13);
}

describe('sphere', () => {
  for (const [r, c] of [
    [1, { x: 0, y: 0, z: 0 }],
    [2.5, { x: 1, y: -2, z: 3 }],
    [37, { x: -100, y: 40, z: 7 }],
  ] as const) {
    it(`k₁ = k₂ = −1/r, K = 1/r², outward normal, umbilic everywhere (r = ${r})`, () => {
      const s = sphere(c, r);
      for (let i = 0; i <= 16; i++) {
        for (let j = 1; j < 16; j++) {
          const u = i / 16;
          const v = j / 16;
          const k = curv(s, u, v);
          near(k.k1, -1 / r, 1e-12, 1 / r, 'k1');
          near(k.k2, -1 / r, 1e-12, 1 / r, 'k2');
          near(k.K, 1 / (r * r), 1e-12, 1 / (r * r), 'K');
          near(k.H, -1 / r, 1e-12, 1 / r, 'H');
          expect(k.d1).toBeNull();
          expect(k.d2).toBeNull();
          const S = surfacePoint(s, u, v);
          expect(dist(k.n, vec.scale(vec.sub(S, c), 1 / r))).toBeLessThanOrEqual(1e-13);
          const n = surfaceNormal(s, u, v);
          expect(n).toEqual({ kind: 'regular', n: k.n });
          near(normalCurvature(s, u, v, { x: 1, y: 2, z: 3 })!, -1 / r, 1e-12, 1 / r);
        }
      }
    });
  }

  it('has a degenerate normal at the collapsed poles; limitNormal gives −z (v = 0) and +z (v = 1)', () => {
    const s = sphere({ x: 1, y: 2, z: 3 }, 2);
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      for (const [v, z, edge] of [
        [0, -1, 'v0'],
        [1, 1, 'v1'],
      ] as const) {
        expect(surfaceNormal(s, u, v)).toEqual({ kind: 'degenerate' });
        expect(principalCurvatures(s, u, v)).toBeNull();
        expect(fundamentalForms(s, u, v)).toBeNull();
        expect(normalCurvature(s, u, v, { x: 1, y: 0, z: 0 })).toBeNull();
        const ln = limitNormal(s, edge, u);
        expect(ln).not.toBeNull();
        expect(dist(ln!, { x: 0, y: 0, z })).toBeLessThanOrEqual(1e-13);
      }
      // Just inside the pole the normal is regular and close to the limit.
      const inside = surfaceNormal(s, u, 1e-7);
      expect(inside.kind).toBe('regular');
      if (inside.kind === 'regular') expect(inside.n.z).toBeLessThan(-0.999999);
    }
    expectCode(() => limitNormal(s, 'u0', 0.5), 'unsupported');
  });
});

describe('torus', () => {
  for (const [R, r, axis] of [
    [3, 1, { x: 0, y: 0, z: 1 }],
    [5, 2, { x: 1, y: 1, z: -0.5 }],
    [1.25, 1, { x: 0, y: 1, z: 0 }],
  ] as const) {
    it(`k = −1/r and −cos φ/(R + r cos φ), K = cos φ/(r(R + r cos φ)) (R = ${R}, r = ${r})`, () => {
      const c = { x: 0.5, y: -1, z: 2 };
      const s = torus(c, axis, R, r);
      const a = unit(axis);
      const scale = 1 / r;
      for (let i = 0; i < 24; i++) {
        for (let j = 0; j < 24; j++) {
          const u = (i + 0.37) / 24;
          const v = (j + 0.11) / 24;
          const S = surfacePoint(s, u, v);
          const d = vec.sub(S, c);
          const h = vec.dot(d, a);
          const radial = vec.sub(d, vec.scale(a, h));
          const rho = vec.norm(radial);
          // The point lies on the torus (exactness; the primitive test pins it to 64 ε).
          near((rho - R) ** 2 + h * h, r * r, 1e-13, r * r);
          const cosPhi = (rho - R) / r;
          const kTube = -1 / r;
          const kPar = -cosPhi / (R + r * cosPhi);
          const k = curv(s, u, v);
          near(k.k1, Math.max(kTube, kPar), 1e-12, scale, 'k1');
          near(k.k2, Math.min(kTube, kPar), 1e-12, scale, 'k2');
          near(k.K, cosPhi / (r * (R + r * cosPhi)), 1e-12, scale * scale, 'K');
          near(k.H, (kTube + kPar) / 2, 1e-12, scale, 'H');
          // Outward from the tube centre.
          const tubeCentre = vec.add(c, vec.scale(radial, R / rho));
          expect(dist(k.n, unit(vec.sub(S, tubeCentre)))).toBeLessThanOrEqual(1e-12);
          checkFrame(k);
          // The parallel direction belongs to kPar, the meridian to kTube.
          const par = unit(vec.cross(a, radial));
          const dPar = kPar > kTube ? k.d1! : k.d2!;
          expect(Math.abs(Math.abs(vec.dot(dPar, par)) - 1)).toBeLessThanOrEqual(1e-10);
        }
      }
    });
  }
});

describe('cylinder and plane', () => {
  it('cylinder: k₁ = 0 along the axis, k₂ = −1/r round it, K = 0', () => {
    const axis = { x: 1, y: -2, z: 0.5 };
    const a = unit(axis);
    for (const r of [0.5, 3]) {
      const s = cylinder({ x: 1, y: 1, z: 1 }, axis, r, 7);
      for (let i = 0; i < 16; i++) {
        for (const v of [0, 0.3, 1]) {
          const k = curv(s, (i + 0.5) / 16, v);
          near(k.k1, 0, 1e-12, 1 / r, 'k1');
          near(k.k2, -1 / r, 1e-12, 1 / r, 'k2');
          near(k.K, 0, 1e-12, 1 / (r * r), 'K');
          near(k.H, -1 / (2 * r), 1e-12, 1 / r, 'H');
          checkFrame(k);
          expect(vec.norm(vec.cross(k.d1!, a))).toBeLessThanOrEqual(1e-10);
          near(vec.dot(k.n, a), 0, 1e-13, 1);
        }
      }
    }
  });

  it('plane: zero curvature, the axes’ normal, umbilic (no directions)', () => {
    const uA = { x: 2, y: 1, z: 0 };
    const vA = { x: -1, y: 1, z: 3 };
    const s = planeSurface({ x: 3, y: -1, z: 2 }, uA, vA, { u: [-1, 4], v: [2, 3] });
    const n = unit(vec.cross(uA, vA));
    for (const [u, v] of [
      [-1, 2],
      [0.3, 2.7],
      [4, 3],
    ] as const) {
      const k = curv(s, u, v);
      // II is rounding noise (Suv of the bilinear net is ~ε, not 0): umbilic, k ≈ 0.
      for (const x of [k.k1, k.k2, k.H]) near(x, 0, 1e-15, 1);
      near(k.K, 0, 1e-30, 1);
      expect(k.d1).toBeNull();
      expect(dist(k.n, n)).toBeLessThanOrEqual(1e-15);
      near(normalCurvature(s, u, v, uA)!, 0, 1e-15, 1);
      const f = fundamentalForms(s, u, v)!;
      expect([f.L, f.N]).toEqual([0, 0]); // degree 1 in u and v: Suu, Svv vanish exactly
      near(f.M, 0, 1e-15, 1);
      near(f.E, vec.dot(uA, uA), 1e-15, 5);
      near(f.F, vec.dot(uA, vA), 1e-15, 5);
      near(f.G, vec.dot(vA, vA), 1e-15, 11);
    }
  });
});

describe('polynomial nets with closed forms', () => {
  it('z = xy (bilinear): E, F, G, L, M, N, K = −1/W², H = −uv/W^{3/2}', () => {
    const s = bilinearPatch(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    const sc = createScratch({ maxDegree: 1 });
    const out = new Float64Array(8);
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const u = i / 10;
        const v = j / 10;
        const W = 1 + u * u + v * v;
        const f = fundamentalForms(s, u, v)!;
        near(f.E, 1 + v * v, 1e-15, 2);
        near(f.F, u * v, 1e-15, 2);
        near(f.G, 1 + u * u, 1e-15, 2);
        expect(f.L).toBe(0);
        near(f.M, 1 / Math.sqrt(W), 1e-15, 1);
        expect(f.N).toBe(0);
        const k = curv(s, u, v);
        near(k.K, -1 / (W * W), 1e-12, 1, 'K');
        near(k.H, (-u * v) / W ** 1.5, 1e-12, 1, 'H');
        near(k.k1 * k.k2, k.K, 1e-12, 1);
        expect(k.k1).toBeGreaterThan(0);
        expect(k.k2).toBeLessThan(0);
        checkFrame(k);
        // The kernel writes the same numbers.
        expect(fundamentalFormsInto(s, u, v, out, 1, sc)).toBe(0);
        expect(Array.from(out.slice(1, 7))).toEqual([f.E, f.F, f.G, f.L, f.M, f.N]);
      }
    }
  });

  /** z = a x² + b y² on [−1, 1]² as a biquadratic Bézier patch (x = 2u − 1). */
  const graph = (a: number, b: number): NurbsSurface => {
    const X = [-1, 0, 1];
    const Q = [1, -1, 1]; // Bernstein coefficients of x² in u
    const pts: number[] = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) pts.push(X[i]!, X[j]!, a * Q[i]! + b * Q[j]!);
    return bezierSurface(pts, 3, 3);
  };

  for (const [a, b, name] of [
    [1, 1, 'paraboloid'],
    [1, -1, 'saddle'],
    [1, 3, 'elliptic paraboloid'],
  ] as const) {
    it(`${name} z = ${a}x² + ${b}y²: graph formulas for K and H, upward normal`, () => {
      const s = graph(a, b);
      for (let i = 0; i <= 12; i++) {
        for (let j = 0; j <= 12; j++) {
          const u = i / 12;
          const v = j / 12;
          const x = 2 * u - 1;
          const y = 2 * v - 1;
          const fx = 2 * a * x;
          const fy = 2 * b * y;
          const g = 1 + fx * fx + fy * fy;
          const K = (4 * a * b) / (g * g);
          const H = ((1 + fy * fy) * 2 * a + (1 + fx * fx) * 2 * b) / (2 * g ** 1.5);
          const k = curv(s, u, v);
          const scale = 2 * Math.max(Math.abs(a), Math.abs(b));
          expect(dist(k.n, unit({ x: -fx, y: -fy, z: 1 }))).toBeLessThanOrEqual(1e-13);
          near(k.K, K, 1e-12, scale * scale, 'K');
          near(k.H, H, 1e-12, scale, 'H');
          near(k.k1 + k.k2, 2 * H, 1e-12, scale);
          expect(k.k1).toBeGreaterThanOrEqual(k.k2);
          if (a === b && x === 0 && y === 0) {
            // The apex of the paraboloid of revolution is an umbilic: k = 2a.
            expect(k.d1).toBeNull();
            near(k.k1, 2 * a, 1e-12, scale);
          } else {
            checkFrame(k);
          }
        }
      }
      // At the apex the principal directions are the coordinate axes (a ≠ b).
      if (a !== b) {
        const k = curv(s, 0.5, 0.5);
        expect(Math.abs(k.d1!.x) + Math.abs(k.d2!.x)).toBeGreaterThan(1 - 1e-12);
        near(Math.max(k.k1, k.k2), 2 * Math.max(a, b), 1e-12, 2 * Math.max(a, b));
        near(Math.min(k.k1, k.k2), 2 * Math.min(a, b), 1e-12, 2 * Math.max(a, b));
      }
    });
  }
});

describe('identities on random NURBS surfaces', () => {
  /** Richardson-extrapolated central difference of the unit normal. */
  const dn = (s: NurbsSurface, u: number, v: number, dir: 'u' | 'v', h: number): Point3 => {
    const n = (x: number): Point3 => {
      const r = dir === 'u' ? surfaceNormal(s, x, v) : surfaceNormal(s, u, x);
      if (r.kind !== 'regular') throw new Error('degenerate in FD');
      return r.n;
    };
    const x0 = dir === 'u' ? u : v;
    const D = (k: number): Point3 => vec.scale(vec.sub(n(x0 + k), n(x0 - k)), 1 / (2 * k));
    return vec.scale(vec.sub(vec.scale(D(h / 2), 4), D(h)), 1 / 3);
  };

  it('Weingarten: L = −Su·n_u, M = −Su·n_v = −Sv·n_u, N = −Sv·n_v (finite differences)', () => {
    const rng = mulberry32(71);
    for (let trial = 0; trial < 30; trial++) {
      const s = randomSurface(rng, {
        degreeU: 2 + (trial % 3),
        degreeV: 2 + ((trial + 1) % 3),
        countU: 5,
        countV: 5,
        kindU: trial % 4 === 0 ? 'periodic' : 'clamped',
        basis: { minSpacing: 0.1 },
        weightRange: trial % 2 ? [0.5, 2] : undefined,
      });
      // Random points well inside one span pair (knot lines are where C² may fail).
      const spanPick = (b: NurbsSurface['u']): { t: number; h: number } => {
        const br: number[] = [];
        for (let i = 0; i < b.knots.length; i++)
          if (i === 0 || b.knots[i] !== b.knots[i - 1]) br.push(b.knots[i]!);
        if (b.kind === 'periodic') br.push(b.domain[1]);
        const k = Math.floor(rng() * (br.length - 1));
        return { t: br[k]! + (0.3 + 0.4 * rng()) * (br[k + 1]! - br[k]!), h: br[k + 1]! - br[k]! };
      };
      const { t: u, h: hu } = spanPick(s.u);
      const { t: v, h: hv } = spanPick(s.v);
      const f = fundamentalForms(s, u, v);
      if (f === null) continue;
      const d = surfaceDerivatives(s, u, v, 1);
      const su = vec.norm(d.Su);
      const sv = vec.norm(d.Sv);
      // n turns at up to |k|max·|Su| per unit u: the step resolves both that and the span.
      const k = principalCurvatures(s, u, v)!;
      const kmax = Math.max(Math.abs(k.k1), Math.abs(k.k2));
      const bu = Math.min(hu, 1 / (kmax * su));
      const bv = Math.min(hv, 1 / (kmax * sv));
      const nu = dn(s, u, v, 'u', bu / 1024);
      const nv = dn(s, u, v, 'v', bv / 1024);
      // Scale: |S·| times the local scale of n's derivative, max(|n_x|, |n|/base).
      const sc = (s1: number, nx: Point3, b: number): number => s1 * Math.max(vec.norm(nx), 1 / b);
      near(f.L, -vec.dot(d.Su, nu), 1e-8, sc(su, nu, bu), `L ${trial}`);
      near(f.M, -vec.dot(d.Su, nv), 1e-8, sc(su, nv, bv), `M ${trial}`);
      near(f.M, -vec.dot(d.Sv, nu), 1e-8, sc(sv, nu, bu), `M' ${trial}`);
      near(f.N, -vec.dot(d.Sv, nv), 1e-8, sc(sv, nv, bv), `N ${trial}`);
    }
  });

  it("Euler's theorem, projection of non-tangent directions, and frames", () => {
    const rng = mulberry32(73);
    for (let trial = 0; trial < 30; trial++) {
      const s = randomSurface(rng, {
        degreeU: 3,
        degreeV: 2,
        countU: 6,
        countV: 5,
        kindV: trial % 3 === 0 ? 'periodic' : 'clamped',
        weightRange: trial % 2 ? [0.5, 2] : undefined,
      });
      const u = rng();
      const v = rng();
      const k = principalCurvatures(s, u, v);
      if (k === null || k.d1 === null) continue;
      checkFrame(k);
      const scale = Math.max(Math.abs(k.k1), Math.abs(k.k2));
      for (let i = 0; i < 12; i++) {
        const th = (i * Math.PI) / 12;
        const dir = vec.add(vec.scale(k.d1, Math.cos(th)), vec.scale(k.d2!, Math.sin(th)));
        const want = k.k1 * Math.cos(th) ** 2 + k.k2 * Math.sin(th) ** 2;
        near(normalCurvature(s, u, v, dir)!, want, 1e-12, scale, `Euler ${trial}`);
        // Adding a normal component and scaling does not change it.
        const tilted = vec.scale(vec.add(dir, vec.scale(k.n, 5)), 3);
        near(normalCurvature(s, u, v, tilted)!, want, 1e-11, scale, `tilted ${trial}`);
      }
      expect(normalCurvature(s, u, v, k.n)).toBeNull();
      expect(k.k1).toBeGreaterThanOrEqual(k.k2);
      near(k.k1 * k.k2, k.K, 1e-12, scale * scale);
      near((k.k1 + k.k2) / 2, k.H, 1e-12, scale);
    }
  });
});

describe('limitNormal, degeneracy and kernels', () => {
  it('limitNormal on a collapsed u edge takes the sign from the side of the edge', () => {
    const O = { x: 0, y: 0, z: 0 };
    // S = u·(1, v, 0): the u0 edge is the apex; n = +z inside.
    const a = bilinearPatch(O, { x: 1, y: 0, z: 0 }, O, { x: 1, y: 1, z: 0 });
    // S = (1 − u)·(1, v, 0): the u1 edge is the apex; n = −z inside.
    const b = bilinearPatch({ x: 1, y: 0, z: 0 }, O, { x: 1, y: 1, z: 0 }, O);
    for (const t of [0, 0.4, 1]) {
      expect(surfaceNormal(a, 0, t)).toEqual({ kind: 'degenerate' });
      expect(limitNormal(a, 'u0', t)).toEqual({ x: 0, y: 0, z: 1 });
      expect(dist(limitNormal(b, 'u1', t)!, { x: 0, y: 0, z: -1 })).toBe(0);
      // On a regular edge it is the ordinary normal.
      const n = surfaceNormal(a, 1, t);
      expect(n.kind === 'regular' && n.n).toEqual(limitNormal(a, 'u1', t));
      const nb = surfaceNormal(b, 0.5, t);
      expect(nb.kind === 'regular' && nb.n.z).toBe(-1);
    }
    expectCode(() => limitNormal(a, 'w0' as 'u0', 0), 'unsupported');
  });

  it('a surface collapsed to a line has no normal anywhere; limitNormal is null', () => {
    const P = (x: number): Point3 => ({ x, y: 2 * x, z: -x });
    const s = bilinearPatch(P(0), P(1), P(2), P(3));
    for (const [u, v] of [
      [0, 0],
      [0.5, 0.5],
      [1, 0.2],
    ] as const) {
      expect(surfaceNormal(s, u, v)).toEqual({ kind: 'degenerate' });
      expect(principalCurvatures(s, u, v)).toBeNull();
    }
    expect(limitNormal(s, 'v0', 0.5)).toBeNull();
    const out = new Float64Array(6);
    const flags = fundamentalFormsInto(s, 0.5, 0.5, out, 0, createScratch({ maxDegree: 1 }));
    expect(flags).toBe(SAMPLE_DEGENERATE);
    expect([out[3], out[4], out[5]]).toEqual([0, 0, 0]);
  });

  it('fundamentalFormsInto equals fundamentalForms bit for bit and reports umbilics', () => {
    const rng = mulberry32(79);
    const sc = createScratch({ maxDegree: 3 });
    const out = new Float64Array(6);
    for (let trial = 0; trial < 10; trial++) {
      const s = randomSurface(rng, {
        degreeU: 3,
        degreeV: 1 + (trial % 3),
        countU: 5,
        countV: 4,
        weightRange: [0.5, 2],
      });
      const u = rng();
      const v = rng();
      const f = fundamentalForms(s, u, v)!;
      expect(fundamentalFormsInto(s, u, v, out, 0, sc) & SAMPLE_DEGENERATE).toBe(0);
      expect(Array.from(out)).toEqual([f.E, f.F, f.G, f.L, f.M, f.N]);
    }
    const sph = sphere({ x: 0, y: 0, z: 0 }, 1);
    expect(fundamentalFormsInto(sph, 0.3, 0.4, out, 0, createScratch({ maxDegree: 2 }))).toBe(
      SAMPLE_UMBILIC,
    );
    expectCode(() => fundamentalFormsInto(sph, 0.3, 0.4, out, 1, sc), 'size-mismatch');
    expectCode(
      () =>
        fundamentalFormsInto(sph, 0.3, 0.4, out, 0, createScratch({ maxDegree: 2, maxDerivs: 1 })),
      'scratch-too-small',
    );
    expectCode(() => normalCurvature(sph, 0.3, 0.4, { x: NaN, y: 0, z: 0 }), 'non-finite');
    expectCode(() => principalCurvatures(sph, 0.3, 1.5), 'param-out-of-domain');
  });
});
