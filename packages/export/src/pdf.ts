import {
  getLength,
  getMaxWidth,
  getThickness,
  getVolume,
  valueAt,
  type BezierBoard,
} from '@board-studio/kernel';

/** Options for {@link exportPdf}. */
export interface PdfOptions {
  /** Polyline samples for the plan-view outline. Default 200. */
  lengthSteps?: number;
  /** Page width in PDF points (1/72 inch). Default 612 (US Letter). */
  pageWidth?: number;
  /** Page height in PDF points. Default 792 (US Letter). */
  pageHeight?: number;
  /** Document title shown at the top of the page. Default `Board Studio Export`. */
  title?: string;
}

const DEFAULT_LENGTH_STEPS = 200;
const DEFAULT_PAGE_W = 612;
const DEFAULT_PAGE_H = 792;

/** PDF number: fixed precision, no exponent, dot decimal. */
const n = (v: number): string => {
  const x = Number.isFinite(v) ? v : 0;
  return (Math.round(x * 1000) / 1000).toString();
};

/** Escape a string for a PDF literal `(...)` Tj operand. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * Hand-rolled single-page vector PDF: the plan-view outline (scaled to fit) plus a
 * spec text block (length / width / thickness / volume from the kernel getters).
 *
 * Built from scratch — header, 5 indirect objects, a content stream of `m`/`l`/`re`/
 * `S`/`BT..Tj..ET` operators, then an xref table with byte-accurate offsets and a
 * trailer. Returned as raw bytes (latin1) so offsets equal byte counts.
 */
export const exportPdf = (board: BezierBoard, opts: PdfOptions = {}): Uint8Array => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const pageW = opts.pageWidth ?? DEFAULT_PAGE_W;
  const pageH = opts.pageHeight ?? DEFAULT_PAGE_H;
  const title = opts.title ?? 'Board Studio Export';

  const length = getLength(board);
  const maxWidth = getMaxWidth(board);
  const thickness = getThickness(board);
  const volume = getVolume(board);

  // --- Build the content stream ---
  const margin = 54;
  const drawW = pageW - 2 * margin;
  // Reserve the top ~120pt for the title + spec text; outline fills the rest.
  const drawTop = pageH - margin - 110;
  const drawBottom = margin;
  const drawH = drawTop - drawBottom;

  // Outline spans length (x, cm) by maxWidth (y, cm); fit preserving aspect ratio.
  const eps = Math.min(0.01, length / (lengthSteps * 4));
  const scale = Math.min(drawW / Math.max(length, 1e-6), drawH / Math.max(maxWidth, 1e-6));
  const originX = margin + (drawW - length * scale) / 2;
  const originY = drawBottom + (drawH - maxWidth * scale) / 2 + (maxWidth / 2) * scale;

  const px = (cmX: number): number => originX + cmX * scale;
  const py = (cmY: number): number => originY + cmY * scale;

  const c: string[] = [];
  // Page border.
  c.push('0.6 0.6 0.6 RG 0.5 w');
  c.push(`${n(margin)} ${n(margin)} ${n(pageW - 2 * margin)} ${n(pageH - 2 * margin)} re S`);

  // Title + spec text.
  c.push('0 0 0 rg BT /F1 16 Tf');
  c.push(`${n(margin + 6)} ${n(pageH - margin - 22)} Td (${esc(title)}) Tj ET`);
  const specY = pageH - margin - 46;
  const spec = [
    `Length:    ${length.toFixed(2)} cm  (${(length / 2.54).toFixed(2)} in)`,
    `Width:     ${maxWidth.toFixed(2)} cm  (${(maxWidth / 2.54).toFixed(2)} in)`,
    `Thickness: ${thickness.toFixed(2)} cm  (${(thickness / 2.54).toFixed(2)} in)`,
    `Volume:    ${volume.toFixed(1)} cm^3  (${(volume / 1000).toFixed(2)} L)`,
  ];
  c.push('BT /F1 11 Tf 13 TL');
  c.push(`${n(margin + 6)} ${n(specY)} Td`);
  for (let i = 0; i < spec.length; i++) {
    if (i > 0) c.push('T*');
    c.push(`(${esc(spec[i]!)}) Tj`);
  }
  c.push('ET');

  // Plan-view outline (closed loop, both rails).
  c.push('0 0 0 RG 1 w');
  const half: Array<[number, number]> = [];
  for (let i = 0; i <= lengthSteps; i++) {
    const cmX = eps + ((length - 2 * eps) * i) / lengthSteps;
    half.push([cmX, valueAt(board.outline, cmX)]);
  }
  const loop: Array<[number, number]> = [...half];
  for (let i = half.length - 1; i >= 0; i--) loop.push([half[i]![0], -half[i]![1]]);
  c.push(`${n(px(loop[0]![0]))} ${n(py(loop[0]![1]))} m`);
  for (let i = 1; i < loop.length; i++) c.push(`${n(px(loop[i]![0]))} ${n(py(loop[i]![1]))} l`);
  c.push('h S');
  // Stringer centreline.
  c.push('0.7 0.7 0.7 RG 0.5 w');
  c.push(`${n(px(eps))} ${n(py(0))} m ${n(px(length - eps))} ${n(py(0))} l S`);

  const content = c.join('\n') + '\n';

  // --- Assemble objects ---
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] ` +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  // --- Serialize with byte-accurate xref ---
  const header = '%PDF-1.4\n%âãÏÓ\n';
  let body = header;
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLen(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = byteLen(body);
  const count = objects.length + 1; // +1 for the free object 0
  let xref = `xref\n0 ${count}\n`;
  xref += '0000000000 65535 f \n';
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${count} /Root 1 0 R >>\n` + `startxref\n${xrefOffset}\n%%EOF\n`;

  return latin1Bytes(body + xref + trailer);
};

/** Byte length of a string when encoded as latin1 (1 byte per code unit ≤ 0xFF). */
const byteLen = (s: string): number => s.length;

const latin1Bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
