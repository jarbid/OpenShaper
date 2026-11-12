// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The profile as an SVG drawing (owner request), for a drawing program or another shaper.
 * It is drawn as the Profile view shows it: the front on the left, the base along the
 * bottom closing the shape, at full size in mm. Every point and handle is written as it
 * is, so Open → Import vector outline, facing left, reads back the same profile.
 */
import type { Spline } from '@openshaper/kernel';

/** Space round the drawing (mm), so the line isn't cut at the page's edge. */
const MARGIN_MM = 2;

const escapeXml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mm = (v: number): string => String(+v.toFixed(4));

export function profileSvg(outline: Spline, title = 'Fin profile'): string {
  const k = outline.knots;
  const pts = k.flatMap((n) => [n.end, n.tangentToPrev, n.tangentToNext]);
  const maxX = Math.max(...pts.map((p) => p.x));
  const minX = Math.min(...pts.map((p) => p.x));
  const maxY = Math.max(0, ...pts.map((p) => p.y));
  const minY = Math.min(0, ...pts.map((p) => p.y));
  // cm in the outline's frame (+x toward the nose, y up) to mm on the page, nose left.
  const at = (p: { x: number; y: number }) =>
    `${mm((maxX - p.x) * 10 + MARGIN_MM)} ${mm((maxY - p.y) * 10 + MARGIN_MM)}`;
  let d = `M${at(k[0]!.end)}`;
  for (let i = 1; i < k.length; i++) {
    d += ` C${at(k[i - 1]!.tangentToNext)} ${at(k[i]!.tangentToPrev)} ${at(k[i]!.end)}`;
  }
  d += ' Z';
  const w = mm((maxX - minX) * 10 + 2 * MARGIN_MM);
  const h = mm((maxY - minY) * 10 + 2 * MARGIN_MM);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    `  <title>${escapeXml(title)}</title>`,
    `  <path d="${d}" fill="none" stroke="#000" stroke-width="0.25"/>`,
    '</svg>',
    '',
  ].join('\n');
}
