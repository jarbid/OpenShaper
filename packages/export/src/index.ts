/**
 * @openshaper/export — STL / DXF / 1:1 PDF / spec-sheet exporters.
 *
 * Pure functions over a `BezierBoard` from `@openshaper/kernel`. No I/O: each
 * returns the encoded document (string for the text formats, bytes for PDF) so the
 * caller decides how to persist or download it. The data-rich, NTS summary lives in
 * the spec sheet (`spec-sheet.ts`, printed to PDF by the browser); the PDF exporter
 * here is the true 1:1, print-at-100% trace template.
 */
export { exportStl, type StlOptions } from './stl';
export { exportDxf, type DxfOptions } from './dxf';
export { exportBoardPdf1to1, type BoardPdf1to1Options, type PdfMeta } from './board-pdf';
export { boardDiagramSvg, type BoardDiagramOptions } from './board-diagram';
export { specSheetHtml, type SpecSheetDoc, type SpecSection } from './spec-sheet';

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
