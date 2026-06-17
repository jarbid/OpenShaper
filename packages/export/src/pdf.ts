import {
  FIN_SETUP_LABELS,
  FIN_SYSTEM_LABELS,
  getInterpolatedCrossSection,
  getLength,
  getMaxRocker,
  getMaxWidth,
  getMaxWidthPos,
  getRockerAtPos,
  getThickness,
  getThicknessAtPos,
  getVolume,
  pointByTT,
  resolveFins,
  valueAt,
  type BezierBoard,
  type ResolvedFin,
} from '@openshaper/kernel';

/** Board metadata shown on the spec sheet (mirrors apps/web BoardMeta's text fields). */
export interface PdfMeta {
  designer?: string;
  model?: string;
  surfer?: string;
  comments?: string;
}

/** Options for {@link exportPdf}. */
export interface PdfOptions {
  /** Polyline samples for the plan-view outline / rocker profiles. Default 200. */
  lengthSteps?: number;
  /** Page width in PDF points (1/72 inch). Default 612 (US Letter). */
  pageWidth?: number;
  /** Page height in PDF points. Default 792 (US Letter). */
  pageHeight?: number;
  /** Document title shown at the top of the page. Defaults to the model or "Surfboard". */
  title?: string;
  /** Board metadata (designer / model / surfer / comments). */
  meta?: PdfMeta;
  /** Display units for dimensions. Default 'cm'. */
  units?: 'cm' | 'in';
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
const esc = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

interface Pt {
  readonly x: number;
  readonly y: number;
}

/**
 * Hand-rolled single-page vector PDF spec sheet (BoardCAD-style, black & white):
 * header + spec block, the plan-view outline with width labels, the rocker profile
 * (deck + bottom) with thickness/rocker labels, three labelled cross-sections, and
 * a comments block. Built from scratch with `m`/`l`/`re`/`S`/`BT..Tj..ET` operators,
 * then an xref table with byte-accurate offsets and a trailer. Returned as raw bytes
 * (latin1) so offsets equal byte counts.
 */
export const exportPdf = (board: BezierBoard, opts: PdfOptions = {}): Uint8Array => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const pageW = opts.pageWidth ?? DEFAULT_PAGE_W;
  const pageH = opts.pageHeight ?? DEFAULT_PAGE_H;
  const meta = opts.meta ?? {};
  const inches = opts.units === 'in';
  const title = opts.title ?? meta.model ?? 'Surfboard';

  const length = getLength(board);
  const maxWidth = getMaxWidth(board);
  const thickness = getThickness(board);
  const volume = getVolume(board);
  const maxRocker = getMaxRocker(board);
  const wpPos = getMaxWidthPos(board);

  // --- length formatter for the active units ---
  const L = (cm: number): string =>
    inches ? `${(cm / 2.54).toFixed(2)} in` : `${cm.toFixed(1)} cm`;

  const c: string[] = [];

  // --- content-stream helpers ---
  const setStroke = (w: number): void => {
    c.push('0 0 0 RG', `${n(w)} w`);
  };
  const text = (x: number, y: number, size: number, str: string): void => {
    c.push('0 0 0 rg', 'BT', `/F1 ${n(size)} Tf`, `${n(x)} ${n(y)} Td`, `(${esc(str)}) Tj`, 'ET');
  };
  const seg = (a: Pt, b: Pt): void => {
    c.push(`${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S`);
  };
  const poly = (pts: readonly Pt[], close: boolean): void => {
    if (pts.length < 2) return;
    c.push(`${n(pts[0]!.x)} ${n(pts[0]!.y)} m`);
    for (let i = 1; i < pts.length; i++) c.push(`${n(pts[i]!.x)} ${n(pts[i]!.y)} l`);
    c.push(close ? 'h S' : 'S');
  };

  const margin = 48;
  const drawW = pageW - 2 * margin;
  let y = pageH - margin; // top-down cursor (PDF y-up)

  // Page border.
  setStroke(0.5);
  c.push(`${n(margin)} ${n(margin)} ${n(drawW)} ${n(pageH - 2 * margin)} re S`);

  // --- 1. Header + spec block ---
  text(margin + 4, y - 18, 18, title);
  y -= 30;
  const date = new Date().toISOString().slice(0, 10);
  const specLines = [
    meta.designer ? `Designer: ${meta.designer}` : '',
    meta.surfer ? `Surfer: ${meta.surfer}` : '',
    `Date: ${date}`,
    `Length ${L(length)}    Width ${L(maxWidth)}    Thickness ${L(thickness)}`,
    `Volume ${volume.toFixed(1)} cm^3 (${(volume / 1000).toFixed(2)} L)    Wide point ${L(wpPos)}    Max rocker ${L(maxRocker)}`,
    board.fins.setup !== 'none'
      ? `Fins: ${FIN_SETUP_LABELS[board.fins.setup]} · ${FIN_SYSTEM_LABELS[board.fins.system]}`
      : '',
  ].filter(Boolean);
  for (const lineStr of specLines) {
    text(margin + 4, y - 9, 10, lineStr);
    y -= 14;
  }
  y -= 6;
  setStroke(0.5);
  seg({ x: margin, y }, { x: pageW - margin, y });
  y -= 14;

  // Shared horizontal scale (pt per cm) so plan + rocker line up along the length.
  const sX = drawW / Math.max(length, 1e-6);
  const eps = Math.min(0.01, length / (lengthSteps * 4));
  const ox = margin; // length axis origin (x=0 at left margin)
  const samplesX = (i: number): number => eps + ((length - 2 * eps) * i) / lengthSteps;

  // --- 2. Plan-view outline (centred on a stringer line) ---
  const planH = maxWidth * sX;
  const planCY = y - planH / 2; // centreline y
  const half: Pt[] = [];
  for (let i = 0; i <= lengthSteps; i++) {
    const cmX = samplesX(i);
    half.push({ x: ox + cmX * sX, y: planCY + valueAt(board.outline, cmX) * sX });
  }
  const loop: Pt[] = [...half];
  for (let i = half.length - 1; i >= 0; i--)
    loop.push({ x: half[i]!.x, y: planCY - (half[i]!.y - planCY) });
  setStroke(1);
  poly(loop, true);
  // Stringer centreline.
  setStroke(0.4);
  seg({ x: ox + eps * sX, y: planCY }, { x: ox + (length - eps) * sX, y: planCY });
  // Width labels at tail (~30cm in), wide point, and nose (~30cm from nose).
  const widthAt = (pos: number) => 2 * valueAt(board.outline, pos);
  const labelStations: [number, string][] = [
    [Math.min(30, length * 0.15), 'tail'],
    [wpPos, 'wide'],
    [Math.max(length - 30, length * 0.85), 'nose'],
  ];
  for (const [pos, tag] of labelStations) {
    const lx = ox + pos * sX;
    setStroke(0.4);
    seg({ x: lx, y: planCY + valueAt(board.outline, pos) * sX }, { x: lx, y: planCY }); // tick
    text(lx - 16, planCY + planH / 2 + 2, 8, `${tag} ${L(widthAt(pos))}`);
  }

  // --- Fins on the plan view: toed footprint + box/plug router template. ---
  const fins = resolveFins(board);
  const planPt = (p: Pt): Pt => ({ x: ox + p.x * sX, y: planCY + p.y * sX });
  setStroke(0.7);
  for (const fin of fins) {
    seg(planPt(fin.baseLine.aft), planPt(fin.baseLine.fore));
    const cx = (fin.baseLine.fore.x + fin.baseLine.aft.x) / 2;
    const cy = (fin.baseLine.fore.y + fin.baseLine.aft.y) / 2;
    const dl = Math.hypot(fin.baseLine.fore.x - fin.baseLine.aft.x, fin.baseLine.fore.y - fin.baseLine.aft.y) || 1; // prettier-ignore
    const ax = (fin.baseLine.fore.x - fin.baseLine.aft.x) / dl;
    const ay = (fin.baseLine.fore.y - fin.baseLine.aft.y) / dl;
    if (fin.box.kind !== 'shapes') continue;
    for (const fp of fin.box.footprints) {
      const ocx = cx + ax * fp.along;
      const ocy = cy + ay * fp.along;
      if (fp.shape.kind === 'rect') {
        const hl = fp.shape.length / 2;
        const hw = fp.shape.width / 2;
        const corner = (sa: number, sn: number): Pt =>
          planPt({ x: ocx + ax * hl * sa - ay * hw * sn, y: ocy + ay * hl * sa + ax * hw * sn });
        poly([corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)], true);
      } else {
        const r = fp.shape.diameter / 2;
        const ring: Pt[] = [];
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          ring.push(planPt({ x: ocx + Math.cos(a) * r, y: ocy + Math.sin(a) * r }));
        }
        poly(ring, true);
      }
    }
  }
  y = planCY - planH / 2 - 18;

  // --- 3. Rocker profile (deck + bottom) ---
  const bottomPts: number[] = [];
  const deckPts: number[] = [];
  let rLo = Infinity;
  let rHi = -Infinity;
  for (let i = 0; i <= lengthSteps; i++) {
    const cmX = samplesX(i);
    const b = valueAt(board.bottom, cmX);
    const d = valueAt(board.deck, cmX);
    bottomPts.push(cmX, b);
    deckPts.push(cmX, d);
    rLo = Math.min(rLo, b, d);
    rHi = Math.max(rHi, b, d);
  }
  const rockerSpan = Math.max(rHi - rLo, 1e-6);
  const rockerBase = y - rockerSpan * sX; // bottom of the rocker band
  const ry = (cmY: number) => rockerBase + (cmY - rLo) * sX;
  const toPts = (flat: number[]): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 0; i < flat.length; i += 2)
      pts.push({ x: ox + flat[i]! * sX, y: ry(flat[i + 1]!) });
    return pts;
  };
  setStroke(1);
  poly(toPts(bottomPts), false);
  poly(toPts(deckPts), false);
  // Thickness & rocker labels at tail / center / nose.
  for (const [pos, tag] of [
    [Math.min(30, length * 0.15), 'tail'],
    [length / 2, 'center'],
    [Math.max(length - 30, length * 0.85), 'nose'],
  ] as [number, string][]) {
    const lx = ox + pos * sX;
    setStroke(0.3);
    seg({ x: lx, y: ry(valueAt(board.bottom, pos)) }, { x: lx, y: ry(valueAt(board.deck, pos)) });
    text(lx - 18, rockerBase - 10, 8, `${tag} t${L(getThicknessAtPos(board, pos))}`);
  }
  text(margin + 4, ry(rHi) + 2, 8, `max rocker ${L(getRockerAtPos(board, eps))}`);
  y = rockerBase - 24;

  // --- 4. Three labelled cross-sections (tail ~30cm, center, nose ~30cm) ---
  const csStations: [number, string][] = [
    [Math.min(30, length * 0.15), 'Tail'],
    [length / 2, 'Center'],
    [Math.max(length - 30, length * 0.85), 'Nose'],
  ];
  const cellW = drawW / 3;
  const csScale = Math.min(sX, (cellW - 24) / Math.max(maxWidth, 1e-6));
  const csTop = y;
  let csBottom = y;
  csStations.forEach(([pos, tag], k) => {
    const cs = getInterpolatedCrossSection(board, pos);
    const cellCX = margin + cellW * (k + 0.5);
    text(cellCX - 18, csTop, 8, `${tag} ${L(pos)}`);
    if (!cs) return;
    const ring: Pt[] = [];
    for (let r = 0; r <= lengthSteps; r++) {
      const p = pointByTT(cs.spline, r / lengthSteps);
      ring.push({ x: p.x, y: p.y });
    }
    const mirrored: Pt[] = [];
    for (let i = ring.length - 1; i >= 0; i--) mirrored.push({ x: -ring[i]!.x, y: ring[i]!.y });
    const full = [...ring, ...mirrored];
    let cyLo = Infinity;
    let cyHi = -Infinity;
    for (const p of full) {
      cyLo = Math.min(cyLo, p.y);
      cyHi = Math.max(cyHi, p.y);
    }
    const top = csTop - 12;
    const placed = full.map((p) => ({
      x: cellCX + p.x * csScale,
      y: top - (cyHi - p.y) * csScale,
    }));
    setStroke(0.8);
    poly(placed, true);
    csBottom = Math.min(csBottom, top - (cyHi - cyLo) * csScale);
  });
  y = csBottom - 22;

  // --- 4b. Fin placement table ---
  if (fins.length > 0) {
    text(margin + 4, y, 9, 'Fin placement:');
    y -= 13;
    const sideName = (s: ResolvedFin['side']): string =>
      s === 0 ? 'Center' : s < 0 ? 'Port' : 'Starboard';
    for (const fin of fins) {
      const angles = fin.side === 0 ? '' : `, toe ${fin.toe}°, cant ${fin.cant}°`;
      const row =
        `${sideName(fin.side)}: ${L(fin.spec.trailingFromTail)} from tail · ` +
        `base ${L(fin.spec.base)} · depth ${L(fin.spec.depth)}${angles} · ${fin.foil}`;
      text(margin + 4, y, 8, row);
      y -= 11;
    }
    y -= 6;
  }

  // --- 5. Comments (word-wrapped) ---
  if (meta.comments) {
    text(margin + 4, y, 9, 'Comments:');
    y -= 13;
    const words = meta.comments.split(/\s+/);
    const maxChars = Math.floor(drawW / 5); // ~5pt per char at 9pt Helvetica
    let lineStr = '';
    for (const w of words) {
      if ((lineStr + ' ' + w).trim().length > maxChars) {
        text(margin + 4, y, 9, lineStr);
        y -= 12;
        lineStr = w;
      } else {
        lineStr = (lineStr + ' ' + w).trim();
      }
    }
    if (lineStr) text(margin + 4, y, 9, lineStr);
  }

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
