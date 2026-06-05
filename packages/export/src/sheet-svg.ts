// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Render a {@link TemplateSheet} to SVG in **millimetres** (real-world size: the
 * `width`/`height` carry mm units and match the `viewBox`). Colour convention for
 * laser software (LightBurn / Glowforge): **red `#FF0000` = cut**, **blue
 * `#0000FF` = engrave/mark**, no fill. Also the source for the editor's live
 * preview. Parts are laid out in a row; SVG's y-down axis is flipped so the board
 * reads the same way as in the editor.
 */
import { bboxOfPts, rowLayout } from './construction/geom';
import type { Label, Loop, Pt, TemplateSheet } from './construction/types';

const GAP = 5; // cm
const CUT = '#FF0000';
const MARK = '#0000FF';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SvgOptions {
  /** Cut/mark stroke width in mm. Default 0.1 (hairline). */
  strokeWidthMm?: number;
}

export const sheetToSvg = (sheet: TemplateSheet, opts: SvgOptions = {}): string => {
  const parts = rowLayout(sheet.parts, GAP);
  const all: Pt[] = [];
  for (const part of parts) {
    for (const l of part.loops) all.push(...l.pts);
    for (const lbl of part.labels ?? []) all.push(lbl.at);
  }
  const bb = bboxOfPts(all);
  const wCm = bb.maxX + GAP;
  const hCm = bb.maxY + GAP;
  const wMm = wCm * 10;
  const hMm = hCm * 10;
  const sw = opts.strokeWidthMm ?? 0.1;

  const fx = (x: number): string => (x * 10).toFixed(2);
  const fy = (y: number): string => ((hCm - y) * 10).toFixed(2); // flip y, cm→mm

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
    `    <text x="${fx(lbl.at.x)}" y="${fy(lbl.at.y)}" font-size="${(lbl.height * 10).toFixed(1)}" fill="${MARK}">${esc(lbl.text)}</text>`;

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

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wMm.toFixed(2)}mm" height="${hMm.toFixed(2)}mm" ` +
    `viewBox="0 0 ${wMm.toFixed(2)} ${hMm.toFixed(2)}">\n` +
    `  <title>${esc(sheet.meta?.title ?? 'Template')}</title>\n` +
    `${body}\n</svg>\n`
  );
};
