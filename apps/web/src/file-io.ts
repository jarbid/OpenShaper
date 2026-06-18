import {
  exportBoardPdf1to1,
  exportDxf,
  exportPdf,
  exportStl,
  type SheetUnit,
  sheetToDxf,
  sheetToPdf,
  sheetToSvg,
  type TemplateSheet,
} from '@openshaper/export';
import { getLength, getMaxWidth, getThickness, getVolume } from '@openshaper/kernel';
import { Unit } from '@openshaper/units';
import { fmtDimsHeadline, fmtVol, type LengthUnit } from './format';
import {
  parseBrd,
  parseS3d,
  parseSrf,
  readBoardJson,
  writeBoardJson,
  writeBrd,
} from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';
import { recordRecentBoard } from './recent-boards';

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
  download(text, 'board.brd', 'application/octet-stream');
}

type BoardFileReader = (file: File) => Promise<{ board: BezierBoard; meta: BoardMeta }>;

// Extension → importer. Each reader controls its own decoding (text vs
// arrayBuffer), so binary formats fit the same table.
const BOARD_FILE_READERS: Record<string, BoardFileReader> = {
  '.brd': async (file) => ({ board: parseBrd(await file.text()).board, meta: {} }),
  '.s3d': async (file) => {
    const { board: b, metadata } = parseS3d(await file.text());
    return {
      board: b,
      meta: { model: metadata?.model, designer: metadata?.designer, comments: metadata?.comments },
    };
  },
  '.srf': async (file) => {
    const result = parseSrf(await file.arrayBuffer());
    return { board: result.board, meta: { model: result.model, comments: result.comments } };
  },
};

const readBoardJsonFile: BoardFileReader = async (file) => {
  const { board, metadata } = readBoardJson(await file.text());
  return { board, meta: (metadata as BoardMeta) ?? {} };
};

/** Read a user-picked file: a format importer by extension, else native .board.json. */
export async function openBoardFile(file: File): Promise<{ board: BezierBoard; meta: BoardMeta }> {
  const name = file.name.toLowerCase();
  const ext = Object.keys(BOARD_FILE_READERS).find((e) => name.endsWith(e));
  return ext ? BOARD_FILE_READERS[ext]!(file) : readBoardJsonFile(file);
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

export type ExportFormat = 'stl' | 'dxf' | 'pdf' | 'pdf-1to1';

/**
 * Export the board to STL / DXF / PDF / 1:1-PDF and download it. `meta` + `units`
 * feed the PDF labels and spec sheet (designer / model / surfer / comments, and the
 * dimension headline). A loaded `ghost` comparison board is overlaid on the DXF's
 * GHOST layer.
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
  switch (format) {
    case 'stl':
      return download(exportStl(board), 'board.stl', 'model/stl');
    case 'dxf':
      return download(exportDxf(board, { ghostBoard: ghost }), 'board.dxf', 'application/dxf');
    case 'pdf': {
      // exportPdf returns a Uint8Array; cast for the DOM BlobPart type (runtime is fine).
      const headline = units
        ? `${fmtDimsHeadline(getLength(board), getMaxWidth(board), getThickness(board), units)} · ${fmtVol(getVolume(board))}`
        : undefined;
      const pdf = exportPdf(board, { title: meta?.model, meta: pdfMeta, units: pdfUnit, headline });
      return download(pdf as unknown as BlobPart, 'board.pdf', 'application/pdf');
    }
    case 'pdf-1to1': {
      const pdf = exportBoardPdf1to1(board, { units: pdfUnit, meta: pdfMeta });
      return download(pdf as unknown as BlobPart, 'board-1to1.pdf', 'application/pdf');
    }
  }
}
