// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The foil sweep drawn over the profile (owner proposal, kernel swept-loft.ts): the base
 * line (foil sweep start) and the tip line (foil sweep end), each a soft green band, the
 * thickness path between them, and the handles that move them. The tip line's ends
 * slide along the outline; each thickness path point slides along its own section.
 */
import {
  outlineFractionNear,
  smoothBlade,
  smoothRowLine,
  sweepTipEdge,
  thicknessPathOf,
  type FinDesign,
  type SmoothBlade,
  type Vec2,
} from '@openshaper/kernel';
import type { FinCurveMarker } from '@openshaper/render2d';
import { TIP_FOIL, type FinState } from '@openshaper/store';
import type { StoreApi } from 'zustand/vanilla';

export const SWEEP_LINE = 'rgba(34,197,94,0.95)';
export const SWEEP_BAND = 'rgba(34,197,94,0.22)';
export const PATH_COLOR = 'rgba(245,158,11,0.95)';

export interface SweepOverlay {
  /** Foil sweep start: the base, along the root (and a raised rear's underside). */
  readonly base: readonly Vec2[];
  /** Foil sweep end: the tip line. */
  readonly tip: readonly Vec2[];
  /** The thickness path, base to tip line. */
  readonly path: readonly Vec2[];
  /** The tip past the tip line: its edge round from one end of the tip line to the other. */
  readonly cap: readonly Vec2[];
  readonly markers: readonly FinCurveMarker[];
}

/** Where the thickness path's three points are (rows): the base, halfway, the tip line. */
const pathRows = (sb: SmoothBlade): [number, number, number] => [0, 0.5, sb.sTip];

/** The profile point `along` of the way along row s. */
const onRow = (sb: SmoothBlade, s: number, along: number): Vec2 => {
  const line = Array.from({ length: 129 }, (_, k) => sb.point(s, k / 128));
  const run = [0];
  for (let k = 1; k < line.length; k++) {
    run.push(run[k - 1]! + Math.hypot(line[k]!.x - line[k - 1]!.x, line[k]!.y - line[k - 1]!.y));
  }
  const target = along * run[run.length - 1]!;
  let k = 1;
  while (k < line.length - 1 && run[k]! < target) k++;
  const t = (target - run[k - 1]!) / (run[k]! - run[k - 1]! || 1);
  const a = line[k - 1]!;
  const c = line[k]!;
  return { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t } as Vec2;
};

export const sweepOverlay = (d: FinDesign): SweepOverlay => {
  const sb = smoothBlade(d);
  const tip = smoothRowLine(d, sb.sTip) as Vec2[];
  const path = Array.from({ length: 41 }, (_, k) => {
    const s = (k / 40) * sb.sTip;
    return onRow(sb, s, sb.path(s));
  });
  const rows = pathRows(sb);
  const handle = (i: 0 | 1 | 2): FinCurveMarker => ({
    id: `path-${i}`,
    at: onRow(sb, rows[i], sb.path(rows[i])),
    color: PATH_COLOR,
    label: [
      'Thickness path at the base',
      'Thickness path halfway',
      'Thickness path at the tip line',
    ][i]!,
  });
  return {
    base: smoothRowLine(d, 0) as Vec2[],
    tip,
    path,
    cap: sweepTipEdge(d),
    markers: [
      { id: 'tip-start', at: tip[0]!, color: SWEEP_LINE, label: 'Foil sweep end, front' },
      { id: 'tip-end', at: tip[tip.length - 1]!, color: SWEEP_LINE, label: 'Foil sweep end, back' },
      handle(0),
      handle(1),
      handle(2),
    ],
  };
};

/** The fraction along row s nearest a point. */
const alongNear = (sb: SmoothBlade, s: number, p: Vec2): number => {
  let best = 0;
  let dist = Infinity;
  for (let k = 0; k <= 200; k++) {
    const q = onRow(sb, s, k / 200);
    const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (dd < dist) [dist, best] = [dd, k / 200];
  }
  return best;
};

/** FinCurveEditor marker handlers wired to the store: one undo step per drag. */
export const sweepMarkerHandlers = (store: StoreApi<FinState>) => {
  const s = store.getState;
  return {
    onMarkerDragStart: (id: string) =>
      s().beginEdit(id.startsWith('tip') ? 'Move the tip line' : 'Move the thickness path'),
    onMarkerDrag: (id: string, to: Vec2) => {
      const d = s().design;
      if (!d) return;
      if (id === 'tip-start' || id === 'tip-end') {
        s().setTipLineEnd(id === 'tip-start' ? 'start' : 'end', outlineFractionNear(d.outline, to));
        return;
      }
      const i = Number(id.slice('path-'.length)) as 0 | 1 | 2;
      const sb = smoothBlade(d);
      const row = pathRows(sb)[i];
      // The path carries a small correction ending it on the tip foil: dragged net of it.
      const way = thicknessPathOf(d)[i];
      s().setThicknessPath(i, alongNear(sb, row, to) - (i === 2 ? 0 : sb.path(row) - way));
    },
    onMarkerDragEnd: () => s().endEdit(),
  };
};

/** How close (px) a click must come to a sweep line to pick it. */
const PICK_PX = 8;

const distToPolyline = (p: Vec2, pts: readonly Vec2[]): number => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
};

/**
 * The sweep line a click at `at` picks, as a foil index (0 the base, TIP_FOIL the tip),
 * or null for neither: the nearer, within a few pixels.
 */
export const pickSweepLine = (o: SweepOverlay, at: Vec2, unitsPerPx: number): number | null => {
  const base = distToPolyline(at, o.base);
  const tip = distToPolyline(at, o.tip);
  const reach = PICK_PX * unitsPerPx;
  if (Math.min(base, tip) > reach) return null;
  return tip < base ? TIP_FOIL : 0;
};
