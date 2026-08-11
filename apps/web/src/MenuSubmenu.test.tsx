// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Behaviour contract for the `submenu` MenuItem — the flyout the cross-section editor's
 * "Rail preset" menu is built from.
 *
 * Lives here rather than in packages/ui because apps/web is the only consumer and
 * already has the jsdom + Testing Library harness configured; packages/ui has no test
 * environment of its own. (Same reasoning as `Tooltip.test.tsx`.)
 *
 * It is exercised through `ContextMenu` deliberately: the flyout's one hard constraint
 * is that it must stay a DOM descendant of the menu panel, because `ContextMenu`
 * dismisses on any outside `pointerdown`. Testing the pieces separately would not catch
 * a regression there.
 */
import { ContextMenu, type MenuItem } from '@openshaper/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const setup = () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const items: MenuItem[] = [
    { kind: 'action', label: 'Delete point', onSelect: vi.fn() },
    {
      kind: 'submenu',
      label: 'Rail preset',
      items: [
        { kind: 'action', label: '50/50 soft', onSelect },
        { kind: 'action', label: '80/20 hard', onSelect: vi.fn() },
      ],
    },
  ];
  render(<ContextMenu x={20} y={20} items={items} onClose={onClose} />);
  return { onSelect, onClose, trigger: screen.getByRole('menuitem', { name: /Rail preset/ }) };
};

describe('submenu menu items', () => {
  it('stays closed until asked', () => {
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('50/50 soft')).toBeNull();
  });

  it('opens on hover and on ArrowRight', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('50/50 soft')).not.toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.pointerLeave(trigger.parentElement!);
      act(() => void vi.advanceTimersByTime(500));
    } finally {
      vi.useRealTimers();
    }
    expect(screen.queryByText('50/50 soft')).toBeNull();

    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    expect(screen.getByText('50/50 soft')).not.toBeNull();
  });

  /**
   * Guards the classic flyout bug: if the flyout sat outside the element that closes on
   * pointer-leave, reaching it would dismiss it, because getting there means leaving the
   * trigger. Asserted structurally — the hover region is the wrapper, and the flyout
   * lives inside it, so travelling between the two never leaves.
   */
  it('keeps the flyout inside the region that governs closing', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(trigger);
    const wrapper = trigger.parentElement!;
    expect(wrapper.contains(screen.getByText('50/50 soft'))).toBe(true);
  });

  /**
   * The reported complaint: the flyout closed before the pointer could reach it,
   * especially when flipped to the left, where the hand's natural rightward drift
   * pulls away from the target. Leaving the row must start a grace period, not an
   * immediate close.
   */
  it('does not close the instant the pointer leaves the row', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(trigger);
    vi.useFakeTimers();
    try {
      fireEvent.pointerLeave(trigger.parentElement!);
      // Still open right after leaving, and still open partway through the grace period.
      expect(screen.getByText('50/50 soft')).not.toBeNull();
      act(() => void vi.advanceTimersByTime(200));
      expect(screen.getByText('50/50 soft')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the pending close when the pointer comes back', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(trigger);
    vi.useFakeTimers();
    try {
      fireEvent.pointerLeave(trigger.parentElement!);
      act(() => void vi.advanceTimersByTime(200));
      // Arriving at the flyout re-enters the wrapper, which must call the close off
      // for good — not merely postpone it.
      fireEvent.pointerEnter(trigger.parentElement!);
      act(() => void vi.advanceTimersByTime(5000));
      expect(screen.getByText('50/50 soft')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The gap between the row and the panel has to belong to the hover region. As a
   * margin on the panel it belongs to neither, so crossing it — which is the only
   * way in — would close the thing being crossed toward.
   */
  it('leaves no dead gap between the row and the flyout', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(trigger);
    const panel = screen.getByText('50/50 soft').closest('[role="menu"]')!;
    expect(panel.className).not.toMatch(/\bm[lr]-\d/);
    const spacer = panel.parentElement!;
    expect(spacer.className).toMatch(/\bp[lr]-\d/);
    expect(trigger.parentElement!.contains(spacer)).toBe(true);
  });

  /**
   * The anti-portal invariant. `ContextMenu` dismisses on any `pointerdown` outside its
   * panel; if the flyout were portalled it would not be a descendant, and the first
   * click on a preset would close the menu instead of applying it.
   */
  it('does not dismiss the menu when the flyout itself is clicked', () => {
    const { onClose, trigger } = setup();
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerDown(screen.getByText('50/50 soft'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('runs the chosen item and closes the whole stack', () => {
    const { onSelect, onClose, trigger } = setup();
    fireEvent.pointerEnter(trigger);
    fireEvent.click(screen.getByText('50/50 soft'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes only the flyout on ArrowLeft, leaving the menu up', () => {
    const { onClose, trigger } = setup();
    fireEvent.pointerEnter(trigger);
    fireEvent.keyDown(screen.getByText('50/50 soft'), { key: 'ArrowLeft' });
    expect(screen.queryByText('50/50 soft')).toBeNull();
    expect(screen.getByText('Delete point')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
