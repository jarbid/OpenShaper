// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLength } from './board';
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

/** Fraction of vertices whose normal points away from the mesh centroid. */
const outwardFraction = (mesh: ReturnType<typeof tessellateBoard>): number => {
  const n = mesh.positions.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    cx += mesh.positions[i]!;
    cy += mesh.positions[i + 1]!;
    cz += mesh.positions[i + 2]!;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let outward = 0;
  for (let v = 0; v < n; v++) {
    const rx = mesh.positions[v * 3]! - cx;
    const ry = mesh.positions[v * 3 + 1]! - cy;
    const rz = mesh.positions[v * 3 + 2]! - cz;
    const d =
      mesh.normals[v * 3]! * rx + mesh.normals[v * 3 + 1]! * ry + mesh.normals[v * 3 + 2]! * rz;
    if (d > 0) outward++;
  }
  return outward / n;
};

describe('tessellateBoard: outward orientation', () => {
  it('orients normals outward for every golden board', () => {
    for (const name of ['shortboard', 'funboard', 'longboard']) {
      const mesh = tessellateBoard(loadBoard(name));
      // The overwhelming majority of vertices should face away from the centroid.
      expect(outwardFraction(mesh)).toBeGreaterThan(0.9);
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
