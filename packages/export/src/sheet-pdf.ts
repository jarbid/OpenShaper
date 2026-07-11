// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Render a {@link TemplateSheet} to a true **1:1** PDF — **one part per page**,
 * each page sized to that part's bounding box plus a margin. No tiling: PDF pages
 * may be oversized, so users print with their own poster/scale settings and every
 * dimension comes out at actual size. Cut loops print solid black; marks print as
 * a dashed grey; labels as small text. Hand-rolled with byte-accurate xref/trailer
 * (same technique as `pdf.ts`).
 */
import { BRAND_LINE } from './brand';
import { buildPdf, esc, n, type PageDoc } from './pdf-core';
import { partBbox } from './construction/geom';
import type { Label, Loop, Part, TemplateSheet } from './construction/types';

const CM_TO_PT = 72 / 2.54;
const MARGIN_CM = 1;

/** Build the content stream + page size for one part, at 1:1. */
const renderPart = (part: Part, note?: string): PageDoc => {
  const bb = partBbox(part);
  const m = MARGIN_CM;
  const width = (bb.maxX - bb.minX + 2 * m) * CM_TO_PT;
  const height = (bb.maxY - bb.minY + 2 * m) * CM_TO_PT;
  const px = (x: number): number => (x - bb.minX + m) * CM_TO_PT;
  const py = (y: number): number => (y - bb.minY + m) * CM_TO_PT; // PDF y-up, same as cm

  const c: string[] = [];
  const poly = (l: Loop): void => {
    if (l.pts.length < 2) return;
    if (l.kind === 'mark') {
      c.push('0.5 0.5 0.5 RG', '0.4 w', l.dashed ? '[3 2] 0 d' : '[] 0 d');
    } else {
      c.push('0 0 0 RG', '0.5 w', '[] 0 d');
    }
    c.push(`${n(px(l.pts[0]!.x))} ${n(py(l.pts[0]!.y))} m`);
    for (let i = 1; i < l.pts.length; i++) c.push(`${n(px(l.pts[i]!.x))} ${n(py(l.pts[i]!.y))} l`);
    c.push(l.closed ? 'h S' : 'S');
  };
  const label = (lbl: Label): void => {
    c.push(
      '0.4 0.4 0.4 rg',
      'BT',
      `/F1 ${n(Math.max(5, lbl.height * CM_TO_PT))} Tf`,
      `${n(px(lbl.at.x))} ${n(py(lbl.at.y))} Td`,
      `(${esc(lbl.text)}) Tj`,
      'ET',
    );
  };

  // Title in the top-left margin.
  c.push(
    '0 0 0 rg',
    'BT',
    '/F1 10 Tf',
    `${n(MARGIN_CM * CM_TO_PT)} ${n(height - 14)} Td`,
    `(${esc(part.label)}) Tj`,
    'ET',
  );
  for (const l of part.loops) poly(l);
  for (const lbl of part.labels ?? []) label(lbl);

  // Board-info + units note, then a lighter product credit, in the bottom margin.
  c.push(
    '0.4 0.4 0.4 rg',
    'BT',
    '/F1 8 Tf',
    `${n(MARGIN_CM * CM_TO_PT)} ${n(MARGIN_CM * CM_TO_PT * 0.4)} Td`,
    ...(note ? [`(${esc(note)}) Tj`] : []),
    '0.65 0.65 0.65 rg',
    '/F1 6 Tf',
    `(${esc((note ? '   ' : '') + BRAND_LINE)}) Tj`,
    'ET',
  );

  return { width, height, content: c.join('\n') + '\n' };
};

export const sheetToPdf = (sheet: TemplateSheet): Uint8Array => {
  const note = sheet.meta?.note;
  const pages = (
    sheet.parts.length > 0 ? sheet.parts : [{ id: 'empty', label: 'Empty', loops: [] }]
  ).map((part) => renderPart(part, note));
  return buildPdf(pages);
};
