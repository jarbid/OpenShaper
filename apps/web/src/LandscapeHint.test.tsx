import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LandscapeHint } from './LandscapeHint';
import { setPointer, setTier, setViewport } from './test/viewport';

const hint = () => screen.queryByRole('status');

describe('the landscape hint', () => {
  beforeEach(() => {
    localStorage.clear();
    // A phone: the hint is only for a device that can be turned (P17).
    setPointer('coarse');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows on a portrait phone — the only case with something to gain', () => {
    setTier('phone');
    render(<LandscapeHint />);
    expect(hint()?.textContent).toContain('sideways');
  });

  it('stays out of the way in a narrow desktop window, which cannot be turned (P17)', () => {
    setTier('phone');
    setPointer('fine');
    render(<LandscapeHint />);
    expect(hint()).toBeNull();
  });

  it('stays out of the way on a landscape phone', () => {
    // Already holding it the way the hint would ask for.
    setTier('phoneLandscape');
    render(<LandscapeHint />);
    expect(hint()).toBeNull();
  });

  it('stays out of the way on a tablet and a desktop', () => {
    setTier('tablet');
    const tablet = render(<LandscapeHint />);
    expect(hint()).toBeNull();
    tablet.unmount();

    setTier('desktop');
    render(<LandscapeHint />);
    expect(hint()).toBeNull();
  });

  it('disappears when the phone is actually turned, without being dismissed', () => {
    setTier('phone');
    render(<LandscapeHint />);
    expect(hint()).not.toBeNull();

    act(() => setViewport(844, 390));
    expect(hint(), 'turning the device answers the hint').toBeNull();
    expect(localStorage.getItem('bs.landscapeHintSeen'), 'and is not a dismissal').toBeNull();
  });

  it('stays dismissed across a remount', () => {
    setTier('phone');
    const first = render(<LandscapeHint />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(hint()).toBeNull();
    first.unmount();

    render(<LandscapeHint />);
    expect(hint(), 'a one-time hint is once, not once per visit').toBeNull();
  });

  it('still renders when localStorage throws, and asks again rather than never', () => {
    // Private browsing / blocked storage. Failing closed here would silently
    // disable the hint for the people most likely to be on a locked-down phone.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setTier('phone');
    render(<LandscapeHint />);
    expect(hint()).not.toBeNull();
    // Dismissing must not blow up even though the write fails.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(hint()).toBeNull();
  });
});
