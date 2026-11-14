// SPDX-License-Identifier: GPL-3.0-or-later
import type { ExternalSurface, PatchPick } from '@openshaper/render3d';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fmtLen, lengthUnitByKey } from './format';
import { PatchReadout } from './PatchReadout';
import { getPatchPick, setPatchPick, usePatchLook } from './patch-look';
import { ANALYSIS_3D, DEFAULT_VIEW_3D, effectiveAnalysis } from './view3d-settings';

const CM = lengthUnitByKey('cm');

/** A surface as far as the look reads it: patches and rail keys. */
const surface = (patch: Uint8Array | null, railKeys = { plus: [20, 60] }): ExternalSurface =>
  ({ patch, railKeys }) as unknown as ExternalSurface;

const HAS = surface(new Uint8Array([0, 1, 2]));
const pick: PatchPick = { patch: 'rail', side: 'plus', x: 40, y: 5, blend: 0 };

afterEach(() => setPatchPick(null));

describe('usePatchLook', () => {
  it('gives the view nothing with another look, or a surface without patches', () => {
    expect(renderHook(() => usePatchLook('none', HAS)).result.current).toEqual({});
    expect(renderHook(() => usePatchLook('patches', surface(null))).result.current).toEqual({});
    expect(renderHook(() => usePatchLook('patches', null)).result.current).toEqual({});
  });

  it('gives the zones of the rail keys, no selection yet, and a callback that chooses', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    expect(result.current.railZones?.plus.map((z) => [z.from, z.to])).toEqual([
      [20, 20],
      [60, 60],
    ]);
    expect(result.current.patchSelection).toBeNull();
    act(() => result.current.onPatchPick?.(pick));
    expect(getPatchPick()).toEqual(pick);
    expect(result.current.patchSelection).toEqual(pick);
    // a tap on nothing clears it
    act(() => result.current.onPatchPick?.(null));
    expect(result.current.patchSelection).toBeNull();
  });

  it('clears the choice on Escape', () => {
    const { result } = renderHook(() => usePatchLook('patches', HAS));
    act(() => result.current.onPatchPick?.(pick));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(getPatchPick()).toEqual(pick);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(getPatchPick()).toBeNull();
  });

  it('forgets the choice when the look is left', () => {
    const { result, rerender } = renderHook(({ a }) => usePatchLook(a, HAS), {
      initialProps: { a: 'patches' as const } as { a: 'patches' | 'none' },
    });
    act(() => result.current.onPatchPick?.(pick));
    rerender({ a: 'none' });
    expect(getPatchPick()).toBeNull();
  });

  it('keeps the zones when the same keys come again in a new mesh, and follows new keys', () => {
    const { result, rerender } = renderHook(({ s }) => usePatchLook('patches', s), {
      initialProps: { s: HAS },
    });
    const first = result.current.railZones;
    rerender({ s: surface(new Uint8Array(3), { plus: [30] }) });
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
