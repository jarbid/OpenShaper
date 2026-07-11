// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cutting list for a {@link TemplateSheet}: one row per template part with its
 * stock bounding-box size and how many copies to cut. Pure data — the panel
 * renders it as a table (formatting lengths per the active display unit) and a
 * totals line is appended to the sheet note for the exports.
 */
import { bboxHeight, bboxWidth, partBbox } from './geom';
import type { TemplateSheet } from './types';

export interface CutItem {
  readonly partId: string;
  readonly label: string;
  /** Copies to cut from this one template. */
  readonly count: number;
  /** Template bounding-box size (cm). */
  readonly widthCm: number;
  readonly heightCm: number;
}

export const cuttingList = (sheet: TemplateSheet): CutItem[] =>
  sheet.parts.map((part) => {
    const bb = partBbox(part);
    return {
      partId: part.id,
      label: part.label,
      count: part.count ?? 1,
      widthCm: bboxWidth(bb),
      heightCm: bboxHeight(bb),
    };
  });

/** Total number of pieces to cut across the sheet. */
export const totalPieces = (items: readonly CutItem[]): number =>
  items.reduce((s, i) => s + i.count, 0);
