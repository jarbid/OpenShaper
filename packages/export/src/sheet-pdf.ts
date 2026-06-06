// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Render a {@link TemplateSheet} to a true **1:1** PDF — **one part per page**,
 * each page sized to that part's bounding box plus a margin. No tiling: PDF pages
 * may be oversized, so users print with their own poster/scale settings and every
 * dimension comes out at actual size. Cut loops print solid black; marks print as
 * a dashed grey; labels as small text. Hand-rolled with byte-accurate xref/trailer
 * (same technique as `pdf.ts`).
 */
import { partBbox } from './construction/geom';
import type { Label, Loop, Part, TemplateSheet } from './construction/types';

const CM_TO_PT = 72 / 2.54;
const MARGIN_CM = 1;

const n = (v: number): string => {
  const x = Number.isFinite(v) ? v : 0;
  return (Math.round(x * 1000) / 1000).toString();
};
const esc = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const byteLen = (s: string): number => s.length;
const latin1Bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

interface PageDoc {
  readonly width: number;
  readonly height: number;
  readonly content: string;
}

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

  // Board-info + units note in the bottom margin.
  if (note) {
    c.push(
      '0.4 0.4 0.4 rg',
      'BT',
      '/F1 8 Tf',
      `${n(MARGIN_CM * CM_TO_PT)} ${n(MARGIN_CM * CM_TO_PT * 0.4)} Td`,
      `(${esc(note)}) Tj`,
      'ET',
    );
  }

  return { width, height, content: c.join('\n') + '\n' };
};

export const sheetToPdf = (sheet: TemplateSheet): Uint8Array => {
  const note = sheet.meta?.note;
  const pages = (
    sheet.parts.length > 0 ? sheet.parts : [{ id: 'empty', label: 'Empty', loops: [] }]
  ).map((part) => renderPart(part, note));

  // Object plan: 1 Catalog, 2 Pages, 3 Font, then (page, content) pair per page.
  const pageObjNum = (i: number): number => 4 + i * 2;
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // Append page + content objects in order so object numbers match pageObjNum().
  pages.forEach((pg, i) => {
    const contentObjNum = pageObjNum(i) + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pg.width)} ${n(pg.height)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>`,
    );
    objects.push(`<< /Length ${byteLen(pg.content)} >>\nstream\n${pg.content}endstream`);
  });

  const header = '%PDF-1.4\n%âãÏÓ\n';
  let body = header;
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLen(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = byteLen(body);
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return latin1Bytes(body + xref + trailer);
};
