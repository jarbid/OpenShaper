// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Deviation from classic": how far the NURBS surface lies from the classic engine's
 * surface of the same board, at the NURBS tessellation vertices.
 *
 * Pure (kernel only), run in the NURBS worker and in tests.
 *
 * ## Sign
 *
 * Positive where the NURBS surface lies **outside** the classic one (the NURBS board
 * has more foam), negative inside it. The kernel's `ghostDeviation` already has this
 * convention ("positive where the point lies outside the ghost"), with the classic
 * board as the ghost.
 *
 * ## Distance
 *
 * The kernel measures within each point's station plane (x = const): the shortest
 * distance, in that plane, from the point to the classic cross-section. For a surface
 * whose unit normal has the length component `nx`, a point `d` along the normal from
 * the classic surface is `d / √(1 − nx²)` away in the station plane, so
 *
 *     normal distance = station-plane distance · √(1 − nx²)
 *
 * with `n` the NURBS surface's exact normal at the vertex. That is the signed
 * distance along the surface normal to first order, and it is what the legend states.
 * Where the surface faces along the board (`nx` near ±1: the tips) the station-plane
 * distance is large and ill-conditioned and the factor is small; the product stays
 * finite and small. A vertex the classic board has no section for (past its ends)
 * is NaN, "no data".
 *
 * ## Stations
 *
 * The NURBS vertices are not in rings like the classic mesh's, so a section at each
 * vertex's own x would be one classic section per vertex. Instead the signed
 * distance is measured against sections every {@link STATION_SPACING} cm and
 * interpolated linearly in x between the two sections around the vertex: second-order
 * accurate (the distance from a fixed point to a section is smooth in x), at a few
 * hundred sections per board.
 */
import { getLength, ghostDeviation, type BezierBoard } from '@openshaper/kernel';

/** Spacing (cm) of the classic sections the deviation is measured against. */
export const STATION_SPACING = 0.25;

export interface ClassicDeviation {
  /** Per vertex, cm; NaN where there is no data. */
  readonly deviation: Float32Array;
  readonly range: readonly [number, number] | null;
  readonly noData: number;
}

/**
 * The signed normal distance (cm) from each NURBS vertex to the classic surface of
 * `classic`. `positions` and `normals` are the NURBS mesh's (stride 3).
 */
export const classicDeviation = (
  classic: BezierBoard,
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
): ClassicDeviation => {
  const count = Math.floor(positions.length / 3);
  const length = getLength(classic);
  const out = new Float32Array(count).fill(Number.NaN);
  if (!(length > 0) || count === 0) return { deviation: out, range: null, noData: count };

  // Two probes per vertex, at the sections either side; the classic board builds each
  // distinct section once.
  const probes = new Float64Array(6 * count);
  const frac = new Float64Array(count);
  const last = Math.max(1, Math.ceil(length / STATION_SPACING));
  const step = length / last;
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i]!;
    const s = Math.min(last - 1e-9, Math.max(0, x / step));
    const k = Math.floor(s);
    frac[i] = s - k;
    const y = positions[3 * i + 1]!;
    const z = positions[3 * i + 2]!;
    probes[6 * i] = k * step;
    probes[6 * i + 1] = y;
    probes[6 * i + 2] = z;
    probes[6 * i + 3] = (k + 1) * step;
    probes[6 * i + 4] = y;
    probes[6 * i + 5] = z;
  }
  const d = ghostDeviation(classic, probes);

  let lo = Infinity;
  let hi = -Infinity;
  let noData = 0;
  for (let i = 0; i < count; i++) {
    const a = d[2 * i]!;
    const b = d[2 * i + 1]!;
    const nx = normals[3 * i]!;
    // A section either side; at an end one of them may not exist (a point), then the
    // other stands in rather than blanking the first quarter-centimetre of the board.
    const planar =
      Number.isFinite(a) && Number.isFinite(b)
        ? a + (b - a) * frac[i]!
        : Number.isFinite(a)
          ? a
          : b;
    // Normal distance: see the module comment. `nx` outside [-1, 1] is rounding.
    const scaled = planar * Math.sqrt(Math.max(0, 1 - Math.min(1, nx * nx)));
    if (!Number.isFinite(scaled)) {
      noData++;
      continue;
    }
    out[i] = scaled;
    if (scaled < lo) lo = scaled;
    if (scaled > hi) hi = scaled;
  }
  return { deviation: out, range: lo <= hi ? [lo, hi] : null, noData };
};
