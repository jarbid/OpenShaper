/**
 * Settings for the 1:1 PDF export dialog: which geometry to include, paper-size
 * tiling, overlap/cut marks, and combined/per-part packaging. Persisted as a single
 * versioned JSON blob in localStorage under 'bs.pdf1to1'. Modeled on settings.ts.
 */
import type { Orientation } from '@openshaper/export';

const STORAGE_KEY = 'bs.pdf1to1';

/** Bump when the shape of Pdf1to1Settings changes in a breaking way. */
export const PDF1TO1_VERSION = 1;

export interface Pdf1to1Settings {
  version: number;
  // --- Geometry ---
  outline: boolean;
  rocker: boolean;
  crossSections: boolean;
  fins: boolean;
  calibration: boolean;
  crossSectionCount: number;
  // --- Output packaging ---
  packaging: 'combined' | 'per-part';
  // --- Slicing ---
  /** When false, each part prints as one oversized page (wide-format plotter). */
  slice: boolean;
  /** Paper-size id from @openshaper/export PAPER_SIZES, or 'custom'. */
  paperId: string;
  /** Custom paper dimensions (internal centimetres), used when paperId === 'custom'. */
  customWidthCm: number;
  customHeightCm: number;
  orientation: Orientation;
  // --- Marks ---
  /** Shared overlap strip between tiles (internal centimetres). */
  overlapCm: number;
  cutMarks: boolean;
  labels: boolean;
}

export const DEFAULT_PDF1TO1: Pdf1to1Settings = {
  version: PDF1TO1_VERSION,
  outline: true,
  rocker: true,
  crossSections: true,
  fins: true,
  calibration: true,
  crossSectionCount: 7,
  packaging: 'combined',
  slice: true,
  paperId: 'a4',
  customWidthCm: 21,
  customHeightCm: 29.7,
  orientation: 'auto',
  overlapCm: 1,
  cutMarks: true,
  labels: true,
};

export function migratePdf1to1(blob: Pdf1to1Settings): Pdf1to1Settings {
  return { ...DEFAULT_PDF1TO1, ...blob, version: PDF1TO1_VERSION };
}

export function loadPdf1to1(): Pdf1to1Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PDF1TO1;
    return migratePdf1to1(JSON.parse(raw) as Pdf1to1Settings);
  } catch {
    return DEFAULT_PDF1TO1;
  }
}

export function savePdf1to1(s: Pdf1to1Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
