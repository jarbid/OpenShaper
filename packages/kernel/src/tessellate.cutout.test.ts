// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getLength } from './board';
import { splineFromKnots } from './bezier-spline';
import { knotFromArray } from './knot';
import { hasTailCutout } from './outline-cutout';
import { tessellateBoard, type BoardMesh } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const shortboard = parseBrdGeometry(readFileSync(resolve(goldenDir, 'shortboard.brd'), 'utf8'));
const LENGTH = getLength(shortboard); // 187.96

/** Tangent handle 1/3 along the chord a→b (keeps each segment near-straight). */
const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

/**
 * Swallow outline on the shortboard's length: notch bottom on the stringer (18,0)
 * → tail tip (0,9, rearmost) → wide (90,23.5) → nose (LENGTH,0). The outline folds
 * back in x at the tail, so x ∈ [0,18] carries an inner notch wall + outer rail.
 */
const swallowOutline = splineFromKnots([
  knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
  knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
  knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, LENGTH, 0)], false, false),
  knotFromArray([LENGTH, 0, ...third(LENGTH, 0, 90, 23.5), LENGTH, 0], false, false),
]);

/** Reuse the real shortboard rocker/deck/sections, swap in the swallow outline. */
const swallowBoard = board(
  swallowOutline,
  shortboard.bottom,
  shortboard.deck,
  shortboard.crossSections,
  shortboard.interpolationType,
  shortboard.fins,
);

const noNaN = (a: Float32Array): boolean => {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
};

/**
 * Weld vertices by quantized position, then count edges used by exactly one
 * triangle. A watertight (closed) mesh has none — welding first collapses the
 * coincident centerline seam where the two half-shells meet.
 */
const boundaryEdgeCount = (mesh: BoardMesh): number => {
  const q = (v: number): number => Math.round(v * 1000);
  const key = (i: number): string =>
    `${q(mesh.positions[i * 3]!)},${q(mesh.positions[i * 3 + 1]!)},${q(mesh.positions[i * 3 + 2]!)}`;
  const canon = new Map<string, number>();
  const id = (i: number): number => {
    const k = key(i);
    let c = canon.get(k);
    if (c === undefined) {
      c = canon.size;
      canon.set(k, c);
    }
    return c;
  };
  const edges = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [id(mesh.indices[t]!), id(mesh.indices[t + 1]!), id(mesh.indices[t + 2]!)];
    for (let e = 0; e < 3; e++) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      if (a === b) continue; // skip degenerate (collapsed sliver / tip) edges
      const ek = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(ek, (edges.get(ek) ?? 0) + 1);
    }
  }
  let boundary = 0;
  for (const c of edges.values()) if (c === 1) boundary++;
  return boundary;
};

describe('tessellateCutout: swallow board', () => {
  const mesh = tessellateBoard(swallowBoard, { lengthSteps: 120, ringSteps: 48 });

  it('the outline is detected as a concave tail', () => {
    expect(hasTailCutout(swallowOutline)).toBe(true);
  });

  it('produces a valid, NaN-free mesh', () => {
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(noNaN(mesh.positions)).toBe(true);
    expect(noNaN(mesh.normals)).toBe(true);
    const vc = mesh.positions.length / 3;
    for (let i = 0; i < mesh.indices.length; i++) expect(mesh.indices[i]!).toBeLessThan(vc);
  });

  it('is watertight after welding the centerline seam (no holes)', () => {
    expect(boundaryEdgeCount(mesh)).toBe(0);
  });

  it('opens a notch: two pods with a centerline gap in the tail', () => {
    // In the notch (x ∈ [3,12]) no foam touches the stringer → min |y| is well > 0.
    let notchMinAbsY = Infinity;
    let bodyMinAbsY = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      const ay = Math.abs(mesh.positions[i + 1]!);
      if (x >= 3 && x <= 12) notchMinAbsY = Math.min(notchMinAbsY, ay);
      if (x >= 60 && x <= 120) bodyMinAbsY = Math.min(bodyMinAbsY, ay);
    }
    expect(notchMinAbsY).toBeGreaterThan(1.0); // gap down the middle of the notch
    expect(bodyMinAbsY).toBeLessThan(0.5); // body welds at the centerline
  });

  it('keeps the outer rail width (max |y| ≈ outline half-width)', () => {
    let maxAbsY = 0;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      maxAbsY = Math.max(maxAbsY, Math.abs(mesh.positions[i]!));
    }
    expect(maxAbsY).toBeCloseTo(23.5, 0); // within 0.5cm of the wide point
  });

  it('samples the concave wall finely (the inner edge steps smoothly, no big facets)', () => {
    // Group verts by station x; the inner edge at a station is its min |y|. Adjacent
    // stations through the notch must step the inner edge only a little — large jumps
    // are the flat-facet artifact the adaptive station sampling removes.
    const inner = new Map<number, number>();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      if (x < 1 || x > 16) continue; // notch interior (avoid tip + notch-base ends)
      const xk = Math.round(x * 100) / 100;
      const ay = Math.abs(mesh.positions[i + 1]!);
      inner.set(xk, Math.min(inner.get(xk) ?? Infinity, ay));
    }
    const xs = [...inner.keys()].sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThan(10); // sampled through the notch
    let maxStep = 0;
    for (let i = 1; i < xs.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(inner.get(xs[i]!)! - inner.get(xs[i - 1]!)!));
    }
    expect(maxStep).toBeLessThan(1.0); // smooth: no large lateral jump between rings
  });
});

describe('tessellateCutout: a steep concave wall stays smooth', () => {
  const L = LENGTH;
  // The inner wall leaves the notch bottom (24,0) running nearly PARALLEL to y (a
  // near-vertical tangent), then curves to the tip (0,13) — the case that gave large
  // flat facets with x-uniform sampling. Adaptive station refinement must follow it.
  const steepSwallow = splineFromKnots([
    knotFromArray([24, 0, 24, 0, 23, 7], false, false), // toNext shoots up in y at x≈24
    knotFromArray([0, 13, 5, 13, ...third(0, 13, 95, 23.5)], false, false),
    knotFromArray([95, 23.5, ...third(95, 23.5, 0, 13), ...third(95, 23.5, L, 0)], false, false),
    knotFromArray([L, 0, ...third(L, 0, 95, 23.5), L, 0], false, false),
  ]);
  const b = board(
    steepSwallow,
    shortboard.bottom,
    shortboard.deck,
    shortboard.crossSections,
    shortboard.interpolationType,
    shortboard.fins,
  );
  const mesh = tessellateBoard(b, { lengthSteps: 120, ringSteps: 48 });

  it('is watertight', () => {
    expect(noNaN(mesh.positions)).toBe(true);
    expect(boundaryEdgeCount(mesh)).toBe(0);
  });

  it('the inner edge follows the curve with small lateral steps', () => {
    const inner = new Map<number, number>();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      if (x < 1 || x > 22) continue;
      const xk = Math.round(x * 100) / 100;
      inner.set(xk, Math.min(inner.get(xk) ?? Infinity, Math.abs(mesh.positions[i + 1]!)));
    }
    const xs = [...inner.keys()].sort((a, b) => a - b);
    let maxStep = 0;
    for (let i = 1; i < xs.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(inner.get(xs[i]!)! - inner.get(xs[i - 1]!)!));
    }
    // With x-uniform sampling this steep wall jumped several cm between rings; adaptive
    // refinement keeps every step small.
    expect(maxStep).toBeLessThan(1.0);
  });
});
