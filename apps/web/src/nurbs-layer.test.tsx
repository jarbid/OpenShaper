// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The layer over a fake viewer: a refused board shows its reason in the "i" popover and
 * the classic mesh stays, the test-board picker drives the viewer's input, and the
 * badge carries the timings of the update on screen.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LENGTH_UNIT } from './format';
import NurbsLayer from './nurbs-layer';
import { boardStore } from './store';
import {
  VIEWER_IDLE,
  type NurbsModel,
  type NurbsViewer,
  type ViewerInput,
  type ViewerState,
} from './nurbs-viewer';
import type { NurbsMeshData, NurbsSummary } from './workers/nurbs-protocol';

const fakeViewer = (initial: ViewerState) => {
  let state = initial;
  const listeners = new Set<() => void>();
  const inputs: ViewerInput[] = [];
  const viewer: NurbsViewer = {
    getState: () => state,
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
    setInput: (i) => void inputs.push(i),
    pause() {},
    dispose() {},
  };
  return {
    viewer,
    inputs,
    set(next: ViewerState) {
      state = next;
      for (const l of [...listeners]) l();
    },
  };
};

const model = (): NurbsModel => ({
  board: null,
  generation: 0,
  testBoard: 'fish',
  issues: [],
  summary: {
    source: 'test',
    conversion: null,
    stationFitError: 0.002,
    clampedControls: 0,
    blendOvershoot: 0,
    volume: 28_500,
    planArea: 5000,
    surfaceArea: 9000,
  } satisfies NurbsSummary,
  timings: {
    convertMs: 0,
    buildMs: 4.2,
    meshMs: 9.1,
    curvatureMs: 0,
    deviationMs: 0,
    totalMs: 13.4,
  },
  roundTripMs: 21,
  sequence: 7,
  mesh: {
    positions: new Float32Array(30),
    normals: new Float32Array(30),
    indices: new Uint32Array(3),
    curvature: null,
    deviation: null,
    deviationRange: null,
    deviationNoData: 0,
    laddersReused: true,
  } satisfies NurbsMeshData,
});

const mount = (viewer: NurbsViewer, onSurface = vi.fn()) =>
  render(
    <NurbsLayer
      store={boardStore}
      analysis="none"
      units={DEFAULT_LENGTH_UNIT}
      onSurface={onSurface}
      viewer={viewer}
    />,
  );

describe('NurbsLayer', () => {
  it('feeds the live board to the viewer and shows the update timings on the badge', () => {
    const f = fakeViewer({ ...VIEWER_IDLE, phase: 'ready', model: model() });
    const onSurface = vi.fn();
    mount(f.viewer, onSurface);
    expect(f.inputs.at(-1)).toMatchObject({ enabled: true, testBoard: null, wantCurvature: false });
    const badge = screen.getByTestId('nurbs-badge');
    expect(badge.textContent).toContain('NURBS (experimental) — read-only');
    expect(badge.getAttribute('data-update')).toBe('7');
    expect(badge.getAttribute('data-round-trip-ms')).toBe('21');
    expect(badge.getAttribute('data-worker-ms')).toBe('13.4');
    expect(onSurface).toHaveBeenLastCalledWith(expect.objectContaining({ tracking: 'standalone' }));
  });

  it('stops tracking the live board for a model of another document, and says a stale surface is stale', () => {
    const classic = { ...model(), testBoard: null, board: {} as never, generation: 1 };
    // the same document: the surface follows the live board
    const same = fakeViewer({ ...VIEWER_IDLE, phase: 'ready', model: classic, generation: 1 });
    const onSame = vi.fn();
    mount(same.viewer, onSame);
    expect(onSame).toHaveBeenLastCalledWith(expect.objectContaining({ tracking: 'live' }));
    cleanup();
    // another file was opened (generation 2) and the answer has not arrived: only a surface that fits
    // the hull on screen is drawn, so the old board's surface does not sit on the new hull
    const other = fakeViewer({ ...VIEWER_IDLE, phase: 'ready', model: classic, generation: 2 });
    const onOther = vi.fn();
    mount(other.viewer, onOther);
    expect(onOther).toHaveBeenLastCalledWith(expect.objectContaining({ tracking: 'hull' }));
    cleanup();
    // a refusal mid-edit keeps the last good surface and the status line says so
    const stale = fakeViewer({
      ...VIEWER_IDLE,
      phase: 'failed',
      model: classic,
      generation: 1,
      stale: true,
      error: 'x',
    });
    mount(stale.viewer);
    expect(screen.getByTestId('nurbs-status').textContent).toContain('last good surface');
  });

  it('puts the refusal in the popover in plain words and keeps the classic mesh', () => {
    const f = fakeViewer({
      ...VIEWER_IDLE,
      phase: 'failed',
      error: 'slice at x = 5: the bottom centre handle rises 0.6 cm',
      issues: [
        {
          code: 'convert-slice',
          severity: 'error',
          message: 'slice at x = 5: the bottom centre handle rises 0.6 cm',
        },
      ],
    });
    const onSurface = vi.fn();
    mount(f.viewer, onSurface);
    expect(onSurface).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('nurbs-status').textContent).toContain('classic shown');
    fireEvent.click(screen.getByRole('button', { name: 'NURBS conversion details' }));
    const info = screen.getByTestId('nurbs-info');
    expect(info.textContent).toContain('cannot hold this board yet');
    expect(info.textContent).toContain('cannot be converted');
    expect(info.textContent).toContain('convert-slice');
  });

  it('lists the test boards and tells the viewer which one to show', () => {
    const f = fakeViewer(VIEWER_IDLE);
    mount(f.viewer);
    const picker = screen.getByTestId('nurbs-test-board') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      'My board',
      'Swallow',
      'Fish',
      'Asymmetric',
      'Analytic',
    ]);
    act(() => {
      fireEvent.change(picker, { target: { value: 'swallow' } });
    });
    expect(f.inputs.at(-1)?.testBoard).toBe('swallow');
    act(() => {
      fireEvent.change(picker, { target: { value: '' } });
    });
    expect(f.inputs.at(-1)?.testBoard).toBeNull();
  });

  it('asks for curvature in an exact mode and for the deviation in its mode', () => {
    const f = fakeViewer(VIEWER_IDLE);
    const { rerender } = mount(f.viewer);
    rerender(
      <NurbsLayer
        store={boardStore}
        analysis="mean-curvature"
        units={DEFAULT_LENGTH_UNIT}
        onSurface={() => {}}
        viewer={f.viewer}
      />,
    );
    expect(f.inputs.at(-1)).toMatchObject({ wantCurvature: true, wantDeviation: false });
    rerender(
      <NurbsLayer
        store={boardStore}
        analysis="nurbs-deviation"
        units={DEFAULT_LENGTH_UNIT}
        onSurface={() => {}}
        viewer={f.viewer}
      />,
    );
    expect(f.inputs.at(-1)).toMatchObject({ wantCurvature: false, wantDeviation: true });
  });
});
