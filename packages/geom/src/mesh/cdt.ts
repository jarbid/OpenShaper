// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Constrained Delaunay triangulation in the plane (design §6.17, §12,
 * decision 26), implemented in-house on the vendored exact predicates.
 *
 * - **Layout** as Delaunator: triangle `t` has the half-edges `3t, 3t + 1,
 *   3t + 2`; half-edge `e` runs from `tri[e]` to `tri[next(e)]` with its
 *   triangle on the left (counter-clockwise, y up); `adj[e]` is the twin.
 * - **Ghost triangles.** The hull is closed by triangles on an infinite vertex
 *   ({@link GHOST}) instead of a super-triangle, so the predicates only ever see
 *   input coordinates. A ghost `(x, y, G)` lies across the hull edge `y → x`;
 *   the outside is on the left of `x → y`.
 * - **Points** are inserted in Hilbert order (deterministic) by Bowyer–Watson
 *   (the cavity of triangles whose circumcircle strictly contains the point,
 *   retriangulated as a fan); point location is a visibility walk whose first
 *   edge is chosen by a fixed-seed generator (a stochastic walk: terminates),
 *   with an exhaustive scan as the guard.
 * - **Segments** are recovered by Sloan's flips (Sloan 1993, "A fast algorithm
 *   for generating constrained Delaunay triangulations"), then the new edges
 *   are made Delaunay again by Lawson flips that never flip a constraint. A
 *   vertex exactly on a segment (`orient2d = 0` and between its ends) splits it;
 *   two segments that cross are reported (`cdt-segments-intersect`).
 * - **Regions.** Each segment keeps its direction. A flood fill from the ghost
 *   triangles (winding 0) gives every triangle its winding number: crossing a
 *   segment from its left to its right subtracts one. With loops oriented as
 *   trim loops (outer counter-clockwise, holes clockwise) the material has
 *   winding 1 and everything else 0; any other winding reveals an inconsistently
 *   oriented loop (`trim-orientation`).
 * - **Steiner points** (tessellation refinement) are inserted by splitting the
 *   containing triangle (or edge) and Lawson flips that never cross a
 *   constraint, so the result stays constrained Delaunay.
 *
 * Every decision is an exact predicate: there is no tolerance in this module.
 */
import { fail } from '../errors';
import { errResult, okResult } from '../errors';
import type {
  GeomIssue,
  ReadonlyF64,
  ReadonlyI32,
  ReadonlyU32,
  ReadonlyU8,
  Result,
} from '../types';
import type { Tolerances } from '../tolerance';
import { resolveTolerances } from '../tolerance';
import { makePredicates } from './predicates';
import type { Predicates } from './predicates';

/** The infinite vertex of the ghost triangles. */
export const GHOST = -1;

/** Input of {@link constrainedDelaunay}: points `[x0, y0, x1, y1, …]` and segments as index pairs. */
export interface CdtInput {
  readonly points: ArrayLike<number>;
  readonly segments: ArrayLike<number>;
}

/** A triangulation in Delaunator's layout. */
export interface Triangulation {
  /** `[x, y]` per vertex: the input points (duplicates merged away are kept but unused). */
  readonly points: ReadonlyF64;
  /** Three vertex indices per triangle, counter-clockwise (y up). */
  readonly triangles: ReadonlyU32;
  /** Twin half-edge, `−1` on the boundary of the triangulated region. */
  readonly halfedges: ReadonlyI32;
  /** Per half-edge: 1 if it lies on a segment. */
  readonly constrained: ReadonlyU8;
}

export const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);
export const prev = (e: number): number => (e % 3 === 0 ? e + 2 : e - 1);

/** The mutable triangulation (internal; shared with the tessellator). */
export interface CdtState {
  x: Float64Array;
  y: Float64Array;
  nv: number;
  /** An outgoing half-edge per vertex, in a live triangle. */
  vtx: Int32Array;
  tri: Int32Array;
  adj: Int32Array;
  /** Per half-edge: segment present. */
  cons: Uint8Array;
  /** Per half-edge: net direction of the segments on it (+1 along the half-edge). */
  seg: Int8Array;
  /** Per triangle: winding number (after {@link classifyRegions}). */
  region: Int32Array;
  alive: Uint8Array;
  /** Triangles allocated (live or free). */
  nt: number;
  free: number[];
  /** Per-triangle marks for searches. */
  mark: Uint32Array;
  gen: number;
  /** Per triangle: a stamp renewed whenever the triangle is (re)written (refinement bookkeeping). */
  ver: Uint32Array;
  clock: number;
  last: number;
  rng: () => number;
  readonly pred: Predicates;
}

/**
 * Mulberry32 with a fixed seed: the walk's first-edge choice (decision 14:
 * determinism; no module state, each triangulation owns its generator).
 */
function walkRng(): () => number {
  let a = 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newState(capV: number): CdtState {
  const capT = 2 * capV + 8;
  return {
    x: new Float64Array(capV),
    y: new Float64Array(capV),
    nv: 0,
    vtx: new Int32Array(capV).fill(-1),
    tri: new Int32Array(3 * capT),
    adj: new Int32Array(3 * capT).fill(-1),
    cons: new Uint8Array(3 * capT),
    seg: new Int8Array(3 * capT),
    region: new Int32Array(capT),
    alive: new Uint8Array(capT),
    nt: 0,
    free: [],
    mark: new Uint32Array(capT),
    gen: 0,
    ver: new Uint32Array(capT),
    clock: 0,
    last: 0,
    rng: walkRng(),
    pred: makePredicates(),
  };
}

function growV(st: CdtState, n: number): void {
  if (n <= st.x.length) return;
  const cap = Math.max(n, 2 * st.x.length);
  const x = new Float64Array(cap);
  x.set(st.x);
  const y = new Float64Array(cap);
  y.set(st.y);
  const vtx = new Int32Array(cap).fill(-1);
  vtx.set(st.vtx);
  st.x = x;
  st.y = y;
  st.vtx = vtx;
}

function growT(st: CdtState, n: number): void {
  if (n <= st.alive.length) return;
  const cap = Math.max(n, 2 * st.alive.length);
  const tri = new Int32Array(3 * cap);
  tri.set(st.tri);
  const adj = new Int32Array(3 * cap).fill(-1);
  adj.set(st.adj);
  const cons = new Uint8Array(3 * cap);
  cons.set(st.cons);
  const seg = new Int8Array(3 * cap);
  seg.set(st.seg);
  const region = new Int32Array(cap);
  region.set(st.region);
  const alive = new Uint8Array(cap);
  alive.set(st.alive);
  const mark = new Uint32Array(cap);
  mark.set(st.mark);
  const ver = new Uint32Array(cap);
  ver.set(st.ver);
  Object.assign(st, { tri, adj, cons, seg, region, alive, mark, ver });
}

export function addVertex(st: CdtState, x: number, y: number): number {
  growV(st, st.nv + 1);
  st.x[st.nv] = x;
  st.y[st.nv] = y;
  return st.nv++;
}

function allocTri(st: CdtState): number {
  const t = st.free.length > 0 ? st.free.pop()! : st.nt++;
  growT(st, t + 1);
  st.alive[t] = 1;
  return t;
}

function killTri(st: CdtState, t: number): void {
  st.alive[t] = 0;
  st.free.push(t);
}

/** Writes triangle `t = (a, b, c)` and points each real vertex at its outgoing half-edge. */
function setTri(st: CdtState, t: number, a: number, b: number, c: number): void {
  const e = 3 * t;
  st.tri[e] = a;
  st.tri[e + 1] = b;
  st.tri[e + 2] = c;
  if (a !== GHOST) st.vtx[a] = e;
  if (b !== GHOST) st.vtx[b] = e + 1;
  if (c !== GHOST) st.vtx[c] = e + 2;
  st.clock = (st.clock + 1) >>> 0 || 1;
  st.ver[t] = st.clock;
}

/** Makes `e` and `f` twins, with `e`'s segment data (and `f`'s mirrored). */
function link(st: CdtState, e: number, f: number, cons: number, seg: number): void {
  st.adj[e] = f;
  st.adj[f] = e;
  st.cons[e] = cons;
  st.cons[f] = cons;
  st.seg[e] = seg;
  st.seg[f] = -seg;
}

export const isGhost = (st: CdtState, t: number): boolean =>
  st.tri[3 * t]! < 0 || st.tri[3 * t + 1]! < 0 || st.tri[3 * t + 2]! < 0;

function nextGen(st: CdtState): number {
  st.gen = (st.gen + 1) >>> 0;
  if (st.gen === 0) {
    st.mark.fill(0);
    st.gen = 1;
  }
  return st.gen;
}

/** orient2d of three real vertices. */
function orientV(st: CdtState, a: number, b: number, c: number): number {
  return st.pred.orient2d(st.x[a]!, st.y[a]!, st.x[b]!, st.y[b]!, st.x[c]!, st.y[c]!);
}

/** Whether `(px, py)`, collinear with a and b, lies strictly between them. */
function strictlyBetween(st: CdtState, a: number, b: number, px: number, py: number): boolean {
  const ax = st.x[a]!;
  const ay = st.y[a]!;
  const bx = st.x[b]!;
  const by = st.y[b]!;
  if (ax !== bx) return ax < bx ? px > ax && px < bx : px < ax && px > bx;
  return ay < by ? py > ay && py < by : py < ay && py > by;
}

/** The first triangle: three non-collinear vertices, counter-clockwise, plus its three ghosts. */
export function initTriangle(st: CdtState, a: number, b: number, c: number): void {
  if (orientV(st, a, b, c) < 0) [b, c] = [c, b];
  const t = allocTri(st);
  setTri(st, t, a, b, c);
  const g = [allocTri(st), allocTri(st), allocTri(st)];
  const vs = [a, b, c];
  for (let k = 0; k < 3; k++) {
    const u = vs[k]!;
    const w = vs[(k + 1) % 3]!;
    // Ghost across u → w: (w, u, G).
    setTri(st, g[k]!, w, u, GHOST);
    link(st, 3 * t + k, 3 * g[k]!, 0, 0);
  }
  for (let k = 0; k < 3; k++) {
    // Ghost k = (w, u, G) has u → G at +1 and G → w at +2; ghost k+1 = (w', w, G) has w → G at +1.
    const gk = g[k]!;
    const gn = g[(k + 1) % 3]!;
    link(st, 3 * gk + 2, 3 * gn + 1, 0, 0);
  }
  st.last = t;
}

/** Point location result. */
interface Location {
  t: number;
  /** A half-edge of `t` the point lies on (inside its segment), or −1. */
  edge: number;
  /** A vertex the point coincides with, or −1. */
  vertex: number;
}

/** Whether the ghost `t` is in conflict with `p`: strictly outside its hull edge, or inside that edge. */
function ghostConflict(st: CdtState, t: number, px: number, py: number): boolean {
  const e = 3 * t;
  let k = 0;
  while (st.tri[e + k] !== GHOST) k++;
  const xv = st.tri[e + ((k + 1) % 3)]!;
  const yv = st.tri[e + ((k + 2) % 3)]!;
  const o = st.pred.orient2d(st.x[xv]!, st.y[xv]!, st.x[yv]!, st.y[yv]!, px, py);
  if (o > 0) return true;
  return o === 0 && strictlyBetween(st, xv, yv, px, py);
}

function inCircumcircle(st: CdtState, t: number, px: number, py: number): boolean {
  const e = 3 * t;
  const a = st.tri[e]!;
  const b = st.tri[e + 1]!;
  const c = st.tri[e + 2]!;
  return st.pred.incircle(st.x[a]!, st.y[a]!, st.x[b]!, st.y[b]!, st.x[c]!, st.y[c]!, px, py) > 0;
}

/** Classifies `p` against the real triangle `t`; returns the location if inside or on it, else null. */
function inTriangle(st: CdtState, t: number, px: number, py: number): Location | null {
  let zeros = 0;
  let zEdge = -1;
  let z2 = -1;
  for (let k = 0; k < 3; k++) {
    const e = 3 * t + k;
    const a = st.tri[e]!;
    const b = st.tri[next(e)]!;
    const o = st.pred.orient2d(st.x[a]!, st.y[a]!, st.x[b]!, st.y[b]!, px, py);
    if (o < 0) return null;
    if (o === 0) {
      if (zeros === 0) zEdge = e;
      else z2 = e;
      zeros++;
    }
  }
  if (zeros >= 2) {
    // On two edges: the vertex they share.
    const v = next(zEdge) === z2 ? st.tri[z2]! : st.tri[zEdge]!;
    return { t, edge: -1, vertex: v };
  }
  return { t, edge: zeros === 1 ? zEdge : -1, vertex: -1 };
}

/**
 * Locates `p`: a real triangle containing it (closed), or a ghost in conflict
 * with it (outside the hull). Stochastic visibility walk from `st.last`, then
 * an exhaustive scan if the walk exceeds its step guard.
 */
export function locate(st: CdtState, px: number, py: number): Location {
  let t = st.last;
  if (!st.alive[t]) {
    t = 0;
    while (!st.alive[t]) t++;
  }
  if (isGhost(st, t)) {
    const e = 3 * t;
    let k = 0;
    while (st.tri[e + k] === GHOST || st.tri[e + ((k + 1) % 3)] === GHOST) k++;
    t = (st.adj[e + k]! / 3) | 0;
  }
  const guard = 4 * st.nt + 16;
  for (let steps = 0; steps < guard; steps++) {
    if (isGhost(st, t)) return { t, edge: -1, vertex: -1 };
    const r = Math.floor(st.rng() * 3);
    let moved = false;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + ((r + k) % 3);
      const a = st.tri[e]!;
      const b = st.tri[next(e)]!;
      if (st.pred.orient2d(st.x[a]!, st.y[a]!, st.x[b]!, st.y[b]!, px, py) < 0) {
        t = (st.adj[e]! / 3) | 0;
        moved = true;
        break;
      }
    }
    if (!moved) return inTriangle(st, t, px, py)!;
  }
  // Guard reached (a cycle is possible only in a non-Delaunay triangulation): scan.
  for (let s = 0; s < st.nt; s++) {
    if (!st.alive[s] || isGhost(st, s)) continue;
    const loc = inTriangle(st, s, px, py);
    if (loc !== null) return loc;
  }
  for (let s = 0; s < st.nt; s++) {
    if (st.alive[s] && isGhost(st, s) && ghostConflict(st, s, px, py)) {
      return { t: s, edge: -1, vertex: -1 };
    }
  }
  return fail('cdt-failure', `point (${px}, ${py}) could not be located`);
}

/**
 * Bowyer–Watson insertion of the new vertex `v` (unconstrained triangulation:
 * no segments yet), starting from the located triangle.
 */
export function insertBowyerWatson(st: CdtState, v: number, loc: Location): void {
  const px = st.x[v]!;
  const py = st.y[v]!;
  const IN = nextGen(st);
  const OUT = nextGen(st);
  const stack = [loc.t];
  st.mark[loc.t] = IN;
  const cavity: number[] = [];
  const boundary: number[] = [];
  while (stack.length > 0) {
    const t = stack.pop()!;
    cavity.push(t);
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      const n = (st.adj[e]! / 3) | 0;
      const m = st.mark[n];
      if (m === IN) continue;
      if (m !== OUT) {
        const hit = isGhost(st, n) ? ghostConflict(st, n, px, py) : inCircumcircle(st, n, px, py);
        if (hit) {
          st.mark[n] = IN;
          stack.push(n);
          continue;
        }
        st.mark[n] = OUT;
      }
      boundary.push(e);
    }
  }
  // Fan of new triangles (a, b, v) on the boundary edges a → b.
  const nb = boundary.length;
  const outer = new Int32Array(nb);
  const from = new Int32Array(nb);
  const to = new Int32Array(nb);
  const cons = new Uint8Array(nb);
  const seg = new Int8Array(nb);
  for (let i = 0; i < nb; i++) {
    const e = boundary[i]!;
    outer[i] = st.adj[e]!;
    from[i] = st.tri[e]!;
    to[i] = st.tri[next(e)]!;
    cons[i] = st.cons[e]!;
    seg[i] = st.seg[e]!;
  }
  for (const t of cavity) killTri(st, t);
  const ids = new Int32Array(nb);
  // Triangle whose boundary edge starts at a vertex (GHOST keyed separately).
  const startAt = new Map<number, number>();
  for (let i = 0; i < nb; i++) {
    const t = allocTri(st);
    ids[i] = t;
    setTri(st, t, from[i]!, to[i]!, v);
    link(st, 3 * t, outer[i]!, cons[i]!, seg[i]!);
    st.region[t] = st.region[(outer[i]! / 3) | 0]!;
    startAt.set(from[i]!, t);
  }
  for (let i = 0; i < nb; i++) {
    const t = ids[i]!;
    // b → v twins v → b of the triangle starting at b.
    const tb = startAt.get(to[i]!)!;
    link(st, 3 * t + 1, 3 * tb + 2, 0, 0);
  }
  st.last = ids[0]!;
}

/**
 * Flips the edge of half-edge `e`, shared by real triangles `(a, b, c)` and
 * `(b, a, d)`, to `c–d`. Returns the half-edge `d → c` of the new diagonal.
 * Segment data of the four outer edges is kept; the diagonal is unconstrained.
 */
export function flip(st: CdtState, e: number): number {
  const f = st.adj[e]!;
  const t0 = (e / 3) | 0;
  const t1 = (f / 3) | 0;
  const e1 = next(e);
  const e2 = prev(e);
  const f1 = next(f);
  const f2 = prev(f);
  const a = st.tri[e]!;
  const b = st.tri[e1]!;
  const c = st.tri[e2]!;
  const d = st.tri[f2]!;
  // Outer half-edges and their segment data: c→a (e2), a→d (f1), d→b (f2), b→c (e1).
  const o = [st.adj[e2]!, st.adj[f1]!, st.adj[f2]!, st.adj[e1]!];
  const oc = [st.cons[e2]!, st.cons[f1]!, st.cons[f2]!, st.cons[e1]!];
  const os = [st.seg[e2]!, st.seg[f1]!, st.seg[f2]!, st.seg[e1]!];
  setTri(st, t0, c, a, d);
  setTri(st, t1, d, b, c);
  link(st, 3 * t0, o[0]!, oc[0]!, os[0]!);
  link(st, 3 * t0 + 1, o[1]!, oc[1]!, os[1]!);
  link(st, 3 * t1, o[2]!, oc[2]!, os[2]!);
  link(st, 3 * t1 + 1, o[3]!, oc[3]!, os[3]!);
  link(st, 3 * t0 + 2, 3 * t1 + 2, 0, 0);
  st.last = t0;
  return 3 * t0 + 2;
}

/** The half-edge `u → w`, or −1. Rotates round `u`. */
export function findEdge(st: CdtState, u: number, w: number): number {
  const start = st.vtx[u]!;
  if (start < 0) return -1;
  let h = start;
  do {
    if (st.tri[next(h)] === w) return h;
    h = st.adj[prev(h)]!;
  } while (h !== start && h >= 0);
  return -1;
}

/** Whether the quadrilateral of edge `e` is strictly convex (the flip is valid). */
function flippable(st: CdtState, e: number): boolean {
  const f = st.adj[e]!;
  if (isGhost(st, (e / 3) | 0) || isGhost(st, (f / 3) | 0)) return false;
  const a = st.tri[e]!;
  const b = st.tri[next(e)]!;
  const c = st.tri[prev(e)]!;
  const d = st.tri[prev(f)]!;
  return orientV(st, c, d, b) > 0 && orientV(st, d, c, a) > 0;
}

/** Lawson: flips `e` if it is unconstrained, between real triangles, and not locally Delaunay. */
function illegal(st: CdtState, e: number): boolean {
  if (st.cons[e]) return false;
  const f = st.adj[e]!;
  if (f < 0) return false;
  const t0 = (e / 3) | 0;
  const t1 = (f / 3) | 0;
  if (isGhost(st, t0) || isGhost(st, t1)) return false;
  const d = st.tri[prev(f)]!;
  return inCircumcircle(st, t0, st.x[d]!, st.y[d]!);
}

/** Restores the constrained Delaunay property over the queued edges (vertex pairs). */
function legalizePairs(st: CdtState, pairs: number[]): void {
  for (let guard = 0; pairs.length > 0; guard++) {
    if (guard > 64 * (st.nt + 16)) fail('cdt-failure', 'Lawson flips did not terminate');
    const w = pairs.pop()!;
    const u = pairs.pop()!;
    if (u === GHOST || w === GHOST) continue;
    const e = findEdge(st, u, w);
    if (e < 0 || !illegal(st, e)) continue;
    const g = flip(st, e); // d → c
    const t0 = (g / 3) | 0;
    const t1 = (st.adj[g]! / 3) | 0;
    // The four outer edges of the flipped pair.
    for (const h of [3 * t0, 3 * t0 + 1, 3 * t1, 3 * t1 + 1]) {
      pairs.push(st.tri[h]!, st.tri[next(h)]!);
    }
  }
}

/** Marks the edge `u → w` (which exists) as a segment running `u → w`. */
function constrain(st: CdtState, e: number): void {
  const f = st.adj[e]!;
  st.cons[e] = 1;
  st.cons[f] = 1;
  st.seg[e] = st.seg[e]! + 1;
  st.seg[f] = -st.seg[e]!;
}

/** Outcome of recovering one segment. */
type SegmentOutcome = { ok: true } | { ok: false; at: number; with: [number, number] };

/**
 * Recovers the segment `a → b` (both vertices): splits it at vertices exactly
 * on it, then for each piece collects the crossed edges, flips them away
 * (Sloan) and makes the new edges Delaunay again. Fails when it crosses a
 * segment.
 */
export function insertSegment(st: CdtState, a0: number, b: number): SegmentOutcome {
  let a = a0;
  for (let guard = 0; a !== b; guard++) {
    if (guard > st.nv + 1) fail('cdt-failure', 'segment recovery did not progress');
    const direct = findEdge(st, a, b);
    if (direct >= 0) {
      constrain(st, direct);
      return { ok: true };
    }
    // The triangle of a's star that the ray a → b enters, or a vertex on the ray.
    const start = st.vtx[a]!;
    let h = start;
    let cross = -1;
    let onRay = -1;
    do {
      const t = (h / 3) | 0;
      if (!isGhost(st, t)) {
        const xv = st.tri[next(h)]!;
        const yv = st.tri[prev(h)]!;
        const ox = orientV(st, a, b, xv);
        const oy = orientV(st, a, b, yv);
        if (ox === 0 && onSide(st, a, b, xv)) {
          onRay = xv;
          break;
        }
        if (oy === 0 && onSide(st, a, b, yv)) {
          onRay = yv;
          break;
        }
        if (ox < 0 && oy > 0) {
          cross = next(h); // x → y, right to left of a → b
          break;
        }
      }
      h = st.adj[prev(h)]!;
    } while (h !== start);
    if (onRay >= 0) {
      constrain(st, findEdge(st, a, onRay));
      a = onRay;
      continue;
    }
    if (cross < 0) fail('cdt-failure', `segment ${a} → ${b} leaves the triangulation`);
    // Walk the crossed edges until b or a vertex on the segment.
    const crossed: number[] = [];
    let c = cross;
    let end = -1;
    for (;;) {
      if (st.cons[c]) {
        return { ok: false, at: a, with: [st.tri[c]!, st.tri[next(c)]!] };
      }
      const xv = st.tri[c]!;
      const yv = st.tri[next(c)]!;
      crossed.push(xv, yv);
      const tw = st.adj[c]!;
      const z = st.tri[prev(tw)]!;
      if (z === b) {
        end = b;
        break;
      }
      const oz = orientV(st, a, b, z);
      if (oz === 0) {
        end = z;
        break;
      }
      // Twin triangle (y, x, z): edges y→x (tw), x→z (next), z→y (prev).
      // x → z (z left of a → b) or z → y (z right): right to left again.
      c = oz > 0 ? next(tw) : prev(tw);
    }
    // Sloan: flip crossed edges away from a → end.
    const queue = crossed;
    const fresh: number[] = [];
    let stall = 0;
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi]!;
      const w = queue[qi + 1]!;
      qi += 2;
      const e = findEdge(st, u, w);
      if (e < 0) fail('cdt-failure', `crossed edge ${u}–${w} vanished`);
      if (!flippable(st, e)) {
        queue.push(u, w);
        if (++stall > queue.length)
          fail('cdt-failure', `segment ${a} → ${end} cannot be recovered`);
        continue;
      }
      stall = 0;
      const g = flip(st, e); // d → c
      const cv = st.tri[next(g)]!;
      const dv = st.tri[g]!;
      const s1 = orientV(st, a, end, cv);
      const s2 = orientV(st, a, end, dv);
      if ((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) queue.push(dv, cv);
      else fresh.push(dv, cv);
    }
    const se = findEdge(st, a, end);
    if (se < 0) fail('cdt-failure', `segment ${a} → ${end} missing after recovery`);
    constrain(st, se);
    legalizePairs(st, fresh);
    a = end;
  }
  return { ok: true };
}

/** Whether `v` (collinear with a → b) lies on the ray from a towards b (it is then between them). */
function onSide(st: CdtState, a: number, b: number, v: number): boolean {
  const dx = st.x[b]! - st.x[a]!;
  const dy = st.y[b]! - st.y[a]!;
  return (st.x[v]! - st.x[a]!) * dx + (st.y[v]! - st.y[a]!) * dy > 0;
}

/**
 * Winding number of every live triangle by flood fill from the ghosts
 * (winding 0). Returns the windings found (to detect loops oriented
 * inconsistently) and whether the fill was consistent.
 */
export function classifyRegions(st: CdtState): { consistent: boolean; windings: Set<number> } {
  const seen = nextGen(st);
  const stack: number[] = [];
  for (let t = 0; t < st.nt; t++) {
    if (st.alive[t] && isGhost(st, t)) {
      st.region[t] = 0;
      st.mark[t] = seen;
      stack.push(t);
    }
  }
  let consistent = true;
  const windings = new Set<number>([0]);
  while (stack.length > 0) {
    const t = stack.pop()!;
    const w = st.region[t]!;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      const n = (st.adj[e]! / 3) | 0;
      const wn = w - st.seg[e]!;
      if (st.mark[n] === seen) {
        if (st.region[n] !== wn) consistent = false;
        continue;
      }
      st.mark[n] = seen;
      st.region[n] = wn;
      windings.add(wn);
      stack.push(n);
    }
  }
  return { consistent, windings };
}

/**
 * Inserts a Steiner point inside the region of winding `region`: splits the
 * containing triangle (or unconstrained edge) and restores the constrained
 * Delaunay property by Lawson flips. Returns the new vertex, or −1 when the
 * point coincides with a vertex, lies on a segment or outside that region.
 */
export function insertSteiner(st: CdtState, px: number, py: number, region: number): number {
  const loc = locate(st, px, py);
  if (loc.vertex >= 0 || isGhost(st, loc.t) || st.region[loc.t] !== region) return -1;
  if (loc.edge >= 0) {
    if (st.cons[loc.edge]) return -1;
    const n = (st.adj[loc.edge]! / 3) | 0;
    if (isGhost(st, n) || st.region[n] !== region) return -1;
  }
  const v = addVertex(st, px, py);
  const pairs: number[] = [];
  if (loc.edge < 0) {
    const t = loc.t;
    const e = 3 * t;
    const a = st.tri[e]!;
    const b = st.tri[e + 1]!;
    const c = st.tri[e + 2]!;
    const out = [st.adj[e]!, st.adj[e + 1]!, st.adj[e + 2]!];
    const oc = [st.cons[e]!, st.cons[e + 1]!, st.cons[e + 2]!];
    const os = [st.seg[e]!, st.seg[e + 1]!, st.seg[e + 2]!];
    const t1 = allocTri(st);
    const t2 = allocTri(st);
    setTri(st, t, a, b, v);
    setTri(st, t1, b, c, v);
    setTri(st, t2, c, a, v);
    st.region[t1] = region;
    st.region[t2] = region;
    link(st, 3 * t, out[0]!, oc[0]!, os[0]!);
    link(st, 3 * t1, out[1]!, oc[1]!, os[1]!);
    link(st, 3 * t2, out[2]!, oc[2]!, os[2]!);
    link(st, 3 * t + 1, 3 * t1 + 2, 0, 0);
    link(st, 3 * t1 + 1, 3 * t2 + 2, 0, 0);
    link(st, 3 * t2 + 1, 3 * t + 2, 0, 0);
    pairs.push(a, b, b, c, c, a);
    st.last = t;
  } else {
    const e = loc.edge;
    const f = st.adj[e]!;
    const t0 = (e / 3) | 0;
    const t1 = (f / 3) | 0;
    const a = st.tri[e]!;
    const b = st.tri[next(e)]!;
    const c = st.tri[prev(e)]!;
    const d = st.tri[prev(f)]!;
    // Outer: b→c (next e), c→a (prev e), a→d (next f), d→b (prev f).
    const hs = [next(e), prev(e), next(f), prev(f)];
    const out = hs.map((h) => st.adj[h]!);
    const oc = hs.map((h) => st.cons[h]!);
    const os = hs.map((h) => st.seg[h]!);
    const t2 = allocTri(st);
    const t3 = allocTri(st);
    setTri(st, t0, b, c, v);
    setTri(st, t1, c, a, v);
    setTri(st, t2, a, d, v);
    setTri(st, t3, d, b, v);
    for (const t of [t2, t3]) st.region[t] = region;
    const ts = [t0, t1, t2, t3];
    for (let i = 0; i < 4; i++) link(st, 3 * ts[i]!, out[i]!, oc[i]!, os[i]!);
    for (let i = 0; i < 4; i++) link(st, 3 * ts[i]! + 1, 3 * ts[(i + 1) % 4]! + 2, 0, 0);
    pairs.push(b, c, c, a, a, d, d, b);
    st.last = t0;
  }
  legalizePairs(st, pairs);
  return v;
}

/**
 * Exports the live real triangles passing `keep` as a {@link Triangulation}
 * over the first `nv` vertices; half-edges whose twin is not kept are −1.
 */
export function exportTriangulation(st: CdtState, keep: (t: number) => boolean): Triangulation {
  const newId = new Int32Array(st.nt).fill(-1);
  let n = 0;
  for (let t = 0; t < st.nt; t++) {
    if (st.alive[t] && !isGhost(st, t) && keep(t)) newId[t] = n++;
  }
  const triangles = new Uint32Array(3 * n);
  const halfedges = new Int32Array(3 * n).fill(-1);
  const constrained = new Uint8Array(3 * n);
  for (let t = 0; t < st.nt; t++) {
    const id = newId[t]!;
    if (id < 0) continue;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      triangles[3 * id + k] = st.tri[e]!;
      constrained[3 * id + k] = st.cons[e]!;
      const f = st.adj[e]!;
      const nid = newId[(f / 3) | 0]!;
      if (nid >= 0) halfedges[3 * id + k] = 3 * nid + (f % 3);
    }
  }
  const points = new Float64Array(2 * st.nv);
  for (let i = 0; i < st.nv; i++) {
    points[2 * i] = st.x[i]!;
    points[2 * i + 1] = st.y[i]!;
  }
  return Object.freeze({ points, triangles, halfedges, constrained });
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** Hilbert-curve order on a 2¹⁶ grid over the bounding box (deterministic insertion order). */
const HILBERT_ORDER = 16;

function hilbertKey(x: number, y: number): number {
  const n = 1 << HILBERT_ORDER;
  let rx: number;
  let ry: number;
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** Indices of `ids` sorted along a Hilbert curve over their bounding box. */
export function hilbertSort(xs: ArrayLike<number>, ys: ArrayLike<number>, ids: number[]): number[] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of ids) {
    x0 = Math.min(x0, xs[i]!);
    x1 = Math.max(x1, xs[i]!);
    y0 = Math.min(y0, ys[i]!);
    y1 = Math.max(y1, ys[i]!);
  }
  const m = (1 << HILBERT_ORDER) - 1;
  const sx = x1 > x0 ? m / (x1 - x0) : 0;
  const sy = y1 > y0 ? m / (y1 - y0) : 0;
  const key = new Map<number, number>();
  for (const i of ids) {
    key.set(i, hilbertKey(Math.round((xs[i]! - x0) * sx), Math.round((ys[i]! - y0) * sy)));
  }
  return ids.slice().sort((i, j) => key.get(i)! - key.get(j)! || i - j);
}

/**
 * The Delaunay triangulation (with ghosts) of the vertices `ids` already added
 * to `st`, inserted in Hilbert order. Returns false when they are all collinear
 * (or fewer than three distinct).
 */
export function triangulateVertices(st: CdtState, ids: number[]): boolean {
  const order = hilbertSort(st.x, st.y, ids);
  if (order.length < 3) return false;
  const a = order[0]!;
  const b = order[1]!;
  let c = -1;
  for (let i = 2; i < order.length; i++) {
    if (orientV(st, a, b, order[i]!) !== 0) {
      c = order[i]!;
      break;
    }
  }
  if (c < 0) return false;
  initTriangle(st, a, b, c);
  for (const v of order) {
    if (v === a || v === b || v === c) continue;
    const loc = locate(st, st.x[v]!, st.y[v]!);
    if (loc.vertex >= 0) fail('cdt-failure', `vertex ${v} duplicates vertex ${loc.vertex}`);
    insertBowyerWatson(st, v, loc);
  }
  return true;
}

function issue(code: GeomIssue['code'], message: string, index?: number): GeomIssue {
  return {
    code,
    severity: 'error',
    message,
    ...(index !== undefined ? { at: { index } } : {}),
  };
}

/** Validates the input (contract violations throw) and returns the point count. */
function checkInput(input: CdtInput): number {
  const pts = input.points;
  const segs = input.segments;
  if (pts.length % 2 !== 0) fail('size-mismatch', `points need pairs; got ${pts.length} values`);
  if (segs.length % 2 !== 0) {
    fail('size-mismatch', `segments need index pairs; got ${segs.length} values`);
  }
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i++) {
    if (!Number.isFinite(pts[i]!)) {
      fail('non-finite', `point coordinate ${i} is not finite: ${pts[i]}`, { index: i >> 1 });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!Number.isInteger(s) || s < 0 || s >= n) {
      fail('size-mismatch', `segment ${i >> 1} has vertex ${s} outside [0, ${n})`, {
        index: i >> 1,
      });
    }
  }
  for (let i = 0; i < segs.length; i += 2) {
    if (segs[i] === segs[i + 1]) {
      fail('size-mismatch', `segment ${i >> 1} starts and ends at vertex ${segs[i]}`, {
        index: i >> 1,
      });
    }
  }
  return n;
}

/** Built triangulation state with the duplicate map (internal; the tessellator continues from it). */
export interface BuiltCdt {
  readonly st: CdtState;
  /** Representative of every input point (itself unless merged). */
  readonly rep: Int32Array;
  readonly issues: readonly GeomIssue[];
}

/**
 * Builds the constrained Delaunay triangulation state of `input`, regions
 * classified. Contract violations throw; data-dependent failures are issues.
 */
export function buildCdt(input: CdtInput, duplicates: 'error' | 'merge'): Result<BuiltCdt> {
  const n = checkInput(input);
  const pts = input.points;
  const st = newState(n + 8);
  for (let i = 0; i < n; i++) addVertex(st, pts[2 * i]!, pts[2 * i + 1]!);
  // Exact duplicates, by lexicographic sort.
  const byXY = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => st.x[i]! - st.x[j]! || st.y[i]! - st.y[j]! || i - j,
  );
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) rep[i] = i;
  const unique: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = byXY[k]!;
    const prevI = k > 0 ? byXY[k - 1]! : -1;
    if (prevI >= 0 && st.x[i] === st.x[prevI] && st.y[i] === st.y[prevI]) {
      if (duplicates === 'error') {
        return errResult([
          issue(
            'cdt-duplicate-point',
            `point ${i} duplicates point ${rep[prevI]} at (${st.x[i]}, ${st.y[i]})`,
            i,
          ),
        ]);
      }
      rep[i] = rep[prevI]!;
    } else unique.push(i);
  }
  if (!triangulateVertices(st, unique)) {
    return errResult([
      issue(
        'cdt-failure',
        'fewer than three distinct non-collinear points: nothing to triangulate',
      ),
    ]);
  }
  const segs = input.segments;
  for (let s = 0; s < segs.length; s += 2) {
    const a = rep[segs[s]!]!;
    const b = rep[segs[s + 1]!]!;
    if (a === b) continue;
    const r = insertSegment(st, a, b);
    if (!r.ok) {
      return errResult([
        issue(
          'cdt-segments-intersect',
          `segment ${s >> 1} (${segs[s]} → ${segs[s + 1]}) crosses the segment ${r.with[0]}–${r.with[1]}`,
          s >> 1,
        ),
      ]);
    }
  }
  return okResult({ st, rep, issues: [] });
}

/**
 * The constrained Delaunay triangulation of `input.points` with every segment
 * present as a chain of edges (split at points lying exactly on it).
 *
 * - `duplicates`: exactly equal points are an error (default) or merged into
 *   the first (`'merge'`; segments are remapped, a collapsed one is dropped).
 * - `removeExterior`: keep only the triangles of winding number 1 (segments
 *   oriented as trim loops: material on the left). Any other winding than 0 or
 *   1 is a `trim-orientation` error.
 *
 * Contract violations (non-finite coordinates, bad indices, a segment from a
 * point to itself) throw; crossing segments (`cdt-segments-intersect`), a
 * duplicate point with `duplicates: 'error'` and degenerate input
 * (`cdt-failure`) are results. `tol` is accepted for signature uniformity:
 * every decision here is an exact predicate.
 */
export function constrainedDelaunay(
  input: CdtInput,
  opts?: {
    readonly duplicates?: 'error' | 'merge';
    readonly removeExterior?: boolean;
    readonly tol?: Partial<Tolerances>;
  },
): Result<Triangulation> {
  resolveTolerances(opts?.tol);
  const built = buildCdt(input, opts?.duplicates ?? 'error');
  if (!built.ok) return built;
  const { st } = built.value;
  if (!opts?.removeExterior) return okResult(exportTriangulation(st, () => true));
  const { consistent, windings } = classifyRegions(st);
  const bad = [...windings].filter((w) => w !== 0 && w !== 1);
  if (!consistent || bad.length > 0) {
    return errResult([
      issue(
        'trim-orientation',
        `segments do not bound regions of winding 0 and 1 (found ${[...windings].sort().join(', ')}${consistent ? '' : '; open chain'}): ` +
          'outer loops must be counter-clockwise and holes clockwise',
      ),
    ]);
  }
  return okResult(exportTriangulation(st, (t) => st.region[t] === 1));
}

/** Twice the signed area of triangle `t` of a {@link Triangulation} (for checks). */
function triArea2(pts: ReadonlyF64, a: number, b: number, c: number): number {
  return (
    (pts[2 * b]! - pts[2 * a]!) * (pts[2 * c + 1]! - pts[2 * a + 1]!) -
    (pts[2 * b + 1]! - pts[2 * a + 1]!) * (pts[2 * c]! - pts[2 * a]!)
  );
}

/**
 * Checks the invariants of a triangulation (exact predicates): every triangle
 * strictly counter-clockwise, half-edges symmetric with matching ends, every
 * unconstrained interior edge locally Delaunay, and (if `segments` are given)
 * every segment present as a chain of constrained edges. Returns one issue
 * per violation (`cdt-failure`), empty when valid.
 */
export function checkTriangulation(
  t: Triangulation,
  segments?: ArrayLike<number>,
): readonly GeomIssue[] {
  const issues: GeomIssue[] = [];
  const pred = makePredicates();
  const P = t.points;
  const T = t.triangles;
  const H = t.halfedges;
  const nt = T.length / 3;
  const X = (v: number): number => P[2 * v]!;
  const Y = (v: number): number => P[2 * v + 1]!;
  for (let i = 0; i < nt; i++) {
    const a = T[3 * i]!;
    const b = T[3 * i + 1]!;
    const c = T[3 * i + 2]!;
    if (!(pred.orient2d(X(a), Y(a), X(b), Y(b), X(c), Y(c)) > 0)) {
      issues.push(
        issue(
          'cdt-failure',
          `triangle ${i} is not counter-clockwise (area ${triArea2(P, a, b, c) / 2})`,
          i,
        ),
      );
    }
  }
  for (let e = 0; e < H.length; e++) {
    const f = H[e]!;
    if (f < 0) continue;
    if (H[f] !== e) issues.push(issue('cdt-failure', `half-edges ${e} and ${f} are not twins`, e));
    if (T[e] !== T[next(f)] || T[next(e)] !== T[f]) {
      issues.push(issue('cdt-failure', `half-edges ${e} and ${f} join different vertices`, e));
    }
    if (t.constrained[e] !== t.constrained[f]) {
      issues.push(issue('cdt-failure', `half-edges ${e} and ${f} disagree on the constraint`, e));
    }
    if (!t.constrained[e] && e < f) {
      const ti = (e / 3) | 0;
      const d = T[prev(f)]!;
      const a = T[3 * ti]!;
      const b = T[3 * ti + 1]!;
      const c = T[3 * ti + 2]!;
      if (pred.incircle(X(a), Y(a), X(b), Y(b), X(c), Y(c), X(d), Y(d)) > 0) {
        issues.push(issue('cdt-failure', `edge ${T[e]}–${T[next(e)]} is not locally Delaunay`, e));
      }
    }
  }
  if (segments !== undefined) {
    // Constrained edges by vertex, to follow each segment's chain.
    const out = new Map<number, number[]>();
    for (let e = 0; e < T.length; e++) {
      if (!t.constrained[e]) continue;
      const u = T[e]!;
      const list = out.get(u) ?? [];
      list.push(T[next(e)]!);
      out.set(u, list);
      if (H[e]! < 0) {
        const w = T[next(e)]!;
        const back = out.get(w) ?? [];
        back.push(u);
        out.set(w, back);
      }
    }
    for (let s = 0; s < segments.length; s += 2) {
      const a = segments[s]!;
      const b = segments[s + 1]!;
      let cur = a;
      let ok = true;
      for (let guard = 0; cur !== b && ok; guard++) {
        const nextV = (out.get(cur) ?? []).find(
          (w) =>
            pred.orient2d(X(a), Y(a), X(b), Y(b), X(w), Y(w)) === 0 &&
            (X(w) - X(cur)) * (X(b) - X(a)) + (Y(w) - Y(cur)) * (Y(b) - Y(a)) > 0,
        );
        if (nextV === undefined || guard > P.length) ok = false;
        else cur = nextV;
      }
      if (!ok)
        issues.push(issue('cdt-failure', `segment ${s >> 1} (${a} → ${b}) is not present`, s >> 1));
    }
  }
  return issues;
}
