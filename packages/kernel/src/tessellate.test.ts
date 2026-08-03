// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLength, getVolume } from './board';
import { tessellateBoard, tessellationSteps } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');

const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

const noNaN = (arr: Float32Array): boolean => {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) return false;
  return true;
};

describe('tessellateBoard: shortboard', () => {
  const board = loadBoard('shortboard');
  const mesh = tessellateBoard(board);

  it('positions length is a multiple of 3 and non-empty', () => {
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.positions.length % 3).toBe(0);
  });

  it('normals length equals positions length', () => {
    expect(mesh.normals.length).toBe(mesh.positions.length);
  });

  it('indices are a multiple of 3 and reference valid vertices', () => {
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    let max = -1;
    for (let i = 0; i < mesh.indices.length; i++) max = Math.max(max, mesh.indices[i]!);
    expect(max).toBeLessThan(vertexCount);
  });

  it('contains no NaN/Inf in positions or normals', () => {
    expect(noNaN(mesh.positions)).toBe(true);
    expect(noNaN(mesh.normals)).toBe(true);
  });

  it('normals are unit length', () => {
    for (let v = 0; v < mesh.normals.length; v += 3) {
      const len = Math.hypot(mesh.normals[v]!, mesh.normals[v + 1]!, mesh.normals[v + 2]!);
      expect(Math.abs(len - 1)).toBeLessThan(1e-3);
    }
  });

  it('bounding-box X-extent ≈ board length', () => {
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    const extent = maxX - minX;
    expect(Math.abs(extent - getLength(board))).toBeLessThanOrEqual(3);
  });
});

/**
 * Signed volume via the divergence theorem: Σ dot(v0, (v1−v0)×(v2−v0)) / 6.
 * Positive means the triangle winding is consistently OUTWARD; a shell built
 * inside-out (what `orientOutward` exists to prevent) gives a negative value.
 * Its magnitude is the enclosed volume, so it doubles as a sanity check that
 * the mesh really is the board and not a self-intersecting tangle.
 */
const signedVolume = (mesh: ReturnType<typeof tessellateBoard>): number => {
  const p = mesh.positions;
  let vol = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]! * 3;
    const ib = mesh.indices[t + 1]! * 3;
    const ic = mesh.indices[t + 2]! * 3;
    const e1x = p[ib]! - p[ia]!;
    const e1y = p[ib + 1]! - p[ia + 1]!;
    const e1z = p[ib + 2]! - p[ia + 2]!;
    const e2x = p[ic]! - p[ia]!;
    const e2y = p[ic + 1]! - p[ia + 1]!;
    const e2z = p[ic + 2]! - p[ia + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    vol += (p[ia]! * nx + p[ia + 1]! * ny + p[ia + 2]! * nz) / 6;
  }
  return vol;
};

/** Fraction of faces whose stored vertex normal agrees with its own face normal. */
const faceNormalAgreement = (mesh: ReturnType<typeof tessellateBoard>): number => {
  const p = mesh.positions;
  let agree = 0;
  let total = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]! * 3;
    const ib = mesh.indices[t + 1]! * 3;
    const ic = mesh.indices[t + 2]! * 3;
    const e1x = p[ib]! - p[ia]!;
    const e1y = p[ib + 1]! - p[ia + 1]!;
    const e1z = p[ib + 2]! - p[ia + 2]!;
    const e2x = p[ic]! - p[ia]!;
    const e2y = p[ic + 1]! - p[ia + 1]!;
    const e2z = p[ic + 2]! - p[ia + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue; // degenerate sliver: no meaningful direction
    if (mesh.normals[ia]! * nx + mesh.normals[ia + 1]! * ny + mesh.normals[ia + 2]! * nz > 0)
      agree++;
    total++;
  }
  return agree / total;
};

/**
 * Orientation is asserted by signed volume and per-face normal agreement rather
 * than by "does each vertex normal point away from the mesh centroid".
 *
 * That older heuristic is not a correctness test: near the nose and tail the
 * board is thin and lifted by rocker, so a deck vertex's radial vector from the
 * GLOBAL centroid points mostly along ±x while its normal points up — the dot
 * product goes slightly negative even though the surface faces correctly
 * outward. Its result therefore tracks how ring samples happen to be
 * distributed along the profile, not whether the shell is inside-out. Signed
 * volume answers the actual question (and would flip negative on a genuine
 * inversion, which is what `orientOutward` guards against).
 */
describe('tessellateBoard: outward orientation', () => {
  it('orients the shell outward for every golden board', () => {
    for (const name of ['shortboard', 'funboard', 'longboard']) {
      const board = loadBoard(name);
      const mesh = tessellateBoard(board);

      // Outward winding ⇒ positive; inside-out ⇒ negative.
      expect(signedVolume(mesh)).toBeGreaterThan(0);

      // ...and it encloses the board: a faceted hull slightly under-fills the
      // curved solid, so allow a few percent under but no overshoot.
      const kernelVolume = getVolume(board);
      expect(signedVolume(mesh)).toBeGreaterThan(kernelVolume * 0.9);
      expect(signedVolume(mesh)).toBeLessThan(kernelVolume * 1.02);

      // Lighting and face culling must agree everywhere.
      expect(faceNormalAgreement(mesh)).toBe(1);
    }
  });
});

describe('tessellateBoard: options and robustness', () => {
  it('honors custom step counts', () => {
    const board = loadBoard('shortboard');
    const mesh = tessellateBoard(board, { lengthSteps: 20, ringSteps: 16 });
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    const vertexCount = mesh.positions.length / 3;
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]!).toBeLessThan(vertexCount);
    }
  });

  it('tessellates all golden boards without NaN', () => {
    for (const name of ['shortboard', 'funboard', 'longboard']) {
      const mesh = tessellateBoard(loadBoard(name));
      expect(mesh.positions.length).toBeGreaterThan(0);
      expect(noNaN(mesh.positions)).toBe(true);
      expect(noNaN(mesh.normals)).toBe(true);
    }
  });
});

describe('tessellateBoard: target face size', () => {
  const board = loadBoard('shortboard');

  it('derives more steps for a smaller target face size', () => {
    const coarse = tessellationSteps(board, 2.0);
    const fine = tessellationSteps(board, 0.5);
    expect(fine.lengthSteps).toBeGreaterThan(coarse.lengthSteps);
    expect(fine.ringSteps).toBeGreaterThan(coarse.ringSteps);
  });

  it('length steps scale ~linearly with board length', () => {
    const short = tessellationSteps(loadBoard('shortboard'), 1.0).lengthSteps;
    const long = tessellationSteps(loadBoard('longboard'), 1.0).lengthSteps;
    expect(long).toBeGreaterThan(short);
  });

  it('a finer target face size yields a denser mesh', () => {
    const coarse = tessellateBoard(board, { targetFaceSize: 2.0 });
    const fine = tessellateBoard(board, { targetFaceSize: 0.5 });
    expect(fine.positions.length).toBeGreaterThan(coarse.positions.length);
    expect(noNaN(fine.positions)).toBe(true);
  });

  it('explicit step counts override the target face size', () => {
    const mesh = tessellateBoard(board, { targetFaceSize: 0.5, lengthSteps: 10, ringSteps: 8 });
    // 10 stations (some end sections may drop) → vertex count near 10*8 plus caps.
    expect(mesh.positions.length / 3).toBeLessThan(10 * 8 + 10);
  });
});
