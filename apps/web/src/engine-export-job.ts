// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS export job of a one-click export (docs/design/m3-exports.md): which `ExportJob` the engine runs
 * for a format when no dialog is involved, built from the saved dialog settings. Pure, so the routing is
 * testable apart from the menu: `exportBoard`'s classic output is the engine-off path only.
 */
import type { BezierBoard, ResolvedFin } from '@openshaper/kernel';
import type { BoardPdf1to1Options } from '@openshaper/export';
import { exportUnitFor, type LengthUnit } from './format';
import type { ExportFormat } from './file-io';
import type { StepSettings } from './step-export-settings';
import { DEFAULT_STL_FACE_SIZE, type ExportJob } from './workers/nurbs-protocol';

/** The unit a STEP file is written in for the dialog's choice (`auto` follows the editor). */
export const stepUnitOf = (settings: StepSettings, units: LengthUnit): 'mm' | 'cm' | 'in' =>
  settings.unit === 'auto' ? exportUnitFor(units) : settings.unit;

export interface QuickJobContext {
  readonly slug: string;
  readonly ghost: BezierBoard | null;
  readonly fins: readonly ResolvedFin[];
  /** The 1:1 PDF options of the saved dialog settings. */
  readonly pdf: BoardPdf1to1Options;
  readonly stepUnit: 'mm' | 'cm' | 'in';
}

/** The engine's job for a format, or null for a format with no NURBS export (rail bands). */
export const engineQuickJob = (format: ExportFormat, c: QuickJobContext): ExportJob | null => {
  switch (format) {
    case 'stl':
      return { format: 'stl', faceSize: DEFAULT_STL_FACE_SIZE, slug: c.slug };
    case 'dxf':
    case 'dxf-spline':
      return {
        format: 'dxf',
        curveMode: format === 'dxf-spline' ? 'spline' : 'polyline',
        crossSectionCount: 7,
        ghost: c.ghost,
        fins: c.fins,
        slug: c.slug,
      };
    case 'pdf-1to1':
      return { format: 'pdf-1to1', options: c.pdf, fins: c.fins, slug: c.slug };
    case 'step':
      return { format: 'step', unit: c.stepUnit, slug: c.slug };
    case 'rail-bands':
      return null;
    default: {
      const never: never = format;
      return never;
    }
  }
};
