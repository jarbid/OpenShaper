// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trimmed surface → triangle mesh (design §6.17, §11.5).
 *
 * 1. **Interior seeds** on a grid aligned to the knot spans: each span is cut
 *    into equal parts, as many as its sampled second derivatives need for the
 *    chord tolerance (`h ≤ √(8·chordTol / |S_uu·n|)`, the sagitta of a
 *    parabola), the angle tolerance (`h ≤ angleTol·|S_u| / |S_uu·n|`, the turn
 *    of the normal, not below `minEdge`) and `maxEdge` (`h ≤ maxEdge / |S_u|`), each evaluated at
 *    the span pair's 3 × 3 corner, edge-midpoint and centre parameters.
 * 2. **Boundary.** Each trim curve is sampled adaptively: an interval is split
 *    at its parameter midpoint while the 3D chord deviates from the curve's
 *    image or from the surface along the straight (u, v) chord by more than
 *    `chordTol`, the normals at its ends differ by more than `angleTol` (on
 *    chords longer than `minEdge`), the
 *    chord is longer than `maxEdge`, or (trim loops) it is longer than the
 *    local seed spacing; each knot span starts with `q` parts (a degree-q span
 *    has at most q − 1 inflections). Splitting stops at the parameter rounding
 *    floor (`paramRel`). A natural boundary is sampled at the seed grid lines,
 *    canonically (ascending), so its seam edges in a periodic direction get
 *    bitwise identical samples. Joins use the trim curves' exact end control
 *    points. A caller can instead pass the boundary samples. Faces sharing one
 *    parameterisation (trims of the same surface) then get bitwise identical
 *    shared-edge positions; faces on different surfaces each evaluate their
 *    own surface, so their shared vertices agree only to the surfaces' gap
 *    along the edge (bitwise watertightness across surfaces is B4's
 *    edge-first pass, positions from the edge curve, design §11.5).
 * 3. **CDT in metric-scaled (u, v)**, `(x, y) = (u·2^a, v·2^b)` with `2^a`,
 *    `2^b` the powers of two nearest the mean `|S_u|`, `|S_v|`: near-Delaunay
 *    in 3D, and exact (scaling by powers of two loses nothing, so orientation
 *    in (x, y) is orientation in (u, v)). Seeds closer to the boundary than
 *    half their local spacing are dropped (no slivers against segments);
 *    exterior and holes are removed by winding number.
 * 4. **Refinement** (constrained Lawson insertion, `cdt.ts`): an interior edge
 *    is split at its midpoint when its 3D midpoint is farther than `chordTol`
 *    from the surface at the (u, v) midpoint, its end normals differ by more
 *    than `angleTol` (edges longer than `minEdge` only), or it is longer than
 *    `maxEdge`; a triangle whose edges
 *    pass gets its centroid inserted when the centroid fails the chord test.
 *    `|linear − S(uv)|` bounds the distance to the surface from above, so the
 *    measured chord error is conservative. Points that would land on a segment
 *    or outside are not inserted; the loop ends when nothing fails or nothing
 *    can be inserted (then a warning reports the remaining error).
 * 5. **Output**: vertices ordered span-major, `(u, v)` exact, a
 *    `SurfaceSamplePlan` over them, and the plan's positions, exact normals
 *    (`Su × Sv`) and principal curvatures (`k1 ≥ k2`, design §4.7 signs).
 */
import { makeScratch } from '../array';
import type { ScratchImpl } from '../array';
import { breakpoints, sanitizeParam, spanOf } from '../basis';
import { curveEvalInto } from '../curve';
import { errResult, fail, okResult } from '../errors';
import { evalSurfacePlan, planSurfaceSamples } from '../plan';
import type { SurfaceSamplePlan } from '../plan';
import { MEASURE_N, SAMPLE_DEGENERATE, measureAt } from '../surface-measure';
import { checkSurfaceShape, evalSurfaceSpan } from '../surface';
import type { SurfaceSide } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import { loopsOf, rectangleLoop } from '../trim';
import type {
  Basis,
  ClampedCurve,
  GeomIssue,
  NurbsSurface,
  ReadonlyF64,
  ReadonlyI32,
  ReadonlyU32,
  ReadonlyU8,
  Result,
  TrimLoop,
  TrimmedSurface,
} from '../types';
import { buildCdt, classifyRegions, insertSteiner, isGhost, next } from './cdt';
import type { CdtState } from './cdt';
import { makePredicates } from './predicates';

/** Mesh accuracy targets. */
export interface TessellationOptions {
  /** Largest distance of the mesh from the surface (cm), at edge midpoints and centroids. */
  readonly chordTol: number;
  /** Largest angle between the exact normals at the two ends of an edge (rad). */
  readonly angleTol: number;
  /** Longest 3D edge (cm); unlimited if absent. */
  readonly maxEdge?: number;
  /**
   * Edges shorter than this (3D, cm) are not split for `angleTol` (default
   * `chordTol`). At a crease (a C0 knot line), a fold or a singular point the
   * normal jumps, so no refinement meets the angle test there; without a floor
   * the mesh would grow until the parameters reach rounding. On a smooth
   * surface an edge shorter than `chordTol` fails the angle test only where
   * the radius of curvature is below `chordTol / angleTol` (1 mm at the
   * defaults), finer than the mesh is meant to resolve. The chord test needs no
   * floor: its error vanishes as edges shrink on any continuous surface.
   */
  readonly minEdge?: number;
  /** Plan derivative order and outputs: 0 positions, 1 + normals, 2 + principal curvatures (default 2). */
  readonly nDer?: 0 | 1 | 2;
}

/**
 * Provisional defaults (design §6.17; Phase 3 tunes them against the classic
 * tessellator): 0.01 cm chord error is a tenth of CNC accuracy and invisible
 * at screen scale; 0.1 rad (≈ 5.7°) between neighbouring normals keeps
 * Gouraud shading smooth.
 */
export const DEFAULT_TESSELLATION: TessellationOptions = Object.freeze({
  chordTol: 0.01,
  angleTol: 0.1,
});

/** Boundary samples supplied by the caller: closed polylines in (u, v). */
export interface BoundarySamples {
  /** `[u0, v0, u1, v1, …]`: the outer loop first, then each hole, each traversed with material on the left. */
  readonly uv: ArrayLike<number>;
  /** Start of each loop in samples (`loops + 1` entries, the last = sample count). */
  readonly loopStarts: ArrayLike<number>;
  /** Optional per-sample edge id, reported in `boundaryEdge`. */
  readonly edges?: ArrayLike<number>;
}

/** A tessellated face. Arrays are per vertex unless stated. */
export interface FaceMesh {
  /** `(u, v)` per vertex, ordered span-major. */
  readonly uv: ReadonlyF64;
  /** Three vertex indices per triangle, counter-clockwise in (u, v) (so `Su × Sv` points to the viewer). */
  readonly triangles: ReadonlyU32;
  /**
   * Boundary vertices: the trim curve each starts (outer loop's curves first,
   * then each hole's; the natural boundary's four edges `v0, u1, v1, u0`), or
   * the caller's `edges` id; −1 inside.
   */
  readonly boundaryEdge: ReadonlyI32;
  /** Boundary vertices: the parameter on that trim curve (0 for caller samples and inside). */
  readonly boundaryParam: ReadonlyF64;
  /** Mesh vertex of every boundary sample, in loop order. */
  readonly loopVertices: ReadonlyU32;
  /** Start of each loop in `loopVertices` (`loops + 1` entries). */
  readonly loopStarts: ReadonlyU32;
  /** Where the boundary came from: sampled from the trim loops, or supplied by the caller. */
  readonly boundarySource: 'trim' | 'caller';
  /** The outer loop was the natural boundary (`outer = null`). */
  readonly naturalOuter: boolean;
  /**
   * Trim curves per loop (the natural boundary counts its four edges), so
   * `boundaryEdge` ids map back to loops; empty for caller samples.
   */
  readonly loopCurves: ReadonlyU32;
  /** All later evaluation, including drags, goes through it. */
  readonly plan: SurfaceSamplePlan;
  /** Positions, stride 3. */
  readonly position: ReadonlyF64;
  /** Exact unit normals `Su × Sv / |Su × Sv|`, stride 3 (`nDer ≥ 1`; zero where degenerate). */
  readonly normal: ReadonlyF64;
  /** Principal curvatures `k1 ≥ k2`, stride 2 (`nDer = 2`). */
  readonly curvature: ReadonlyF64;
  /** `SAMPLE_DEGENERATE | SAMPLE_UMBILIC` per vertex. */
  readonly flags: ReadonlyU8;
  /**
   * Largest `|linear − S(u, v)|` measured at the final mesh's edge midpoints
   * and centroids by the tessellator (an upper bound of the distance to the
   * surface there). A retargeted mesh keeps its source's value.
   */
  readonly maxChordError: number;
}

// ---------------------------------------------------------------------------
// Evaluation context
// ---------------------------------------------------------------------------

interface Ctx {
  readonly s: NurbsSurface;
  readonly t: Tolerances;
  readonly chordTol: number;
  readonly angleTol: number;
  readonly maxEdge: number;
  readonly minEdge: number;
  readonly sc: ScratchImpl;
  /** Scale exponents' factors: x = u·su, y = v·sv (powers of two). */
  su: number;
  sv: number;
}

/**
 * Position, normal and regular-normal flag at `(u, v)` (sanitized). `side`
 * picks the one-sided normal on a knot line (a crease at a C0 knot); the
 * position is the same from either side.
 */
function pn(
  ctx: Ctx,
  u: number,
  v: number,
  out: Float64Array,
  o: number,
  side?: SurfaceSide,
): boolean {
  const s = ctx.s;
  const flags = measureAt(s, sanitizeParam(s.u, u), sanitizeParam(s.v, v), 1, ctx.sc, ctx.t, side);
  const f = ctx.sc.f;
  for (let k = 0; k < 3; k++) {
    out[o + k] = f[ctx.sc.oS + k]!;
    out[o + 3 + k] = f[ctx.sc.oM + MEASURE_N + k]!;
  }
  return (flags & SAMPLE_DEGENERATE) === 0;
}

/**
 * The side of `(ua, va)` facing `(ub, vb)`: an edge's angle test compares the
 * normals of the smooth piece it runs through, so across a C0 knot line it
 * sees the crease only when it straddles the line, never from a vertex on it.
 */
const sideToward = (ua: number, va: number, ub: number, vb: number): SurfaceSide => ({
  u: ub < ua ? 'left' : 'right',
  v: vb < va ? 'left' : 'right',
});

const dist3 = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);

/** Deviation of the chord midpoint of `a`, `b` (positions at `i`, `j`) from the point at `k`. */
function chordDev(
  a: ArrayLike<number>,
  i: number,
  b: ArrayLike<number>,
  j: number,
  c: ArrayLike<number>,
  k: number,
): number {
  return Math.hypot(
    0.5 * (a[i]! + b[j]!) - c[k]!,
    0.5 * (a[i + 1]! + b[j + 1]!) - c[k + 1]!,
    0.5 * (a[i + 2]! + b[j + 2]!) - c[k + 2]!,
  );
}

function angle(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const cx = a[i + 1]! * b[j + 2]! - a[i + 2]! * b[j + 1]!;
  const cy = a[i + 2]! * b[j]! - a[i]! * b[j + 2]!;
  const cz = a[i]! * b[j + 1]! - a[i + 1]! * b[j]!;
  return Math.atan2(
    Math.hypot(cx, cy, cz),
    a[i]! * b[j]! + a[i + 1]! * b[j + 1]! + a[i + 2]! * b[j + 2]!,
  );
}

// ---------------------------------------------------------------------------
// Seed grid
// ---------------------------------------------------------------------------

/** Distinct breakpoints over the domain (one period, both ends, for a periodic basis). */
function spanBreaks(b: Basis): number[] {
  const br = Array.from(breakpoints(b));
  if (b.kind === 'periodic') {
    const t0 = b.domain[0];
    const inPeriod = br.filter((x) => x >= t0 && x < t0 + b.period);
    if (inPeriod[0] !== t0) inPeriod.unshift(t0);
    inPeriod.push(t0 + b.period);
    return inPeriod;
  }
  return br;
}

/**
 * Grid lines in u and v (module comment, step 1), and the metric scales. The
 * scales are powers of two near the mean `|Su|`, `|Sv|` of the samples.
 */
function seedGrid(ctx: Ctx): { us: number[]; vs: number[] } {
  const s = ctx.s;
  const ub = spanBreaks(s.u);
  const vb = spanBreaks(s.v);
  const nu = ub.length - 1;
  const nv = vb.length - 1;
  const cu = new Int32Array(nu).fill(1);
  const cv = new Int32Array(nv).fill(1);
  const sc = makeScratch(Math.max(s.u.degree, s.v.degree), 2);
  let sumU = 0;
  let sumV = 0;
  let nSum = 0;
  const need = (h: number, second: number, first: number): number => {
    let n = 1;
    if (second > 0) {
      n = Math.max(n, h * Math.sqrt(second / (8 * ctx.chordTol)));
      // The angle test stops at minEdge (3D spacing ≈ first · h / n).
      if (first > 0) {
        n = Math.max(n, Math.min((h * second) / (first * ctx.angleTol), (h * first) / ctx.minEdge));
      }
    }
    if (Number.isFinite(ctx.maxEdge)) n = Math.max(n, (h * first) / ctx.maxEdge);
    return Math.ceil(n);
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      for (let a = 0; a <= 2; a++) {
        for (let b = 0; b <= 2; b++) {
          const u = ub[i]! + (a * (ub[i + 1]! - ub[i]!)) / 2;
          const v = vb[j]! + (b * (vb[j + 1]! - vb[j]!)) / 2;
          const uu = sanitizeParam(s.u, u);
          const vv = sanitizeParam(s.v, v);
          // Inner side at the upper span ends.
          evalSurfaceSpan(s, uu, vv, spanOf(s.u, uu, a === 2), spanOf(s.v, vv, b === 2), 2, sc);
          const f = sc.f;
          const o = sc.oS;
          const Su = [f[o + 3]!, f[o + 4]!, f[o + 5]!];
          const Sv = [f[o + 6]!, f[o + 7]!, f[o + 8]!];
          const nx = Su[1]! * Sv[2]! - Su[2]! * Sv[1]!;
          const ny = Su[2]! * Sv[0]! - Su[0]! * Sv[2]!;
          const nz = Su[0]! * Sv[1]! - Su[1]! * Sv[0]!;
          const nn = Math.hypot(nx, ny, nz);
          const lu = Math.hypot(Su[0]!, Su[1]!, Su[2]!);
          const lv = Math.hypot(Sv[0]!, Sv[1]!, Sv[2]!);
          // Normal components of the second derivatives (the full ones where n is undefined).
          const comp = (k: number): number =>
            nn > 0
              ? Math.abs((f[o + k]! * nx + f[o + k + 1]! * ny + f[o + k + 2]! * nz) / nn)
              : Math.hypot(f[o + k]!, f[o + k + 1]!, f[o + k + 2]!);
          cu[i] = Math.max(cu[i]!, need(ub[i + 1]! - ub[i]!, comp(9), lu));
          cv[j] = Math.max(cv[j]!, need(vb[j + 1]! - vb[j]!, comp(15), lv));
          if (lu > 0 && lv > 0) {
            sumU += lu;
            sumV += lv;
            nSum++;
          }
        }
      }
    }
  }
  const pow2 = (x: number): number =>
    x > 0 && Number.isFinite(x) ? 2 ** Math.round(Math.log2(x)) : 1;
  ctx.su = pow2(nSum > 0 ? sumU / nSum : 1);
  ctx.sv = pow2(nSum > 0 ? sumV / nSum : 1);
  const lines = (br: number[], counts: Int32Array): number[] => {
    const out: number[] = [];
    for (let i = 0; i + 1 < br.length; i++) {
      const n = counts[i]!;
      for (let k = 0; k < n; k++)
        out.push(k === 0 ? br[i]! : br[i]! + ((br[i + 1]! - br[i]!) * k) / n);
    }
    out.push(br[br.length - 1]!);
    return out;
  };
  return { us: lines(ub, cu), vs: lines(vb, cv) };
}

/** Index `i` with `xs[i] ≤ x < xs[i + 1]` (clamped to the last cell). */
function cellOf(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 2;
  if (x <= xs[0]!) return 0;
  if (x >= xs[hi]!) return hi;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m]! <= x) lo = m;
    else hi = m;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Boundary sampling
// ---------------------------------------------------------------------------

/** One boundary sample. */
interface Sample {
  u: number;
  v: number;
  curve: number;
  t: number;
}

/**
 * Adaptive samples of a parameter range `[a, b]` mapped to (u, v) by `uvAt`
 * (module comment, step 2): pushes `[x, u, v]` for every sample, `a` included
 * and `b` excluded (it starts the next curve). `grid` adds the seed-spacing
 * criterion (trim loops).
 */
function sampleRange(
  ctx: Ctx,
  a: number,
  b: number,
  init: readonly number[],
  uvAt: (x: number) => [number, number],
  grid: { us: number[]; vs: number[] } | null,
  out: number[],
): void {
  const floor = ctx.t.paramRel * (b - a);
  const P0 = new Float64Array(6);
  const P1 = new Float64Array(6);
  const Pm = new Float64Array(6);
  const Pc = new Float64Array(6);
  const split = (t0: number, t1: number): void => {
    const [u0, v0] = uvAt(t0);
    const tm = 0.5 * (t0 + t1);
    if (!(tm > t0 && tm < t1) || t1 - t0 <= floor) {
      out.push(t0, u0, v0);
      return;
    }
    const [u1, v1] = uvAt(t1);
    const r0 = pn(ctx, u0, v0, P0, 0, sideToward(u0, v0, u1, v1));
    const r1 = pn(ctx, u1, v1, P1, 0, sideToward(u1, v1, u0, v0));
    const [um, vm] = uvAt(tm);
    pn(ctx, um, vm, Pm, 0);
    pn(ctx, 0.5 * (u0 + u1), 0.5 * (v0 + v1), Pc, 0);
    let bad =
      chordDev(P0, 0, P1, 0, Pm, 0) > ctx.chordTol ||
      chordDev(P0, 0, P1, 0, Pc, 0) > ctx.chordTol ||
      (r0 && r1 && angle(P0, 3, P1, 3) > ctx.angleTol && dist3(P0, 0, P1, 0) > ctx.minEdge) ||
      dist3(P0, 0, P1, 0) > ctx.maxEdge;
    if (!bad && grid !== null) {
      // Not longer than the local seed spacing (metric units).
      const i = cellOf(grid.us, um);
      const j = cellOf(grid.vs, vm);
      const h = Math.min(
        (grid.us[i + 1]! - grid.us[i]!) * ctx.su,
        (grid.vs[j + 1]! - grid.vs[j]!) * ctx.sv,
      );
      bad = Math.hypot((u1 - u0) * ctx.su, (v1 - v0) * ctx.sv) > h;
    }
    if (!bad) {
      out.push(t0, u0, v0);
      return;
    }
    split(t0, tm);
    split(tm, t1);
  };
  for (let k = 0; k + 1 < init.length; k++) split(init[k]!, init[k + 1]!);
}

/** Initial parameters of a trim curve: each knot span in `q` equal parts. */
function initialParams(c: ClampedCurve<2>): number[] {
  const q = c.basis.degree;
  const br = Array.from(breakpoints(c.basis));
  const out: number[] = [];
  for (let i = 0; i + 1 < br.length; i++) {
    for (let k = 0; k < q; k++)
      out.push(k === 0 ? br[i]! : br[i]! + ((br[i + 1]! - br[i]!) * k) / q);
  }
  out.push(br[br.length - 1]!);
  return out;
}

/** (u, v) on a trim curve: its exact end control points at the ends, else evaluated. */
function curveUV(c: ClampedCurve<2>): (x: number) => [number, number] {
  const [a, b] = c.basis.domain;
  const sc = makeScratch(c.basis.degree, 0);
  const cv = new Float64Array(2);
  const o = 3 * (c.basis.count - 1);
  return (x) => {
    if (x === a) return [c.cw[0]! / c.cw[2]!, c.cw[1]! / c.cw[2]!];
    if (x === b) return [c.cw[o]! / c.cw[o + 2]!, c.cw[o + 1]! / c.cw[o + 2]!];
    curveEvalInto(c, x, 0, cv, 0, sc);
    return [cv[0]!, cv[1]!];
  };
}

/**
 * Samples every loop: the outer loop (or the natural rectangle) first, then
 * each hole. Rectangle edge `k` (`v0`, `u1`, `v1`, `u0`, counter-clockwise) is
 * sampled ascending along its own coordinate from the grid lines, then put in
 * loop order; its parameter is the line pcurve's, `t ∈ [0, 1]`.
 */
function sampleLoops(
  ctx: Ctx,
  ts: TrimmedSurface,
  grid: { us: number[]; vs: number[] },
): { samples: Sample[]; loopStarts: number[]; loopCurves: number[] } {
  const s = ctx.s;
  const samples: Sample[] = [];
  const loopStarts: number[] = [0];
  const loopCurves: number[] = [];
  const natural = ts.outer === null;
  const loops: TrimLoop[] = natural ? [rectangleLoop(s), ...ts.holes] : loopsOf(ts);
  const [u0, u1] = s.u.domain;
  const [v0, v1] = s.v.domain;
  let g = 0;
  loops.forEach((loop, li) => {
    for (const c of loop.curves) {
      const raw: number[] = [];
      if (natural && li === 0) {
        const k = g;
        const alongU = k % 2 === 0;
        const lo = alongU ? u0 : v0;
        const hi = alongU ? u1 : v1;
        const fixed = [v0, u1, v1, u0][k]!;
        const at = (x: number): [number, number] => (alongU ? [x, fixed] : [fixed, x]);
        sampleRange(ctx, lo, hi, alongU ? grid.us : grid.vs, at, null, raw);
        const asc: number[] = [];
        for (let i = 0; i < raw.length; i += 3) asc.push(raw[i]!);
        // Edges 0, 1 run ascending from lo; edges 2, 3 descending from hi.
        const ordered = k < 2 ? asc : [hi, ...asc.slice(1).reverse()];
        for (const x of ordered) {
          const [u, v] = at(x);
          samples.push({ u, v, curve: k, t: k < 2 ? (x - lo) / (hi - lo) : (hi - x) / (hi - lo) });
        }
      } else {
        const [a, b] = c.basis.domain;
        sampleRange(ctx, a, b, initialParams(c), curveUV(c), grid, raw);
        for (let i = 0; i < raw.length; i += 3) {
          samples.push({ u: raw[i + 1]!, v: raw[i + 2]!, curve: g, t: raw[i]! });
        }
      }
      g++;
    }
    loopStarts.push(samples.length);
    loopCurves.push(loop.curves.length);
  });
  return { samples, loopStarts, loopCurves };
}

// ---------------------------------------------------------------------------
// Tessellation
// ---------------------------------------------------------------------------

function checkOptions(o: TessellationOptions): {
  chordTol: number;
  angleTol: number;
  maxEdge: number;
  minEdge: number;
  nDer: 0 | 1 | 2;
} {
  if (typeof o !== 'object' || o === null) fail('unsupported', 'tessellation options are required');
  for (const [k, x] of [
    ['chordTol', o.chordTol],
    ['angleTol', o.angleTol],
  ] as const) {
    if (!Number.isFinite(x) || !(x > 0))
      fail('unsupported', `${k} must be a finite number > 0; got ${String(x)}`, { value: x });
  }
  const maxEdge = o.maxEdge ?? Infinity;
  if (!(maxEdge > 0))
    fail('unsupported', `maxEdge must be > 0; got ${String(o.maxEdge)}`, { value: o.maxEdge });
  const minEdge = o.minEdge ?? o.chordTol;
  if (!(minEdge >= 0) || !Number.isFinite(minEdge))
    fail('unsupported', `minEdge must be a finite number ≥ 0; got ${String(o.minEdge)}`, {
      value: o.minEdge,
    });
  const nDer = o.nDer ?? 2;
  if (!(nDer === 0 || nDer === 1 || nDer === 2))
    fail('unsupported', `nDer must be 0, 1 or 2; got ${String(nDer)}`);
  return { chordTol: o.chordTol, angleTol: o.angleTol, maxEdge, minEdge, nDer };
}

function failure(message: string, more: readonly GeomIssue[] = []): Result<FaceMesh> {
  return errResult([{ code: 'tessellation-failure', severity: 'error', message }, ...more]);
}

/** Growable per-vertex cache: position + normal (6) and a regular-normal flag. */
interface VCache {
  pn: Float64Array;
  ok: Uint8Array;
}

function cacheVertex(ctx: Ctx, st: CdtState, vc: VCache, v: number): void {
  if (vc.ok.length <= v) {
    const cap = Math.max(v + 1, 2 * vc.ok.length);
    const pnv = new Float64Array(6 * cap);
    pnv.set(vc.pn);
    const ok = new Uint8Array(cap);
    ok.set(vc.ok);
    vc.pn = pnv;
    vc.ok = ok;
  }
  vc.ok[v] = pn(ctx, st.x[v]! / ctx.su, st.y[v]! / ctx.sv, vc.pn, 6 * v) ? 1 : 0;
}

/**
 * Triangulates a trimmed surface to the given tolerances (module comment).
 * `boundary` replaces the sampling of the loops by the caller's samples.
 * Errors: `tessellation-failure` (with the CDT's issue) when the boundary
 * polylines cross or are inconsistently oriented. A warning reports a chord
 * error left above `chordTol` where refinement reached rounding.
 */
export function tessellateTrimmedSurface(
  ts: TrimmedSurface,
  opts: TessellationOptions,
  boundary?: BoundarySamples,
): Result<FaceMesh> {
  checkSurfaceShape(ts.surface);
  const o = checkOptions(opts);
  const s = ts.surface;
  const t = resolveTolerances();
  const ctx: Ctx = {
    s,
    t,
    chordTol: o.chordTol,
    angleTol: o.angleTol,
    maxEdge: o.maxEdge,
    minEdge: o.minEdge,
    sc: makeScratch(Math.max(s.u.degree, s.v.degree), 1),
    su: 1,
    sv: 1,
  };
  const grid = seedGrid(ctx);
  // Boundary samples.
  let samples: Sample[];
  let loopStarts: number[];
  let loopCurves: number[] = [];
  let edgeIds: ArrayLike<number> | undefined;
  if (boundary !== undefined) {
    const uv = boundary.uv;
    const ls = Array.from(boundary.loopStarts);
    const n = uv.length / 2;
    if (!Number.isInteger(n) || ls.length < 2 || ls[0] !== 0 || ls[ls.length - 1] !== n) {
      fail(
        'size-mismatch',
        'boundary: uv must hold pairs and loopStarts run from 0 to the sample count',
      );
    }
    for (let k = 1; k < ls.length; k++) {
      if (!(ls[k]! - ls[k - 1]! >= 3))
        fail('too-few-points', `boundary loop ${k - 1} needs at least 3 samples`);
    }
    for (let i = 0; i < uv.length; i++)
      if (!Number.isFinite(uv[i]!)) fail('non-finite', `boundary uv ${i} is not finite`);
    if (boundary.edges !== undefined && boundary.edges.length !== n) {
      fail('size-mismatch', `boundary edges needs ${n} entries; got ${boundary.edges.length}`);
    }
    samples = [];
    for (let k = 0; k < n; k++) samples.push({ u: uv[2 * k]!, v: uv[2 * k + 1]!, curve: -1, t: 0 });
    loopStarts = ls;
    edgeIds = boundary.edges;
  } else {
    ({ samples, loopStarts, loopCurves } = sampleLoops(ctx, ts, grid));
  }
  // Seeds: interior grid nodes not too close to the boundary.
  const { us, vs } = grid;
  const nu = us.length;
  const nv = vs.length;
  const drop = new Uint8Array(nu * nv);
  const halfSpacing = (i: number, j: number): number =>
    0.5 *
    Math.min(
      (us[Math.min(i + 1, nu - 1)]! - us[Math.max(i - 1, 0)]!) * 0.5 * ctx.su,
      (vs[Math.min(j + 1, nv - 1)]! - vs[Math.max(j - 1, 0)]!) * 0.5 * ctx.sv,
      (i + 1 < nu ? us[i + 1]! - us[i]! : Infinity) * ctx.su,
      (i > 0 ? us[i]! - us[i - 1]! : Infinity) * ctx.su,
      (j + 1 < nv ? vs[j + 1]! - vs[j]! : Infinity) * ctx.sv,
      (j > 0 ? vs[j]! - vs[j - 1]! : Infinity) * ctx.sv,
    );
  let rMax = 0;
  for (let i = 1; i < nu; i++) rMax = Math.max(rMax, 0.5 * (us[i]! - us[i - 1]!) * ctx.su);
  for (let j = 1; j < nv; j++) rMax = Math.max(rMax, 0.5 * (vs[j]! - vs[j - 1]!) * ctx.sv);
  for (let l = 0; l + 1 < loopStarts.length; l++) {
    const a0 = loopStarts[l]!;
    const a1 = loopStarts[l + 1]!;
    for (let k = a0; k < a1; k++) {
      const A = samples[k]!;
      const B = samples[k + 1 < a1 ? k + 1 : a0]!;
      const ax = A.u * ctx.su;
      const ay = A.v * ctx.sv;
      const bx = B.u * ctx.su;
      const by = B.v * ctx.sv;
      const i0 = cellOf(us, (Math.min(ax, bx) - rMax) / ctx.su);
      const i1 = cellOf(us, (Math.max(ax, bx) + rMax) / ctx.su) + 1;
      const j0 = cellOf(vs, (Math.min(ay, by) - rMax) / ctx.sv);
      const j1 = cellOf(vs, (Math.max(ay, by) + rMax) / ctx.sv) + 1;
      for (let i = i0; i <= Math.min(i1, nu - 1); i++) {
        for (let j = j0; j <= Math.min(j1, nv - 1); j++) {
          const px = us[i]! * ctx.su;
          const py = vs[j]! * ctx.sv;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          let w = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
          w = w < 0 ? 0 : w > 1 ? 1 : w;
          if (Math.hypot(px - ax - w * dx, py - ay - w * dy) < halfSpacing(i, j))
            drop[i * nv + j] = 1;
        }
      }
    }
  }
  const pts: number[] = [];
  for (const sm of samples) pts.push(sm.u * ctx.su, sm.v * ctx.sv);
  for (let i = 1; i + 1 < nu; i++) {
    for (let j = 1; j + 1 < nv; j++) {
      if (!drop[i * nv + j]) pts.push(us[i]! * ctx.su, vs[j]! * ctx.sv);
    }
  }
  const segs: number[] = [];
  for (let l = 0; l + 1 < loopStarts.length; l++) {
    const a0 = loopStarts[l]!;
    const a1 = loopStarts[l + 1]!;
    for (let k = a0; k < a1; k++) segs.push(k, k + 1 < a1 ? k + 1 : a0);
  }
  const built = buildCdt({ points: pts, segments: segs }, 'error');
  if (!built.ok) return failure('the boundary polylines cannot be triangulated', built.issues);
  const st = built.value.st;
  const { consistent, windings } = classifyRegions(st);
  if (!consistent || [...windings].some((w) => w !== 0 && w !== 1)) {
    return failure(
      `boundary loops bound regions of winding ${[...windings].sort().join(', ')}: outer loops must be counter-clockwise and holes clockwise`,
    );
  }
  const vc: VCache = { pn: new Float64Array(6 * st.nv), ok: new Uint8Array(st.nv) };
  for (let v = 0; v < st.nv; v++) cacheVertex(ctx, st, vc, v);
  const maxErr = refine(ctx, st, vc);
  return okResult(
    ...assemble(
      ctx,
      st,
      samples,
      { loopStarts, loopCurves, naturalOuter: ts.outer === null },
      edgeIds,
      boundary === undefined,
      o.nDer,
      maxErr,
    ),
  );
}

/** Refines (module comment, step 4); returns the largest measured chord error of the final mesh. */
/** Interior knot lines (distinct breakpoints without the domain ends), in scaled coordinates. */
function interiorKnots(b: Basis, scale: number): number[] {
  const br = spanBreaks(b);
  return br.slice(1, -1).map((k) => k * scale);
}

/**
 * Where to split the edge `a`–`b`: on the knot line it crosses nearest its
 * midpoint, if it crosses one, else at the midpoint. The surface is only
 * piecewise smooth across knot lines (a crease at a C0 knot): vertices on the
 * line let edges align with it instead of straddling it, which no amount of
 * midpoint splitting achieves. The point's knot coordinate is exact (scaled by
 * a power of two), the other interpolated along the edge.
 */
function splitPoint(
  st: CdtState,
  a: number,
  b: number,
  kx: readonly number[],
  ky: readonly number[],
): [number, number] {
  const xa = st.x[a]!;
  const ya = st.y[a]!;
  const xb = st.x[b]!;
  const yb = st.y[b]!;
  let best: [number, number] | null = null;
  let bestOff = Infinity;
  const scan = (ks: readonly number[], p0: number, p1: number, onX: boolean): void => {
    const lo = Math.min(p0, p1);
    const hi = Math.max(p0, p1);
    for (const k of ks) {
      if (!(k > lo && k < hi)) continue;
      const f = (k - p0) / (p1 - p0);
      const off = Math.abs(f - 0.5);
      if (off < bestOff) {
        bestOff = off;
        best = onX ? [k, ya + f * (yb - ya)] : [xa + f * (xb - xa), k];
      }
    }
  };
  scan(kx, xa, xb, true);
  scan(ky, ya, yb, false);
  return best ?? [0.5 * (xa + xb), 0.5 * (ya + yb)];
}

function refine(ctx: Ctx, st: CdtState, vc: VCache): number {
  const knotsX = interiorKnots(ctx.s.u, ctx.su);
  const knotsY = interiorKnots(ctx.s.v, ctx.sv);
  const onKnotX = new Set(knotsX);
  const onKnotY = new Set(knotsY);
  const NA = new Float64Array(6);
  const NB = new Float64Array(6);
  /**
   * The normal at `v` seen from the edge towards `w` into `buf` (offset
   * returned): the cached one unless `v` lies on a knot line, where the
   * one-sided normal facing `w` is evaluated. Returns −1 where degenerate.
   */
  const edgeNormal = (v: number, w: number, buf: Float64Array): [Float64Array, number] => {
    if (!onKnotX.has(st.x[v]!) && !onKnotY.has(st.y[v]!)) {
      return [vc.pn, vc.ok[v] ? 6 * v + 3 : -1];
    }
    const side = sideToward(st.x[v]!, st.y[v]!, st.x[w]!, st.y[w]!);
    const ok = pn(ctx, st.x[v]! / ctx.su, st.y[v]! / ctx.sv, buf, 0, side);
    return [buf, ok ? 3 : -1];
  };
  /** Angle between the edge's end normals (one-sided on knot lines); 0 where one is degenerate. */
  const edgeAngle = (a: number, b: number): number => {
    const [ba, oa] = edgeNormal(a, b, NA);
    const [bb, ob] = edgeNormal(b, a, NB);
    return oa < 0 || ob < 0 ? 0 : angle(ba, oa, bb, ob);
  };
  let checked = new Uint32Array(st.alive.length);
  let err = new Float64Array(st.alive.length);
  const P = new Float64Array(6);
  const uvOf = (v: number): [number, number] => [st.x[v]! / ctx.su, st.y[v]! / ctx.sv];
  for (;;) {
    if (checked.length < st.alive.length) {
      const c = new Uint32Array(st.alive.length);
      c.set(checked);
      checked = c;
      const e = new Float64Array(st.alive.length);
      e.set(err);
      err = e;
    }
    const edgeErr = new Map<number, number>();
    const failing = new Set<number>();
    const cands: number[] = [];
    const nt = st.nt;
    for (let tr = 0; tr < nt; tr++) {
      if (!st.alive[tr] || st.region[tr] !== 1 || isGhost(st, tr) || checked[tr] === st.ver[tr])
        continue;
      checked[tr] = st.ver[tr]!;
      let worst = 0;
      let edgeFails = false;
      for (let k = 0; k < 3; k++) {
        const e = 3 * tr + k;
        const a = st.tri[e]!;
        const b = st.tri[next(e)]!;
        const key = a < b ? a * 67108864 + b : b * 67108864 + a;
        let d = edgeErr.get(key);
        if (d === undefined) {
          const [ua, va] = uvOf(a);
          const [ub, vb] = uvOf(b);
          pn(ctx, 0.5 * (ua + ub), 0.5 * (va + vb), P, 0);
          d = chordDev(vc.pn, 6 * a, vc.pn, 6 * b, P, 0);
          edgeErr.set(key, d);
          if (!st.cons[e]) {
            const [mx, my] = splitPoint(st, a, b, knotsX, knotsY);
            const splittable =
              (mx !== st.x[a] || my !== st.y[a]) && (mx !== st.x[b] || my !== st.y[b]);
            const bad =
              d > ctx.chordTol ||
              (dist3(vc.pn, 6 * a, vc.pn, 6 * b) > ctx.minEdge && edgeAngle(a, b) > ctx.angleTol) ||
              dist3(vc.pn, 6 * a, vc.pn, 6 * b) > ctx.maxEdge;
            if (bad && splittable) {
              failing.add(key);
              cands.push(mx, my);
            }
          }
        }
        if (failing.has(key)) edgeFails = true;
        if (d > worst) worst = d;
      }
      if (!edgeFails) {
        const a = st.tri[3 * tr]!;
        const b = st.tri[3 * tr + 1]!;
        const c = st.tri[3 * tr + 2]!;
        const cx = (st.x[a]! + st.x[b]! + st.x[c]!) / 3;
        const cy = (st.y[a]! + st.y[b]! + st.y[c]!) / 3;
        pn(ctx, cx / ctx.su, cy / ctx.sv, P, 0);
        let d = 0;
        for (let k = 0; k < 3; k++) {
          d += ((vc.pn[6 * a + k]! + vc.pn[6 * b + k]! + vc.pn[6 * c + k]!) / 3 - P[k]!) ** 2;
        }
        d = Math.sqrt(d);
        if (d > worst) worst = d;
        if (d > ctx.chordTol) cands.push(cx, cy);
      }
      err[tr] = worst;
    }
    if (cands.length === 0) break;
    let inserted = 0;
    for (let k = 0; k < cands.length; k += 2) {
      const v = insertSteiner(st, cands[k]!, cands[k + 1]!, 1);
      if (v >= 0) {
        cacheVertex(ctx, st, vc, v);
        inserted++;
      }
    }
    if (inserted === 0) break;
  }
  let maxErr = 0;
  for (let tr = 0; tr < st.nt; tr++) {
    if (st.alive[tr] && st.region[tr] === 1 && !isGhost(st, tr) && err[tr]! > maxErr)
      maxErr = err[tr]!;
  }
  return maxErr;
}

/** Builds the face mesh from the refined state. */
function assemble(
  ctx: Ctx,
  st: CdtState,
  samples: readonly Sample[],
  loops: {
    readonly loopStarts: readonly number[];
    readonly loopCurves: readonly number[];
    readonly naturalOuter: boolean;
  },
  edgeIds: ArrayLike<number> | undefined,
  fromTrim: boolean,
  nDer: 0 | 1 | 2,
  maxErr: number,
): [FaceMesh, GeomIssue[]] {
  const s = ctx.s;
  const used = new Uint8Array(st.nv);
  const tris: number[] = [];
  for (let tr = 0; tr < st.nt; tr++) {
    if (!st.alive[tr] || st.region[tr] !== 1 || isGhost(st, tr)) continue;
    for (let k = 0; k < 3; k++) {
      const v = st.tri[3 * tr + k]!;
      used[v] = 1;
      tris.push(v);
    }
  }
  const ids: number[] = [];
  for (let v = 0; v < st.nv; v++) if (used[v]) ids.push(v);
  const su = new Int32Array(st.nv);
  const sv = new Int32Array(st.nv);
  for (const v of ids) {
    su[v] = spanOf(s.u, sanitizeParam(s.u, st.x[v]! / ctx.su), false);
    sv[v] = spanOf(s.v, sanitizeParam(s.v, st.y[v]! / ctx.sv), false);
  }
  ids.sort((a, b) => su[a]! - su[b]! || sv[a]! - sv[b]! || a - b);
  const newId = new Int32Array(st.nv).fill(-1);
  ids.forEach((v, i) => (newId[v] = i));
  const n = ids.length;
  const uv = new Float64Array(2 * n);
  const boundaryEdge = new Int32Array(n).fill(-1);
  const boundaryParam = new Float64Array(n);
  ids.forEach((v, i) => {
    uv[2 * i] = st.x[v]! / ctx.su;
    uv[2 * i + 1] = st.y[v]! / ctx.sv;
    if (v < samples.length) {
      const sm = samples[v]!;
      boundaryEdge[i] = edgeIds !== undefined ? edgeIds[v]! : sm.curve;
      boundaryParam[i] = sm.t;
    }
  });
  const triangles = new Uint32Array(tris.length);
  for (let k = 0; k < tris.length; k++) triangles[k] = newId[tris[k]!]!;
  const loopVertices = new Uint32Array(samples.length);
  for (let k = 0; k < samples.length; k++) loopVertices[k] = newId[k]!;
  const outputs = evaluate(s, uv, nDer);
  const issues: GeomIssue[] = [];
  if (maxErr > ctx.chordTol) {
    issues.push({
      code: 'tessellation-failure',
      severity: 'warning',
      message: `refinement stopped with chord error ${maxErr} above chordTol ${ctx.chordTol} (parameter rounding reached or points not insertable)`,
      value: maxErr,
    });
  }
  const mesh: FaceMesh = Object.freeze({
    uv,
    triangles,
    boundaryEdge,
    boundaryParam,
    loopVertices,
    loopStarts: Uint32Array.from(loops.loopStarts),
    boundarySource: fromTrim ? ('trim' as const) : ('caller' as const),
    naturalOuter: loops.naturalOuter,
    loopCurves: Uint32Array.from(loops.loopCurves),
    ...outputs,
    maxChordError: maxErr,
  });
  return [mesh, issues];
}

/** Plan and outputs over `uv`. */
function evaluate(
  s: NurbsSurface,
  uv: Float64Array,
  nDer: 0 | 1 | 2,
): Pick<FaceMesh, 'plan' | 'position' | 'normal' | 'curvature' | 'flags'> {
  const n = uv.length / 2;
  const plan = planSurfaceSamples(s, uv, nDer);
  const position = new Float64Array(3 * n);
  const normal = new Float64Array(nDer >= 1 ? 3 * n : 0);
  const curvature = new Float64Array(nDer === 2 ? 2 * n : 0);
  const flags = new Uint8Array(n);
  evalSurfacePlan(
    plan,
    s,
    {
      position,
      ...(nDer >= 1 ? { normal } : {}),
      ...(nDer === 2 ? { curvature } : {}),
      flags,
    },
    makeScratch(Math.max(s.u.degree, s.v.degree), nDer),
  );
  return { plan, position, normal, curvature, flags };
}

/**
 * Moves a mesh onto changed trim loops without changing its topology (design
 * §11.5 step 6): boundary vertices keep their trim parameters and take the new
 * curves' points there (a natural boundary keeps its (u, v)); interior vertices
 * keep their (u, v). Returns `null` when a triangle would flip or degenerate
 * (exact `orient2d` in (u, v)) or the loops no longer match the mesh's
 * (`naturalOuter`, curve counts per loop `loopCurves`): then re-tessellate. Chord accuracy is not
 * re-measured (`maxChordError` is the source's). Needs a mesh sampled from the
 * trim loops (`boundarySource: 'trim'`).
 */
export function retargetTessellation(mesh: FaceMesh, ts: TrimmedSurface): FaceMesh | null {
  checkSurfaceShape(ts.surface);
  if (mesh.boundarySource !== 'trim') {
    fail('unsupported', 'retargetTessellation needs a mesh sampled from the trim loops');
  }
  const s = ts.surface;
  const natural = ts.outer === null;
  const loops: TrimLoop[] = natural ? [rectangleLoop(s), ...ts.holes] : loopsOf(ts);
  // Same loop structure: natural or not, and the same curve count per loop
  // (else a boundary vertex's curve id would name another loop's curve).
  if (natural !== mesh.naturalOuter || loops.length !== mesh.loopCurves.length) return null;
  if (loops.some((l, li) => l.curves.length !== mesh.loopCurves[li])) return null;
  const curves: { c: ClampedCurve<2>; keep: boolean }[] = [];
  loops.forEach((l, li) => l.curves.forEach((c) => curves.push({ c, keep: natural && li === 0 })));
  const uv = Float64Array.from(mesh.uv);
  const sc = makeScratch(Math.max(...curves.map((x) => x.c.basis.degree)), 0);
  const cv = new Float64Array(2);
  for (let k = 0; k < mesh.loopVertices.length; k++) {
    const v = mesh.loopVertices[k]!;
    const g = mesh.boundaryEdge[v]!;
    const entry = curves[g];
    if (entry === undefined) return null;
    if (entry.keep) continue;
    const c = entry.c;
    const x = mesh.boundaryParam[v]!;
    const [a, b] = c.basis.domain;
    if (!(x >= a && x <= b)) return null;
    if (x === a) {
      uv[2 * v] = c.cw[0]! / c.cw[2]!;
      uv[2 * v + 1] = c.cw[1]! / c.cw[2]!;
    } else {
      curveEvalInto(c, x, 0, cv, 0, sc);
      uv[2 * v] = cv[0]!;
      uv[2 * v + 1] = cv[1]!;
    }
  }
  const pred = makePredicates();
  const T = mesh.triangles;
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i]!;
    const b = T[i + 1]!;
    const c = T[i + 2]!;
    if (
      !(
        pred.orient2d(
          uv[2 * a]!,
          uv[2 * a + 1]!,
          uv[2 * b]!,
          uv[2 * b + 1]!,
          uv[2 * c]!,
          uv[2 * c + 1]!,
        ) > 0
      )
    ) {
      return null;
    }
  }
  const outputs = evaluate(s, uv, mesh.plan.nDer);
  return Object.freeze({ ...mesh, uv, ...outputs });
}
