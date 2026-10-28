// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Deviation from classic" on the real thing: the sample shortboard (the golden
 * shortboard) converted to NURBS and measured against its own classic board, with an
 * oracle that shares no code with `nurbs-deviation.ts`: a brute-force 3D distance from
 * each vertex to a fine classic mesh.
 *
 * These pin the two failures the synthetic tests cannot reach. A linear blend of
 * station distances read +0.72 cm at the tail of this board, where the truth is a
 * tenth of that; and a vertex facing along the board read "about zero".
 *
 * The conversion takes about 10 s (the same work the worker does).
 */
import { parseBrd } from '@openshaper/io';
import { getLength, tessellateBoard, type BezierBoard } from '@openshaper/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import { convertAndMesh } from './nurbs-core';
import { NX_NO_DATA, TIP_NO_DATA_ZONE } from './nurbs-deviation';
import type { NurbsMeshData } from './nurbs-protocol';

/**
 * The most the deviation of the converted shortboard may reach anywhere (cm). The
 * converter reports a worst rail-fit error of 0.067 cm (`summary.bandError`, S7
 * deviation 7); the first-order normal distance adds up to 0.065 cm in the last
 * centimetres, where it is measured against a 3D oracle (below). 0.15 leaves a little
 * more. The unfixed code reported up to +0.72 cm.
 */
const MAX_ABS_DEVIATION = 0.15;

/** How far the value may differ from the true 3D distance beyond the tip zone (cm). Measured worst: 0.043. */
const ORACLE_TOLERANCE = 0.1;

// --- brute-force oracle: nearest distance from a point to a triangle mesh -------------

type V = readonly [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (a: V, d: V, t: number): V => [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Distance from `p` to triangle `abc` (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(p: V, a: V, b: V, c: V): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist(p, a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(p, along(a, ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(p, along(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return dist(p, along(b, sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6)));
  }
  const den = 1 / (va + vb + vc);
  return dist(p, along(along(a, ab, vb * den), ac, vc * den));
}

/** Triangles of a mesh binned by the centimetre of x they span. */
function bucketed(positions: ArrayLike<number>, indices: ArrayLike<number>, length: number) {
  const buckets: number[][] = Array.from({ length: Math.ceil(length) + 2 }, () => []);
  const at = (i: number): V => [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!];
  for (let t = 0; t < indices.length; t += 3) {
    const xs = [0, 1, 2].map((k) => positions[3 * indices[t + k]!]!);
    const hi = Math.min(buckets.length - 1, Math.floor(Math.max(...xs)));
    for (let k = Math.max(0, Math.floor(Math.min(...xs))); k <= hi; k++) buckets[k]!.push(t);
  }
  return (p: V, radius: number): number => {
    let best = Infinity;
    const hi = Math.min(buckets.length - 1, Math.floor(p[0] + radius));
    for (let k = Math.max(0, Math.floor(p[0] - radius)); k <= hi; k++) {
      for (const t of buckets[k]!) {
        const d = pointTriangle(p, at(indices[t]!), at(indices[t + 1]!), at(indices[t + 2]!));
        if (d < best) best = d;
      }
    }
    return best;
  };
}

let board: BezierBoard;
let length: number;
let mesh: NurbsMeshData;
let distanceToClassic: (p: V, radius: number) => number;

beforeAll(() => {
  board = parseBrd(sampleBrd).board;
  length = getLength(board);
  const r = convertAndMesh(1, board, 0.9);
  if (!r.ok) throw new Error(`the sample board did not convert: ${r.error}`);
  mesh = r.mesh;
  const classic = tessellateBoard(board, { targetFaceSize: 0.3 });
  distanceToClassic = bucketed(classic.positions, classic.indices, length);
}, 120_000);

const vertex = (i: number): V => [
  mesh.positions[3 * i]!,
  mesh.positions[3 * i + 1]!,
  mesh.positions[3 * i + 2]!,
];
const endDistance = (i: number) =>
  Math.min(mesh.positions[3 * i]!, length - mesh.positions[3 * i]!);

describe('deviation of the converted sample shortboard', () => {
  it('stays within the documented bound everywhere, and the range is the data’s', () => {
    const d = mesh.deviation!;
    let worst = 0;
    let finite = 0;
    for (let i = 0; i < d.length; i++) {
      if (!Number.isFinite(d[i]!)) continue;
      finite++;
      worst = Math.max(worst, Math.abs(d[i]!));
    }
    expect(worst).toBeLessThan(MAX_ABS_DEVIATION);
    expect(worst).toBeGreaterThan(0.02); // it is a fit, not an identity: the check measures something
    expect(mesh.deviationRange![0]).toBeGreaterThan(-MAX_ABS_DEVIATION);
    expect(mesh.deviationRange![1]).toBeLessThan(MAX_ABS_DEVIATION);
    expect(mesh.deviationNoData).toBe(d.length - finite);
    expect(mesh.deviationNoData / d.length).toBeLessThan(0.1);
  });

  it('has no data exactly in the tip zones and where the surface faces along the board', () => {
    const d = mesh.deviation!;
    let tip = 0;
    for (let i = 0; i < d.length; i++) {
      const blank = !Number.isFinite(d[i]!);
      const inTip = endDistance(i) < TIP_NO_DATA_ZONE;
      const facing = Math.abs(mesh.normals[3 * i]!) > NX_NO_DATA;
      expect(blank, `vertex ${i} at x = ${mesh.positions[3 * i]!}`).toBe(inTip || facing);
      if (inTip) tip++;
    }
    expect(tip).toBeGreaterThan(100); // both tips are densely meshed
  });

  it('agrees with a brute-force 3D distance to the classic mesh up to 3 cm from either tip', () => {
    // The first 0.5 cm is no data (above). Beyond it the value is the 3D normal distance
    // to first order; measured worst 0.043 cm, tolerance 0.1.
    let checked = 0;
    let worst = 0;
    for (let i = 0; i < mesh.deviation!.length; i++) {
      const e = endDistance(i);
      const v = mesh.deviation![i]!;
      if (e >= 3 || !Number.isFinite(v)) continue;
      const truth = distanceToClassic(vertex(i), 1.5);
      worst = Math.max(worst, Math.abs(Math.abs(v) - truth));
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(ORACLE_TOLERANCE);
  });

  it('is not the +0.72 cm the interpolated stations gave near the tail', () => {
    // The unfixed code read +0.72 cm at (0.0997, 2.362, 7.153); at that x the vertex is
    // 0.09 cm inside the classic section. Whatever vertex lies nearest that spot now,
    // its deviation is small.
    let nearest = -1;
    let best = Infinity;
    for (let i = 0; i < mesh.deviation!.length; i++) {
      const dd = Math.hypot(
        mesh.positions[3 * i]! - 0.0997,
        mesh.positions[3 * i + 1]! - 2.362,
        mesh.positions[3 * i + 2]! - 7.153,
      );
      if (dd < best) [best, nearest] = [dd, i];
    }
    const v = mesh.deviation![nearest]!;
    expect(Number.isNaN(v) || Math.abs(v) < MAX_ABS_DEVIATION).toBe(true);
    // And in the tail's first 3 cm, no vertex reads more than the bound.
    for (let i = 0; i < mesh.deviation!.length; i++) {
      if (mesh.positions[3 * i]! < 3 && Number.isFinite(mesh.deviation![i]!)) {
        expect(Math.abs(mesh.deviation![i]!)).toBeLessThan(MAX_ABS_DEVIATION);
      }
    }
  });
});
