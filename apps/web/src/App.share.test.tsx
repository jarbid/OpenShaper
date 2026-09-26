// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Share's entry points, wired into the real shell.
 *
 * The dialog itself is covered in ShareDialog.test.tsx; what matters here is
 * that all three routes to it exist and open the same thing — a share that
 * works from the menubar but not the command palette is a share a phone user
 * does not have.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

const editorReady = () => screen.findAllByText(/\d+\.\dL/);

describe('share entry points', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens the dialog from the top-navigation button', async () => {
    render(<App />);
    await editorReady();

    fireEvent.click(screen.getByRole('button', { name: 'Share board' }));

    // The dialog's own title, not the button that opened it.
    expect(await screen.findByRole('heading', { name: 'Share board' })).toBeTruthy();
    expect(await screen.findByText(/Link size:/)).toBeTruthy();
  });

  it('opens the dialog from the File menu', async () => {
    render(<App />);
    await editorReady();

    fireEvent.click(screen.getByText('File'));
    fireEvent.click(await screen.findByText('Share…'));

    expect(await screen.findByText(/Link size:/)).toBeTruthy();
  });

  it('reaches the command palette, which derives from the menus', async () => {
    render(<App />);
    await editorReady();

    // Ctrl+K is the palette; on a phone it is the only way in, since the
    // menubar collapses to a single button there.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const search = await screen.findByPlaceholderText(/command/i);
    fireEvent.change(search, { target: { value: 'share' } });
    fireEvent.click(await screen.findByText('File: Share…'));

    expect(await screen.findByText(/Link size:/)).toBeTruthy();
  });

  it('disables both entry points when no board is loaded', async () => {
    render(<App />);
    await editorReady();

    // Drop the board the way a failed load would leave things.
    boardStore.setState({ board: null } as never);

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Share board' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );

    fireEvent.click(screen.getByText('File'));
    // Menu items are native buttons, so `disabled` is the real thing and not an
    // aria attribute that could read "false" and still pass a truthiness check.
    const item = (await screen.findByText('Share…')).closest('button');
    expect(item).not.toBeNull();
    expect(item!.disabled).toBe(true);
  });
});
