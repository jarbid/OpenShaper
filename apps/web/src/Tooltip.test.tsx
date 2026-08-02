// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Behaviour contract for the shared `Tooltip` primitive.
 *
 * Lives here rather than in packages/ui because apps/web is the only consumer and
 * already has the jsdom + Testing Library harness configured; packages/ui has no
 * test environment of its own.
 */
import { Button, Tooltip } from '@openshaper/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

const openDelay = () =>
  act(() => {
    vi.advanceTimersByTime(400);
  });

describe('Tooltip', () => {
  it('stays hidden until the hover delay passes', () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Copy dimensions">
        <Button aria-label="Copy dimensions">c</Button>
      </Tooltip>,
    );

    fireEvent.pointerEnter(screen.getByRole('button'), { pointerType: 'mouse' });
    expect(screen.queryByText('Copy dimensions')).toBeNull();

    openDelay();
    expect(screen.getByText('Copy dimensions')).not.toBeNull();
  });

  it('hides again on pointer leave', () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Delete this cross-section">
        <Button aria-label="Delete">d</Button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button');

    fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    openDelay();
    expect(screen.getByText('Delete this cross-section')).not.toBeNull();

    fireEvent.pointerLeave(btn);
    expect(screen.queryByText('Delete this cross-section')).toBeNull();
  });

  // A tooltip on a touch device either never shows or fights the tap.
  it('never shows for touch input', () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Add a cross-section here">
        <Button aria-label="Add">+</Button>
      </Tooltip>,
    );

    fireEvent.pointerEnter(screen.getByRole('button'), { pointerType: 'touch' });
    openDelay();
    expect(screen.queryByText('Add a cross-section here')).toBeNull();
  });

  // Keyboard users shouldn't have to wait out a hover delay.
  it('shows immediately on focus', () => {
    render(
      <Tooltip label="Next cross-section" shortcut="]">
        <Button aria-label="Next">n</Button>
      </Tooltip>,
    );

    fireEvent.focus(screen.getByRole('button'));
    expect(screen.getByText('Next cross-section')).not.toBeNull();
    expect(screen.getByText(']')).not.toBeNull();

    fireEvent.blur(screen.getByRole('button'));
    expect(screen.queryByText('Next cross-section')).toBeNull();
  });

  it('dismisses once the control is actually clicked', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(
      <Tooltip label="Copy this cross-section">
        <Button aria-label="Copy" onClick={onClick}>
          c
        </Button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button');

    fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    openDelay();
    fireEvent.pointerDown(btn);

    expect(screen.queryByText('Copy this cross-section')).toBeNull();
    // The trigger's own handlers must survive being wrapped.
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // The trigger's aria-label is the accessible name; exposing the tooltip too
  // would make screen readers announce the same thing twice.
  it('is hidden from assistive technology', () => {
    render(
      <Tooltip label="Paste the copied cross-section shape here">
        <Button aria-label="Paste">p</Button>
      </Tooltip>,
    );

    fireEvent.focus(screen.getByRole('button'));
    const tip = screen.getByText('Paste the copied cross-section shape here').parentElement;
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
  });
});
