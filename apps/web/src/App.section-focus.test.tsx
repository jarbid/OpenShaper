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
        <div data-testid={`editor-${kind}`} data-scrub={props.overlays?.scrubProbe ?? ''}>
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

describe('cross-section marker focus', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it('shows an exact position editor, suppresses scrubbing, and dismisses on Escape', async () => {
    render(<App />);
    await waitFor(() => expect(boardStore.getState().board).not.toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'Scrub outline' })[0]!);
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('20');

    fireEvent.click(screen.getAllByRole('button', { name: 'Focus slice from outline' })[0]!);
    const position = await screen.findByRole('textbox', { name: 'Selected slice position' });
    expect((position as HTMLInputElement).value).toBe('9.53');
    expect(position.className).toContain('w-20');
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('');

    fireEvent.focus(position);
    fireEvent.blur(position);
    expect(boardStore.getState().board!.crossSections[1]!.position).toBe(0.9525);

    const increase = screen.getByRole('button', { name: 'Increase slice position' });
    const decrease = screen.getByRole('button', { name: 'Decrease slice position' });
    expect(increase.title).toBe('Increase by 10 mm');
    expect(screen.getByTestId('section-position-editor').className).toContain('mr-2');

    fireEvent.click(increase);
    expect(boardStore.getState().board!.crossSections[1]!.position).toBeCloseTo(1.953);
    expect((position as HTMLInputElement).value).toBe('19.53');

    fireEvent.click(decrease);
    expect(boardStore.getState().board!.crossSections[1]!.position).toBeCloseTo(0.953);
    expect((position as HTMLInputElement).value).toBe('9.53');

    const unitSelector = screen.getByTitle('Display units');
    fireEvent.change(unitSelector, { target: { value: 'cm' } });
    expect(increase.title).toBe('Increase by 1 cm');
    fireEvent.change(unitSelector, { target: { value: 'in' } });
    expect(increase.title).toBe('Increase by 0.5 in');
    fireEvent.change(unitSelector, { target: { value: 'ftin' } });
    expect(increase.title).toBe('Increase by 0.5 in');
    fireEvent.change(unitSelector, { target: { value: 'mm' } });

    fireEvent.click(screen.getAllByRole('button', { name: 'Scrub outline' })[0]!);
    expect(screen.getAllByTestId('editor-outline')[0]!.dataset.scrub).toBe('');

    fireEvent.change(position, { target: { value: '20' } });
    fireEvent.keyDown(position, { key: 'Enter' });
    expect(boardStore.getState().board!.crossSections[1]!.position).toBe(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Selected slice position' })).toBeNull();
  });
});
