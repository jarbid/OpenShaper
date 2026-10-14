// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Deviation from ghost" (Phase 0, item 0.8) as the app wires it: the mode is
 * disabled until a ghost is open, the 3D view is handed the ghost and the band, the
 * band control appears with the mode, and the legend reads out in the display unit.
 *
 * Rendered through `<App />` with the 3D view stubbed: what is under test is what
 * the view is given and what the app makes of its report, not how it draws.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseBrd } from '@openshaper/io';
import type { Board3DViewProps } from '@openshaper/render3d';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fmtSmallLen, lengthUnitByKey } from './format';
import sampleBrd from './sample-board.brd?raw';
import { GHOST_DEVIATION_NO_GHOST } from './view3d-settings';

vi.mock('@openshaper/render3d', () => ({
  // Reports a ready deviation map whenever it is asked for one against a ghost, the
  // way the real view does once the worker answers.
  Board3DView: (props: Board3DViewProps) => {
    const { analysis, ghost, deviationBand, onAnalysisStatus } = props;
    useEffect(() => {
      if (analysis !== 'ghost-deviation') onAnalysisStatus?.({ state: 'off' });
      else if (!ghost) {
        onAnalysisStatus?.({ state: 'unavailable', mode: analysis, reason: 'no-ghost' });
      } else {
        onAnalysisStatus?.({
          state: 'ready',
          mode: analysis,
          band: deviationBand!,
          range: [-0.25, 0.64],
          ramp: ['#0000ff', '#ffffff', '#ff0000'],
          stripes: ['#444444', '#666666'],
        });
      }
    }, [analysis, ghost, deviationBand, onAnalysisStatus]);
    return (
      <div
        data-testid="board-3d"
        data-analysis={analysis}
        data-ghost={ghost ? 'yes' : 'no'}
        data-band={String(deviationBand)}
      />
    );
  },
}));

// Only the file reading is stubbed: the ghost goes through the app's real import path.
vi.mock('./file-io', async (importActual) => ({
  ...(await importActual<typeof import('./file-io')>()),
  openBoardFile: vi.fn(),
}));
const fileIo = await import('./file-io');

beforeEach(() => {
  localStorage.clear();
  vi.mocked(fileIo.openBoardFile).mockResolvedValue({
    board: parseBrd(sampleBrd).board,
    meta: {},
    warnings: [],
  });
});

/** The editor is up and the lazily loaded 3D pane has arrived. */
const ready = async () => {
  await screen.findAllByText(/\d+\.\dL/);
  await screen.findByTestId('board-3d');
};
const analysisSelect = () => screen.getAllByTitle(/^Surface analysis/)[0] as HTMLSelectElement;
const deviationOption = () =>
  Array.from(analysisSelect().options).find((o) => o.value === 'ghost-deviation')!;
const view = () => screen.getByTestId('board-3d');

const openGhost = async () => {
  // The board, trace and ghost pickers, in that order.
  const ghostInput = document.querySelectorAll('input[type="file"]')[2] as HTMLInputElement;
  await act(async () => {
    fireEvent.change(ghostInput, { target: { files: [new File(['x'], 'ghost.brd')] } });
  });
};

describe('Deviation from ghost', () => {
  it('is disabled with the reason until a ghost is open, then measures against it', async () => {
    render(<App />);
    await ready();
    expect(deviationOption().disabled).toBe(true);
    expect(deviationOption().title).toBe(GHOST_DEVIATION_NO_GHOST);
    expect(view().getAttribute('data-ghost')).toBe('no');

    await openGhost();
    await waitFor(() => expect(deviationOption().disabled).toBe(false));
    expect(view().getAttribute('data-ghost')).toBe('yes');

    fireEvent.change(analysisSelect(), { target: { value: 'ghost-deviation' } });
    expect(view().getAttribute('data-analysis')).toBe('ghost-deviation');
    expect(view().getAttribute('data-band')).toBe('0.5');

    // The legend, in the default unit (mm).
    const legend = await screen.findByRole('status', { name: 'Deviation from ghost legend' });
    expect(legend.textContent).toContain('−5 mm');
    expect(legend.textContent).toContain('+5 mm');
    expect(legend.textContent).toContain('On this board: −2.5 mm to +6.4 mm.');
  });

  it('hands the band slider’s value to the view, and the legend follows the unit', async () => {
    render(<App />);
    await ready();
    await openGhost();
    await waitFor(() => expect(deviationOption().disabled).toBe(false));
    fireEvent.change(analysisSelect(), { target: { value: 'ghost-deviation' } });

    const band = screen.getAllByRole('slider', { name: 'Deviation band' })[0]!;
    fireEvent.change(band, { target: { value: '1.25' } });
    expect(view().getAttribute('data-band')).toBe('1.25');

    fireEvent.change(screen.getByTitle('Display units'), { target: { value: 'in' } });
    const inches = lengthUnitByKey('in');
    const legend = await screen.findByRole('status', { name: 'Deviation from ghost legend' });
    await waitFor(() => expect(legend.textContent).toContain(`+${fmtSmallLen(1.25, inches)}`));
    expect(legend.textContent).not.toMatch(/\bcm\b|\bmm\b/);
    expect(band.getAttribute('aria-valuetext')).toBe(`±${fmtSmallLen(1.25, inches)}`);
  });

  it('says why once the ghost is cleared, and puts the band away', async () => {
    render(<App />);
    await ready();
    await openGhost();
    await waitFor(() => expect(deviationOption().disabled).toBe(false));
    fireEvent.change(analysisSelect(), { target: { value: 'ghost-deviation' } });
    expect(screen.getAllByRole('slider', { name: 'Deviation band' }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear ghost' }));

    await waitFor(() => expect(view().getAttribute('data-ghost')).toBe('no'));
    expect(deviationOption().disabled).toBe(true);
    expect(screen.queryByRole('slider', { name: 'Deviation band' })).toBeNull();
    const legend = await screen.findByRole('status', { name: 'Deviation from ghost legend' });
    expect(legend.textContent).toContain(GHOST_DEVIATION_NO_GHOST);
  });
});
