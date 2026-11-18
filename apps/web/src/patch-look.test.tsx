// SPDX-License-Identifier: GPL-3.0-or-later
import type { RailsBoard } from '@openshaper/board2';
import type { ExternalSurface, PatchPick } from '@openshaper/render3d';
import { RAIL_ZONE_COLORS } from '@openshaper/render3d/patches';
import type { RailKey } from '@openshaper/store/rails';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fmtLen, lengthUnitByKey } from './format';
import { PatchReadout } from './PatchReadout';
import { chooseRail, getPatchPick, setPatchPick, usePatchLook } from './patch-look';
import { getRailChoice, getRailPlace, resetRailChoice, setRailSides } from './rail-choice';
import type { Rails } from './rail-zones';
import { activeStore, boardStore, railsStore } from './store';
import { ANALYSIS_3D, DEFAULT_VIEW_3D, effectiveAnalysis } from './view3d-settings';

const CM = lengthUnitByKey('cm');

/** A surface as far as the look reads it: patches. */
const surface = (patch: Uint8Array | null): ExternalSurface =>
  ({ patch }) as unknown as ExternalSurface;

const HAS = surface(new Uint8Array([0, 1, 2]));
const pick: PatchPick = { patch: 'rail', side: 'plus', x: 40, y: 5, blend: 0 };

const key = (x: number, apex: number): RailKey => ({
  x,
  rail: { band: 2, hardness: 0.5, tuck: 1.4, tuckShape: 0.45, bottomEdge: 0, deckEdge: 0, apex },
});
/** Two zones of no length with a blend between, on a mirror board. */
const MIRROR: Rails = { plus: [key(20, 0.5), key(60, 0.4)] };

/** Make `rails` the rails board being edited (a new document: the choice starts clean). */
function showRails(rails: Rails | null): void {
  if (rails === null) {
    activeStore.use(boardStore);
    return;
  }
  activeStore.use(railsStore);
  railsStore.setState({
    doc: { model: 'rails', rails } as unknown as RailsBoard,
    loadCount: railsStore.getState().loadCount + 1,
  });
}

beforeEach(() => showRails(MIRROR));
afterEach(() => {
  setPatchPick(null);
  resetRailChoice();
  showRails(null);
});

describe('usePatchLook', () => {
  it('gives the view nothing with another look, or a surface without patches', () => {
    expect(renderHook(() => usePatchLook('none', HAS)).result.current).toEqual({});
    expect(renderHook(() => usePatchLook('patches', surface(null))).result.current).toEqual({});
    expect(renderHook(() => usePatchLook('patches', null)).result.current).toEqual({});
  });

  it('gives the zones of the rails board coloured by index, no selection yet, and a callback that chooses', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    expect(result.current.railZones?.plus.map((z) => [z.from, z.to])).toEqual([
      [20, 20],
      [60, 60],
    ]);
    expect(result.current.railZones?.plus.map((z) => z.color)).toEqual(
      RAIL_ZONE_COLORS.slice(0, 2),
    );
    expect(result.current.patchSelection).toBeNull();
    act(() => result.current.onPatchPick?.(pick));
    expect(getPatchPick()).toEqual(pick);
    // a tap on a rail is the Rails step's choice, lit on both sides while the sides are one list
    expect(getRailChoice()).toEqual({ side: 'plus', blend: 0 });
    expect(getRailPlace()).toBe(40);
    expect(result.current.patchSelection).toEqual({
      patch: 'rail',
      side: 'plus',
      blend: 0,
      both: true,
    });
    // a tap on nothing clears it
    act(() => result.current.onPatchPick?.(null));
    expect(result.current.patchSelection).toBeNull();
    expect(getRailChoice()).toBeNull();
  });

  it('has no zones with no rails board being edited', () => {
    showRails(null);
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    expect(result.current.railZones).toEqual({ plus: [], minus: [] });
  });

  it('lights a tapped deck, and lets a tap on the deck drop the rail choice', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    act(() => result.current.onPatchPick?.(pick));
    const deck: PatchPick = { patch: 'deck', side: 'plus', x: 5, y: 1 };
    act(() => result.current.onPatchPick?.(deck));
    expect(getRailChoice()).toBeNull();
    expect(result.current.patchSelection).toEqual(deck);
  });

  it('lights one side only once the sides are edited one at a time', () => {
    showRails({ plus: MIRROR.plus, minus: MIRROR.plus });
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    act(() => setRailSides('minus'));
    act(() => chooseRail({ side: 'minus', zone: 1 }, 60));
    expect(result.current.patchSelection).toEqual({ patch: 'rail', side: 'minus', zone: 1 });
  });

  it('what the map chooses lights the same zone, and drops the pick a tap made', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    act(() => result.current.onPatchPick?.({ patch: 'deck', side: 'plus', x: 5, y: 1 }));
    act(() => chooseRail({ side: 'plus', zone: 1 }, 60));
    expect(getPatchPick()).toBeNull();
    expect(result.current.patchSelection).toEqual({
      patch: 'rail',
      side: 'plus',
      zone: 1,
      both: true,
    });
  });

  it('clears the choice on Escape', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    act(() => result.current.onPatchPick?.(pick));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(getPatchPick()).toEqual(pick);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(getPatchPick()).toBeNull();
    expect(getRailChoice()).toBeNull();
  });

  it('forgets the pick when the look is left, and keeps the zone the panel is editing', () => {
    const { result, rerender } = renderHook(({ a }) => usePatchLook(a, HAS), {
      initialProps: { a: 'patches' as const } as { a: 'patches' | 'none' },
    });
    act(() => result.current.onPatchPick?.(pick));
    rerender({ a: 'none' });
    expect(getPatchPick()).toBeNull();
    expect(getRailChoice()).toEqual({ side: 'plus', blend: 0 });
    rerender({ a: 'patches' });
    expect(result.current.patchSelection).toMatchObject({ patch: 'rail', blend: 0 });
  });

  it('holds the zones while a drag is open until a new mesh arrives, and takes the live ones when it ends', () => {
    const { result, rerender } = renderHook(({ s }) => usePatchLook('patches', s), {
      initialProps: { s: HAS },
    });
    const first = result.current.railZones;
    act(() => railsStore.setState({ editing: true }));
    act(() =>
      railsStore.setState({
        doc: { model: 'rails', rails: { plus: [key(30, 0.5)] } } as unknown as RailsBoard,
      }),
    );
    // the pointer has moved the rails: the board has not been given new zones for it
    expect(result.current.railZones).toBe(first);
    // the mesh for it arrives: the zones come with it
    rerender({ s: surface(new Uint8Array([0, 1, 2])) });
    expect(result.current.railZones).not.toBe(first);
    expect(result.current.railZones?.plus).toHaveLength(1);
    // and with no drag open the zones are live
    act(() => railsStore.getState().endEdit());
    act(() =>
      railsStore.setState({
        doc: {
          model: 'rails',
          rails: { plus: [key(30, 0.5), key(90, 0.4)] },
        } as unknown as RailsBoard,
      }),
    );
    expect(result.current.railZones?.plus).toHaveLength(2);
  });

  it('keeps the zones while the rails are the same object, and follows new rails', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    const first = result.current.railZones;
    act(() => railsStore.setState({ slices: null }));
    expect(result.current.railZones).toBe(first);
    act(() =>
      railsStore.setState({
        doc: { model: 'rails', rails: { plus: [key(30, 0.5)] } } as unknown as RailsBoard,
      }),
    );
    expect(result.current.railZones).not.toBe(first);
    expect(result.current.railZones?.plus).toHaveLength(1);
  });
});

describe('PatchReadout', () => {
  it('says how to choose, then what was chosen, in the display unit', () => {
    render(<PatchReadout units={CM} />);
    expect(screen.getByTestId('patch-readout').textContent).toBe('Tap the board to choose a patch');
    act(() => setPatchPick(pick));
    expect(screen.getByTestId('patch-readout').textContent).toBe(
      `Rail, left side, blend between zones 1 and 2, ${fmtLen(40, CM)} from the tail`,
    );
    expect(screen.getByTestId('patch-readout').dataset.patch).toBe('rail');
  });

  it('says the zone the rail map chose, with the cursor as its place', () => {
    render(<PatchReadout units={CM} />);
    act(() => chooseRail({ side: 'plus', zone: 1 }, 60));
    expect(screen.getByTestId('patch-readout').textContent).toBe(
      `Rail, left side, zone 2, ${fmtLen(60, CM)} from the tail`,
    );
  });
});

describe('the Patches look in the settings', () => {
  it('is listed, marked as needing a surface with patches', () => {
    expect(ANALYSIS_3D.find((o) => o.value === 'patches')).toMatchObject({
      label: 'Patches',
      patches: true,
    });
  });

  it('is ignored, not erased, while it is not offered', () => {
    const saved = { ...DEFAULT_VIEW_3D, analysis: 'patches' as const };
    expect(effectiveAnalysis(saved.analysis, true)).toBe('none');
    expect(effectiveAnalysis(saved.analysis, true, true)).toBe('patches');
    expect(effectiveAnalysis('zebra', false)).toBe('zebra');
    expect(effectiveAnalysis('nurbs-deviation', false, true)).toBe('none');
  });
});
