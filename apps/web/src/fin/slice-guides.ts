// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Foil slices as draggable guides (docs/design/fin-designer.md, foil slices): level
 * lines in the profile and the upright thickness view, one per slice. Picking one makes
 * its foil the one being edited; dragging it moves the slice up or down, one undo step
 * per drag. Guide ids are the slices' foil indices (1-based; 0 is the root foil).
 *
 * A control section is a row of the fin, from edge to edge along it: the profile draws it
 * along its row and a drag moves it to the row under the pointer; the thickness view
 * places it by how far along the fin its row is, as the thickness curve is read there.
 */
import {
  smoothEta,
  smoothLocate,
  smoothRowAtEta,
  smoothRowLine,
  smoothSectionDistance,
  smoothSectionHeight,
  smoothSectionRow,
  type FinDesign,
} from '@openshaper/kernel';
import type { FinCurveGuide } from '@openshaper/render2d';
import type { FinState } from '@openshaper/store';
import type { StoreApi } from 'zustand/vanilla';
import { fmtLen, type LengthUnit } from '../format';

// Pink: control sections' own colour (owner review: violet was also the inside face's).
export const SLICE_COLOR = 'rgba(244,114,182,0.9)';

/**
 * The slices as guides. `axis` and `scale` place them: the profile holds y at the
 * height in cm (`'y'`, depth), the taper holds x at the fraction (`'x'`, 1).
 */
export const sliceGuides = (
  d: FinDesign,
  activeFoil: number,
  units: LengthUnit,
  axis: 'x' | 'y',
): FinCurveGuide[] =>
  d.slices.map((sl, i) => {
    const row = smoothSectionRow(d, sl.height);
    return {
      id: String(i + 1),
      axis,
      at: axis === 'y' ? sl.height : smoothEta(d, row),
      ...(axis === 'y' ? { path: smoothRowLine(d, row) } : {}),
      color: SLICE_COLOR,
      selected: activeFoil === i + 1,
      label: `Control section ${fmtLen(smoothSectionDistance(d, sl.height), units)}`,
    };
  });

/** FinCurveEditor guide handlers wired to the store. */
export const sliceGuideHandlers = (store: StoreApi<FinState>, axis: 'x' | 'y') => {
  const s = store.getState;
  return {
    onGuideSelect: (id: string) => s().setActiveFoil(Number(id)),
    onGuideDragStart: () => s().beginEdit('Move foil slice'),
    // The dragged slice is the active one (selected as the drag starts), followed by
    // index rather than the guide's id: passing another slice renumbers it.
    onGuideDrag: (_id: string, at: number) => {
      // The thickness view's; the profile's follow the point (onGuideDragPoint).
      const d = s().design;
      if (d && axis === 'x')
        s().moveSlice(s().activeFoil, smoothSectionHeight(d, smoothRowAtEta(d, at)));
    },
    onGuideDragPoint: (_id: string, p: { x: number; y: number }) => {
      const d = s().design;
      if (!(d && axis === 'y')) return;
      // The row under the pointer; off the blade, it stays where it is.
      const at = smoothLocate(d, p.x, p.y);
      if (at) s().moveSlice(s().activeFoil, smoothSectionHeight(d, at.s));
    },
    onGuideDragEnd: () => s().endEdit(),
  };
};
