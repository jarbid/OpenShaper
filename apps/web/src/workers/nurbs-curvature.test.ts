// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The mapping from geom's principal curvatures to the view's mean / Gaussian / radius,
 * against surfaces with known curvature: geom's own exact sphere and cylinder, read
 * back through geom's own derivative code (not through a mesh).
 */
import {
  cylinder,
  principalCurvatures,
  reverseSurface,
  sphere,
  type NurbsSurface,
} from '@openshaper/geom';
import { MAX_RADIUS } from '@openshaper/render3d/curvature-mesh';
import { describe, expect, it } from 'vitest';
import { convexCurvatures, curvatureScale, repairNormals, vertexAreas } from './nurbs-curvature';

const R = 7.5;

/** The view's quantities at (u, v) of a surface, as `nurbs-core` computes them for a face. */
const viewQuantities = (s: NurbsSurface, u: number, v: number, sameSense: boolean) => {
  const k = principalCurvatures(s, u, v);
  if (!k) throw new Error('degenerate');
  return convexCurvatures(k.k1, k.k2, sameSense);
};

describe('convexCurvatures against exact surfaces', () => {
  const ball = sphere({ x: 1, y: 2, z: 3 }, R);

  it('reads a sphere as convex: mean 1/r, Gaussian 1/r², radius r', () => {
    // geom reports k1 = k2 = -1/r for an outward normal; the view wants + for convex.
    for (const [u, v] of [
      [0.1, 0.3],
      [0.5, 0.5],
      [0.8, 0.7],
    ] as const) {
      const q = viewQuantities(ball, u, v, true);
      expect(q.mean).toBeCloseTo(1 / R, 12);
      expect(q.gaussian).toBeCloseTo(1 / (R * R), 12);
      expect(q.radius).toBeCloseTo(R, 9);
    }
  });

  it('reads a cylinder as convex one way: mean 1/(2r), Gaussian 0, radius r', () => {
    const tube = cylinder({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, R, 20);
    const q = viewQuantities(tube, 0.3, 0.5, true);
    expect(q.mean).toBeCloseTo(1 / (2 * R), 12);
    expect(q.gaussian).toBeCloseTo(0, 12);
    expect(q.radius).toBeCloseTo(R, 9);
  });

  it('gives a hollow (concave) sphere the opposite mean and the same Gaussian', () => {
    // The inward-facing sphere: n points to the centre, k = +1/r relative to it. The
    // B-rep marks such a face sameSense = false when its outward normal is the reverse.
    const inside = reverseSurface(ball, 'u');
    const flipped = viewQuantities(inside, 0.4, 0.4, false);
    expect(flipped.mean).toBeCloseTo(1 / R, 12); // reversed normal, flipped back: convex again
    const raw = viewQuantities(inside, 0.4, 0.4, true);
    expect(raw.mean).toBeCloseTo(-1 / R, 12); // read against the inward normal: concave
    expect(raw.gaussian).toBeCloseTo(1 / (R * R), 12);
  });

  it('flips (k1, k2) to (−k2, −k1) for a face whose outward normal is reversed', () => {
    const a = convexCurvatures(-0.2, -0.05, true);
    const b = convexCurvatures(0.05, 0.2, false);
    expect(b.mean).toBeCloseTo(a.mean, 15);
    expect(b.gaussian).toBeCloseTo(a.gaussian, 15);
    expect(b.radius).toBeCloseTo(a.radius, 12);
  });

  it('is negative for a saddle’s Gaussian and zero-mean for a minimal one', () => {
    const q = convexCurvatures(-0.1, 0.1, true);
    expect(q.gaussian).toBeCloseTo(-0.01, 15);
    expect(q.mean).toBeCloseTo(0, 15);
    expect(q.radius).toBeCloseTo(10, 12);
  });

  it('caps the radius of a flat spot so it stays finite', () => {
    expect(convexCurvatures(0, 0, true).radius).toBe(MAX_RADIUS);
    expect(convexCurvatures(1e-9, -1e-9, true).radius).toBe(MAX_RADIUS);
  });
});

describe('display scale', () => {
  // A unit square of two triangles: every vertex has some area.
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const indices = [0, 1, 2, 0, 2, 3];

  it('weights vertices by a third of their triangles’ area', () => {
    const area = vertexAreas(positions, indices, 4);
    expect(area[1]).toBeCloseTo(1 / 6, 12);
    expect(area[0]).toBeCloseTo(1 / 3, 12);
    expect([...area].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('takes the 80th percentile of the magnitudes, so one extreme vertex does not set it', () => {
    const n = 1000;
    const mean = new Float32Array(n).fill(0.01);
    mean[0] = 50; // a pinched tip
    const gaussian = new Float32Array(n).fill(1e-4);
    const radius = new Float32Array(n).fill(100);
    radius[0] = 0.01;
    const scale = curvatureScale(mean, gaussian, radius, new Float64Array(n).fill(1));
    expect(scale.mean).toBeGreaterThan(0.009);
    expect(scale.mean).toBeLessThan(0.0115);
    expect(scale.gaussian).toBeGreaterThan(9e-5);
    expect(scale.radius[0]).toBeGreaterThan(90);
  });
});

describe('repairNormals', () => {
  it('replaces an undefined (zero) normal by the area-weighted normal of its triangles', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const indices = [0, 1, 2, 2, 1, 3];
    const normals = Float32Array.of(0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    expect(repairNormals(positions, normals, indices)).toBe(1);
    expect([...normals.slice(0, 3)]).toEqual([0, 0, 1]);
  });

  it('leaves good normals alone and reports nothing to repair', () => {
    const normals = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1);
    expect(repairNormals([0, 0, 0, 1, 0, 0, 0, 1, 0], normals, [0, 1, 2])).toBe(0);
    expect([...normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });
});
