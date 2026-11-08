// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The smoothness gate (owner request, 2026-11: "blend these attributes without creating
 * distortions in the surface"): whether a blade's faces are smooth, measured rather than
 * judged by eye.
 *
 * A face is sampled on a grid of points, rows up the blade and columns across it, and at
 * each point the face's turn is measured: the angle between the steps to the points either
 * side, up the blade and across it. On a smooth face that turn is its curvature times the
 * spacing, so sampled twice as finely it halves. Across a crease (the face's slope jumps)
 * it doesn't: however fine the sampling, the step across the crease turns by the jump.
 * So the gate samples each face at two spacings and compares the worst turns:
 *
 * - **smooth**: the worst turn at the finer spacing is at most {@link FAIR_RATIO} of the
 *   coarser one's, or too small to see ({@link FAIR_FLOOR});
 * - otherwise a **crease**, reported where the finer sampling found its worst turn.
 *
 * The edges are left out: a foil's rounded nose turns ever faster toward the edge, by
 * design, so its turn doesn't halve. The sampler decides what counts as an edge (how far
 * in its columns start).
 */
import type { Vert3 } from '../loft';
import { bladeRowHeights, bladeSection, bladeTop, prepareBlade } from './blade';
import type { FinDesign } from './fin-design';

/** Rows of points on one face, each row the same number of points (columns). */
export type FaceGrid = readonly (readonly Vert3[])[];

/** A blade's two faces on one grid. */
export interface BladeGrid {
  readonly outside: FaceGrid;
  readonly inside: FaceGrid;
}

/** Samples a blade's faces: `rows` + 1 rows of `cols` + 1 points. */
export type BladeSampler = (rows: number, cols: number) => BladeGrid;

/** The face's worst turn on a grid: how much (deg) and where. */
export interface Bend {
  readonly deg: number;
  readonly at: Vert3;
  readonly face: 'outside' | 'inside';
}

/** Each grid cell's unit normal, from its diagonals (null where it has no area). */
const cellNormals = (g: FaceGrid): (Vert3 | null)[][] =>
  g.slice(0, -1).map((row, i) =>
    row.slice(0, -1).map((p00, j) => {
      const p01 = row[j + 1]!;
      const p10 = g[i + 1]![j]!;
      const p11 = g[i + 1]![j + 1]!;
      const ax = p11.x - p00.x;
      const ay = p11.y - p00.y;
      const az = p11.z - p00.z;
      const bx = p01.x - p10.x;
      const by = p01.y - p10.y;
      const bz = p01.z - p10.z;
      const n = { x: ay * bz - az * by, y: az * bx - ax * bz, z: ax * by - ay * bx };
      const l = Math.hypot(n.x, n.y, n.z);
      return l > 1e-18 ? { x: n.x / l, y: n.y / l, z: n.z / l } : null;
    }),
  );

/** The angle (deg) between two unit normals; 0 if either is missing. */
const between = (a: Vert3 | null, b: Vert3 | null): number =>
  a && b
    ? (Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180) / Math.PI
    : 0;

/**
 * How far the face turns over two steps between cells (deg): the angles between their
 * normals, up the blade (`up[i][j]`: cells i to i + 2 of column j) and across it
 * (`across[i][j]`: cells j to j + 2 of row i). Normals, not the grid's lines: those bend
 * with how the grid is laid out (along a horizontal section's trailing end, say) on a
 * face that is smooth.
 */
const turns = (g: FaceGrid): { up: Float64Array[]; across: Float64Array[] } => {
  const n = cellNormals(g);
  // Over two steps: a crease inside a cell tilts that cell's normal part way, splitting its
  // jump between the steps either side, unevenly. Over two it is all there, so a crease
  // reads the same however finely sampled, while a smooth face's turn still halves.
  const up = n
    .slice(0, -2)
    .map((row, i) =>
      Float64Array.from(
        row,
        (c, j) => between(c, n[i + 1]![j]!) + between(n[i + 1]![j]!, n[i + 2]![j]!),
      ),
    );
  const across = n.map((row) =>
    Float64Array.from(
      row.slice(0, -2),
      (c, j) => between(c, row[j + 1]!) + between(row[j + 1]!, row[j + 2]!),
    ),
  );
  return { up, across };
};

/** The largest of `t` over rows i0..i1 and columns j0..j1 (clamped to the table). */
const windowMax = (t: readonly Float64Array[], i0: number, i1: number, j0: number, j1: number) => {
  let m = 0;
  for (let a = Math.max(0, i0); a <= Math.min(t.length - 1, i1); a++) {
    const row = t[a]!;
    for (let b = Math.max(0, j0); b <= Math.min(row.length - 1, j1); b++) m = Math.max(m, row[b]!);
  }
  return m;
};

/** A spot where a face turns as much sampled finely as coarsely: a crease. */
export interface Crease {
  readonly face: 'outside' | 'inside';
  readonly at: Vert3;
  /** The worst turn there at the coarser and the finer spacing (deg). */
  readonly coarse: number;
  readonly fine: number;
}

/**
 * Where a face creases: each spot of the coarse grid against the same spot of the fine one
 * (a grid of points twice as close, the coarse grid's among them), the worst turn near it
 * in each. A smooth face's halves; a crease's doesn't. The worst first.
 */
export const faceCreases = (coarse: FaceGrid, fine: FaceGrid, face: Crease['face']): Crease[] => {
  const tc = turns(coarse);
  const tf = turns(fine);
  const out: Crease[] = [];
  const rows = coarse.length - 1;
  const cols = coarse[0]!.length - 1;
  // The same patch of face at both spacings. A coarse two-step turn up the blade at row i
  // is centred on cell i + 1, z = i + 1½ coarse rows; a fine one at row k on z = (k + 1½)/2.
  // So coarse rows i − 1 to i + 1 (z from i + ½ to i + 2½) are fine rows 2i − ½ to 2i + 3½,
  // and coarse columns j − 1 to j + 1 (cells, x from j − ½ to j + 1½) are fine 2j − 1½ to
  // 2j + 2½. Across, rows and columns swap. Spots whose patch reaches the grid's sides are
  // left out: a side cell has nothing beyond it to turn against.
  for (let i = 1; i < rows - 4; i++) {
    for (let j = 1; j < cols - 4; j++) {
      const c = Math.max(
        windowMax(tc.up, i - 1, i + 1, j - 1, j + 1),
        windowMax(tc.across, i - 1, i + 1, j - 1, j + 1),
      );
      const f = Math.max(
        windowMax(tf.up, 2 * i, 2 * i + 3, 2 * j - 1, 2 * j + 2),
        windowMax(tf.across, 2 * i - 1, 2 * i + 2, 2 * j, 2 * j + 3),
      );
      if (f > FAIR_FLOOR && f > FAIR_RATIO * c) {
        out.push({ face, at: coarse[i + 1]![j + 1]!, coarse: c, fine: f });
      }
    }
  }
  return out.sort((p, q) => q.fine - p.fine);
};

/** The worst turn on a face grid. */
export const worstBend = (g: FaceGrid, face: Bend['face']): Bend => {
  const { up, across } = turns(g);
  let best: Bend = { deg: 0, at: g[0]?.[0] ?? { x: 0, y: 0, z: 0 }, face };
  for (const [t, di, dj] of [
    [up, 1, 0],
    [across, 0, 1],
  ] as const) {
    t.forEach((row, i) =>
      row.forEach((d, j) => {
        if (d > best.deg) best = { deg: d, at: g[i + 2 * di]![j + 2 * dj]!, face };
      }),
    );
  }
  return best;
};

/** The worst turn on either face. */
export const bladeBend = (g: BladeGrid): Bend => {
  const o = worstBend(g.outside, 'outside');
  const i = worstBend(g.inside, 'inside');
  return o.deg >= i.deg ? o : i;
};

/**
 * Sampled twice as finely, a smooth face's worst turn on a patch is at most this share of
 * the coarser sampling's: in theory a half, with room for the turn varying over the patch.
 */
export const FAIR_RATIO = 0.7;

/** A turn this small (deg) at the finer spacing doesn't show, crease or not. */
export const FAIR_FLOOR = 0.2;

/** The gate's grid: rows and columns at the coarser spacing (doubled for the finer). */
export const FAIR_GRID = { rows: 80, cols: 40 } as const;

export interface Fairness {
  /** No creases. */
  readonly smooth: boolean;
  /** Where the faces crease, the worst first (none on a smooth blade). */
  readonly creases: readonly Crease[];
  /** The worst turn anywhere, at the finer spacing. */
  readonly worst: Bend;
}

/**
 * The smoothness gate on a blade (see the file comment). The sampler's grid with `rows`
 * and `cols` steps must hold the one with half as many: each of its points among the
 * finer grid's.
 */
export const fairness = (sample: BladeSampler, grid = FAIR_GRID): Fairness => {
  const c = sample(grid.rows, grid.cols);
  const f = sample(grid.rows * 2, grid.cols * 2);
  const creases = [
    ...faceCreases(c.outside, f.outside, 'outside'),
    ...faceCreases(c.inside, f.inside, 'inside'),
  ].sort((p, q) => q.fine - p.fine);
  return { smooth: creases.length === 0, creases, worst: bladeBend(f) };
};

/** How far in from each edge (chord fraction) the gate's columns start: the noses left out. */
export const FAIR_EDGE = 0.06;

/**
 * The horizontal-section blade's sampler (blade.ts): rows spaced along the edges' travel
 * from the root to just under the tip, columns evenly across the chord short of the edges.
 */
export const sectionSampler =
  (d: FinDesign): BladeSampler =>
  (rows, cols) => {
    const b = prepareBlade(d);
    const top = bladeTop(b, 0.01) - 0.02 * b.depth;
    const us = Array.from(
      { length: cols + 1 },
      (_, j) => FAIR_EDGE + ((1 - 2 * FAIR_EDGE) * j) / cols,
    );
    const secs = bladeRowHeights(b, 0, top, rows).map((h) => bladeSection(b, h, us));
    return { outside: secs.map((s) => s.outside), inside: secs.map((s) => s.inside) };
  };
