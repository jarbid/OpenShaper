// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for `vertexCurvature` on meshes with known curvature, built here with exact
 * normals: sphere, cylinder, plane, saddle, torus, refinement, and degenerate input.
 */
import { describe, expect, it } from 'vitest';
import { vertexCurvature } from './curvature';

interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

type Surf = (u: number, v: number) => { p: [number, number, number]; n: [number, number, number] };

/** A (nu+1) x (nv+1) grid over [u0,u1] x [v0,v1], two triangles per cell, no welding. */
function grid(
  s: Surf,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  nu: number,
  nv: number,
): Mesh {
  const nVert = (nu + 1) * (nv + 1);
  const positions = new Float32Array(3 * nVert);
  const normals = new Float32Array(3 * nVert);
  const indices = new Uint32Array(6 * nu * nv);
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const { p, n } = s(u0 + ((u1 - u0) * i) / nu, v0 + ((v1 - v0) * j) / nv);
      const o = 3 * (j * (nu + 1) + i);
      positions.set(p, o);
      normals.set(n, o);
    }
  }
  let t = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      indices.set([a, b, d, a, d, c], t);
      t += 6;
    }
  }
  return { positions, normals, indices };
}

const sphere =
  (R: number, sign = 1): Surf =>
  (th, ph) => {
    const x = Math.cos(th) * Math.sin(ph),
      y = Math.sin(th) * Math.sin(ph),
      z = Math.cos(ph);
    return { p: [R * x, R * y, R * z], n: [sign * x, sign * y, sign * z] };
  };

/** Unit-normal grid test mesh for a sphere, u around, v from pole to pole. */
const torusSurf =
  (R: number, r: number): Surf =>
  (th, ph) => {
    const cp = Math.cos(ph),
      sp = Math.sin(ph);
    return {
      p: [(R + r * cp) * Math.cos(th), (R + r * cp) * Math.sin(th), r * sp],
      n: [cp * Math.cos(th), cp * Math.sin(th), sp],
    };
  };

const uvSphere = (R: number, nu: number, nv: number, sign = 1): Mesh =>
  grid(sphere(R, sign), 0, 2 * Math.PI, 0, Math.PI, nu, nv);

function sphereError(R: number, nu: number, nv: number, sign = 1): number {
  const m = uvSphere(R, nu, nv, sign);
  const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
  let worst = 0;
  for (let j = 2; j <= nv - 2; j++) {
    for (let i = 0; i <= nu; i++) {
      const v = j * (nu + 1) + i;
      worst = Math.max(
        worst,
        Math.abs(k1[v]! - (sign * 1) / R) * R,
        Math.abs(k2[v]! - (sign * 1) / R) * R,
      );
    }
  }
  return worst;
}

describe('vertexCurvature', () => {
  it('reads a sphere as convex positive 1/R in both, and negative for inward normals', () => {
    const R = 7;
    const outward = sphereError(R, 64, 48, 1);
    const inward = sphereError(R, 64, 48, -1);
    expect(outward).toBeLessThan(0.03);
    expect(inward).toBeLessThan(0.03);
    const m = uvSphere(R, 64, 48, 1);
    const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
    const v = 24 * 65 + 10;
    expect(k1[v]!).toBeGreaterThan(0);
    expect(k2[v]!).toBeGreaterThan(0);
  });

  it('puts a cylinder radius in k1 and zero in k2', () => {
    const R = 3;
    const cyl: Surf = (x, th) => ({
      p: [x, R * Math.cos(th), R * Math.sin(th)],
      n: [0, Math.cos(th), Math.sin(th)],
    });
    const m = grid(cyl, 0, 20, 0, 2 * Math.PI, 40, 48);
    const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
    let e1 = 0,
      e2 = 0;
    for (let v = 0; v < k1.length; v++) {
      e1 = Math.max(e1, Math.abs(k1[v]! - 1 / R) * R);
      e2 = Math.max(e2, Math.abs(k2[v]!) * R);
    }
    expect(e1).toBeLessThan(0.03);
    expect(e2).toBeLessThan(0.01);
    // concave (inward normals): zero is the larger, -1/R the smaller
    const inn = { ...m, normals: m.normals.map((x) => -x) };
    const c = vertexCurvature(inn.positions, inn.normals, inn.indices);
    expect(c.k1[500]!).toBeCloseTo(0, 2);
    expect(c.k2[500]!).toBeCloseTo(-1 / R, 1);
  });

  it('gives zero on a plane', () => {
    // z = 0.5x - y has the exact normal (-0.5, 1, 1) / 1.5.
    const nrm = Math.hypot(0.5, 1, 1);
    const m = grid(
      (x, y) => ({ p: [x, y, 0.5 * x - y], n: [-0.5 / nrm, 1 / nrm, 1 / nrm] }),
      0,
      5,
      0,
      5,
      10,
      10,
    );
    const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
    for (let v = 0; v < k1.length; v++) {
      expect(Math.abs(k1[v]!)).toBeLessThan(1e-9);
      expect(Math.abs(k2[v]!)).toBeLessThan(1e-9);
    }
  });

  it('reads a saddle as +1/a and -1/a at the centre', () => {
    const a = 10;
    // z = (x^2 - y^2) / (2a) with the downward normal (x/a, -y/a, -1) / norm: along x
    // the surface bends away from that normal (concave, -1/a), along y toward it (+1/a).
    const saddle: Surf = (x, y) => {
      const l = Math.hypot(x / a, y / a, 1);
      return { p: [x, y, (x * x - y * y) / (2 * a)], n: [x / a / l, -y / a / l, -1 / l] };
    };
    const m = grid(saddle, -2, 2, -2, 2, 40, 40);
    const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
    const c = 20 * 41 + 20;
    expect(Math.abs(k1[c]! - 1 / a) * a).toBeLessThan(0.05);
    expect(Math.abs(k2[c]! + 1 / a) * a).toBeLessThan(0.05);
    expect(k1[c]!).toBeGreaterThan(k2[c]!);
  });

  it('follows a torus where the two curvatures differ and vary', () => {
    const R = 10,
      r = 3;
    const torus: Surf = (th, ph) => {
      const cp = Math.cos(ph),
        sp = Math.sin(ph);
      return {
        p: [(R + r * cp) * Math.cos(th), (R + r * cp) * Math.sin(th), r * sp],
        n: [cp * Math.cos(th), cp * Math.sin(th), sp],
      };
    };
    const nu = 120,
      nv = 60;
    const m = grid(torus, 0, 2 * Math.PI, 0, 2 * Math.PI, nu, nv);
    const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
    for (const j of [5, 10, 20, 40, 50]) {
      const ph = (2 * Math.PI * j) / nv;
      const kAround = Math.cos(ph) / (R + r * Math.cos(ph));
      const kTube = 1 / r;
      const hi = Math.max(kAround, kTube),
        lo = Math.min(kAround, kTube);
      for (let i = 0; i < nu; i += 7) {
        const v = j * (nu + 1) + i;
        expect(Math.abs(k1[v]! - hi)).toBeLessThan(0.05 * Math.abs(hi));
        expect(Math.abs(k2[v]! - lo)).toBeLessThan(0.05 * Math.abs(lo) + 1e-3);
      }
    }
  });

  it('improves when the mesh is refined', () => {
    // A sphere with exact normals is reproduced to rounding at any resolution, so the
    // refinement check uses the torus, whose error is discretisation error.
    const err = (nu: number, nv: number): number => {
      const m = grid(torusSurf(10, 3), 0, 2 * Math.PI, 0, 2 * Math.PI, nu, nv);
      const { k1, k2 } = vertexCurvature(m.positions, m.normals, m.indices);
      let worst = 0;
      for (let j = 0; j < nv; j++) {
        const ph = (2 * Math.PI * j) / nv;
        const ka = Math.cos(ph) / (10 + 3 * Math.cos(ph));
        const hi = Math.max(ka, 1 / 3),
          lo = Math.min(ka, 1 / 3);
        for (let i = 0; i < nu; i += 3) {
          const v = j * (nu + 1) + i;
          worst = Math.max(worst, Math.abs(k1[v]! - hi) + Math.abs(k2[v]! - lo));
        }
      }
      return worst;
    };
    expect(err(80, 40)).toBeLessThan(err(40, 20));
  });

  it('stays finite on a zero-area triangle and an isolated vertex', () => {
    const m = uvSphere(4, 16, 12);
    const nV = m.positions.length / 3;
    const positions = new Float32Array(3 * (nV + 2));
    positions.set(m.positions);
    positions.set([1, 2, 3, 1, 2, 3], 3 * nV); // the isolated vertex and a coincident one
    const normals = new Float32Array(3 * (nV + 2));
    normals.set(m.normals);
    normals.set([0, 0, 1, 0, 0, 1], 3 * nV);
    const extra = new Uint32Array(m.indices.length + 3);
    extra.set(m.indices);
    extra.set([0, 0, 1], m.indices.length); // zero area: repeated vertex
    const { k1, k2 } = vertexCurvature(positions, normals, extra);
    for (let v = 0; v < nV + 2; v++) {
      expect(Number.isFinite(k1[v]!)).toBe(true);
      expect(Number.isFinite(k2[v]!)).toBe(true);
    }
    expect(k1[nV]).toBe(0);
    expect(k2[nV]).toBe(0);
    expect(k1[nV + 1]).toBe(0);
  });

  it('keeps duplicated seam vertices at the cylinder values on both sides', () => {
    const R = 2;
    const cyl: Surf = (x, th) => ({
      p: [x, R * Math.cos(th), R * Math.sin(th)],
      n: [0, Math.cos(th), Math.sin(th)],
    });
    const a = grid(cyl, 0, 10, 0, Math.PI, 20, 24);
    const b = grid(cyl, 0, 10, Math.PI, 2 * Math.PI, 20, 24);
    const nA = a.positions.length / 3;
    const positions = new Float32Array([...a.positions, ...b.positions]);
    const normals = new Float32Array([...a.normals, ...b.normals]);
    const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + nA)]);
    const { k1, k2 } = vertexCurvature(positions, normals, indices);
    for (let v = 0; v < k1.length; v++) {
      expect(Math.abs(k1[v]! - 1 / R) * R).toBeLessThan(0.1);
      expect(Math.abs(k2[v]!) * R).toBeLessThan(0.1);
    }
  });

  it('times a mesh of about 45 thousand vertices', () => {
    const m = uvSphere(10, 300, 150);
    const t0 = performance.now();
    vertexCurvature(m.positions, m.normals, m.indices);
    const ms = performance.now() - t0;
    expect(m.positions.length / 3).toBeGreaterThan(45000);
    // Measured about 18 ms; the bound is far above that.
    expect(ms).toBeLessThan(1000);
  });
});
