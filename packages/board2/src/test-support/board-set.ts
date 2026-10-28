// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: the set of boards the review-fix tests run over (the three converted goldens, a classic
 * swallow and a classic fish made from the shortboard, and the three test boards), and a few
 * measurements of a built board that more than one test needs.
 */
import { board, crossSection, knotFromArray, loftRing, splineFromKnots } from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import { convertClassic } from '../classic';
import { buildBoard, createEvaluator, MEASURE } from '../surface';
import type { BuiltBoard, SurfaceEvaluator } from '../surface';
import { asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import { classicNotched, GOLDENS } from './classic-samples';
import { nurbsRing, polylineHausdorff } from './mesh-checks';
import type { V3 } from './mesh-checks';

export interface NamedBoard {
  readonly name: string;
  readonly doc: BoardDoc;
  /** The classic board a converted document came from. */
  readonly classic?: BezierBoard;
}

/** Converts a classic board, throwing with the reasons if it is refused. */
export function convertOrThrow(b: BezierBoard): BoardDoc {
  const r = convertClassic(b);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  return r.value.doc;
}

/** Builds without validation, throwing with the reasons if it fails. */
export function buildOrThrow(doc: BoardDoc): BuiltBoard {
  const r = buildBoard(doc, { check: false });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

export function boardSet(): NamedBoard[] {
  const goldens = GOLDENS.map((s) => ({
    name: s.name.replace(/.*\//, '').replace('.brd', ''),
    classic: s.load(),
  }));
  const out: NamedBoard[] = goldens.map((g) => ({
    name: g.name,
    classic: g.classic,
    doc: convertOrThrow(g.classic),
  }));
  const base = goldens[0]!.classic;
  const swallow = classicNotched(base, swallowBoard());
  const fish = classicNotched(base, fishBoard());
  out.push({ name: 'classic swallow', classic: swallow, doc: convertOrThrow(swallow) });
  out.push({ name: 'classic fish', classic: fish, doc: convertOrThrow(fish) });
  out.push({ name: 'swallow', doc: swallowBoard() });
  out.push({ name: 'fish', doc: fishBoard() });
  out.push({ name: 'asymmetric', doc: asymmetricBoard() });
  return out;
}

/**
 * The angle (degrees) between the surface normals just below and just above the apex (t = 1/2)
 * along the board, every `step` cm of ξ (the first and last 2 % are skipped: the tips). Both sides
 * of an asymmetric board.
 */
export function apexCrease(
  board: BuiltBoard,
  step = 0.5,
): { max: number; at: number; list: [number, number][] } {
  const ev = createEvaluator(board);
  const below = new Float64Array(MEASURE.size);
  const above = new Float64Array(MEASURE.size);
  const span = board.xiMax - board.xiMin;
  const list: [number, number][] = [];
  let max = 0;
  let at = 0;
  const mirror = board.doc.symmetry === 'mirror';
  for (let x = board.xiMin + 0.02 * span; x <= board.xiMax - 0.02 * span; x += step) {
    for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
      ev.row(side, x, 2);
      ev.measure(0.5, below, true);
      ev.measure(0.5, above, false);
      const c = below[0]! * above[0]! + below[1]! * above[1]! + below[2]! * above[2]!;
      const deg = (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
      if (side === 0) list.push([x, deg]);
      if (deg > max) {
        max = deg;
        at = x;
      }
    }
  }
  return { max, at, list };
}

/**
 * The distance (cm) between the converted surface's section at ξ = x and the classic loft's section at
 * x: the larger of the two Hausdorff distances between the closed rings. (Valid where the plane x is a
 * section of the converted surface, that is outside a notch zone.)
 */
export function ringDeviation(classic: BezierBoard, board: BuiltBoard, x: number): number {
  const ev = createEvaluator(board);
  const plus = nurbsRing(ev, x, 200);
  const minus = plus.slice(1, -1).map((p): V3 => [p[0], -p[1], p[2]]);
  const ring = [...plus, ...minus.reverse()];
  const loft = loftRing(classic, x, 400);
  if (loft === null) return Number.NaN;
  const ref = loft.map((v): V3 => [v.x, v.y, v.z]);
  return Math.max(polylineHausdorff(ref, ring, true), polylineHausdorff(ring, ref, true));
}

/**
 * The classic board with slice `index` (counting the dummy tail slice as 0) edited: moved along the board
 * by `dx`, and its knot `knot` (point and both handles) moved by (`dw`, `dh`) in the slice's own plane (cm).
 */
export function editSlice(
  b: BezierBoard,
  index: number,
  edit: { dx?: number; knot?: number; dw?: number; dh?: number },
): BezierBoard {
  const slices = b.crossSections.map((cs, i) => {
    if (i !== index) return cs;
    const spline = splineFromKnots(
      cs.spline.knots.map((k, j) =>
        j === (edit.knot ?? -1)
          ? knotFromArray(
              [
                k.end.x + (edit.dw ?? 0),
                k.end.y + (edit.dh ?? 0),
                k.tangentToPrev.x + (edit.dw ?? 0),
                k.tangentToPrev.y + (edit.dh ?? 0),
                k.tangentToNext.x + (edit.dw ?? 0),
                k.tangentToNext.y + (edit.dh ?? 0),
              ],
              k.continuous,
              k.other,
            )
          : k,
      ),
    );
    return crossSection(cs.position + (edit.dx ?? 0), spline);
  });
  return board(b.outline, b.bottom, b.deck, slices, b.interpolationType, b.fins);
}

/**
 * How far one built board's surface is from another's (cm): the largest Hausdorff distance between the
 * rings of the two surfaces at `rows` values of ξ (cosine-spaced over the common range), on both sides.
 * (A point-for-point comparison at equal (ξ, t) would also count the sliding of the parametrisation
 * along a steep rail, which is not the surface moving.)
 */
export function surfaceMove(a: BuiltBoard, b: BuiltBoard, rows = 60, cols = 120): number {
  const ea = createEvaluator(a);
  const eb = createEvaluator(b);
  const lo = Math.max(a.xiMin, b.xiMin);
  const hi = Math.min(a.xiMax, b.xiMax);
  let worst = 0;
  for (const side of a.doc.symmetry === 'mirror' ? ([0] as const) : ([0, 1] as const)) {
    const ring = (ev: SurfaceEvaluator, x: number): V3[] => {
      const o = new Float64Array(3);
      const out: V3[] = [];
      ev.row(side, x, 0);
      for (let j = 0; j <= cols; j++) {
        ev.eval(j / cols, 0, o);
        out.push([o[0]!, o[1]!, o[2]!]);
      }
      return out;
    };
    for (let i = 0; i <= rows; i++) {
      const x = lo + ((hi - lo) * (1 - Math.cos((Math.PI * i) / rows))) / 2;
      const ra = ring(ea, x);
      const rb = ring(eb, x);
      worst = Math.max(worst, polylineHausdorff(ra, rb, false), polylineHausdorff(rb, ra, false));
    }
  }
  return worst;
}

/** Segments of the level curve X = x of a surface grid, for one or more planes (marching squares). */
export interface PlaneSections {
  /** `segments[k]`: flat list `ax ay az bx by bz` of the plane `xs[k]`, plus side then its mirror image. */
  readonly segments: Float64Array[];
}

/**
 * The cross-sections of a built board by the planes X = x, found from a `rows` × `cols` grid of the
 * surface in (ξ, t) (both sides): for notched boards the plane does not follow a ξ row, so the surface
 * is cut where it is. Segment lists (marching squares on the grid cells), accurate to a fraction of
 * the cell size.
 */
export function planeSections(
  board: BuiltBoard,
  xs: readonly number[],
  rows = 1200,
  cols = 800,
): PlaneSections {
  const ev = createEvaluator(board);
  const out = xs.map(() => [] as number[]);
  const o = new Float64Array(3);
  const gx = new Float64Array(2 * (cols + 1));
  const gy = new Float64Array(2 * (cols + 1));
  const gz = new Float64Array(2 * (cols + 1));
  const fill = (xi: number, off: number): void => {
    ev.row(0, xi, 0);
    for (let j = 0; j <= cols; j++) {
      ev.eval(j / cols, 0, o);
      gx[off + j] = o[0]!;
      gy[off + j] = o[1]!;
      gz[off + j] = o[2]!;
    }
  };
  fill(board.xiMin, 0);
  for (let i = 1; i <= rows; i++) {
    const a = ((i - 1) & 1) * (cols + 1);
    const b = (i & 1) * (cols + 1);
    fill(board.xiMin + ((board.xiMax - board.xiMin) * i) / rows, b);
    for (let j = 0; j < cols; j++) {
      const cx = [gx[a + j]!, gx[a + j + 1]!, gx[b + j + 1]!, gx[b + j]!];
      const cy = [gy[a + j]!, gy[a + j + 1]!, gy[b + j + 1]!, gy[b + j]!];
      const cz = [gz[a + j]!, gz[a + j + 1]!, gz[b + j + 1]!, gz[b + j]!];
      const lo = Math.min(...cx);
      const hi = Math.max(...cx);
      xs.forEach((x, k) => {
        if (!(x >= lo && x < hi)) return;
        const pts: number[] = [];
        for (let e = 0; e < 4; e++) {
          const f = (e + 1) & 3;
          if (cx[e]! < x === cx[f]! < x) continue;
          const w = (x - cx[e]!) / (cx[f]! - cx[e]!);
          pts.push(x, cy[e]! + w * (cy[f]! - cy[e]!), cz[e]! + w * (cz[f]! - cz[e]!));
        }
        for (let p = 0; p + 5 < pts.length + 0 && p < pts.length; p += 6) {
          out[k]!.push(...pts.slice(p, p + 6));
        }
      });
    }
  }
  return { segments: out.map((a) => Float64Array.from(a)) };
}

/**
 * The distance (cm) between the plane section X = x of a built board (given as marching-squares segments,
 * plus side only) and the classic loft's ring at x: the larger of the two Hausdorff distances.
 */
export function sectionDeviation(classic: BezierBoard, seg: Float64Array, x: number): number {
  const loft = loftRing(classic, x, 2400);
  if (loft === null || seg.length === 0) return Number.NaN;
  // the classic ring's plus half (y >= 0) against the plus-side segments
  const ring = loft.filter((v) => v.y >= -1e-9).map((v): V3 => [v.x, v.y, v.z]);
  ring.sort((p, q) => p[2] - q[2]);
  const half = loft.slice(0, loft.length >> 1).map((v): V3 => [v.x, v.y, v.z]);
  const poly = half.length > 1 ? half : ring;
  const segDist = (p: V3, a: V3, b: V3): number => {
    const e: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const ee = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    const f = ee > 0 ? Math.min(1, Math.max(0, (w[0] * e[0] + w[1] * e[1] + w[2] * e[2]) / ee)) : 0;
    return Math.hypot(w[0] - f * e[0], w[1] - f * e[1], w[2] - f * e[2]);
  };
  let h = 0;
  // points of the surface section against the classic polyline
  for (let k = 0; k < seg.length; k += 3) {
    const p: V3 = [seg[k]!, seg[k + 1]!, seg[k + 2]!];
    let d = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) d = Math.min(d, segDist(p, poly[i]!, poly[i + 1]!));
    h = Math.max(h, d);
  }
  // points of the classic polyline against the surface section's segments
  for (const p of poly) {
    let d = Infinity;
    for (let k = 0; k < seg.length; k += 6) {
      d = Math.min(
        d,
        segDist(p, [seg[k]!, seg[k + 1]!, seg[k + 2]!], [seg[k + 3]!, seg[k + 4]!, seg[k + 5]!]),
      );
    }
    h = Math.max(h, d);
  }
  return h;
}
