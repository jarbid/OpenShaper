import {
  customPaper,
  exportBoardPdf1to1,
  exportBoardPdf1to1Files,
  exportDxf,
  exportRailBandsPdf,
  exportStep,
  exportStl,
  PAPER_SIZES,
  paperSizeById,
  type PdfTiling,
  type RailBandsWarning,
  type SheetUnit,
  sheetToDxf,
  sheetToPdf,
  sheetToSvg,
  type TemplateSheet,
} from '@openshaper/export';
import { Unit } from '@openshaper/units';
import { exportUnitFor, fmtLen, type LengthUnit } from './format';
import type { Pdf1to1Settings } from './pdf-export-settings';
import { DEFAULT_RAIL_BANDS, type RailBandsSettings } from './rail-bands-settings';
import { manualSpecOf } from './ExportRailBandsDialog';
import { STEP_TOLERANCE_CM, type StepSettings } from './step-export-settings';
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
 * non-alphanumerics collapsed to a single separator, edges trimmed. Falls back
 * to 'board' when the name is missing or has nothing usable in it. The
 * separator defaults to a hyphen (kebab-case), matching the export filenames;
 * pass '_' for the snake-case native-save name.
 */
export function slugifyName(name: string | undefined, separator = '-'): string {
  const sep = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '');
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

/**
 * Trigger a download of the board as a native .board.json document. When no
 * explicit `filename` is given, it is derived from the board's model name in
 * snake_case (`slugifyName(model, '_')`), falling back to 'board' — so a named
 * board saves as e.g. `my_fish.board` instead of the anonymous `board (n)`.
 */
export function downloadBoard(
  board: BezierBoard,
  meta?: BoardMeta,
  filename = `${slugifyName(meta?.model, '_')}.board`,
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

/**
 * Which importer {@link openBoardFile} would pick, as a bare format name
 * ('brd', 's3d', …, or 'board' for the native fallback). Lives here so it
 * resolves against the same registry rather than drifting from it.
 *
 * Deliberately derives only the format, never the file name — callers use this
 * for analytics, where the name would be user content.
 */
export function sourceExtension(fileName: string): string {
  const name = fileName.toLowerCase();
  const ext = Object.keys(BOARD_FILE_READERS).find((e) => name.endsWith(e));
  return ext ? ext.slice(1) : 'board';
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
 * always true 1:1 physical, so the unit only affects its printed note. Pass
 * `pdfTiling` to slice the PDF parts across a home paper size (null = plot pages).
 */
export function downloadTemplateSheet(
  sheet: TemplateSheet,
  format: TemplateFormat,
  unit: SheetUnit = 'mm',
  baseName = 'hws-frame',
  pdfTiling: PdfTiling | null = null,
): void {
  switch (format) {
    case 'dxf':
      return download(sheetToDxf(sheet, { unit }), `${baseName}.dxf`, 'application/dxf');
    case 'svg':
      return download(sheetToSvg(sheet, { unit }), `${baseName}.svg`, 'image/svg+xml');
    case 'pdf':
      return download(
        sheetToPdf(sheet, { tiling: pdfTiling }) as unknown as BlobPart,
        `${baseName}.pdf`,
        'application/pdf',
      );
  }
}

export type ExportFormat = 'stl' | 'step' | 'dxf' | 'dxf-spline' | 'pdf-1to1' | 'rail-bands';

/**
 * Display names for each export format. Typed as a full `Record`, which is what
 * makes it exhaustive: adding a member to `ExportFormat` without adding it here
 * is a compile error. Mirrors the `FIN_*_LABELS` convention in the kernel.
 */
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  stl: 'STL (3D mesh)',
  step: 'STEP (3D surfaces)',
  dxf: 'DXF (polylines)',
  'dxf-spline': 'DXF (true curves)',
  'pdf-1to1': 'PDF (1:1 template)',
  'rail-bands': 'PDF (rail bands)',
};

/**
 * The formats as runtime values, so they can be enumerated — the docs coverage
 * test walks this to check every export format is documented.
 */
export const EXPORT_FORMATS = Object.keys(EXPORT_FORMAT_LABELS) as ExportFormat[];

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
    case 'step':
      return download(
        exportStep(board, { unit: units ? exportUnitFor(units) : 'mm', name: slug }),
        `${slug}.step`,
        'model/step',
      );
    case 'pdf-1to1': {
      const pdf = exportBoardPdf1to1(board, { units: pdfUnit, meta: pdfMeta });
      return download(pdf as unknown as BlobPart, `${slug}-1to1.pdf`, 'application/pdf');
    }
    case 'rail-bands': {
      // The menu opens the dialog; this no-options path exists so the format is
      // exportable from the same switch as the rest. Warnings are dropped here — the
      // dialog is where they are shown, and they are printed on the sheet regardless.
      downloadRailBands(board, DEFAULT_RAIL_BANDS, meta, units);
      return;
    }
    default: {
      // Adding a member to `ExportFormat` without a case here used to compile
      // cleanly and silently download nothing: the function returns void and
      // `noImplicitReturns` is off. This makes the omission a type error.
      const never: never = format;
      return never;
    }
  }
}

/**
 * Export the board's 1:1 geometry per the dialog `settings` (geometry selection,
 * paper-size tiling, overlap/cut marks, combined/per-part packaging) and download the
 * resulting PDF file(s). `units` only affects the printed labels + calibration ruler.
 */
/**
 * Export STEP per the dialog `settings`. The plain `exportBoard('step')` path
 * stays as the no-options default; this is the one the menu uses.
 */
export function downloadStep(
  board: BezierBoard,
  settings: StepSettings,
  meta?: BoardMeta,
  units?: LengthUnit,
): void {
  const slug = slugifyName(meta?.model);
  const unit: SheetUnit =
    settings.unit === 'auto' ? (units ? exportUnitFor(units) : 'mm') : settings.unit;
  return download(
    exportStep(board, { unit, name: slug, tolerance: STEP_TOLERANCE_CM[settings.accuracy] }),
    `${slug}.step`,
    'model/step',
  );
}

/**
 * Export the rail-band sheet per the dialog `settings` and download it.
 *
 * The editor's own length formatter is handed to the exporter rather than a unit flag,
 * because these numbers get marked onto foam with a tape measure: an inch user needs
 * `1 1/4"`, not `1.25 in`. `packages/export` cannot reach `@openshaper/units` itself
 * (nor should it), so the formatter crosses the boundary as a function.
 *
 * Returns the geometry warnings so the caller can surface them; they are also printed
 * on the sheet.
 */
export function downloadRailBands(
  board: BezierBoard,
  settings: RailBandsSettings,
  meta?: BoardMeta,
  units?: LengthUnit,
): readonly RailBandsWarning[] {
  const slug = slugifyName(meta?.model);
  const res = exportRailBandsPdf(board, {
    units: units?.unit === Unit.INCHES ? 'in' : 'cm',
    fmt: units ? (cm: number) => fmtLen(cm, units) : undefined,
    meta: {
      designer: meta?.designer,
      model: meta?.model,
      surfer: meta?.surfer,
      comments: meta?.comments,
    },
    facets: {
      deckBands: settings.bands,
      angleMode: settings.angleMode,
      bottomAngle: settings.bottomAngle,
    },
    manual: manualSpecOf(settings),
    stationSpacingCm: settings.stationSpacingCm,
    endMarginCm: settings.endMarginCm,
    detailPages: settings.detailPages,
    ghostSection: settings.ghostSection,
    calibration: settings.calibration,
    paper: paperSizeById(settings.paperId),
  });
  download(res.file.bytes as unknown as BlobPart, `${slug}-rail-bands.pdf`, 'application/pdf');
  return res.warnings;
}

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
    outlineHalf: settings.outlineHalf,
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
