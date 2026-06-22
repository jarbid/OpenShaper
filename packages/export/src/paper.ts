// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Paper sizes for tiling the 1:1 board PDF across sheets a shaper can actually
 * print. Sizes are stored in **PDF points** (1 pt = 1/72 in), the unit the
 * hand-rolled PDF writer in {@link ./pdf-core} uses for MediaBox dimensions.
 * ISO sizes are defined in millimetres, US sizes in inches, then converted once.
 */

/** PDF points per centimetre — the 1:1 scale factor used everywhere in the PDFs. */
export const POINTS_PER_CM = 72 / 2.54;

const PT_PER_MM = 72 / 25.4;
const PT_PER_IN = 72;

/** A printable sheet, sized in PDF points (portrait: width < height). */
export interface PaperSize {
  /** Stable id used in settings + the UI select. */
  readonly id: string;
  /** Human label for the picker. */
  readonly label: string;
  /** Width in PDF points (portrait orientation). */
  readonly wPt: number;
  /** Height in PDF points (portrait orientation). */
  readonly hPt: number;
}

const iso = (id: string, label: string, wMm: number, hMm: number): PaperSize => ({
  id,
  label,
  wPt: wMm * PT_PER_MM,
  hPt: hMm * PT_PER_MM,
});

const us = (id: string, label: string, wIn: number, hIn: number): PaperSize => ({
  id,
  label,
  wPt: wIn * PT_PER_IN,
  hPt: hIn * PT_PER_IN,
});

/** The paper sizes offered by the 1:1 PDF export dialog (portrait dimensions). */
export const PAPER_SIZES: readonly PaperSize[] = [
  iso('a4', 'A4', 210, 297),
  iso('a3', 'A3', 297, 420),
  iso('a2', 'A2', 420, 594),
  iso('a1', 'A1', 594, 841),
  iso('a0', 'A0', 841, 1189),
  us('letter', 'Letter', 8.5, 11),
  us('tabloid', 'Tabloid', 11, 17),
];

export const paperSizeById = (id: string): PaperSize | undefined =>
  PAPER_SIZES.find((p) => p.id === id);

/** Build a custom paper size from centimetre dimensions (e.g. a plotter roll width). */
export const customPaper = (wCm: number, hCm: number): PaperSize => ({
  id: 'custom',
  label: 'Custom',
  wPt: Math.max(1, wCm) * POINTS_PER_CM,
  hPt: Math.max(1, hCm) * POINTS_PER_CM,
});

export type Orientation = 'auto' | 'portrait' | 'landscape';

/**
 * Resolve a paper size to the requested orientation. `'auto'` picks whichever
 * orientation matches the part's aspect ratio (wide parts → landscape) so the
 * board tiles into the fewest sheets.
 */
export const orient = (p: PaperSize, o: Orientation, partAspect: number): PaperSize => {
  const landscape = { ...p, wPt: p.hPt, hPt: p.wPt };
  if (o === 'portrait') return p.wPt <= p.hPt ? p : landscape;
  if (o === 'landscape') return p.wPt >= p.hPt ? p : landscape;
  // auto: a part wider than tall prints best on a landscape sheet.
  const wantLandscape = partAspect >= 1;
  const isLandscape = p.wPt >= p.hPt;
  return wantLandscape === isLandscape ? p : landscape;
};
