import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

vi.mock('@openshaper/render2d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openshaper/render2d')>();
  return {
    ...actual,
    SplineEditor: (props: React.ComponentProps<typeof actual.SplineEditor>) => {
      const kind = props.targets[0]?.kind ?? 'unknown';
      return (
        <div
          data-testid={`editor-${kind}`}
          data-scrub={props.overlays?.scrubProbe ?? ''}
          data-can-delete={props.onDeleteSection ? 'yes' : 'no'}
          data-drag-label={props.formatSectionPosition?.(12.7) ?? ''}
        >
          <button
            aria-label={`Focus slice from ${kind}`}
            onClick={() => {
              props.onFocusSection?.(1);
              props.onPickSection?.(1);
            }}
          />
          <button aria-label={`Scrub ${kind}`} onClick={() => props.onScrub?.(20)} />
        </div>
      );
    },
  };
});

/**
 * Switch to a single maximized pane via its view shortcut — the tab label alone is
 * ambiguous, since the pane headers carry the same words.
 */
const showOnly = (key: string) => fireEvent.keyDown(window, { key });

describe('cross-section station controls', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it('edits the current station from the cross-section pane header, in display units', async () => {
    render(<App />);
    await waitFor(() => expect(boardStore.getState().board).not.toBeNull());

    // The editor rides with the other per-station controls, so it is on screen
    // without focusing a marker first — no toolbar reflow when focus changes.
    const position = (
      await screen.findAllByRole('textbox', {
        name: 'Selected slice position',
      })
    )[0] as HTMLInputElement;
    expect(position.value).toBe('9.53');

    const increase = screen.getAllByRole('button', { name: 'Increase slice position' })[0]!;
    const decrease = screen.getAllByRole('button', { name: 'Decrease slice position' })[0]!;
    expect(increase.title).toBe('Increase by 10 mm');

    fireEvent.click(increase);
    expect(boardStore.getState().board!.crossSections[1]!.position).toBeCloseTo(1.953);
    expect(position.value).toBe('19.53');

    fireEvent.click(decrease);
    expect(boardStore.getState().board!.crossSections[1]!.position).toBeCloseTo(0.953);
    expect(position.value).toBe('9.53');

    fireEvent.change(position, { target: { value: '20' } });
    fireEvent.keyDown(position, { key: 'Enter' });
    expect(boardStore.getState().board!.crossSections[1]!.position).toBe(2);
  });

  it('re-renders the stepper and the drag chip in the selected unit', async () => {
    render(<App />);
    await waitFor(() => expect(boardStore.getState().board).not.toBeNull());
    await screen.findAllByRole('textbox', { name: 'Selected slice position' });

    const increase = screen.getAllByRole('button', { name: 'Increase slice position' })[0]!;
    const unitSelector = screen.getByTitle('Display units');
    const dragLabel = () => screen.getAllByTestId('editor-outline')[0]!.dataset.dragLabel;

    // 12.7 cm is 127 mm / 5" exactly, so every unit has an unambiguous rendering.
    expect(dragLabel()).toBe('127.0 mm');

    fireEvent.change(unitSelector, { target: { value: 'cm' } });
    expect(increase.title).toBe('Increase by 1 cm');
    expect(dragLabel()).toBe('12.70 cm');

    fireEvent.change(unitSelector, { target: { value: 'in' } });
    expect(increase.title).toBe('Increase by 0.5 in');
    expect(dragLabel()).toBe('5"');

    fireEvent.change(unitSelector, { target: { value: 'ftin' } });
    expect(increase.title).toBe('Increase by 0.5 in');
  });

  it('suppresses the scrub overlay while a marker is focused, and releases it on Escape', async () => {
    render(<App />);
    await waitFor(() => expect(boardStore.getState().board).not.toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'Scrub outline' })[0]!);
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('20');

    fireEvent.click(screen.getAllByRole('button', { name: 'Focus slice from outline' })[0]!);
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('');

    // Still suppressed: a focused marker owns the pane.
    fireEvent.click(screen.getAllByRole('button', { name: 'Scrub outline' })[0]!);
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('');

    // Escape comes from the shortcut table (`cross-section-blur`), not a local listener.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Scrub outline' })[0]!);
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('20');
  });

  it('offers marker deletion in the maximized panes, not just the quad view', async () => {
    render(<App />);
    await waitFor(() => expect(boardStore.getState().board).not.toBeNull());

    // Quad renders every pane; both length-axis panes must be able to delete.
    for (const pane of screen.getAllByTestId('editor-outline')) {
      expect(pane.dataset.canDelete).toBe('yes');
    }

    // `buildContextMenuItems` needs onDeleteSection to build the marker menu at all,
    // so a maximized pane missing it loses add-slice too, not just delete. Queried by
    // attribute rather than testid: the rocker pane's first target is the deck curve.
    for (const key of ['2', '3']) {
      showOnly(key);
      const panes = document.querySelectorAll<HTMLElement>('[data-can-delete]');
      expect(panes).toHaveLength(1);
      expect(panes[0]!.dataset.canDelete).toBe('yes');
    }
  });
});
