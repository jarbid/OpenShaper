// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only checks of a grid mesh against its surface (docs/design/m1-model.md §6, step 2):
 * topology, the distance of triangle centres and edge midpoints from the surface, and
 * the normal-angle jump across a station.
 */
import { createEvaluator } from '../surface';
import type { BuiltBoard, SurfaceEvaluator } from '../surface';
import { meshVertex } from '../mesh';
import type { BoardMesh } from '../mesh';

export interface Topology {
  /** Directed edges whose reverse is missing, or that occur more than once. */
  readonly badEdges: number;
  readonly vertices: number;
  readonly edges: number;
  readonly triangles: number;
  /** Vertices that no triangle uses. */
  readonly unused: number;
}

/** Edge bookkeeping of an indexed triangle list: closed and consistently oriented means `badEdges === 0`. */
export function topology(indices: Uint32Array, vertexCount: number): Topology {
  const directed = new Map<number, number>();
  const key = (a: number, b: number): number => a * vertexCount + b;
  const used = new Uint8Array(vertexCount);
  for (let k = 0; k < indices.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[k + e]!;
      const b = indices[k + ((e + 1) % 3)]!;
      used[a] = 1;
      directed.set(key(a, b), (directed.get(key(a, b)) ?? 0) + 1);
    }
  }
  let bad = 0;
  let edges = 0;
  for (const [k, n] of directed) {
    const a = Math.floor(k / vertexCount);
    const b = k % vertexCount;
    if (n !== 1 || directed.get(key(b, a)) !== 1) bad++;
    if (a < b) edges++;
  }
  let unused = 0;
  for (let v = 0; v < vertexCount; v++) if (used[v] === 0) unused++;
  return {
    badEdges: bad,
    vertices: vertexCount - unused,
    edges,
    triangles: indices.length / 3,
    unused,
  };
}

/**
 * An upper bound of the distance from `p` to the surface: Levenberg-Marquardt on
 * (ξ, t) from a start guess, the best distance seen. (Any point it finds is on the
 * surface, so a bound is a proof; a poor start only loosens it.)
 */
export function surfaceDistance(
  ev: SurfaceEvaluator,
  board: BuiltBoard,
  side: 0 | 1,
  p: ArrayLike<number>,
  xi0: number,
  t0: number,
): number {
  const o = new Float64Array(18);
  let xi = xi0;
  let t = t0;
  let best = Infinity;
  for (let it = 0; it < 12; it++) {
    ev.at(side, xi, t, 1, o);
    const rx = o[0]! - p[0]!;
    const ry = o[1]! - p[1]!;
    const rz = o[2]! - p[2]!;
    best = Math.min(best, Math.hypot(rx, ry, rz));
    const aa = o[3]! * o[3]! + o[4]! * o[4]! + o[5]! * o[5]!;
    const cc = o[6]! * o[6]! + o[7]! * o[7]! + o[8]! * o[8]!;
    const ac = o[3]! * o[6]! + o[4]! * o[7]! + o[5]! * o[8]!;
    const ga = o[3]! * rx + o[4]! * ry + o[5]! * rz;
    const gc = o[6]! * rx + o[7]! * ry + o[8]! * rz;
    const damp = 1e-6;
    const A = aa * (1 + damp) + 1e-12;
    const C = cc * (1 + damp) + 1e-12;
    const det = A * C - ac * ac;
    if (!(det > 0)) break;
    xi = Math.min(Math.max(xi - (C * ga - ac * gc) / det, board.xiMin), board.xiMax);
    t = Math.min(Math.max(t - (A * gc - ac * ga) / det, 0), 1);
  }
  return best;
}

export interface Deviation {
  readonly centre: number;
  readonly edgeMid: number;
  readonly checked: number;
}

/**
 * The worst distance of triangle centres and edge midpoints (diagonals included) from the
 * surface, over every `stride`-th triangle.
 */
export function meshDeviation(board: BuiltBoard, mesh: BoardMesh, stride = 1): Deviation {
  const ev = createEvaluator(board);
  const { rows, cols } = mesh.layout;
  const pxi = new Float64Array(mesh.vertexCount);
  const pt = new Float64Array(mesh.vertexCount);
  for (const side of [0, 1] as const) {
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const v = meshVertex(mesh.layout, side, i, j);
        pxi[v] = mesh.ladders.xi[i]!;
        pt[v] = mesh.ladders.t[j]!;
      }
    }
  }
  const P = mesh.positions;
  const both: readonly (0 | 1)[] = [0, 1];
  const best = (q: number[], xi: number, t: number): number =>
    Math.min(...both.map((s) => surfaceDistance(ev, board, s, q, xi, t)));
  let centre = 0;
  let edgeMid = 0;
  let checked = 0;
  for (let k = 0; k < mesh.indices.length; k += 3 * stride) {
    const v = [mesh.indices[k]!, mesh.indices[k + 1]!, mesh.indices[k + 2]!];
    // the planar caps of a blunt end are not on the surface: skip triangles lying in an end row
    const end = (x: number): boolean => x === board.xiMin || x === board.xiMax;
    if (v.every((q) => end(pxi[q]!) && pxi[q] === pxi[v[0]!])) continue;
    const c = [0, 1, 2].map((a) => (P[3 * v[0]! + a]! + P[3 * v[1]! + a]! + P[3 * v[2]! + a]!) / 3);
    centre = Math.max(
      centre,
      best(
        c,
        (pxi[v[0]!]! + pxi[v[1]!]! + pxi[v[2]!]!) / 3,
        (pt[v[0]!]! + pt[v[1]!]! + pt[v[2]!]!) / 3,
      ),
    );
    for (let e = 0; e < 3; e++) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      const m = [0, 1, 2].map((q) => (P[3 * a + q]! + P[3 * b + q]!) / 2);
      edgeMid = Math.max(edgeMid, best(m, (pxi[a]! + pxi[b]!) / 2, (pt[a]! + pt[b]!) / 2));
    }
    checked++;
  }
  return { centre, edgeMid, checked };
}

// ---------------------------------------------------------------------------
// Normal-angle jump across a station
// ---------------------------------------------------------------------------

export type V3 = readonly [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * The largest angle (rad) between the normal from the rings just before a station and
 * the normal from the rings just after it. A ring is the plus half-section as points in
 * the same order at three x: `before` (x − δ), `at` and `after` (x + δ); the normal at
 * point k is the ring tangent there crossed with the step to the neighbouring ring. For
 * a surface that is C1 across the station the angle is O(δ); a linear loft has a
 * finite jump.
 */
export function normalJump(before: readonly V3[], at: readonly V3[], after: readonly V3[]): number {
  let worst = 0;
  for (let k = 1; k + 1 < at.length; k++) {
    const tangent = sub(at[k + 1]!, at[k - 1]!);
    const nl = cross(tangent, sub(at[k]!, before[k]!));
    const nr = cross(tangent, sub(after[k]!, at[k]!));
    const a = len(nl);
    const b = len(nr);
    if (!(a > 0 && b > 0)) continue;
    const c = (nl[0] * nr[0] + nl[1] * nr[1] + nl[2] * nr[2]) / (a * b);
    worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, c))));
  }
  return worst;
}

/** The plus half-section of the NURBS surface at ξ = x as `n + 1` points, t from 0 to 1. */
export function nurbsRing(ev: SurfaceEvaluator, x: number, n: number): V3[] {
  const o = new Float64Array(18);
  const out: V3[] = [];
  ev.row(0, x, 0);
  for (let k = 0; k <= n; k++) {
    ev.eval(k / n, 0, o);
    out.push([o[0]!, o[1]!, o[2]!]);
  }
  return out;
}

/** Hausdorff distance between two point lists taken as polylines (`closed` joins the last point to the first). */
export function polylineHausdorff(a: readonly V3[], b: readonly V3[], closedB: boolean): number {
  const segDist = (p: V3, q: V3, r: V3): number => {
    const e = sub(r, q);
    const w = sub(p, q);
    const ee = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    const f = ee > 0 ? Math.min(1, Math.max(0, (w[0] * e[0] + w[1] * e[1] + w[2] * e[2]) / ee)) : 0;
    return Math.hypot(w[0] - f * e[0], w[1] - f * e[1], w[2] - f * e[2]);
  };
  const toPoly = (p: V3, poly: readonly V3[], closed: boolean): number => {
    let d = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) d = Math.min(d, segDist(p, poly[i]!, poly[i + 1]!));
    if (closed) d = Math.min(d, segDist(p, poly[poly.length - 1]!, poly[0]!));
    return d;
  };
  let h = 0;
  for (const p of a) h = Math.max(h, toPoly(p, b, closedB));
  return h;
}
