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
 * distance, in that plane, from the point to the classic cross-section at the
 * point's own x. For a surface whose unit normal has the length component `nx`, a
 * point `d` along the normal from the classic surface is `d / √(1 − nx²)` away in the
 * station plane, so
 *
 *     normal distance = station-plane distance · √(1 − nx²)
 *
 * with `n` the NURBS surface's exact normal at the vertex. That is the signed
 * distance along the surface normal to first order, and it is what the legend states.
 * It is a first-order estimate, not a 3D distance: it is sound where the surface
 * leans only a little along the board and fails where it faces along it.
 *
 * ## No data
 *
 * - Past the classic board's ends, and within {@link TIP_NO_DATA_ZONE} of them.
 * - Where the surface faces along the board, `|nx| > ` {@link NX_NO_DATA}: the
 *   station-plane distance is ill-conditioned there (a tip's section is a point and
 *   the distance to it is a distance along the board) and the factor `√(1 − nx²)`
 *   that corrects it tends to 0, so the product would read "about zero" whatever the
 *   truth. Such a vertex is NaN, not ~0, and does not enter the range.
 *
 * ## Stations
 *
 * The NURBS vertices are not in rings like the classic mesh's, so a section at each
 * vertex's own x would be one classic section per vertex (thousands). Instead the
 * station-plane distance is measured against sections every {@link STATION_SPACING}
 * cm and interpolated linearly in x between the two sections around the vertex. That
 * is second-order accurate where the distance varies smoothly with x, and wrong where
 * it does not: near the ends a section grows like √x, and the distances to the two
 * neighbouring sections can differ in sign and by centimetres. So a vertex within
 * {@link OWN_STATION_END_ZONE} of an end, or whose two neighbouring distances differ
 * by more than {@link OWN_STATION_JUMP}, is measured against the classic section at
 * its **own** x instead (exact in x; the classic builds one section per distinct x).
 *
 * ## Accuracy
 *
 * A first-order estimate of the 3D distance to the classic surface, not the distance
 * itself. Measured against a brute-force 3D distance to a fine classic mesh on the
 * three golden boards (`nurbs-deviation.golden.test.ts` pins it for the shortboard):
 * at most 0.016 cm away from the ends, and at most 0.065 cm at 0.5 to 3 cm from an
 * end (see {@link TIP_NO_DATA_ZONE} for what lies closer). The fit it measures is
 * itself 0.07 cm off on these boards, so the estimate does not decide a reading.
 */
import { getLength, ghostDeviation, type BezierBoard } from '@openshaper/kernel';

/** Spacing (cm) of the classic sections the deviation is measured against. */
export const STATION_SPACING = 0.25;

/**
 * Within this distance (cm) of either end of the classic board, and beyond the ends,
 * a vertex is "no data". Past the ends the NURBS board is longer than the classic one
 * and there is nothing to measure against. Within it, the normal distance is only
 * first-order and the classic surface there is not locally a plane (the section
 * collapses to the end thickness over a few millimetres): measured against a brute
 * force 3D distance to the classic mesh on the three golden boards, the estimate is
 * off by up to 1.4 mm (shortboard), 1.2 mm (funboard) and 2.4 mm (longboard) in the
 * last quarter centimetre, by up to 1.5 mm in the longboard's next quarter, and by at
 * most 0.65 mm beyond half a centimetre. Showing the former as data would put the
 * extremes of the legend range there, so it is blank instead.
 */
export const TIP_NO_DATA_ZONE = 0.5;

/**
 * Within this distance (cm) of either end of the classic board a vertex is measured
 * against the section at its own x, not interpolated between stations: the section
 * there changes too fast for a linear blend (its width grows like √x). Six stations;
 * the shortboard's tail section is 7 cm wide at the first station.
 */
export const OWN_STATION_END_ZONE = 1.5;

/**
 * Anywhere else, a vertex whose two neighbouring stations disagree about its distance
 * by more than this (cm) is measured against the section at its own x: the distance
 * is not varying smoothly enough for a linear blend. 0.5 mm, a few times the ghost
 * ring's own resolution (`DEVIATION_RING_SPACING`), so ordinary slopes (a rocker
 * slope of 0.1 moves a distance 0.25 cm in a quarter-centimetre) do not trigger it.
 */
export const OWN_STATION_JUMP = 0.05;

/**
 * A vertex whose normal has `|nx|` above this faces along the board (a tip) and is
 * "no data": see the module comment. 0.9 is a surface tilted 64° from the board's
 * broad faces; `√(1 − 0.81)` = 0.44, so the station-plane distance is at most 2.3
 * times the normal distance there.
 */
export const NX_NO_DATA = 0.9;

export interface ClassicDeviation {
  /** Per vertex, cm; NaN where there is no data. */
  readonly deviation: Float32Array;
  /** The range of the data. Ignores no-data vertices, which are NaN and not ~0. */
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

  // Vertices that have data to measure: inside the board's length, not facing along it.
  const wanted = new Uint8Array(count);
  const measured: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i]!;
    const nx = normals[3 * i]!;
    if (x >= TIP_NO_DATA_ZONE && x <= length - TIP_NO_DATA_ZONE && Math.abs(nx) <= NX_NO_DATA) {
      wanted[i] = 1;
      measured.push(i);
    }
  }

  // Two probes per measured vertex, at the sections either side; the classic board
  // builds each distinct section once.
  const m = measured.length;
  const probes = new Float64Array(6 * m);
  const frac = new Float64Array(m);
  const last = Math.max(1, Math.ceil(length / STATION_SPACING));
  const step = length / last;
  for (let j = 0; j < m; j++) {
    const i = measured[j]!;
    const x = positions[3 * i]!;
    const s = Math.min(last - 1e-9, Math.max(0, x / step));
    const k = Math.floor(s);
    frac[j] = s - k;
    const y = positions[3 * i + 1]!;
    const z = positions[3 * i + 2]!;
    probes[6 * j] = k * step;
    probes[6 * j + 1] = y;
    probes[6 * j + 2] = z;
    probes[6 * j + 3] = (k + 1) * step;
    probes[6 * j + 4] = y;
    probes[6 * j + 5] = z;
  }
  const d = ghostDeviation(classic, probes);

  // The station-plane distance of each measured vertex: interpolated, or, where the
  // interpolation cannot be trusted, taken at the vertex's own x.
  const planar = new Float64Array(m);
  const own: number[] = [];
  for (let j = 0; j < m; j++) {
    const x = positions[3 * measured[j]!]!;
    const a = d[2 * j]!;
    const b = d[2 * j + 1]!;
    const nearEnd = x < OWN_STATION_END_ZONE || x > length - OWN_STATION_END_ZONE;
    if (
      nearEnd ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      Math.abs(a - b) > OWN_STATION_JUMP
    ) {
      own.push(j);
    } else {
      planar[j] = a + (b - a) * frac[j]!;
    }
  }
  if (own.length > 0) {
    const points = new Float64Array(3 * own.length);
    own.forEach((j, q) => {
      const i = measured[j]!;
      points[3 * q] = positions[3 * i]!;
      points[3 * q + 1] = positions[3 * i + 1]!;
      points[3 * q + 2] = positions[3 * i + 2]!;
    });
    const exact = ghostDeviation(classic, points);
    own.forEach((j, q) => (planar[j] = exact[q]!));
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < m; j++) {
    const i = measured[j]!;
    const nx = normals[3 * i]!;
    // Normal distance: see the module comment. `nx` outside [-1, 1] is rounding.
    const scaled = planar[j]! * Math.sqrt(Math.max(0, 1 - Math.min(1, nx * nx)));
    if (!Number.isFinite(scaled)) {
      wanted[i] = 0;
      continue;
    }
    out[i] = scaled;
    if (scaled < lo) lo = scaled;
    if (scaled > hi) hi = scaled;
  }
  let noData = 0;
  for (let i = 0; i < count; i++) if (!wanted[i]) noData++;
  return { deviation: out, range: lo <= hi ? [lo, hi] : null, noData };
};
