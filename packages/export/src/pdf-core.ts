// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared primitives for the hand-rolled vector PDFs (spec sheet, template sheet,
 * 1:1 board sheet). Each generator builds a content stream of PDF operators, then
 * hands its pages to {@link buildPdf}, which assembles the objects with a
 * byte-accurate xref table and trailer and returns raw latin1 bytes (so file
 * offsets equal byte counts). No external PDF library.
 */

/** PDF number: fixed precision, no exponent, dot decimal. */
export const n = (v: number): string => {
  const x = Number.isFinite(v) ? v : 0;
  return (Math.round(x * 1000) / 1000).toString();
};

/** Escape a string for a PDF literal `(...)` Tj operand. */
export const esc = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Byte length of a string when encoded as latin1 (1 byte per code unit ≤ 0xFF). */
export const byteLen = (s: string): number => s.length;

export const latin1Bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** One page: its MediaBox size (PDF points) plus a ready content stream. */
export interface PageDoc {
  readonly width: number;
  readonly height: number;
  readonly content: string;
}

/**
 * Assemble one or more pages into a single PDF. Object plan: 1 Catalog, 2 Pages,
 * 3 Font (Helvetica /F1), then a (Page, Contents) object pair per page.
 */
export const buildPdf = (pages: readonly PageDoc[]): Uint8Array => {
  const list = pages.length > 0 ? pages : [{ width: 612, height: 792, content: '' }];
  const pageObjNum = (i: number): number => 4 + i * 2;
  const kids = list.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${list.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  list.forEach((pg, i) => {
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
  const count = objects.length + 1; // +1 for the free object 0
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return latin1Bytes(body + xref + trailer);
};
