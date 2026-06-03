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
