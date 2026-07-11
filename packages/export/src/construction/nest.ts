// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic material-sheet nesting for a {@link TemplateSheet}: first-fit-
 * decreasing shelf packing over part **bounding boxes** (not true polygon
 * nesting — simple, predictable, and good enough to answer "how many ply sheets
 * do I need and where does each part go"). Multi-cut templates (`Part.count`)
 * are expanded into individual copies; parts may rotate 90° when allowed.
 */
import { bboxHeight, bboxWidth, loop, partBbox, rotatePart90, translatePart } from './geom';
import type { Part, TemplateSheet } from './types';

export interface NestSpec {
  /** Material sheet size (cm). */
  widthCm: number;
  heightCm: number;
  /** Border kept clear inside every sheet edge (cm). Default 1. */
  marginCm?: number;
  /** Clearance between neighbouring parts (cm). Default 1. */
  gapCm?: number;
  /** Allow 90° part rotation while packing. Default true. */
  allowRotate?: boolean;
}

export interface NestPlacement {
  /** The placed copy: translated (and possibly rotated) into sheet-local cm. */
  readonly part: Part;
  /** 0-based sheet index. */
  readonly sheet: number;
  readonly rotated: boolean;
}

export interface NestResult {
  /** Number of material sheets used. */
  readonly sheets: number;
  readonly placements: readonly NestPlacement[];
  /** Parts too large for the sheet in either orientation. */
  readonly unplaced: readonly Part[];
  readonly spec: Required<NestSpec>;
}

export const nestParts = (partsIn: readonly Part[], specIn: NestSpec): NestResult => {
  const spec: Required<NestSpec> = {
    widthCm: Math.max(1, specIn.widthCm),
    heightCm: Math.max(1, specIn.heightCm),
    marginCm: Math.max(0, specIn.marginCm ?? 1),
    gapCm: Math.max(0, specIn.gapCm ?? 1),
    allowRotate: specIn.allowRotate ?? true,
  };
  const usableW = spec.widthCm - 2 * spec.marginCm;
  const usableH = spec.heightCm - 2 * spec.marginCm;

  // Expand multi-cut templates into individual copies with unique ids.
  const copies: Part[] = [];
  for (const part of partsIn) {
    const nCopies = Math.max(1, Math.round(part.count ?? 1));
    if (nCopies === 1) {
      copies.push(part);
      continue;
    }
    for (let k = 1; k <= nCopies; k++) {
      const { count: _count, ...rest } = part;
      copies.push({ ...rest, id: `${part.id}~${k}`, label: `${part.label} (${k}/${nCopies})` });
    }
  }

  // Pick an orientation per copy — it must fit the usable area; prefer the
  // flatter one (short shelves pack tighter).
  interface Oriented {
    part: Part;
    rotated: boolean;
    w: number;
    h: number;
  }
  const oriented: Oriented[] = [];
  const unplaced: Part[] = [];
  for (const part of copies) {
    const bb = partBbox(part);
    const w = bboxWidth(bb);
    const h = bboxHeight(bb);
    const options: Oriented[] = [];
    if (w <= usableW && h <= usableH) options.push({ part, rotated: false, w, h });
    if (spec.allowRotate && h <= usableW && w <= usableH) {
      options.push({ part, rotated: true, w: h, h: w });
    }
    if (options.length === 0) {
      unplaced.push(part);
      continue;
    }
    options.sort((a, b) => a.h - b.h || a.w - b.w);
    oriented.push(options[0]!);
  }

  // First-fit decreasing by height onto shelves (stable, deterministic).
  oriented.sort((a, b) => b.h - a.h || b.w - a.w || a.part.id.localeCompare(b.part.id));
  interface Shelf {
    sheet: number;
    x: number; // cursor within the shelf (from the usable area's left edge)
    y: number; // shelf bottom (from the usable area's bottom edge)
    h: number;
  }
  const shelves: Shelf[] = [];
  const sheetNextY: number[] = []; // next free shelf y per sheet
  const placements: NestPlacement[] = [];

  for (const o of oriented) {
    let shelf = shelves.find((s) => o.h <= s.h && o.w <= usableW - s.x);
    if (!shelf) {
      // Open a new shelf on the first sheet with vertical room, else a new sheet.
      let sheet = sheetNextY.findIndex((y) => o.h <= usableH - y);
      if (sheet === -1) {
        sheet = sheetNextY.length;
        sheetNextY.push(0);
      }
      shelf = { sheet, x: 0, y: sheetNextY[sheet]!, h: o.h };
      sheetNextY[sheet] = sheetNextY[sheet]! + o.h + spec.gapCm;
      shelves.push(shelf);
    }
    let placed = o.rotated ? rotatePart90(o.part) : o.part;
    const bb = partBbox(placed);
    placed = translatePart(
      placed,
      spec.marginCm + shelf.x - bb.minX,
      spec.marginCm + shelf.y - bb.minY,
    );
    placements.push({ part: placed, sheet: shelf.sheet, rotated: o.rotated });
    shelf.x += o.w + spec.gapCm;
  }

  return { sheets: sheetNextY.length, placements, unplaced, spec };
};

/** Visual gap between material sheets laid side by side (cm). */
const SHEET_GAP = 10;

/** One sheet-boundary part: a mark rectangle + "Sheet i/N" label, at offset `ox`. */
const sheetBoundary = (index: number, total: number, ox: number, W: number, H: number): Part => ({
  id: `sheet-${index + 1}`,
  label: `Sheet ${index + 1}/${total}`,
  loops: [
    loop('mark', true, [
      { x: ox, y: 0 },
      { x: ox + W, y: 0 },
      { x: ox + W, y: H },
      { x: ox, y: H },
    ]),
  ],
  labels: [{ text: `Sheet ${index + 1}/${total}`, at: { x: ox + 1, y: H + 0.6 }, height: 1 }],
});

/**
 * One prearranged {@link TemplateSheet} per material sheet — the panel preview
 * steps through these ("Sheet 1/N", …). Each holds its boundary + its parts in
 * sheet-local coordinates.
 */
export const nestedSheetViews = (sheet: TemplateSheet, nest: NestResult): TemplateSheet[] =>
  Array.from({ length: nest.sheets }, (_, s) => ({
    ...sheet,
    prearranged: true,
    parts: [
      sheetBoundary(s, nest.sheets, 0, nest.spec.widthCm, nest.spec.heightCm),
      ...nest.placements.filter((pl) => pl.sheet === s).map((pl) => pl.part),
    ],
  }));

/**
 * Materialise a {@link NestResult} as a prearranged {@link TemplateSheet}: the
 * material sheets side by side (boundary rectangles as marks, labelled
 * "Sheet i/N") with each part at its packed position. Anything that didn't fit
 * is stacked to the right of the last sheet, so nothing is silently lost.
 */
export const layoutNestedSheet = (sheet: TemplateSheet, nest: NestResult): TemplateSheet => {
  const { widthCm: W, heightCm: H } = nest.spec;
  const parts: Part[] = [];
  for (let s = 0; s < nest.sheets; s++) {
    const ox = s * (W + SHEET_GAP);
    parts.push(sheetBoundary(s, nest.sheets, ox, W, H));
    for (const pl of nest.placements) {
      if (pl.sheet === s) parts.push(translatePart(pl.part, ox, 0));
    }
  }
  let cx = nest.sheets * (W + SHEET_GAP);
  for (const up of nest.unplaced) {
    const bb = partBbox(up);
    parts.push(translatePart(up, cx - bb.minX, -bb.minY));
    cx += bboxWidth(bb) + SHEET_GAP;
  }
  return { ...sheet, parts, prearranged: true };
};
