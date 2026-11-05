// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Foil slices as draggable guides (docs/design/fin-designer.md, foil slices): level
 * lines in the profile and the upright thickness view, one per slice. Picking one makes
 * its foil the one being edited; dragging it moves the slice up or down, one undo step
 * per drag. Guide ids are the slices' foil indices (1-based; 0 is the root foil).
 */
import { finReadouts, type FinDesign } from '@openshaper/kernel';
import type { FinCurveGuide } from '@openshaper/render2d';
import type { FinState } from '@openshaper/store';
import type { StoreApi } from 'zustand/vanilla';
import { fmtLen, type LengthUnit } from '../format';

// Pink: control sections' own colour (owner review: violet was also the inside face's).
export const SLICE_COLOR = 'rgba(244,114,182,0.9)';

/** The fin's depth (cm): slice heights are fractions of it. */
const depthOf = (d: FinDesign) => finReadouts(d).depth;

/**
 * The slices as guides. `axis` and `scale` place them: the profile holds y at the
 * height in cm (`'y'`, depth), the taper holds x at the fraction (`'x'`, 1).
 */
export const sliceGuides = (
  d: FinDesign,
  activeFoil: number,
  units: LengthUnit,
  axis: 'x' | 'y',
): FinCurveGuide[] => {
  const depth = depthOf(d);
  return d.slices.map((sl, i) => ({
    id: String(i + 1),
    axis,
    at: axis === 'y' ? sl.height * depth : sl.height,
    color: SLICE_COLOR,
    selected: activeFoil === i + 1,
    label: `Control section ${fmtLen(sl.height * depth, units)}`,
  }));
};

/** FinCurveEditor guide handlers wired to the store. */
export const sliceGuideHandlers = (store: StoreApi<FinState>, axis: 'x' | 'y') => {
  const s = store.getState;
  const toHeight = (at: number) => {
    const d = s().design;
    if (!d) return at;
    return axis === 'y' ? at / depthOf(d) : at;
  };
  return {
    onGuideSelect: (id: string) => s().setActiveFoil(Number(id)),
    onGuideDragStart: () => s().beginEdit('Move foil slice'),
    // The dragged slice is the active one (selected as the drag starts), followed by
    // index rather than the guide's id: passing another slice renumbers it.
    onGuideDrag: (_id: string, at: number) => {
      s().moveSlice(s().activeFoil, toHeight(at));
    },
    onGuideDragEnd: () => s().endEdit(),
  };
};
