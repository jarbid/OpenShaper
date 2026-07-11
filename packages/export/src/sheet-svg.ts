// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Render a {@link TemplateSheet} to SVG at real-world size. The output unit
 * follows the caller's {@link SheetUnit} (default `mm`): `width`/`height` carry
 * that unit and match the `viewBox`. Colour convention for laser software
 * (LightBurn / Glowforge): **red `#FF0000` = cut**, **blue `#0000FF` = engrave/mark**,
 * no fill. Also the source for the editor's live preview. Parts are stacked top-to-
 * bottom (centred on a common axis); SVG's y-down axis is flipped so the board reads
 * the same way as in the editor.
 */
import { BRAND_LINE } from './brand';
import { bboxOfPts, columnLayout } from './construction/geom';
import type { Label, Loop, Pt, TemplateSheet } from './construction/types';
import { SHEET_UNIT, type SheetUnit } from './construction/units';

const GAP = 5; // cm
const CUT = '#FF0000';
const MARK = '#0000FF';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SvgOptions {
  /** Cut/mark stroke width in mm. Default 0.1 (hairline). */
  strokeWidthMm?: number;
  /** Output unit. Default `mm`. */
  unit?: SheetUnit;
}

export const sheetToSvg = (sheet: TemplateSheet, opts: SvgOptions = {}): string => {
  const unit: SheetUnit = opts.unit ?? 'mm';
  const k = SHEET_UNIT[unit].factor; // cm -> output unit
  const parts = sheet.prearranged ? [...sheet.parts] : columnLayout(sheet.parts, GAP);
  const all: Pt[] = [];
  for (const part of parts) {
    for (const l of part.loops) all.push(...l.pts);
    for (const lbl of part.labels ?? []) all.push(lbl.at);
  }
  const bb = bboxOfPts(all);
  const wCm = bb.maxX + GAP;
  const hCm = bb.maxY + 2 * GAP; // extra bottom margin for the note line
  const w = wCm * k;
  const h = hCm * k;
  const sw = opts.strokeWidthMm ?? 0.1;

  const fx = (x: number): string => (x * k).toFixed(3);
  const fy = (y: number): string => ((hCm - y) * k).toFixed(3); // flip y, cm->unit

  const pathData = (pts: readonly Pt[], closed: boolean): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fx(p.x)} ${fy(p.y)}`).join(' ') +
    (closed ? ' Z' : '');

  const loopEl = (l: Loop): string => {
    const stroke = l.kind === 'mark' ? MARK : CUT;
    const dash = l.dashed
      ? ` stroke-dasharray="${(sw * 20).toFixed(2)},${(sw * 10).toFixed(2)}"`
      : '';
    return `    <path d="${pathData(l.pts, l.closed)}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
  };
  const labelEl = (lbl: Label): string =>
    `    <text x="${fx(lbl.at.x)}" y="${fy(lbl.at.y)}" font-size="${(lbl.height * k).toFixed(1)}" fill="${MARK}">${esc(lbl.text)}</text>`;

  const body = parts
    .map((part) => {
      const inner = [
        `    <title>${esc(part.label)}</title>`,
        ...part.loops.map(loopEl),
        ...(part.labels ?? []).map(labelEl),
      ].join('\n');
      return `  <g id="${esc(part.id)}">\n${inner}\n  </g>`;
    })
    .join('\n');

  // Board-info + units note in the bottom margin.
  const note = sheet.meta?.note
    ? `  <text x="${(GAP * k).toFixed(2)}" y="${(h - GAP * k * 0.4).toFixed(2)}" ` +
      `font-size="${(0.5 * k).toFixed(1)}" fill="${MARK}">${esc(sheet.meta.note)}</text>\n`
    : '';
  // Light product credit, bottom-right of the same margin.
  const brand =
    `  <text x="${(w - GAP * k).toFixed(2)}" y="${(h - GAP * k * 0.4).toFixed(2)}" ` +
    `text-anchor="end" font-size="${(0.35 * k).toFixed(1)}" fill="#999999">${esc(BRAND_LINE)}</text>\n`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}${unit}" height="${h.toFixed(3)}${unit}" ` +
    `viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}">\n` +
    `  <title>${esc(sheet.meta?.title ?? 'Template')}</title>\n` +
    `${body}\n${note}${brand}</svg>\n`
  );
};
