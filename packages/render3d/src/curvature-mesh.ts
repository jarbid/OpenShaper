// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The hull's exact curvature, tessellated for the 3D view's analysis modes.
 *
 * Pure (no three.js, no DOM): the tessellation worker runs it, and the tests run
 * it directly.
 *
 * ## What is measured
 *
 * Not the viewport mesh. That mesh's normals are averaged from flat faces, so any
 * curvature read off it depends on triangle size and cannot tell a smooth join
 * from a break. This fits the hull with `fitBoardSurface` — the same B-spline
 * surface the STEP export writes, within its tolerance of the loft — and evaluates
 * principal curvatures analytically at every vertex.
 *
 * ## Where the vertices go
 *
 * A row at every distinct u-knot, with the spans between subdivided to about
 * {@link U_STEP} along the board, and a column at every v-knot with each span
 * halved. Between knots the surface is one polynomial and the colour varies
 * smoothly, so linear interpolation across a triangle is honest there; at a knot
 * it is not, so a knot is never inside a triangle.
 *
 * The fit carries a knot of multiplicity 3 at every real cross-section: the loft
 * blends stations linearly, so the hull has a tangent break there. Such a knot
 * gets TWO rows at the same place, one evaluated from each side
 * (`KnotSide`), and no triangles between them — so the jump in curvature at a
 * station shows as a crisp edge exactly on the station rather than a smear one
 * row wide. Any knot where the surface is less than C2 (multiplicity ≥ degree - 1)
 * is treated the same way.
 *
 * ## The two halves and the ends
 *
 * The -Y patch is the +Y patch mirrored, exactly (`mirrorSurface`), and mirroring
 * preserves curvature when the normal is mirrored with it, so it is built by
 * mirroring the +Y vertices rather than evaluated twice. The tests check that
 * against evaluating `model.minus` directly. The end caps are plain planar fans
 * with no curvature data; the view shades them neutrally.
 */
import {
  HULL_ORIENTATION,
  curvaturesFromDerivs,
  evalSurfaceDeriv2,
  evalSurfaceDeriv2Grid,
  fitBoardSurface,
  hasTailCutout,
  knotMultiplicities,
  type BezierBoard,
  type BoardSurfaceModel,
  type BSplineSurface,
  type GridParam,
} from '@openshaper/kernel';

/** Largest step between rows along the board, in cm, inside one knot span. */
export const U_STEP = 1;
/** Columns per v-knot span. The ring knots already cluster at the rail apex. */
export const V_SUBDIVISIONS = 2;
/**
 * Radii are capped here (cm) so a flat spot stays a finite number on the GPU. A
 * hundred metres is flat for any purpose on a surfboard.
 */
export const MAX_RADIUS = 1e4;
/**
 * Area-weighted percentiles behind the display scales.
 *
 * Not the extremes: the single most curved point — a pinched tip, the last
 * millimetre of a nose — would set the scale and wash everything else out to grey.
 * And not the 95th percentile either, which sounds robust but on a surfboard lands
 * on the rails: they are a tenth or more of the area and fifty times as curved as
 * the deck and bottom, so a ±95% scale paints the whole deck and bottom flat grey
 * and hides exactly the jumps at the stations this view exists to show. At the
 * 80th, the broad surfaces fill the ramp and the rails saturate — rail curvature is
 * what the rail-radius mode is for. (Measured on the golden boards: |H| is about
 * 0.003/cm at the median, 0.01 at the 80th percentile and 0.25 at the 95th.)
 */
export const SCALE_PERCENTILE = 0.8;
/** Rail radius: the tight end of the ramp, and where it reaches the flat end. */
export const RADIUS_PERCENTILES: readonly [tight: number, flat: number] = [0.02, 0.5];

/** Robust display scales for the three modes. */
export interface CurvatureScale {
  /** Symmetric limit for mean curvature, 1/cm. Colours saturate at ±this. */
  readonly mean: number;
  /**
   * Symmetric limit for Gaussian curvature, 1/cm². The view maps Gaussian
   * curvature through `sign(K)·sqrt(|K|)` — one over the radius of a ball that
   * curved — so it saturates at ±`sqrt(gaussian)` on that scale.
   */
  readonly gaussian: number;
  /** Rail radius range, cm: tightest colour at or below [0], lightest at or above [1]. */
  readonly radius: readonly [number, number];
}

export interface CurvatureMesh {
  /** Vertex positions, board cm (tail at x = 0), not centred. */
  readonly positions: Float32Array;
  /** Exact outward unit normals. */
  readonly normals: Float32Array;
  /** Mean curvature, 1/cm, positive where convex. */
  readonly mean: Float32Array;
  /** Gaussian curvature, 1/cm²: positive on a dome, negative on a saddle. */
  readonly gaussian: Float32Array;
  /** Minimum radius of curvature, 1/max(|k1|, |k2|), cm, capped at {@link MAX_RADIUS}. */
  readonly minRadius: Float32Array;
  readonly indices: Uint32Array;
  /** The first this-many indices are the hull; the end caps follow. */
  readonly hullIndexCount: number;
  readonly scale: CurvatureScale;
  /** Grid rows along the board (a crease counts twice), for diagnostics and tests. */
  readonly rows: number;
  /** Grid columns around one half-ring. */
  readonly cols: number;
  /** Knots sampled from both sides: the station creases. */
  readonly creases: number;
}

/**
 * Sample parameters along one direction: every distinct knot, `parts(a, b)`
 * subdivisions of each span, and every interior knot of multiplicity
 * `degree - 1` or more twice — from below, then from above.
 */
export const gridParams = (
  knots: readonly number[],
  degree: number,
  parts: (a: number, b: number) => number,
): Required<GridParam>[] => {
  const { values, mults } = knotMultiplicities(knots);
  const out: Required<GridParam>[] = [];
  for (let i = 0; i < values.length; i++) {
    const k = values[i]!;
    const interior = i > 0 && i < values.length - 1;
    if (interior && mults[i]! >= degree - 1) {
      out.push({ t: k, side: 'below' }, { t: k, side: 'above' });
    } else {
      out.push({ t: k, side: i === values.length - 1 ? 'below' : 'above' });
    }
    if (i === values.length - 1) break;
    const next = values[i + 1]!;
    const n = Math.max(1, parts(k, next));
    for (let s = 1; s < n; s++) out.push({ t: k + ((next - k) * s) / n, side: 'above' });
  }
  return out;
};

/** True for two consecutive params that are the two sides of one break. */
const isBreak = (a: GridParam, b: GridParam) => a.t === b.t;

/** Histogram resolution of {@link weightedQuantiles}: bins per factor of two (~1% error). */
const BINS_PER_OCTAVE = 32;
const MIN_LOG2 = -64;
const MAX_LOG2 = 32;

/**
 * Weighted quantiles of non-negative `values` (magnitudes, radii), one per `qs`.
 *
 * A log-spaced histogram rather than a sort: these feed a colour scale, where 1%
 * is invisible, and the curvature of a board spans eight orders of magnitude, so
 * linear bins would not do. O(n) instead of a 40 ms comparator sort per quantity.
 * Zero (and anything below 2^-64) counts in the lowest bin; entries with no
 * weight or a non-finite value are skipped.
 */
export const weightedQuantiles = (
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  qs: readonly number[],
): number[] => {
  const bins = (MAX_LOG2 - MIN_LOG2) * BINS_PER_OCTAVE;
  const hist = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]!;
    const x = values[i]!;
    if (!(w > 0) || !Number.isFinite(x)) continue;
    const b = x > 0 ? Math.floor((Math.log2(x) - MIN_LOG2) * BINS_PER_OCTAVE) : 0;
    const k = Math.max(0, Math.min(bins - 1, b));
    hist[k] = hist[k]! + w;
    total += w;
  }
  return qs.map((q) => {
    if (!(total > 0)) return 0;
    const target = q * total;
    let acc = 0;
    let b = 0;
    for (; b < bins - 1; b++) {
      acc += hist[b]!;
      if (acc >= target) break;
    }
    // The bin's geometric centre.
    return 2 ** (MIN_LOG2 + (b + 0.5) / BINS_PER_OCTAVE);
  });
};

/**
 * Tessellate a fitted hull with exact curvature at every vertex.
 *
 * `uStep` and `vSubdivisions` set the density; the defaults give a mesh of the
 * same order as the viewport's standard one (about 25k vertices per half on the
 * golden boards).
 */
export const curvatureMesh = (
  model: BoardSurfaceModel,
  { uStep = U_STEP, vSubdivisions = V_SUBDIVISIONS } = {},
): CurvatureMesh => {
  const s: BSplineSurface = model.plus;
  // x depends on u alone (every fitted row is a station plane), so the bottom
  // centreline reads it off.
  const xAt = (u: number) => evalSurfaceDeriv2(s, u, 0).point.x;
  const us = gridParams(s.uKnots, s.uDegree, (a, b) => Math.ceil((xAt(b) - xAt(a)) / uStep));
  const vs = gridParams(s.vKnots, s.vDegree, () => vSubdivisions);
  const rows = us.length;
  const cols = vs.length;
  const half = rows * cols;

  // Two hull halves, then two caps of (cols + 1) vertices each (ring + centre)
  // per side of the stringer: each cap ring is the +Y and -Y boundary rows.
  const capVerts = 2 * (2 * cols + 1);
  const total = 2 * half + capVerts;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const mean = new Float32Array(total);
  const gaussian = new Float32Array(total);
  const minRadius = new Float32Array(total).fill(MAX_RADIUS);

  const put = (vi: number, x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions[3 * vi] = x;
    positions[3 * vi + 1] = y;
    positions[3 * vi + 2] = z;
    normals[3 * vi] = nx;
    normals[3 * vi + 1] = ny;
    normals[3 * vi + 2] = nz;
  };

  evalSurfaceDeriv2Grid(s, us, vs, (r, c, d) => {
    let k = curvaturesFromDerivs(d, HULL_ORIENTATION.plus);
    if (!k) {
      // Degenerate (S_u x S_v vanishes): take the limit from just inside.
      const u = us[r]!.t;
      const v = vs[c]!.t;
      k = curvaturesFromDerivs(
        evalSurfaceDeriv2(s, u + (u < 0.5 ? 1e-7 : -1e-7), v + (v < 0.5 ? 1e-7 : -1e-7), {
          uSide: us[r]!.side,
          vSide: vs[c]!.side,
        }),
        HULL_ORIENTATION.plus,
      );
    }
    const vi = r * cols + c;
    const p = d.point;
    const n = k?.normal ?? { x: 0, y: 0, z: vs[c]!.t < 0.5 ? -1 : 1 };
    put(vi, p.x, p.y, p.z, n.x, n.y, n.z);
    // The -Y half: mirrored position and normal, the same curvature.
    put(half + vi, p.x, -p.y, p.z, n.x, -n.y, n.z);
    if (k) {
      const kmax = Math.max(Math.abs(k.k1), Math.abs(k.k2));
      const radius = kmax > 1 / MAX_RADIUS ? 1 / kmax : MAX_RADIUS;
      mean[vi] = mean[half + vi] = k.mean;
      gaussian[vi] = gaussian[half + vi] = k.gaussian;
      minRadius[vi] = minRadius[half + vi] = radius;
    }
  });

  // --- hull triangles, with per-vertex area for the robust scales ---
  const tris: number[] = [];
  const area = new Float64Array(total);
  const tri = (a: number, b: number, c: number) => {
    tris.push(a, b, c);
    const ax = positions[3 * a]!;
    const ay = positions[3 * a + 1]!;
    const az = positions[3 * a + 2]!;
    const ux = positions[3 * b]! - ax;
    const uy = positions[3 * b + 1]! - ay;
    const uz = positions[3 * b + 2]! - az;
    const wx = positions[3 * c]! - ax;
    const wy = positions[3 * c + 1]! - ay;
    const wz = positions[3 * c + 2]! - az;
    const third = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 6;
    area[a] = area[a]! + third;
    area[b] = area[b]! + third;
    area[c] = area[c]! + third;
  };
  for (const base of [0, half]) {
    // On +Y, S_u x S_v points inward (HULL_ORIENTATION.plus), so the quad's
    // (u, v) order is reversed to face out; the mirror reverses it back.
    const flip = base === 0;
    for (let r = 0; r < rows - 1; r++) {
      if (isBreak(us[r]!, us[r + 1]!)) continue;
      for (let c = 0; c < cols - 1; c++) {
        if (isBreak(vs[c]!, vs[c + 1]!)) continue;
        const a = base + r * cols + c;
        const b = base + (r + 1) * cols + c;
        const d = base + r * cols + c + 1;
        const e = base + (r + 1) * cols + c + 1;
        if (flip) {
          tri(a, e, b);
          tri(a, d, e);
        } else {
          tri(a, b, e);
          tri(a, e, d);
        }
      }
    }
  }
  const hullIndexCount = tris.length;

  // --- end caps: a fan from the ring's centroid, wound to face along ±x ---
  let vi = 2 * half;
  for (const [row, dir] of [
    [0, model.end0.dir],
    [rows - 1, model.end1.dir],
  ] as const) {
    // The closed boundary: +Y bottom→deck, then -Y deck→bottom.
    const ring: number[] = [];
    for (let c = 0; c < cols; c++) ring.push(row * cols + c);
    for (let c = cols - 1; c >= 0; c--) ring.push(half + row * cols + c);
    const start = vi;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const src of ring.slice(0, 2 * cols)) {
      cx += positions[3 * src]!;
      cy += positions[3 * src + 1]!;
      cz += positions[3 * src + 2]!;
    }
    cx /= 2 * cols;
    cy /= 2 * cols;
    cz /= 2 * cols;
    put(vi++, cx, cy, cz, dir, 0, 0);
    for (const src of ring) {
      put(vi++, positions[3 * src]!, positions[3 * src + 1]!, positions[3 * src + 2]!, dir, 0, 0);
    }
    // Signed area of the ring in (y, z): its sign says which way the fan winds.
    let signed = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      signed +=
        positions[3 * p + 1]! * positions[3 * q + 2]! -
        positions[3 * q + 1]! * positions[3 * p + 2]!;
    }
    const forward = signed * dir > 0;
    for (let i = 0; i < ring.length; i++) {
      const a = start + 1 + i;
      const b = start + 1 + ((i + 1) % ring.length);
      if (forward) tris.push(start, a, b);
      else tris.push(start, b, a);
    }
  }

  // --- robust scales, from the hull alone ---
  const hull = 2 * half;
  const hullArea = area.subarray(0, hull);
  const magnitudes = (a: Float32Array) => Float64Array.from(a.subarray(0, hull), Math.abs);
  const [meanLimit] = weightedQuantiles(magnitudes(mean), hullArea, [SCALE_PERCENTILE]);
  const [gaussLimit] = weightedQuantiles(magnitudes(gaussian), hullArea, [SCALE_PERCENTILE]);
  const [tight, flat] = weightedQuantiles(
    minRadius.subarray(0, hull),
    hullArea,
    RADIUS_PERCENTILES,
  );
  const scale: CurvatureScale = {
    mean: meanLimit!,
    gaussian: gaussLimit!,
    radius: [tight!, flat!],
  };

  return {
    positions,
    normals,
    mean,
    gaussian,
    minRadius,
    indices: Uint32Array.from(tris),
    hullIndexCount,
    scale,
    rows,
    cols,
    creases: us.filter((p, i) => i > 0 && isBreak(us[i - 1]!, p)).length,
  };
};

/** Why a board has no exact curvature analysis, or null when it has one. */
export const curvatureUnsupported = (board: BezierBoard): string | null =>
  hasTailCutout(board.outline) ? 'concave-tail' : null;

/**
 * Fit the board and tessellate it with curvature: the worker's whole job.
 *
 * Throws for a concave (swallow / fish) tail, which the fit does not model, and
 * for a board too degenerate to fit; the worker reports either as an error.
 */
export const boardCurvatureMesh = (board: BezierBoard): CurvatureMesh => {
  if (curvatureUnsupported(board)) {
    throw new Error('Exact curvature is not available for concave (swallow / fish) tails');
  }
  return curvatureMesh(fitBoardSurface(board));
};

/** The typed arrays of a result, for a zero-copy transfer out of the worker. */
export const curvatureTransferables = (m: CurvatureMesh): ArrayBuffer[] =>
  [m.positions, m.normals, m.mean, m.gaussian, m.minRadius, m.indices].map(
    (a) => a.buffer as ArrayBuffer,
  );
