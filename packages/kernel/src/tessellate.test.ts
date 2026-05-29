import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLength } from './board';
import { tessellateBoard } from './tessellate';
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
