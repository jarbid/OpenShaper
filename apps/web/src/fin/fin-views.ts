// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which view is in the fin designer's large pane, and which order the small panes show
 * the rest in (docs/design/fin-designer.md, round 1, R3). A small pane's swap button
 * trades places with the large pane, so the view that was large lands in that slot.
 */
import { readStored, writeStored } from '../persisted';

export type FinView = 'outline' | 'foil' | 'taper' | '3d';

/** Large pane first, then the small panes top to bottom. */
export type FinViewOrder = readonly [FinView, FinView, FinView, FinView];

export const FIN_VIEWS: FinViewOrder = ['outline', 'foil', 'taper', '3d'];

export const FIN_VIEW_TITLE: Record<FinView, string> = {
  outline: 'Profile',
  foil: 'Foil',
  taper: 'Thickness',
  '3d': '3D',
};

/** Put the view in slot `slot` (1–3) into the large pane, and the large one into that slot. */
export const swapIntoMain = (order: FinViewOrder, slot: number): FinViewOrder => {
  if (slot < 1 || slot > 3) return order;
  const next = [...order] as [FinView, FinView, FinView, FinView];
  [next[0], next[slot]] = [next[slot]!, next[0]];
  return next;
};

const isOrder = (v: unknown): v is FinViewOrder =>
  Array.isArray(v) && v.length === FIN_VIEWS.length && FIN_VIEWS.every((view) => v.includes(view));

const KEY = 'bs.fin.views';

/** The order last used on this device, or the default with the profile large. */
export const readViewOrder = (): FinViewOrder =>
  readStored<FinViewOrder>(KEY, FIN_VIEWS, (v) => (isOrder(v) ? v : FIN_VIEWS));

export const writeViewOrder = (order: FinViewOrder): void => {
  writeStored(KEY, order);
};
