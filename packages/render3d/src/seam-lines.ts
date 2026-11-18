// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry } from 'three';
import type { PatchSeams } from './patches';

/**
 * The seam lines as a BufferGeometry of line segments, in board coordinates and not centred: the
 * caller places it as it places the surface. The positions are the seams' own array, read and
 * never written. `aEdge` is 1 on the vertices of the band-edge segments, which the Patches look
 * lights when a rail zone or blend is chosen, and 0 on the apex line and the cross-seams.
 */
export function seamGeometry(seams: PatchSeams): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(seams.positions, 3));
  const edge = new Float32Array(seams.positions.length / 3);
  edge.fill(1, 0, 2 * seams.bandEdges);
  g.setAttribute('aEdge', new BufferAttribute(edge, 1));
  g.computeBoundingSphere();
  return g;
}
