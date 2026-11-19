// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS layer in the workspace: the chips give way to one quiet line (what a tap does, the build
 * status, the "i" button when the build has something to flag), the badge stays in the page for the
 * scripts, and a Classic choice or a test board kept from the tabbed layout does not apply there, though
 * the tabbed layout still honours both.
 *
 * Its own file: the Classic choice and the test board are module state, shared by every render in a file.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LENGTH_UNIT } from './format';
import NurbsLayer from './nurbs-layer';
import {
  VIEWER_IDLE,
  type NurbsModel,
  type NurbsViewer,
  type ViewerInput,
  type ViewerState,
} from './nurbs-viewer';
import { boardStore } from './store';
import type { NurbsIssue, NurbsMeshData, NurbsSummary } from './workers/nurbs-protocol';

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

/** The model of a rails board that is the document: one patch id per vertex, as the Patches look needs. */
const model = (issues: readonly NurbsIssue[] = []): NurbsModel => ({
  board: null,
  generation: 0,
  testBoard: null,
  issues,
  summary: {
    source: 'doc',
    engine: 'rails',
    conversion: null,
    stationFitError: 0.002,
    clampedControls: 0,
    blendOvershoot: 0,
    volume: 28_500,
    planArea: 5000,
    surfaceArea: 9000,
  } satisfies NurbsSummary,
  timings: {
    convertMs: 1,
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
    patch: new Uint8Array(10),
    seams: null,
    laddersReused: true,
  } satisfies NurbsMeshData,
});

const ready = (issues: readonly NurbsIssue[] = []): ViewerState => ({
  ...VIEWER_IDLE,
  phase: 'ready',
  model: model(issues),
  issues,
});

const warning = (code: string): NurbsIssue => ({
  code,
  severity: 'warning',
  message: `${code} 0.5 cm`,
});

const mount = (
  viewer: NurbsViewer,
  props: Partial<React.ComponentProps<typeof NurbsLayer>> = {},
  onSurface = vi.fn(),
) =>
  render(
    <NurbsLayer
      store={boardStore}
      analysis="none"
      units={DEFAULT_LENGTH_UNIT}
      onSurface={onSurface}
      viewer={viewer}
      {...props}
    />,
  );

afterEach(cleanup);

describe('the workspace layer', () => {
  it('draws none of the chips', () => {
    mount(fakeViewer(ready()).viewer, { workspace: true });
    expect(screen.queryByRole('button', { name: 'Classic' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'NURBS' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Engine shown in the 3D view' })).toBeNull();
    expect(screen.queryByTestId('nurbs-test-board')).toBeNull();
    expect(screen.queryByText('Test board')).toBeNull();
    expect(screen.queryByText('Showing the NURBS surface')).toBeNull();
  });

  it('keeps the badge in the page, hidden from sight and from a screen reader, with every attribute it had', () => {
    mount(fakeViewer(ready()).viewer, { workspace: true });
    const badge = screen.getByTestId('nurbs-badge');
    expect(badge.className).toBe('sr-only');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.textContent).toBe('NURBS (experimental) — read-only');
    expect(Object.fromEntries([...badge.attributes].map((a) => [a.name, a.value]))).toMatchObject({
      'data-phase': 'ready',
      'data-showing': 'nurbs',
      'data-update': '7',
      'data-round-trip-ms': '21',
      'data-worker-ms': '13.4',
      'data-convert-ms': '1.0',
      'data-build-ms': '4.2',
      'data-mesh-ms': '9.1',
      'data-curvature-ms': '0.0',
      'data-deviation-ms': '0.0',
      'data-ladders-reused': 'true',
      'data-source': 'doc',
      'data-engine': 'rails',
      'data-vertices': '10',
    });
    expect(screen.getByTestId('nurbs-layer')).toBeTruthy();
  });

  it('has the same attributes on the badge as the tabbed layout’s', () => {
    const f = fakeViewer(ready());
    const names = (el: HTMLElement) =>
      [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-'));
    const { unmount } = mount(f.viewer, { workspace: true });
    const quiet = names(screen.getByTestId('nurbs-badge')).sort();
    unmount();
    mount(f.viewer);
    expect(names(screen.getByTestId('nurbs-badge')).sort()).toEqual(quiet);
  });

  it('draws no line at all before the first build has anything to say', () => {
    mount(fakeViewer(VIEWER_IDLE).viewer, { workspace: true });
    const layer = screen.getByTestId('nurbs-layer');
    expect(layer.children).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Board build details' })).toBeNull();
  });

  it('has the “i” button, as the icon alone, once a build is there to read, as the tabbed layout does', () => {
    mount(fakeViewer(ready()).viewer, { workspace: true });
    const button = screen.getByRole('button', { name: 'Board build details' });
    expect(button.textContent).toBe('');
    expect(button.getAttribute('title')).toBe('Board build details');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(button);
    const info = screen.getByTestId('nurbs-info');
    expect(info.textContent).toContain('Volume');
    expect(info.textContent).toContain('No warnings.');
  });

  it('says what a tap does with the Patches look, in the one line, and leaves the pointer to the board', () => {
    mount(fakeViewer(ready()).viewer, { workspace: true, analysis: 'patches' });
    const readout = screen.getByTestId('patch-readout');
    expect(readout.textContent).toBe('Tap the board to choose a patch');
    expect(readout.className).not.toMatch(/border|shadow/);
    // a tap or a drag beside the line reaches the canvas
    expect(screen.getByTestId('nurbs-layer').className).toContain('pointer-events-none');
    // no line under another look: a tap chooses nothing
    cleanup();
    mount(fakeViewer(ready()).viewer, { workspace: true, analysis: 'zebra' });
    expect(screen.queryByTestId('patch-readout')).toBeNull();
  });

  it('says the board is being built, in a shaper’s words, once it takes a moment', () => {
    const converting = fakeViewer({ ...VIEWER_IDLE, phase: 'converting' });
    mount(converting.viewer, { workspace: true });
    expect(screen.getByTestId('nurbs-status').textContent).toBe('Building the board…');
    cleanup();
    const slow = fakeViewer({ ...ready(), job: { startedAt: Date.now() - 5000 } });
    mount(slow.viewer, { workspace: true });
    expect(screen.getByTestId('nurbs-status').textContent).toMatch(/^Building the board… [45] s$/);
    cleanup();
    const quick = fakeViewer({ ...ready(), job: { startedAt: Date.now() } });
    mount(quick.viewer, { workspace: true });
    expect(screen.queryByTestId('nurbs-status')).toBeNull();
  });

  it('says a refusal, and has the “i” button with its details', () => {
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
    mount(f.viewer, { workspace: true });
    expect(screen.getByTestId('nurbs-status').textContent).toContain('This board was refused');
    const button = screen.getByRole('button', { name: 'Board build details' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.className).toContain('pointer-events-auto');
    fireEvent.click(button);
    const info = screen.getByTestId('nurbs-info');
    expect(info.getAttribute('aria-label')).toBe('Board build details');
    expect(info.textContent).toContain('cannot hold this board yet');
    expect(info.textContent).toContain('convert-slice');
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByTestId('nurbs-info')).toBeNull();
  });

  it('counts the warnings on the “i” button, and has its popover leave out the check the workspace does not offer', () => {
    mount(fakeViewer(ready([warning('thin-rail'), warning('band')])).viewer, { workspace: true });
    const button = screen.getByRole('button', { name: 'Board build details' });
    expect(button.textContent).toBe('2 warnings');
    expect(button.getAttribute('title')).toContain('2 warnings');
    fireEvent.click(button);
    const info = screen.getByTestId('nurbs-info');
    expect(within(info).getByText('Warnings (2)')).toBeTruthy();
    expect(info.textContent).not.toContain('Deviation from classic');
    expect(info.textContent).toContain('This is the NURBS board you are editing');
  });

  it('says one warning in the singular', () => {
    mount(fakeViewer(ready([warning('band')])).viewer, { workspace: true });
    expect(screen.getByRole('button', { name: 'Board build details' }).textContent).toBe(
      '1 warning',
    );
  });

  it('leaves the popover of the tabbed layout as it was, with its pointer to “Deviation from classic”', () => {
    mount(fakeViewer(ready([warning('band')])).viewer);
    fireEvent.click(screen.getByRole('button', { name: 'NURBS conversion details' }));
    expect(screen.getByTestId('nurbs-info').textContent).toContain('Deviation from classic');
    expect(screen.getByTestId('nurbs-info').getAttribute('aria-label')).toBe(
      'NURBS conversion details',
    );
  });

  it('stands in the top left, and in the bottom left where a computed analysis has its legend', () => {
    mount(fakeViewer(ready()).viewer, { workspace: true, analysis: 'patches' });
    expect(screen.getByTestId('nurbs-layer').className).toMatch(/\btop-2\b/);
    for (const analysis of [
      'mean-curvature',
      'gaussian-curvature',
      'rail-radius',
      'ghost-deviation',
    ] as const) {
      cleanup();
      mount(fakeViewer(ready([warning('band')])).viewer, { workspace: true, analysis });
      expect(screen.getByTestId('nurbs-layer').className, analysis).toMatch(/\bbottom-2\b/);
    }
  });
});

describe('what the tabbed layout kept', () => {
  it('is ignored in the workspace, and still honoured by the tabbed layout', () => {
    const f = fakeViewer(ready());

    // in the tabbed layout, choose Classic and a test board: both are kept in the browser
    const onTabbed = vi.fn();
    mount(f.viewer, {}, onTabbed);
    expect(onTabbed).toHaveBeenLastCalledWith(expect.objectContaining({ tracking: 'standalone' }));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Classic' }));
    });
    expect(onTabbed).toHaveBeenLastCalledWith(null);
    act(() => {
      fireEvent.change(screen.getByTestId('nurbs-test-board'), { target: { value: 'fish' } });
    });
    expect(f.inputs.at(-1)?.testBoard).toBe('fish');
    cleanup();

    // the workspace shows the surface of the person's own board: Patches needs it
    const onWorkspace = vi.fn();
    const w = fakeViewer(ready());
    mount(w.viewer, { workspace: true, analysis: 'patches' }, onWorkspace);
    expect(onWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: expect.any(Uint8Array) }),
    );
    expect(w.inputs.length).toBeGreaterThan(0);
    for (const input of w.inputs) expect(input.testBoard).toBeNull();
    expect(screen.getByTestId('nurbs-badge').getAttribute('data-showing')).toBe('nurbs');
    cleanup();

    // back in the tabbed layout both are still in force: nothing was erased
    const onBack = vi.fn();
    const b = fakeViewer(ready());
    mount(b.viewer, {}, onBack);
    expect(onBack).toHaveBeenLastCalledWith(null);
    expect(b.inputs.at(-1)?.testBoard).toBe('fish');
    expect((screen.getByTestId('nurbs-test-board') as HTMLSelectElement).value).toBe('fish');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'NURBS' }));
      fireEvent.change(screen.getByTestId('nurbs-test-board'), { target: { value: '' } });
    });
  });

  it('does not change when the choice is made while the workspace is showing', () => {
    const f = fakeViewer(ready());
    const onSurface = vi.fn();
    mount(f.viewer, { workspace: true }, onSurface);
    expect(onSurface).toHaveBeenLastCalledWith(expect.objectContaining({ tracking: 'standalone' }));
    // the tabbed layout, mounted elsewhere, makes a choice while the workspace is on screen
    const other = render(
      <NurbsLayer
        store={boardStore}
        analysis="none"
        units={DEFAULT_LENGTH_UNIT}
        onSurface={() => undefined}
        viewer={fakeViewer(ready()).viewer}
      />,
    );
    act(() => {
      fireEvent.click(within(other.container).getByRole('button', { name: 'Classic' }));
    });
    other.unmount();
    // the workspace still hands the view its surface, and asks the viewer for the person's own board
    expect(onSurface).not.toHaveBeenLastCalledWith(null);
    expect(f.inputs.at(-1)?.testBoard).toBeNull();
    const again = render(
      <NurbsLayer
        store={boardStore}
        analysis="none"
        units={DEFAULT_LENGTH_UNIT}
        onSurface={() => undefined}
        viewer={fakeViewer(ready()).viewer}
      />,
    );
    act(() => {
      fireEvent.click(within(again.container).getByRole('button', { name: 'NURBS' }));
    });
    again.unmount();
  });
});
