/**
 * @openshaper/export — STL / DXF / PDF exporters.
 *
 * Pure functions over a `BezierBoard` from `@openshaper/kernel`. No I/O: each
 * returns the encoded document (string for the text formats, bytes for PDF) so the
 * caller decides how to persist or download it.
 */
export { exportStl, type StlOptions } from './stl';
export { exportDxf, type DxfOptions } from './dxf';
export { exportPdf, type PdfOptions, type PdfMeta } from './pdf';
export { specSheetHtml, type SpecSheetDoc } from './spec-sheet';

// --- Construction templates (machineable: laser / router) ---
export { buildHwsTemplates } from './construction/hws';
export {
  DEFAULT_HWS_PARAMS,
  type HwsParams,
  type RibMode,
  type TemplateSheet,
  type Part,
  type Loop,
  type LoopKind,
} from './construction/types';
export { sheetToDxf, type DxfSheetOptions } from './sheet-dxf';
export { sheetToSvg, type SvgOptions } from './sheet-svg';
export { sheetToPdf } from './sheet-pdf';
export type { SheetUnit } from './construction/units';
