// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign, finReadouts, smoothBlade, smoothEta } from '@openshaper/kernel';
import { createFinStore } from '@openshaper/store';
import { describe, expect, it } from 'vitest';
import { sliceGuideHandlers, sliceGuides } from './slice-guides';
import { lengthUnitByKey } from '../format';

describe('sliceGuideHandlers', () => {
  it('keeps dragging the same slice after it passes another and is renumbered', () => {
    const store = createFinStore();
    store.getState().load(defaultFinDesign('side', 'right'));
    store.getState().addSlice(0.3);
    store.getState().applyNaca('0008'); // its own foil, to tell it from the other
    store.getState().addSlice(0.7);
    store.getState().setActiveFoil(0);
    const depth = finReadouts(store.getState().design!).depth;
    const on = sliceGuideHandlers(store, 'y');
    // The editor reports the guide it grabbed ('1') for the whole drag.
    on.onGuideSelect('1');
    on.onGuideDragStart();
    on.onGuideDrag('1', 0.8 * depth); // past the slice at 0.7: now the second slice
    on.onGuideDrag('1', 0.9 * depth);
    on.onGuideDragEnd();
    const slices = store.getState().design!.slices;
    expect(slices.map((sl) => sl.height)).toEqual([0.7, 0.9]);
    // The slice grabbed, not the one it passed: its symmetric 0008 went with it.
    expect(slices[1]!.section.inside).toBeNull();
    expect(slices[0]!.section.inside).not.toBeNull();
    expect(store.getState().activeFoil).toBe(2);
  });

  it('on the smooth surface, draws a section along its row and drags it to the row under the pointer', () => {
    const store = createFinStore();
    store.getState().load(defaultFinDesign('side', 'left'));
    store.getState().setEngine('smooth');
    store.getState().addSlice(0.4);
    const d = store.getState().design!;
    const mm = lengthUnitByKey('mm');
    const [profile] = sliceGuides(d, 1, mm, 'y', 'smooth');
    // Its row, edge to edge: from the leading edge to the trailing edge.
    const sb = smoothBlade(d);
    expect(profile!.path!.length).toBeGreaterThan(10);
    const lead = sb.point(0.4, 0);
    expect(profile!.path![0]!.x).toBeCloseTo(lead.x, 6);
    // The thickness view places it by how far along the fin its row is.
    const [taper] = sliceGuides(d, 1, mm, 'x', 'smooth');
    expect(taper!.at).toBeCloseTo(smoothEta(d, 0.4), 9);
    const on = sliceGuideHandlers(store, 'y');
    on.onGuideSelect('1');
    on.onGuideDragStart();
    const to = sb.point(0.65, 0.5);
    on.onGuideDragPoint('1', to);
    on.onGuideDragEnd();
    expect(store.getState().design!.slices[0]!.height).toBeCloseTo(0.65, 6);
  });
});
