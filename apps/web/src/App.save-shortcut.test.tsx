/**
 * P11: Ctrl/Cmd+S takes the same path as File > Save, so the save is recorded
 * (`save_board`) and lands in Open recent, instead of a bare download.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { track } from './analytics';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));
vi.mock('./analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics')>()),
  track: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(track).mockClear();
  // jsdom has no object URLs; the download itself is not what is under test.
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

describe('Ctrl+S (P11)', () => {
  it('records the save like File > Save', async () => {
    render(<App />);
    await screen.findAllByText(/\d+\.\dL/); // board loaded

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(track).toHaveBeenCalledWith('save_board', { format: 'board' });
  });
});
