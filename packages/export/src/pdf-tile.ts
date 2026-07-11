// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Slice a full-size board drawing across printable sheets. The drawing is rendered
 * **once** in PDF points (true 1:1); each tile is a paper-sized page that *clips and
 * translates* a window of that drawing — geometry and labels come out actual-size on
 * every sheet, with no re-sampling and no scaling. Adjacent tiles share an `overlap`
 * strip so the shaper can glue them edge-over-edge; each tile carries a code
 * (top-left = `A1`), cut/registration marks, and the neighbouring tiles' codes printed
 * in the shared strips for easy assembly.
 */
import { esc, n, type PageDoc } from './pdf-core';
import type { PaperSize } from './paper';

/** A part of the board rendered full-size: content stream sized `widthPt × heightPt`. */
export interface PartDrawing {
  readonly title: string;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly content: string;
}

export interface TileOptions {
  /** Sheet size, already resolved to the desired orientation. */
  readonly paper: PaperSize;
  /** White border kept around the printable area on every sheet (points). */
  readonly marginPt?: number;
  /** Shared overlap strip between adjacent tiles (points). */
  readonly overlapPt: number;
  /** Draw corner crop ticks + printable-area trim border. */
  readonly cutMarks: boolean;
  /** Draw tile codes, footer labels, and neighbour join IDs. */
  readonly labels: boolean;
  /** Short part name shown in labels (e.g. "Outline"). */
  readonly partCode: string;
}

const DEFAULT_MARGIN_PT = 36; // 0.5"

/** Tile code from a row-from-top index and a column index: A1, A2, …, B1, … */
const tileCode = (rowFromTop: number, col: number): string =>
  `${String.fromCharCode(65 + (rowFromTop % 26))}${col + 1}`;

const line = (
  out: string[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dashed: boolean,
): void => {
  out.push(
    '0 0 0 RG',
    '0.4 w',
    dashed ? '[3 3] 0 d' : '[] 0 d',
    `${n(x0)} ${n(y0)} m`,
    `${n(x1)} ${n(y1)} l`,
    'S',
  );
};

const text = (out: string[], x: number, y: number, str: string, size: number, gray = 0): void => {
  out.push(
    `${n(gray)} ${n(gray)} ${n(gray)} rg`,
    'BT',
    `/F1 ${n(size)} Tf`,
    `${n(x)} ${n(y)} Td`,
    `(${esc(str)}) Tj`,
    'ET',
  );
};

/** Slice `part` into paper-sized pages. Returns reading-order pages (top row first). */
export const tileDrawing = (part: PartDrawing, opts: TileOptions): PageDoc[] => {
  const margin = opts.marginPt ?? DEFAULT_MARGIN_PT;
  const printW = Math.max(1, opts.paper.wPt - 2 * margin);
  const printH = Math.max(1, opts.paper.hPt - 2 * margin);
  // Overlap can't exceed half the live area, or steps go non-positive.
  const overlap = Math.max(0, Math.min(opts.overlapPt, printW * 0.5, printH * 0.5));
  const stepX = printW - overlap;
  const stepY = printH - overlap;

  const cols =
    part.widthPt <= printW ? 1 : Math.max(1, Math.ceil((part.widthPt - overlap) / stepX));
  const rows =
    part.heightPt <= printH ? 1 : Math.max(1, Math.ceil((part.heightPt - overlap) / stepY));

  const tickLen = 10;
  const pages: PageDoc[] = [];

  // Reading order: top row → bottom, left → right. Part-space y is up, so the
  // top row (rowFromTop 0) is the highest band: r counts from the bottom.
  for (let rowFromTop = 0; rowFromTop < rows; rowFromTop++) {
    const r = rows - 1 - rowFromTop;
    for (let c = 0; c < cols; c++) {
      const tx = margin - c * stepX;
      const ty = margin - r * stepY;
      const out: string[] = [];

      // Clip to the printable area, then place the full-size drawing in its window.
      out.push(
        'q',
        `${n(margin)} ${n(margin)} ${n(printW)} ${n(printH)} re W n`,
        `1 0 0 1 ${n(tx)} ${n(ty)} cm`,
        part.content.trimEnd(),
        'Q',
      );

      const left = margin;
      const right = margin + printW;
      const bottom = margin;
      const top = margin + printH;
      const hasLeft = c > 0;
      const hasRight = c < cols - 1;
      const hasBelow = r > 0; // a tile exists below in part-space
      const hasAbove = r < rows - 1;

      if (opts.cutMarks) {
        // Printable-area trim border.
        out.push(
          '0 0 0 RG',
          '0.4 w',
          '[] 0 d',
          `${n(left)} ${n(bottom)} ${n(printW)} ${n(printH)} re S`,
        );
        // Corner crop ticks reaching into the margin.
        for (const [cx, cy, sx, sy] of [
          [left, bottom, -1, -1],
          [right, bottom, 1, -1],
          [left, top, -1, 1],
          [right, top, 1, 1],
        ] as const) {
          line(out, cx, cy, cx + sx * tickLen, cy, false);
          line(out, cx, cy, cx, cy + sy * tickLen, false);
        }
      }

      if (overlap > 0) {
        // Dashed overlap boundary on each leading edge that meets a neighbour.
        if (hasLeft) line(out, left + overlap, bottom, left + overlap, top, true);
        if (hasBelow) line(out, left, bottom + overlap, right, bottom + overlap, true);
      }

      if (opts.labels) {
        const code = tileCode(rowFromTop, c);
        // Big tile code, top-left inside the printable area.
        text(out, left + 6, top - 16, code, 13, 0.55);
        // Footer: part + position + scale reminder.
        text(
          out,
          left + 6,
          bottom - tickLen - 9,
          `${opts.partCode} · ${code} (row ${rowFromTop + 1}/${rows}, col ${c + 1}/${cols}) · print at 100% · openshaper.com`,
          7,
          0.4,
        );
        // Neighbour join IDs printed toward each shared edge, so the shaper knows
        // which tile glues onto which side.
        if (hasRight) text(out, right - 26, top - 16, `${tileCode(rowFromTop, c + 1)} >`, 8, 0.5);
        if (hasLeft) text(out, left + 6, top - 30, `< ${tileCode(rowFromTop, c - 1)}`, 8, 0.5);
        if (hasAbove) text(out, (left + right) / 2 - 10, top - 14, `^ ${tileCode(rowFromTop - 1, c)}`, 8, 0.5); // prettier-ignore
        if (hasBelow) text(out, left + 6, bottom + 6, `v ${tileCode(rowFromTop + 1, c)}`, 8, 0.5);
      }

      pages.push({ width: opts.paper.wPt, height: opts.paper.hPt, content: out.join('\n') + '\n' });
    }
  }

  return pages;
};
