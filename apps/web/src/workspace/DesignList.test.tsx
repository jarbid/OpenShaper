// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The design list: every entry is there, the current step is marked, the keyboard moves through it,
 * and below `lg` it is a column of icons that still has a name for every button.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignList, type DesignListProps } from './DesignList';
import { DESIGN_STEPS, PANEL_ENTRIES, WORKSPACE_ENTRIES } from './steps';

const NAMES = WORKSPACE_ENTRIES.map((e) => e.label);

function setup(props: Partial<DesignListProps> = {}) {
  const onStep = vi.fn();
  const onPanel = vi.fn();
  const view = render(
    <DesignList step="outline" onStep={onStep} sidebarTab={null} onPanel={onPanel} {...props} />,
  );
  const nav = screen.getByRole('navigation', { name: 'Design steps' });
  const buttons = () => within(nav).getAllByRole('button');
  const button = (name: string) => within(nav).getByRole('button', { name });
  return { ...view, nav, buttons, button, onStep, onPanel };
}

describe('the list', () => {
  it('is a navigation named Design steps, with a button for each of the ten entries, in order', () => {
    const { buttons } = setup();
    expect(buttons().map((b) => b.textContent)).toEqual(NAMES);
  });

  it('marks the current step, and only it, as the step', () => {
    const { nav, rerender, button, onStep, onPanel } = setup({ step: 'deck' });
    const current = () =>
      within(nav)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-current') === 'step')
        .map((b) => b.textContent);
    expect(current()).toEqual(['Deck']);
    expect(button('Outline').hasAttribute('aria-current')).toBe(false);
    rerender(<DesignList step="fins" onStep={onStep} sidebarTab={null} onPanel={onPanel} />);
    expect(current()).toEqual(['Fins']);
  });

  it('chooses a design step on a click, and a panel on a click on one of the last three', () => {
    const { button, onStep, onPanel } = setup();
    fireEvent.click(button('Bottom'));
    expect(onStep).toHaveBeenCalledWith('bottom');
    fireEvent.click(button('Compare'));
    expect(onPanel).toHaveBeenCalledWith('compare');
    fireEvent.click(button('Specs'));
    expect(onPanel).toHaveBeenLastCalledWith('specs');
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it('marks the panel entry whose tab the sidebar shows, apart from the step', () => {
    const { nav, button, rerender, onStep, onPanel } = setup({
      step: 'rails',
      sidebarTab: 'build',
    });
    expect(button('Build').getAttribute('aria-current')).toBe('true');
    expect(button('Rails').getAttribute('aria-current')).toBe('step');
    const marked = () =>
      within(nav)
        .getAllByRole('button')
        .filter((b) => b.hasAttribute('aria-current'))
        .map((b) => b.textContent);
    expect(marked()).toEqual(['Rails', 'Build']);
    rerender(<DesignList step="rails" onStep={onStep} sidebarTab="reference" onPanel={onPanel} />);
    expect(marked()).toEqual(['Rails', 'Compare']);
    rerender(<DesignList step="rails" onStep={onStep} sidebarTab="shape" onPanel={onPanel} />);
    expect(marked()).toEqual(['Rails']);
    rerender(<DesignList step="rails" onStep={onStep} sidebarTab={null} onPanel={onPanel} />);
    expect(marked()).toEqual(['Rails']);
  });

  it('has one divider between the steps and the panels, hidden from assistive technology', () => {
    const { nav } = setup();
    const divider = nav.querySelector('[aria-hidden="true"].h-px');
    expect(divider).not.toBeNull();
    expect(within(nav).queryByRole('separator')).toBeNull();
  });
});

describe('the keyboard', () => {
  it('has one tab stop: the current step', () => {
    const { buttons } = setup({ step: 'rocker' });
    const stops = buttons().filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.textContent)).toEqual(['Rocker and foil']);
  });

  it('moves focus down and up, one entry a press, across the divider into the panels', () => {
    const { button } = setup();
    button('Outline').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(button('Rocker and foil'));
    for (let i = 0; i < 5; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(button('Fins'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(button('Specs'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(button('Fins'));
  });

  it('stops at the ends rather than wrapping, and Home and End go to them', () => {
    const { button } = setup();
    button('Outline').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(button('Outline'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(button('Compare'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(button('Compare'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(button('Outline'));
  });

  it('does not choose anything by moving; Enter chooses what has focus', () => {
    const { button, onStep, onPanel } = setup();
    button('Outline').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(onStep).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onStep).toHaveBeenCalledWith('deck');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onPanel).toHaveBeenCalledWith('compare');
  });

  it('moves the tab stop with focus, and puts it back on the step when the step changes', () => {
    const { button, buttons, rerender, onStep, onPanel } = setup({ step: 'outline' });
    button('Outline').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(buttons().filter((b) => b.tabIndex === 0)).toEqual([button('Rocker and foil')]);
    rerender(<DesignList step="tail" onStep={onStep} sidebarTab={null} onPanel={onPanel} />);
    expect(buttons().filter((b) => b.tabIndex === 0)).toEqual([button('Tail')]);
  });

  it('consumes the keys it uses, so the point editor does not nudge on them', () => {
    // The nudge listens on window and skips an event someone has already used.
    const seen: boolean[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
    window.addEventListener('keydown', onWindow);
    const { button } = setup();
    button('Deck').focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
      fireEvent.keyDown(document.activeElement!, { key });
    }
    window.removeEventListener('keydown', onWindow);
    expect(seen).toEqual([true, true, true, true, true]);
  });

  it('leaves keys it does not use alone', () => {
    const seen: boolean[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
    window.addEventListener('keydown', onWindow);
    const { button } = setup();
    button('Deck').focus();
    for (const key of ['ArrowLeft', 'ArrowRight', '3', 'Escape']) {
      fireEvent.keyDown(document.activeElement!, { key });
    }
    window.removeEventListener('keydown', onWindow);
    expect(seen).toEqual([false, false, false, false]);
  });
});

describe('the sizes', () => {
  it('is a 168 px column of icons and names from lg up', () => {
    const { nav, buttons } = setup();
    expect(nav.className).toContain('w-[168px]');
    for (const b of buttons()) {
      expect(b.querySelector('svg'), b.textContent ?? '').not.toBeNull();
      expect(b.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(within(nav).getByText('Design')).toBeTruthy();
  });

  it('floors a finger at 44 px there', () => {
    const { buttons } = setup();
    for (const b of buttons()) expect(b.className).toContain('pointer-coarse:h-11');
  });

  it('is a 56 px column of icons below lg, 44 px square whatever the pointer', () => {
    const { nav, buttons } = setup({ compact: true });
    expect(nav.className).toContain('w-14');
    expect(buttons()).toHaveLength(10);
    for (const b of buttons()) {
      expect(b.className).toContain('size-11');
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.textContent).toBe('');
    }
    expect(within(nav).queryByText('Design')).toBeNull();
  });

  it('names every icon-only button for assistive technology', () => {
    const { buttons } = setup({ compact: true });
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(NAMES);
  });

  it('keeps the marks and the keyboard in the icon column', () => {
    const { button, buttons, onStep } = setup({
      compact: true,
      step: 'bottom',
      sidebarTab: 'specs',
    });
    expect(button('Bottom').getAttribute('aria-current')).toBe('step');
    expect(button('Specs').getAttribute('aria-current')).toBe('true');
    button('Bottom').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(button('Deck'));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onStep).toHaveBeenCalledWith('deck');
    expect(buttons()).toHaveLength(10);
  });
});

describe('the tooltips', () => {
  const tip = () => document.querySelector('[role="presentation"][aria-hidden="true"]');

  it('name the step and its key, the key read from the shortcut table', () => {
    const { button } = setup({ compact: true });
    fireEvent.focus(button('Rails'));
    expect(tip()?.textContent).toBe('Rails5');
  });

  it('are there on the wide list too, where the names are already showing', () => {
    const { button } = setup();
    fireEvent.focus(button('Fins'));
    expect(tip()?.textContent).toBe('Fins7');
  });

  it('give a panel entry its name and no key', () => {
    const { button } = setup({ compact: true });
    fireEvent.focus(button('Compare'));
    expect(tip()?.textContent).toBe('Compare');
  });

  it('exist for every design step, with the key that step has', () => {
    const { button } = setup({ compact: true });
    for (const s of DESIGN_STEPS) {
      fireEvent.focus(button(s.label));
      expect(tip()?.textContent, s.id).toBe(`${s.label}${s.key}`);
      fireEvent.blur(button(s.label));
    }
    expect(PANEL_ENTRIES).toHaveLength(3);
  });
});
