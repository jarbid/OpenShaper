import {
  customPaper,
  exportBoardPdf1to1,
  exportBoardPdf1to1Files,
  exportDxf,
  exportStl,
  PAPER_SIZES,
  paperSizeById,
  type PdfTiling,
  type SheetUnit,
  sheetToDxf,
  sheetToPdf,
  sheetToSvg,
  type TemplateSheet,
} from '@openshaper/export';
import { Unit } from '@openshaper/units';
import { type LengthUnit } from './format';
import type { Pdf1to1Settings } from './pdf-export-settings';
import {
  parseBrdFile,
  parseS3d,
  parseS3dx,
  parseSrf,
  readBoardJson,
  writeBoardJson,
  writeBrd,
} from '@openshaper/io';
import type { ImportWarning } from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';
import { recordRecentBoard } from './recent-boards';

/**
 * Turn a board model name into a safe download-filename stem: lowercase,
 * non-alphanumerics collapsed to single hyphens, edges trimmed. Falls back to
 * 'board' when the name is missing or has nothing usable in it.
 */
export function slugifyName(name: string | undefined): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'board';
}

function download(data: BlobPart, filename: string, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Editable board info (designer/model/etc.), stored in the .board.json metadata. */
export interface BoardMeta {
  designer?: string;
  model?: string;
  surfer?: string;
  comments?: string;
  /** Fin setup name (see fins.ts FinSetup); positions are derived, not stored. */
  finType?: string;
  /** Foam type + glass schedule for the weight estimate (see weights.ts). */
  foamType?: string;
  glassSchedule?: string;
}

/** Trigger a download of the board as a native .board.json document. */
export function downloadBoard(
  board: BezierBoard,
  meta?: BoardMeta,
  filename = 'board.board',
): void {
  const metadata =
    meta && Object.values(meta).some(Boolean) ? (meta as Record<string, unknown>) : undefined;
  const boardJson = writeBoardJson(board, metadata);
  download(boardJson, filename, 'application/json');
  // Record in the recent-boards list. Use meta.model if present, otherwise strip
  // the native extension (.board, the legacy .board.json, or a bare .json).
  const name =
    meta?.model?.trim() || filename.replace(/\.board(\.json)?$/i, '').replace(/\.json$/i, '');
  recordRecentBoard(name || filename, boardJson);
}

/** Trigger a download of the board in the legacy BoardCAD-LE `.brd` text format. */
export function downloadBrd(board: BezierBoard, meta?: BoardMeta): void {
  const text = writeBrd(board, {
    model: meta?.model,
    designer: meta?.designer,
    surfer: meta?.surfer,
    comments: meta?.comments,
    finType: meta?.finType,
  });
  download(text, `${slugifyName(meta?.model)}.brd`, 'application/octet-stream');
}

type BoardFileReader = (
  file: File,
) => Promise<{ board: BezierBoard; meta: BoardMeta; warnings: readonly ImportWarning[] }>;

// Extension → importer. Each reader controls its own decoding (text vs
// arrayBuffer), so binary formats fit the same table.
const BOARD_FILE_READERS: Record<string, BoardFileReader> = {
  // .brd may be plain text or encrypted (%BRD-1.0x) — read bytes and let
  // parseBrdFile sniff the magic and decrypt as needed.
  '.brd': async (file) => {
    const { board, warnings } = parseBrdFile(new Uint8Array(await file.arrayBuffer()));
    return { board, meta: {}, warnings };
  },
  '.s3d': async (file) => {
    const { board: b, metadata, warnings } = parseS3d(await file.text());
    return {
      board: b,
      meta: { model: metadata?.model, designer: metadata?.designer, comments: metadata?.comments },
      warnings,
    };
  },
  '.s3dx': async (file) => {
    const { board: b, metadata, warnings } = parseS3dx(await file.text());
    return {
      board: b,
      meta: { model: metadata?.model, designer: metadata?.designer, comments: metadata?.comments },
      warnings,
    };
  },
  '.srf': async (file) => {
    const result = parseSrf(await file.arrayBuffer());
    return {
      board: result.board,
      meta: { model: result.model, comments: result.comments },
      warnings: [],
    };
  },
};

const readBoardJsonFile: BoardFileReader = async (file) => {
  const { board, metadata } = readBoardJson(await file.text());
  return { board, meta: (metadata as BoardMeta) ?? {}, warnings: [] };
};

/** Read a user-picked file: a format importer by extension, else native .board.json. */
export async function openBoardFile(
  file: File,
): Promise<{ board: BezierBoard; meta: BoardMeta; warnings: readonly ImportWarning[] }> {
  const name = file.name.toLowerCase();
  const ext = Object.keys(BOARD_FILE_READERS).find((e) => name.endsWith(e));
  return ext ? BOARD_FILE_READERS[ext]!(file) : readBoardJsonFile(file);
}

export interface ImportDecision {
  /** 'confirm' → show the blocking dialog first; 'load' → load now. */
  readonly action: 'confirm' | 'load';
  readonly dropped: ImportWarning[];
  readonly info: ImportWarning[];
}

/** Classify import warnings into a load decision (pure). */
export function decideImport(warnings: readonly ImportWarning[]): ImportDecision {
  const dropped = warnings.filter((w) => w.severity === 'dropped');
  const info = warnings.filter((w) => w.severity === 'info');
  return { action: dropped.length > 0 ? 'confirm' : 'load', dropped, info };
}

export type TemplateFormat = 'dxf' | 'svg' | 'pdf';

/**
 * Download a built construction-template {@link TemplateSheet} in the chosen vector
 * format. DXF/SVG are emitted in `unit` (matching the editor's display unit); PDF is
 * always true 1:1 physical, so the unit only affects its printed note.
 */
export function downloadTemplateSheet(
  sheet: TemplateSheet,
  format: TemplateFormat,
  unit: SheetUnit = 'mm',
  baseName = 'hws-frame',
): void {
  switch (format) {
    case 'dxf':
      return download(sheetToDxf(sheet, { unit }), `${baseName}.dxf`, 'application/dxf');
    case 'svg':
      return download(sheetToSvg(sheet, { unit }), `${baseName}.svg`, 'image/svg+xml');
    case 'pdf':
      return download(
        sheetToPdf(sheet) as unknown as BlobPart,
        `${baseName}.pdf`,
        'application/pdf',
      );
  }
}

export type ExportFormat = 'stl' | 'dxf' | 'dxf-spline' | 'pdf-1to1';

/**
 * Export the board to STL / DXF / 1:1-PDF and download it. `meta` + `units`
 * feed the PDF labels (designer / model / surfer / comments). A loaded `ghost`
 * comparison board is overlaid on the DXF's GHOST layer.
 */
export function exportBoard(
  board: BezierBoard,
  format: ExportFormat,
  meta?: BoardMeta,
  units?: LengthUnit,
  ghost?: BezierBoard,
): void {
  const pdfUnit: 'cm' | 'in' = units?.unit === Unit.INCHES ? 'in' : 'cm';
  const pdfMeta = {
    designer: meta?.designer,
    model: meta?.model,
    surfer: meta?.surfer,
    comments: meta?.comments,
  };
  const slug = slugifyName(meta?.model);
  switch (format) {
    case 'stl':
      return download(exportStl(board), `${slug}.stl`, 'model/stl');
    case 'dxf':
      return download(
        exportDxf(board, { ghostBoard: ghost, curveMode: 'polyline' }),
        `${slug}.dxf`,
        'application/dxf',
      );
    case 'dxf-spline':
      return download(
        exportDxf(board, { ghostBoard: ghost, curveMode: 'spline' }),
        `${slug}-spline.dxf`,
        'application/dxf',
      );
    case 'pdf-1to1': {
      const pdf = exportBoardPdf1to1(board, { units: pdfUnit, meta: pdfMeta });
      return download(pdf as unknown as BlobPart, `${slug}-1to1.pdf`, 'application/pdf');
    }
  }
}

/**
 * Export the board's 1:1 geometry per the dialog `settings` (geometry selection,
 * paper-size tiling, overlap/cut marks, combined/per-part packaging) and download the
 * resulting PDF file(s). `units` only affects the printed labels + calibration ruler.
 */
export function downloadPdf1to1(
  board: BezierBoard,
  settings: Pdf1to1Settings,
  meta?: BoardMeta,
  units?: LengthUnit,
): void {
  const pdfUnit: 'cm' | 'in' = units?.unit === Unit.INCHES ? 'in' : 'cm';
  const pdfMeta = {
    designer: meta?.designer,
    model: meta?.model,
    surfer: meta?.surfer,
    comments: meta?.comments,
  };
  const tiling: PdfTiling | null = settings.slice
    ? {
        paper:
          settings.paperId === 'custom'
            ? customPaper(settings.customWidthCm, settings.customHeightCm)
            : (paperSizeById(settings.paperId) ?? PAPER_SIZES[0]!),
        orientation: settings.orientation,
        overlapCm: settings.overlapCm,
        cutMarks: settings.cutMarks,
        labels: settings.labels,
      }
    : null;
  const { files } = exportBoardPdf1to1Files(board, {
    units: pdfUnit,
    meta: pdfMeta,
    crossSectionCount: settings.crossSectionCount,
    parts: {
      outline: settings.outline,
      rocker: settings.rocker,
      crossSections: settings.crossSections,
      fins: settings.fins,
      calibration: settings.calibration,
    },
    tiling,
    packaging: settings.packaging,
  });
  // The export package names files 'board-1to1[-part].pdf'; swap in the model slug.
  const slug = slugifyName(meta?.model);
  for (const f of files) {
    download(f.bytes as unknown as BlobPart, f.name.replace(/^board/, slug), 'application/pdf');
  }
}
