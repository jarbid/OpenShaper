import {
  exportDxf,
  exportPdf,
  exportStl,
  sheetToDxf,
  sheetToPdf,
  sheetToSvg,
  type TemplateSheet,
} from '@openshaper/export';
import { parseBrd, readBoardJson, writeBoardJson } from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';

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
  filename = 'board.board.json',
): void {
  const metadata =
    meta && Object.values(meta).some(Boolean) ? (meta as Record<string, unknown>) : undefined;
  download(writeBoardJson(board, metadata), filename, 'application/json');
}

/** Read a user-picked file: native .board.json or a legacy .brd import. */
export async function openBoardFile(file: File): Promise<{ board: BezierBoard; meta: BoardMeta }> {
  const text = await file.text();
  if (file.name.toLowerCase().endsWith('.brd')) return { board: parseBrd(text).board, meta: {} };
  const { board, metadata } = readBoardJson(text);
  return { board, meta: (metadata as BoardMeta) ?? {} };
}

export type TemplateFormat = 'dxf' | 'svg' | 'pdf';

/** Download a built construction-template {@link TemplateSheet} in the chosen vector format. */
export function downloadTemplateSheet(
  sheet: TemplateSheet,
  format: TemplateFormat,
  baseName = 'hws-frame',
): void {
  switch (format) {
    case 'dxf':
      return download(sheetToDxf(sheet), `${baseName}.dxf`, 'application/dxf');
    case 'svg':
      return download(sheetToSvg(sheet), `${baseName}.svg`, 'image/svg+xml');
    case 'pdf':
      return download(
        sheetToPdf(sheet) as unknown as BlobPart,
        `${baseName}.pdf`,
        'application/pdf',
      );
  }
}

export type ExportFormat = 'stl' | 'dxf' | 'pdf';

/**
 * Export the board to STL / DXF / PDF and download it. `meta` + `units` feed the
 * PDF spec sheet (designer / model / surfer / comments, and dimension units).
 */
export function exportBoard(
  board: BezierBoard,
  format: ExportFormat,
  meta?: BoardMeta,
  units: 'cm' | 'in' = 'cm',
): void {
  switch (format) {
    case 'stl':
      return download(exportStl(board), 'board.stl', 'model/stl');
    case 'dxf':
      return download(exportDxf(board), 'board.dxf', 'application/dxf');
    case 'pdf': {
      // exportPdf returns a Uint8Array; cast for the DOM BlobPart type (runtime is fine).
      const pdf = exportPdf(board, {
        title: meta?.model,
        meta: {
          designer: meta?.designer,
          model: meta?.model,
          surfer: meta?.surfer,
          comments: meta?.comments,
        },
        units,
      });
      return download(pdf as unknown as BlobPart, 'board.pdf', 'application/pdf');
    }
  }
}
