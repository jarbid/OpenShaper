// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The seams of a trimmed and blended board: the lines a view draws over the mesh to show where
 * one patch ends and the next begins. They are read from the mesh's strips, never from its
 * triangles, so every endpoint is a vertex the mesh already has and a seam cannot drift from
 * the surface it marks.
 *
 * A strip is laid out `deckRows` deck rows, `tuckRows` tuck rows, then the apex (see
 * `TrimMesh.deckRows`). Row 0 is where the deck blend leaves the deck panel, row `deckRows`
 * (the tuck's first row) is where the tuck leaves the bottom panel, and the last row is the
 * apex, the rail's widest line.
 *
 * Three lines run the length of the loop, one segment from each sample to the next (the loop is
 * closed, so the last sample joins the first): the deck's band edge, the tuck's band edge and the
 * apex line. Where the outline passes from one stretch to the next (the ends of a corner, of a
 * tail's straight edge) a cross-seam runs down the strip of the stretch's last sample, along
 * the strip's two chains: row 0 down to the apex and the tuck's first row up to it. A cross-seam
 * follows the strip one row at a time rather than cutting straight across, because a chord from
 * a band edge to the apex runs inside the rail's convex section and the surface would hide it.
 * Nothing else is drawn: the panels' own grids are not seams.
 */
import type { Loop } from './loop';
import type { TrimMesh } from './solid';

/** Line segments over a mesh, for a view to draw on it. */
export interface Seams {
  /**
   * Segment endpoints, `[x0, y0, z0, x1, y1, z1, …]`, in the mesh's own coordinates (board cm).
   * The segments come in blocks: the deck's band edge, the tuck's band edge, the apex line (`n`
   * segments each, `n` the loop's sample count), then the cross-seams.
   */
  readonly positions: Float32Array;
  /**
   * How many leading segments are band edges, the deck's and the tuck's (`2n`). A view that
   * lights a part's band edges tells them from the apex line and the cross-seams by this.
   */
  readonly bandEdges: number;
}

/** What the seams are read from: the strips' vertices and the loop's stretches. */
export interface SeamsSource {
  readonly positions: TrimMesh['positions'];
  readonly loop: Pick<Loop, 'n' | 'seg'>;
  readonly deckRows: number;
  readonly tuckRows: number;
}

/**
 * The seams of a mesh: `3n + c * (deckRows + tuckRows)` segments for a loop of `n` samples
 * with `c` stretch changes (counting the pair of the last sample and the first), in the blocks
 * `Seams.positions` describes.
 */
export function trimSeams(mesh: SeamsSource): Seams {
  const { positions, loop, deckRows: nt, tuckRows: nb } = mesh;
  const n = loop.n;
  // a loop of fewer than three samples encloses nothing
  if (n < 3) return { positions: new Float32Array(0), bandEdges: 0 };
  const per = nt + nb + 1;
  const apex = nt + nb;
  // the last sample of each stretch
  const ends: number[] = [];
  for (let i = 0; i < n; i++) if (loop.seg[i] !== loop.seg[(i + 1) % n]) ends.push(i);
  const out = new Float32Array(6 * (3 * n + ends.length * (nt + nb)));
  let w = 0;
  const put = (vertex: number): void => {
    const at = 3 * vertex;
    out[w++] = positions[at]!;
    out[w++] = positions[at + 1]!;
    out[w++] = positions[at + 2]!;
  };
  const segment = (from: number, to: number): void => {
    put(from);
    put(to);
  };
  for (const row of [0, nt, apex]) {
    for (let i = 0; i < n; i++) segment(per * i + row, per * ((i + 1) % n) + row);
  }
  for (const i of ends) {
    const strip = per * i;
    for (let j = 0; j < nt; j++) segment(strip + j, strip + (j + 1 < nt ? j + 1 : apex));
    for (let j = 0; j < nb; j++) {
      segment(strip + nt + j, strip + (j + 1 < nb ? nt + j + 1 : apex));
    }
  }
  return { positions: out, bandEdges: 2 * n };
}
