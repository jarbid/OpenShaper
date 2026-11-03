// SPDX-License-Identifier: GPL-3.0-or-later
import type { BoardSpecs } from '@openshaper/store';
import type { MeshMeasure } from './workers/nurbs-protocol';

/**
 * The sidebar's specs with the integrals taken from the NURBS mesh (docs/design/m2-editor.md §4, step 5):
 * volume, plan area and the centre of mass are the surface's; the lengths, widths, thicknesses and rockers
 * stay the classic readouts of the projection, which are exact for the curves the shaper edits. The mesh
 * is accurate to about 1% in volume (nurbs-plan.md, decision 6).
 */
export function specsFromMesh(specs: BoardSpecs, mesh: MeshMeasure | null): BoardSpecs {
  if (!mesh) return specs;
  return {
    ...specs,
    volume: mesh.volume,
    volumeLiters: mesh.volume / 1000,
    area: mesh.planArea,
    centerOfMass: mesh.centreX,
  };
}
