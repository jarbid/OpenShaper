// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * STL export of a designed fin, for 3D printing (docs/design/fin-designer.md,
 * step 16). Binary, in **millimetres** by default: STL has no unit field and slicers
 * assume mm. (The board STL writes cm; see P47 in PROPOSALS.md.)
 *
 * Two closed shells, blade and tab, touching on the tab top, from the kernel's fine
 * fin mesh (`finMesh`, FIN_MESH_FINE): rings about half a millimetre apart, tab arcs
 * within 0.005 mm. A slicer merges the shells, as CAD does with the STEP's two solids.
 */
import { FIN_MESH_FINE, finMesh, type FinDesign, type FinLaminate } from '@openshaper/kernel';
import { SHEET_UNIT, type SheetUnit } from './construction/units';
import { FIN_BRAND } from './brand';
import { encodeBinaryStl, writeMesh } from './stl';

export interface FinStlOptions {
  /** Unit of the coordinates written. Default 'mm', what slicers assume. */
  unit?: SheetUnit;
  /** Name written into the header. Default 'fin'. */
  name?: string;
  /** Write the blade, and the tab if it wraps it, as the core under this laminate (cm per face). */
  laminate?: FinLaminate;
  /**
   * Thicken the edges and tip to at least this (cm) in the file only, e.g. 0.1 for a
   * 1 mm printable edge. Never under the design minimum, which is the default.
   */
  minThickness?: number;
}

export const exportFinStl = (d: FinDesign, opts: FinStlOptions = {}): Uint8Array => {
  const scale = SHEET_UNIT[opts.unit ?? 'mm'].factor;
  const mesh = finMesh(d, {
    ...FIN_MESH_FINE,
    ...(opts.laminate ? { laminate: opts.laminate } : {}),
    ...(opts.minThickness === undefined ? {} : { minThickness: opts.minThickness }),
  });
  const facets: number[] = [];
  writeMesh(facets, mesh.blade, scale);
  writeMesh(facets, mesh.tab, scale);
  return encodeBinaryStl(facets, opts.name ?? 'fin', FIN_BRAND.product);
};
