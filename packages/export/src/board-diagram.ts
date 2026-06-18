// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A technical `<svg>` drawing of a board — plan outline, rocker profile, and three
 * labelled cross-sections — mirroring the layout of the vector PDF spec sheet
 * (`pdf.ts`) so the printable HTML sheet and the PDF share one look. Pure
 * `board -> string` (no DOM). Strokes/labels use CSS classes (`.outline`,
 * `.profile`, `.center`, `.tick`, `.fin`, `.dim`, `.tag`) so the embedding sheet
 * colours them (cyan on screen, black on print). Dimension labels are formatted by
 * the caller-supplied `fmt` so they follow the editor's unit.
 */
import {
  getLength,
  getMaxRocker,
  getMaxWidth,
  getMaxWidthPos,
  resolveFins,
  valueAt,
  type BezierBoard,
} from '@openshaper/kernel';
import { bbox, crossSectionRing, planOutlineLoop, sampleProfile, type Pt } from './board-curves';

export interface BoardDiagramOptions {
  /** Drawing width in SVG user units (the sheet scales it to fit). Default 860. */
  width?: number;
  /** Length formatter for dimension labels (e.g. `cm => fmtLen(cm, units)`). */
  fmt?: (cm: number) => string;
}

const f = (v: number): string => (Math.round(v * 100) / 100).toString();
const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

export const boardDiagramSvg = (board: BezierBoard, opts: BoardDiagramOptions = {}): string => {
  const W = opts.width ?? 860;
  const fmt = opts.fmt ?? ((cm: number) => `${cm.toFixed(1)} cm`);
  const steps = 200;
  const ringSteps = 64;
  const pad = 18;

  const length = getLength(board);
  const eps = Math.min(0.01, length / (steps * 4));
  const s = (W - 2 * pad) / Math.max(length, 1e-6); // shared horizontal scale (px per cm)
  const maxWidth = getMaxWidth(board);
  const wpPos = getMaxWidthPos(board);
  const sx = (x: number): number => pad + x * s;

  const out: string[] = [];
  const path = (pts: readonly Pt[], cls: string, close: boolean): void => {
    if (pts.length < 2) return;
    let d = '';
    pts.forEach((p, i) => {
      d += `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)} `;
    });
    out.push(`<path d="${d.trim()}${close ? ' Z' : ''}" class="${cls}"/>`);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, cls: string): void => {
    out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" class="${cls}"/>`);
  };
  const dim = (x: number, y: number, str: string, anchor = 'middle'): void => {
    out.push(
      `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" class="dim">${esc(str)}</text>`,
    );
  };
  const tag = (x: number, y: number, str: string, anchor = 'middle'): void => {
    out.push(
      `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" class="tag">${esc(str)}</text>`,
    );
  };

  let y = pad + 6;

  // --- Plan view: outline (both rails), stringer, station width callouts, fins. ---
  const planH = maxWidth * s;
  const planCY = y + planH / 2;
  const toPlan = (p: Pt): Pt => ({ x: sx(p.x), y: planCY - p.y * s });
  path(planOutlineLoop(board, steps).map(toPlan), 'outline', true);
  line(sx(eps), planCY, sx(length - eps), planCY, 'center');
  const planStations: [number, string][] = [
    [Math.min(30, length * 0.15), 'TAIL'],
    [wpPos, 'WIDE'],
    [Math.max(length - 30, length * 0.85), 'NOSE'],
  ];
  for (const [pos, name] of planStations) {
    const half = valueAt(board.outline, pos);
    line(sx(pos), planCY - half * s, sx(pos), planCY + half * s, 'tick');
    dim(sx(pos), planCY + planH / 2 + 13, `${name} · ${fmt(2 * half)}`);
  }
  // Fins: base footprint + box/plug router template, in plan coords.
  for (const fin of resolveFins(board)) {
    const { fore, aft } = fin.baseLine;
    const a = toPlan(aft);
    const b = toPlan(fore);
    line(a.x, a.y, b.x, b.y, 'fin');
    if (fin.box.kind !== 'shapes') continue;
    const cx = (fore.x + aft.x) / 2;
    const cy = (fore.y + aft.y) / 2;
    const dl = Math.hypot(fore.x - aft.x, fore.y - aft.y) || 1;
    const ax = (fore.x - aft.x) / dl;
    const ay = (fore.y - aft.y) / dl;
    const nx = -ay;
    const ny = ax;
    for (const fp of fin.box.footprints) {
      const ox = cx + ax * fp.along;
      const oy = cy + ay * fp.along;
      if (fp.shape.kind === 'rect') {
        const hl = fp.shape.length / 2;
        const hw = fp.shape.width / 2;
        const corner = (sa: number, sn: number): Pt =>
          toPlan({ x: ox + ax * hl * sa + nx * hw * sn, y: oy + ay * hl * sa + ny * hw * sn });
        path([corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)], 'fin', true);
      } else {
        const r = fp.shape.diameter / 2;
        const ring: Pt[] = [];
        for (let k = 0; k <= 20; k++) {
          const t = (k / 20) * Math.PI * 2;
          ring.push(toPlan({ x: ox + Math.cos(t) * r, y: oy + Math.sin(t) * r }));
        }
        path(ring, 'fin', true);
      }
    }
  }
  y = planCY + planH / 2 + 22;

  // --- Rocker profile: deck + bottom, thickness ticks, max-rocker note. ---
  const bottom = sampleProfile(board.bottom, eps, length - eps, steps);
  const deck = sampleProfile(board.deck, eps, length - eps, steps);
  let rLo = Infinity;
  let rHi = -Infinity;
  for (const p of [...bottom, ...deck]) {
    rLo = Math.min(rLo, p.y);
    rHi = Math.max(rHi, p.y);
  }
  const rockerH = (rHi - rLo) * s;
  const rockerTop = y + 12;
  const ry = (yc: number): number => rockerTop + (rHi - yc) * s; // deck (max) on top
  const toRocker = (p: Pt): Pt => ({ x: sx(p.x), y: ry(p.y) });
  path(bottom.map(toRocker), 'profile', false);
  path(deck.map(toRocker), 'profile', false);
  for (const pos of [
    Math.min(30, length * 0.15),
    length / 2,
    Math.max(length - 30, length * 0.85),
  ]) {
    const b = valueAt(board.bottom, pos);
    const d = valueAt(board.deck, pos);
    line(sx(pos), ry(b), sx(pos), ry(d), 'tick');
    dim(sx(pos), rockerTop - 5, fmt(Math.abs(d - b)));
  }
  dim(sx(eps), rockerTop + rockerH + 12, `MAX ROCKER · ${fmt(getMaxRocker(board))}`, 'start');
  y = rockerTop + rockerH + 26;

  // --- Cross-sections: tail / center / nose, one uniform scale, hung from a top line. ---
  const csStations: [number, string][] = [
    [Math.min(30, length * 0.15), 'TAIL'],
    [length / 2, 'CENTER'],
    [Math.max(length - 30, length * 0.85), 'NOSE'],
  ];
  const rings = csStations
    .map(([pos, name]) => ({ pos, name, ring: crossSectionRing(board, pos, ringSteps) }))
    .filter((r): r is { pos: number; name: string; ring: Pt[] } => r.ring !== null);
  if (rings.length > 0) {
    const cellW = (W - 2 * pad) / rings.length;
    let maxSecW = 1e-6;
    let maxSecH = 1e-6;
    const boxes = rings.map((r) => bbox(r.ring));
    boxes.forEach((bb) => {
      maxSecW = Math.max(maxSecW, bb.maxX - bb.minX);
      maxSecH = Math.max(maxSecH, bb.maxY - bb.minY);
    });
    const csScale = Math.min(s, (cellW - 28) / maxSecW);
    const labelY = y;
    const drawTop = y + 12;
    rings.forEach((r, k) => {
      const bb = boxes[k]!;
      const cellCX = pad + cellW * (k + 0.5);
      tag(cellCX, labelY, `${r.name} · ${fmt(r.pos)}`);
      const placed = r.ring.map((p) => ({
        x: cellCX + (p.x - (bb.minX + bb.maxX) / 2) * csScale,
        y: drawTop + (bb.maxY - p.y) * csScale,
      }));
      path(placed, 'profile', true);
    });
    y = drawTop + maxSecH * csScale + 14;
  }

  const totalH = y + pad;
  return (
    `<svg class="board-diagram" viewBox="0 0 ${f(W)} ${f(totalH)}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Board plan, rocker and sections">` +
    out.join('') +
    `</svg>`
  );
};
