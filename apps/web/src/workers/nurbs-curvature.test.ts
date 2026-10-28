// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The mapping from the grid mesh's convex-positive principal curvatures to the view's
 * mean / Gaussian / radius, against the closed forms of a sphere and a cylinder, and
 * the display scales.
 */
import { MAX_RADIUS } from '@openshaper/render3d/curvature-mesh';
import { describe, expect, it } from 'vitest';
import {
  convexCurvatures,
  curvatureArrays,
  curvatureScale,
  excludeUndefined,
  vertexAreas,
} from './nurbs-curvature';

const R = 7.5;

describe('convexCurvatures against closed forms', () => {
  it('reads a sphere as convex: mean 1/r, Gaussian 1/r², radius r', () => {
    const q = convexCurvatures(1 / R, 1 / R);
    expect(q.mean).toBeCloseTo(1 / R, 12);
    expect(q.gaussian).toBeCloseTo(1 / (R * R), 12);
    expect(q.radius).toBeCloseTo(R, 9);
  });

  it('reads a cylinder as convex one way: mean 1/(2r), Gaussian 0, radius r', () => {
    const q = convexCurvatures(1 / R, 0);
    expect(q.mean).toBeCloseTo(1 / (2 * R), 12);
    expect(q.gaussian).toBeCloseTo(0, 12);
    expect(q.radius).toBeCloseTo(R, 9);
  });

  it('gives a concave bowl the opposite mean and the same Gaussian as a dome', () => {
    const bowl = convexCurvatures(-1 / R, -1 / R);
    expect(bowl.mean).toBeCloseTo(-1 / R, 12);
    expect(bowl.gaussian).toBeCloseTo(1 / (R * R), 12);
  });

  it('is negative for a saddle’s Gaussian and zero-mean for a minimal one', () => {
    const q = convexCurvatures(0.1, -0.1);
    expect(q.gaussian).toBeCloseTo(-0.01, 15);
    expect(q.mean).toBeCloseTo(0, 15);
    expect(q.radius).toBeCloseTo(10, 12);
  });

  it('caps the radius of a flat spot so it stays finite', () => {
    expect(convexCurvatures(0, 0).radius).toBe(MAX_RADIUS);
    expect(convexCurvatures(1e-9, -1e-9).radius).toBe(MAX_RADIUS);
  });
});

describe('curvatureArrays', () => {
  it('maps every vertex and flags the ones whose curvature is not finite', () => {
    const k1 = Float32Array.of(1 / R, Number.NaN, 0);
    const k2 = Float32Array.of(1 / R, 0.1, 0);
    const a = curvatureArrays(k1, k2);
    expect(a.mean[0]).toBeCloseTo(1 / R, 6);
    expect(a.gaussian[0]).toBeCloseTo(1 / (R * R), 6);
    expect(a.minRadius[0]).toBeCloseTo(R, 4);
    expect([...a.undefinedAt]).toEqual([0, 1, 0]);
    expect(a.mean[1]).toBe(0);
    expect(a.minRadius[1]).toBe(MAX_RADIUS);
    expect(a.minRadius[2]).toBe(MAX_RADIUS);
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

describe('excludeUndefined', () => {
  it('gives vertices with undefined curvature no weight in the display scales', () => {
    // 100 vertices at mean 0.01 and 900 undefined ones (mean 0, capped radius) of the
    // same area: counted, the 90th percentile of |mean| is 0; excluded, it is 0.01.
    const n = 1000;
    const mean = new Float32Array(n).fill(0.01);
    const gaussian = new Float32Array(n).fill(1e-4);
    const radius = new Float32Array(n).fill(100);
    const undefinedAt = new Uint8Array(n);
    for (let i = 100; i < n; i++) {
      mean[i] = 0;
      gaussian[i] = 0;
      radius[i] = MAX_RADIUS;
      undefinedAt[i] = 1;
    }
    const counted = curvatureScale(mean, gaussian, radius, new Float64Array(n).fill(1));
    expect(counted.mean).toBeLessThan(1e-9);
    const area = excludeUndefined(new Float64Array(n).fill(1), undefinedAt);
    expect(area.slice(0, 100).every((a) => a === 1)).toBe(true);
    expect(area.slice(100).every((a) => a === 0)).toBe(true);
    const scale = curvatureScale(mean, gaussian, radius, area);
    expect(scale.mean).toBeGreaterThan(0.009);
    expect(scale.mean).toBeLessThan(0.0115);
    expect(scale.radius[0]).toBeGreaterThan(90);
  });
});
