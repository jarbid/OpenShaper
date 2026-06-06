// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Output unit for the construction-template writers. The sheet geometry is always
 * centimetres (the kernel unit); each writer scales coordinates on the way out to
 * the chosen real-world unit so the file matches the unit selected in the editor.
 *
 * `dxfCode` is the DXF `$INSUNITS` header value (1 = inches, 4 = mm, 5 = cm) so
 * CAM / laser importers land the parts at the right scale instead of guessing.
 */
export type SheetUnit = 'mm' | 'cm' | 'in';

export const SHEET_UNIT: Record<SheetUnit, { factor: number; dxfCode: number }> = {
  mm: { factor: 10, dxfCode: 4 },
  cm: { factor: 1, dxfCode: 5 },
  in: { factor: 1 / 2.54, dxfCode: 1 },
};
