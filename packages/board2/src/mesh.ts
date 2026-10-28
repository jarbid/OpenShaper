// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fast live mesh (docs/design/m1-model.md §3): a regular grid per side, evaluated
 * straight from the surface evaluator. No trimming, no B-rep.
 *
 * **Grid.** Rows follow ξ (the stringer coordinate) and columns follow t (around the
 * section: 0 bottom centre, ½ apex, 1 deck centre). One pair of ladders serves both
 * sides, so the two sides share their stringer vertices (columns 0 and last) exactly,
 * and a collapsed end row (a pointed tail, nose or notch bottom: the chord has zero
 * length) is welded: the plus and minus vertices of that row are the same vertices.
 * An end with real width (a blunt tail or nose) is closed by a planar cap, a strip
 * across the end section. The mesh is therefore closed, and every edge is used by two
 * triangles of opposite direction.
 *
 * **Tolerance.** The ladders are refined by bisection until, for every neighbouring
 * pair of rows (columns), the surface at the midpoint is within a share of the tolerance
 * (`MESH_DEV_FRACTION`) of the chord between the two. Rows start from the stations, the
 * knots of the outline, rocker, deck and features, the notch zone's breakpoints and equal
 * steps of outline arc length (which densifies the tips and the notch fan); columns start
 * uniform. Columns are refined first (independent of the rows, on probe rows at the
 * stations), then rows (on a stride of the final columns). `deriveLadders` is the
 * expensive part; pass its result back as `ladders` to re-mesh an edited board without
 * it (the grid stays valid for small edits and is re-derived when the edit settles).
 *
 * **Data.** Typed arrays: float32 positions and exact unit outward normals, optional
 * principal curvatures (`k1 ≥ k2`, convex positive, from `measure`), uint32 triangle
 * indices counter-clockwise seen from outside. Normals at a collapsed row are the limit
 * taken a little way into the board. Volume and the areas come from the triangles.
 */
import { arcFractionParams } from './chain';
import { frameAt, xiOfParam } from './frame';
import {
  MESH_DEV_FRACTION,
  MESH_MAX_COLS,
  MESH_MAX_LEVELS,
  MESH_MAX_ROWS,
  MESH_MIN_T_SPAN,
  MESH_MIN_XI_SPAN,
  MESH_NORMAL_OFFSET,
  MESH_PROBE_COLS,
  MESH_PROBE_ROWS_UNIFORM,
  MESH_SEED_COLS_PER_HALF,
  MESH_SEED_ROWS_ARC,
  MESH_SEED_ROWS_UNIFORM,
  MESH_TWIST_FRACTION,
  MESH_VERIFY_ROWS,
  PLAN_EXACT_TOL,
} from './params';
import { MEASURE, createEvaluator } from './surface';
import type { BuiltBoard, SurfaceEvaluator } from './surface';

/** The row ladder (ξ, increasing, first and last are the ends) and the column ladder (t, from 0 to 1, ½ included). */
export interface Ladders {
  readonly xi: Float64Array;
  readonly t: Float64Array;
}

export interface MeshOptions {
  /** Mesh tolerance in cm; default `board.doc.build.tolerance`. */
  readonly tolerance?: number;
  /** Longest edge allowed, cm (a cap only: the tolerance always holds). Default none. */
  readonly maxEdge?: number;
  /** Also compute the principal curvatures. */
  readonly curvature?: boolean;
  /** Reuse these ladders instead of deriving them. */
  readonly ladders?: Ladders;
}

/** How the vertices are numbered (see {@link meshVertex}). */
export interface MeshLayout {
  readonly rows: number;
  readonly cols: number;
  /** The first (last) row has zero chord: the two sides share its vertices. */
  readonly weldFirst: boolean;
  readonly weldLast: boolean;
  /** Index of the first minus-only vertex (`rows · cols`: the plus grid comes first). */
  readonly minusBase: number;
}

export interface BoardMesh {
  /** x y z per vertex, cm. */
  readonly positions: Float32Array;
  /** Unit outward normals, x y z per vertex. */
  readonly normals: Float32Array;
  /** Principal curvatures (1/cm, convex positive, `k1 ≥ k2`) when asked for. */
  readonly k1?: Float32Array;
  readonly k2?: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly layout: MeshLayout;
  readonly ladders: Ladders;
  /** From the triangles: volume (cm³), plan area (the upward-facing triangles projected onto z = 0, cm²) and surface area (cm²). */
  readonly volume: number;
  readonly planArea: number;
  readonly surfaceArea: number;
}

/** Vertex index of grid node `(i, j)` on side 0 (plus) or 1 (minus). */
export function meshVertex(layout: MeshLayout, side: 0 | 1, i: number, j: number): number {
  const { rows, cols, weldFirst, weldLast } = layout;
  const edge = j === 0 || j === cols - 1;
  if (side === 0 || edge || (weldFirst && i === 0) || (weldLast && i === rows - 1)) {
    return i * cols + j;
  }
  return layout.minusBase + (i - (weldFirst ? 1 : 0)) * (cols - 2) + (j - 1);
}

// ---------------------------------------------------------------------------
// Ladders
// ---------------------------------------------------------------------------

/** Distance of the point `m` from the segment `a b`. */
function segDist(
  P: Float64Array,
  a: number,
  Q: Float64Array,
  b: number,
  M: Float64Array,
  m: number,
): number {
  const ex = Q[b]! - P[a]!;
  const ey = Q[b + 1]! - P[a + 1]!;
  const ez = Q[b + 2]! - P[a + 2]!;
  const wx = M[m]! - P[a]!;
  const wy = M[m + 1]! - P[a + 1]!;
  const wz = M[m + 2]! - P[a + 2]!;
  const ee = ex * ex + ey * ey + ez * ez;
  let f = ee > 0 ? (wx * ex + wy * ey + wz * ez) / ee : 0;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  return Math.hypot(wx - f * ex, wy - f * ey, wz - f * ez);
}

const edgeLen = (P: Float64Array, a: number, Q: Float64Array, b: number): number =>
  Math.hypot(Q[b]! - P[a]!, Q[b + 1]! - P[a + 1]!, Q[b + 2]! - P[a + 2]!);

/** Sorted, with values closer than `span` merged, and inside `[lo, hi]` (the ends always kept). */
function tidy(values: number[], lo: number, hi: number, span: number): number[] {
  const v = values.filter((x) => x > lo && x < hi).sort((a, b) => a - b);
  const out = [lo];
  for (const x of v) if (x - out[out.length - 1]! >= span && hi - x >= span) out.push(x);
  out.push(hi);
  return out;
}

function rowSeeds(board: BuiltBoard): number[] {
  const lo = board.xiMin;
  const hi = board.xiMax;
  const seeds: number[] = [];
  for (const s of board.doc.stations) seeds.push(s.x);
  for (let k = 1; k < MESH_SEED_ROWS_UNIFORM; k++) {
    seeds.push(lo + ((hi - lo) * k) / MESH_SEED_ROWS_UNIFORM);
  }
  const fr = Float64Array.from(
    { length: MESH_SEED_ROWS_ARC + 1 },
    (_, k) => k / MESH_SEED_ROWS_ARC,
  );
  const frames =
    board.doc.symmetry === 'mirror' ? [board.sides[0].frame] : board.sides.map((s) => s.frame);
  for (const f of frames) {
    const ss = arcFractionParams(f.chain, 0, f.chain.segments, fr);
    for (const s of ss) seeds.push(xiOfParam(f, s));
    for (let k = 0; k <= f.chain.segments; k++) seeds.push(xiOfParam(f, k));
    if (f.notch !== null) {
      seeds.push(f.notch.d, f.notch.xiEnd, xiOfParam(f, f.notch.sTip));
    }
  }
  for (const ch of [board.rocker, board.deck]) {
    for (let k = 0; k < ch.segments; k++) seeds.push(ch.c[8 * k]!);
    seeds.push(ch.c[8 * ch.segments - 2]!);
  }
  for (const f of board.features) for (const key of f.feature.depth.keys) seeds.push(key.s);
  return tidy(seeds, lo, hi, MESH_MIN_XI_SPAN);
}

/** The rows at which columns are tested: the stations, the midpoints between them, and a few uniform ones. */
function probeRows(board: BuiltBoard): number[] {
  const lo = board.xiMin;
  const hi = board.xiMax;
  const xs = board.doc.stations.map((s) => s.x);
  const v: number[] = [...xs];
  for (let i = 0; i + 1 < xs.length; i++) v.push(0.5 * (xs[i]! + xs[i + 1]!));
  for (let k = 1; k <= MESH_PROBE_ROWS_UNIFORM; k++) {
    v.push(lo + ((hi - lo) * k) / (MESH_PROBE_ROWS_UNIFORM + 1));
  }
  return tidy(v, lo, hi, MESH_MIN_XI_SPAN);
}

/**
 * Bisects the column ladder until the section's midpoint deviation is within `tolDir`
 * at every probe row (both sides on an asymmetric board).
 */
function refineCols(
  ev: SurfaceEvaluator,
  sideList: readonly (0 | 1)[],
  probe: readonly number[],
  start: readonly number[],
  tolDir: number,
  maxEdge: number,
): Float64Array {
  let ts: number[] = [...start];
  const lines = probe.length * sideList.length;
  const buf = new Float64Array(3);
  // positions of every line at the current columns
  let pos: number[][] = [];
  for (const xi of probe) {
    for (const side of sideList) {
      ev.row(side, xi, 0);
      const p: number[] = [];
      for (const t of ts) {
        ev.eval(t, 0, buf);
        p.push(buf[0]!, buf[1]!, buf[2]!);
      }
      pos.push(p);
    }
  }
  let dirty: boolean[] = ts.slice(1).map(() => true);
  for (let level = 0; level < MESH_MAX_LEVELS; level++) {
    const nIv = ts.length - 1;
    const split = new Uint8Array(nIv);
    const mids: Float64Array[] = [];
    let line = 0;
    const A = new Float64Array(3);
    const B = new Float64Array(3);
    for (const xi of probe) {
      for (const side of sideList) {
        ev.row(side, xi, 0);
        const p = pos[line]!;
        const M = new Float64Array(3 * nIv);
        for (let j = 0; j < nIv; j++) {
          if (!dirty[j]) continue;
          ev.eval(0.5 * (ts[j]! + ts[j + 1]!), 0, buf);
          M[3 * j] = buf[0]!;
          M[3 * j + 1] = buf[1]!;
          M[3 * j + 2] = buf[2]!;
          if (split[j]) continue;
          A[0] = p[3 * j]!;
          A[1] = p[3 * j + 1]!;
          A[2] = p[3 * j + 2]!;
          B[0] = p[3 * j + 3]!;
          B[1] = p[3 * j + 4]!;
          B[2] = p[3 * j + 5]!;
          if (segDist(A, 0, B, 0, buf, 0) > tolDir || edgeLen(A, 0, B, 0) > maxEdge) {
            split[j] = 1;
          }
        }
        mids.push(M);
        line++;
      }
    }
    let any = false;
    const nts: number[] = [ts[0]!];
    const ndirty: boolean[] = [];
    const npos: number[][] = Array.from({ length: lines }, (_, l) => [
      pos[l]![0]!,
      pos[l]![1]!,
      pos[l]![2]!,
    ]);
    let room = MESH_MAX_COLS - ts.length;
    for (let j = 0; j < nIv; j++) {
      const wide = ts[j + 1]! - ts[j]! >= 2 * MESH_MIN_T_SPAN;
      if (split[j] && wide && room > 0) {
        any = true;
        room--;
        nts.push(0.5 * (ts[j]! + ts[j + 1]!), ts[j + 1]!);
        ndirty.push(true, true);
        for (let l = 0; l < lines; l++) {
          const M = mids[l]!;
          npos[l]!.push(
            M[3 * j]!,
            M[3 * j + 1]!,
            M[3 * j + 2]!,
            pos[l]![3 * j + 3]!,
            pos[l]![3 * j + 4]!,
            pos[l]![3 * j + 5]!,
          );
        }
      } else {
        nts.push(ts[j + 1]!);
        ndirty.push(false);
        for (let l = 0; l < lines; l++)
          npos[l]!.push(pos[l]![3 * j + 3]!, pos[l]![3 * j + 4]!, pos[l]![3 * j + 5]!);
      }
    }
    ts = nts;
    pos = npos;
    dirty = ndirty;
    if (!any) break;
  }
  return Float64Array.from(ts);
}

/**
 * Bisects the row ladder (starting from `seeds`) until the surface's midpoint deviation
 * is within `tolDir` at every probe column (both sides on an asymmetric board).
 */
function refineRows(
  ev: SurfaceEvaluator,
  sideList: readonly (0 | 1)[],
  seeds: readonly number[],
  probeT: readonly number[],
  tolDir: number,
  twistTol: number,
  maxEdge: number,
): Float64Array {
  const stride = 3 * probeT.length;
  const width = stride * sideList.length;
  const evalRow = (xi: number): Float64Array => {
    const out = new Float64Array(width);
    const buf = new Float64Array(3);
    let o = 0;
    for (const side of sideList) {
      ev.row(side, xi, 0);
      for (const t of probeT) {
        ev.eval(t, 0, buf);
        out[o++] = buf[0]!;
        out[o++] = buf[1]!;
        out[o++] = buf[2]!;
      }
    }
    return out;
  };
  let xs: number[] = [...seeds];
  let rows: Float64Array[] = xs.map(evalRow);
  let dirty: boolean[] = xs.slice(1).map(() => true);
  for (let level = 0; level < MESH_MAX_LEVELS; level++) {
    const nIv = xs.length - 1;
    const nxs: number[] = [xs[0]!];
    const nrows: Float64Array[] = [rows[0]!];
    const ndirty: boolean[] = [];
    let any = false;
    let room = MESH_MAX_ROWS - xs.length;
    for (let j = 0; j < nIv; j++) {
      let doSplit = false;
      let M: Float64Array | null = null;
      const xm = 0.5 * (xs[j]! + xs[j + 1]!);
      if (dirty[j] && xs[j + 1]! - xs[j]! >= 2 * MESH_MIN_XI_SPAN && room > 0) {
        M = evalRow(xm);
        const P = rows[j]!;
        const Q = rows[j + 1]!;
        for (let k = 0; k < width && !doSplit; k += 3) {
          if (segDist(P, k, Q, k, M, k) > tolDir || edgeLen(P, k, Q, k) > maxEdge) doSplit = true;
          // the twist of the cell between this probe column and the next (not across the sides)
          if ((k / 3) % probeT.length < probeT.length - 1) {
            const k3 = k + 3;
            const twist =
              Math.hypot(
                P[k]! + Q[k3]! - P[k3]! - Q[k]!,
                P[k + 1]! + Q[k3 + 1]! - P[k3 + 1]! - Q[k + 1]!,
                P[k + 2]! + Q[k3 + 2]! - P[k3 + 2]! - Q[k + 2]!,
              ) / 4;
            if (twist > twistTol) doSplit = true;
          }
        }
      }
      if (doSplit && M !== null) {
        any = true;
        room--;
        nxs.push(xm, xs[j + 1]!);
        nrows.push(M, rows[j + 1]!);
        ndirty.push(true, true);
      } else {
        nxs.push(xs[j + 1]!);
        nrows.push(rows[j + 1]!);
        ndirty.push(false);
      }
    }
    xs = nxs;
    rows = nrows;
    dirty = ndirty;
    if (!any) break;
  }
  return Float64Array.from(xs);
}

/**
 * Derives the row and column ladders of a built board for a tolerance (cm). This is the
 * costly part of meshing; reuse the result while a board is being dragged.
 */
export function deriveLadders(
  board: BuiltBoard,
  tolerance: number = board.doc.build.tolerance,
  maxEdge = Number.POSITIVE_INFINITY,
): Ladders {
  return deriveWith(board, createEvaluator(board), tolerance, maxEdge);
}

/** A stride through the column ladder: the columns at which a row interval is tested. */
function probeCols(t: Float64Array): number[] {
  const n = Math.min(MESH_PROBE_COLS, t.length);
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(t[Math.round((k * (t.length - 1)) / (n - 1))]!);
  return out;
}

function deriveWith(
  board: BuiltBoard,
  ev: SurfaceEvaluator,
  tolerance: number,
  maxEdge: number,
): Ladders {
  const tolDir = MESH_DEV_FRACTION * tolerance;
  const twistTol = MESH_TWIST_FRACTION * tolerance;
  const sideList: readonly (0 | 1)[] = board.doc.symmetry === 'mirror' ? [0] : [0, 1];
  const half = MESH_SEED_COLS_PER_HALF;
  const seedT = Array.from({ length: 2 * half + 1 }, (_, j) => j / (2 * half));
  let t = refineCols(ev, sideList, probeRows(board), seedT, tolDir, maxEdge);
  let xi = refineRows(ev, sideList, rowSeeds(board), probeCols(t), tolDir, twistTol, maxEdge);
  // a feature's lateral track moves along the board: check the columns at the rows found, and
  // if they had to grow, the rows against the new columns
  const stride = Math.max(1, Math.ceil(xi.length / MESH_VERIFY_ROWS));
  const verify: number[] = [];
  for (let i = 0; i < xi.length; i += stride) verify.push(xi[i]!);
  const t2 = refineCols(ev, sideList, verify, Array.from(t), tolDir, maxEdge);
  if (t2.length > t.length) {
    t = t2;
    xi = refineRows(ev, sideList, Array.from(xi), probeCols(t), tolDir, twistTol, maxEdge);
  }
  return { xi, t };
}

// ---------------------------------------------------------------------------
// The mesh
// ---------------------------------------------------------------------------

/** A row is collapsed when the chord to the outline has zero length on every side. */
function collapsedRow(board: BuiltBoard, xi: number): boolean {
  const p = new Float64Array(6);
  for (const side of board.sides) {
    frameAt(side.frame, xi, p);
    if (Math.hypot(p[0]! - xi, p[1]!) > PLAN_EXACT_TOL) return false;
  }
  return true;
}

/** Meshes a built board; see the module comment. */
export function meshBoard(board: BuiltBoard, opts: MeshOptions = {}): BoardMesh {
  const ev = createEvaluator(board);
  const tol = opts.tolerance ?? board.doc.build.tolerance;
  const ladders =
    opts.ladders ?? deriveWith(board, ev, tol, opts.maxEdge ?? Number.POSITIVE_INFINITY);
  return buildMesh(board, ev, ladders, opts.curvature === true);
}

function buildMesh(
  board: BuiltBoard,
  ev: SurfaceEvaluator,
  ladders: Ladders,
  curvature: boolean,
): BoardMesh {
  const { xi, t } = ladders;
  const rows = xi.length;
  const cols = t.length;
  const mirror = board.doc.symmetry === 'mirror';
  const weldFirst = collapsedRow(board, xi[0]!);
  const weldLast = collapsedRow(board, xi[rows - 1]!);
  const minusRows = rows - (weldFirst ? 1 : 0) - (weldLast ? 1 : 0);
  const minusBase = rows * cols;
  const layout: MeshLayout = { rows, cols, weldFirst, weldLast, minusBase };
  const nV = minusBase + minusRows * (cols - 2);
  const positions = new Float32Array(3 * nV);
  const normals = new Float32Array(3 * nV);
  const k1 = curvature ? new Float32Array(nV) : undefined;
  const k2 = curvature ? new Float32Array(nV) : undefined;
  const order = curvature ? 2 : 1;
  const buf = new Float64Array(18);
  const mb = new Float64Array(MEASURE.size);
  /** x y z, unit outward normal, k1 k2 of the prepared row at `tj`. */
  const vtx = new Float64Array(8);

  const evalVertex = (side: 0 | 1, tj: number): void => {
    if (curvature) {
      ev.eval(tj, 0, buf);
      ev.measure(tj, mb);
      vtx[3] = mb[MEASURE.nx]!;
      vtx[4] = mb[MEASURE.ny]!;
      vtx[5] = mb[MEASURE.nz]!;
      vtx[6] = mb[MEASURE.k1]!;
      vtx[7] = mb[MEASURE.k2]!;
    } else {
      ev.eval(tj, 1, buf);
      // S_t × S_ξ is outward on the plus side, inward on the minus side
      const sgn = side === 0 ? 1 : -1;
      const nx = buf[7]! * buf[5]! - buf[8]! * buf[4]!;
      const ny = buf[8]! * buf[3]! - buf[6]! * buf[5]!;
      const nz = buf[6]! * buf[4]! - buf[7]! * buf[3]!;
      const len = Math.hypot(nx, ny, nz);
      vtx[3] = (sgn * nx) / len;
      vtx[4] = (sgn * ny) / len;
      vtx[5] = (sgn * nz) / len;
      vtx[6] = 0;
      vtx[7] = 0;
    }
    vtx[0] = buf[0]!;
    vtx[1] = buf[1]!;
    vtx[2] = buf[2]!;
    // an undefined normal (NaN) falls back to straight down or up
    if (!(Math.abs(vtx[3]! + vtx[4]! + vtx[5]!) < Number.POSITIVE_INFINITY)) {
      vtx[3] = 0;
      vtx[4] = 0;
      vtx[5] = tj < 0.5 ? -1 : 1;
    }
  };

  const put = (v: number, mirrorY: boolean): void => {
    positions[3 * v] = vtx[0]!;
    positions[3 * v + 1] = mirrorY ? 0 - vtx[1]! : vtx[1]!;
    positions[3 * v + 2] = vtx[2]!;
    normals[3 * v] = vtx[3]!;
    normals[3 * v + 1] = mirrorY ? 0 - vtx[4]! : vtx[4]!;
    normals[3 * v + 2] = vtx[5]!;
    if (k1 !== undefined && k2 !== undefined) {
      k1[v] = vtx[6]!;
      k2[v] = vtx[7]!;
    }
  };

  /** Writes the vertex in `vtx` as node `(i, j)` of `side`, and on a mirror board its mirror image. */
  const store = (side: 0 | 1, i: number, j: number): void => {
    const v = meshVertex(layout, side, i, j);
    put(v, false);
    if (side === 0 && mirror && j !== 0 && j !== cols - 1) {
      const w = meshVertex(layout, 1, i, j);
      if (w !== v) put(w, true);
    }
  };

  const here = new Float64Array(3 * cols);
  const sideList: readonly (0 | 1)[] = mirror ? [0] : [0, 1];
  for (const side of sideList) {
    for (let i = 0; i < rows; i++) {
      const collapsed = (i === 0 && weldFirst) || (i === rows - 1 && weldLast);
      if (side === 1 && collapsed) continue;
      const first = side === 1 ? 1 : 0;
      const last = side === 1 ? cols - 2 : cols - 1;
      if (!collapsed) {
        ev.row(side, xi[i]!, order);
        for (let j = first; j <= last; j++) {
          evalVertex(side, t[j]!);
          store(side, i, j);
        }
        continue;
      }
      // a collapsed row: positions on the row, normals a little way into the board
      ev.row(side, xi[i]!, 0);
      for (let j = 0; j < cols; j++) {
        ev.eval(t[j]!, 0, buf);
        here[3 * j] = buf[0]!;
        here[3 * j + 1] = buf[1]!;
        here[3 * j + 2] = buf[2]!;
      }
      const next = xi[i === 0 ? 1 : rows - 2]!;
      ev.row(side, xi[i]! + MESH_NORMAL_OFFSET * (next - xi[i]!), order);
      for (let j = 0; j < cols; j++) {
        evalVertex(side, t[j]!);
        vtx[0] = here[3 * j]!;
        vtx[1] = here[3 * j + 1]!;
        vtx[2] = here[3 * j + 2]!;
        store(side, i, j);
      }
    }
  }

  // triangles
  let nTri = 2 * (rows - 1) * (cols - 1) * 2;
  if (!weldFirst) nTri += 2 * (cols - 1);
  if (!weldLast) nTri += 2 * (cols - 1);
  const idx = new Uint32Array(3 * nTri);
  let n = 0;
  const tri = (a: number, b: number, c: number): void => {
    if (a === b || b === c || a === c) return;
    idx[n++] = a;
    idx[n++] = b;
    idx[n++] = c;
  };
  for (let i = 0; i + 1 < rows; i++) {
    for (let j = 0; j + 1 < cols; j++) {
      const a = meshVertex(layout, 0, i, j);
      const b = meshVertex(layout, 0, i, j + 1);
      const c = meshVertex(layout, 0, i + 1, j);
      const d = meshVertex(layout, 0, i + 1, j + 1);
      const am = meshVertex(layout, 1, i, j);
      const bm = meshVertex(layout, 1, i, j + 1);
      const cm = meshVertex(layout, 1, i + 1, j);
      const dm = meshVertex(layout, 1, i + 1, j + 1);
      // the diagonal b-c would be used by both sides' quads if both its ends are shared
      if (b === bm && c === cm) {
        tri(a, b, d);
        tri(a, d, c);
        tri(am, dm, bm);
        tri(am, cm, dm);
      } else {
        tri(a, b, c);
        tri(c, b, d);
        tri(am, cm, bm);
        tri(cm, dm, bm);
      }
    }
  }
  for (const [end, outward] of [
    [rows - 1, true],
    [0, false],
  ] as const) {
    if (end === 0 ? weldFirst : weldLast) continue;
    for (let j = 0; j + 1 < cols; j++) {
      const p0 = meshVertex(layout, 0, end, j);
      const p1 = meshVertex(layout, 0, end, j + 1);
      const m0 = meshVertex(layout, 1, end, j);
      const m1 = meshVertex(layout, 1, end, j + 1);
      if (outward) {
        tri(p0, p1, m1);
        tri(p0, m1, m0);
      } else {
        tri(p0, m1, p1);
        tri(p0, m0, m1);
      }
    }
  }
  const indices = idx.slice(0, n);
  const props = meshProperties(positions, indices);
  return {
    positions,
    normals,
    ...(k1 !== undefined && k2 !== undefined ? { k1, k2 } : {}),
    indices,
    vertexCount: nV,
    triangleCount: n / 3,
    layout,
    ladders,
    ...props,
  };
}

/**
 * Volume (divergence theorem about the bounding box centre), plan area and surface area of
 * a closed mesh with outward counter-clockwise triangles.
 */
export function meshProperties(
  positions: Float32Array,
  indices: Uint32Array,
): { volume: number; planArea: number; surfaceArea: number } {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  if (positions.length > 0) {
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      x0 = Math.min(x0, positions[i]!);
      x1 = Math.max(x1, positions[i]!);
      y0 = Math.min(y0, positions[i + 1]!);
      y1 = Math.max(y1, positions[i + 1]!);
      z0 = Math.min(z0, positions[i + 2]!);
      z1 = Math.max(z1, positions[i + 2]!);
    }
    cx = 0.5 * (x0 + x1);
    cy = 0.5 * (y0 + y1);
    cz = 0.5 * (z0 + z1);
  }
  let vol = 0;
  let plan = 0;
  let surf = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const a = 3 * indices[k]!;
    const b = 3 * indices[k + 1]!;
    const c = 3 * indices[k + 2]!;
    const ax = positions[a]! - cx;
    const ay = positions[a + 1]! - cy;
    const az = positions[a + 2]! - cz;
    const bx = positions[b]! - cx;
    const by = positions[b + 1]! - cy;
    const bz = positions[b + 2]! - cz;
    const px = positions[c]! - cx;
    const py = positions[c + 1]! - cy;
    const pz = positions[c + 2]! - cz;
    vol += (ax * (by * pz - bz * py) + ay * (bz * px - bx * pz) + az * (bx * py - by * px)) / 6;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const wx = px - ax;
    const wy = py - ay;
    const wz = pz - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    surf += 0.5 * Math.hypot(nx, ny, nz);
    if (nz > 0) plan += 0.5 * nz;
  }
  return { volume: vol, planArea: plan, surfaceArea: surf };
}
