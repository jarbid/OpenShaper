// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace's layout and what follows from the step: the board over the drawing, the list on
 * the left, the sidebar on the right (below lg: not there); a step changes the drawing and the
 * sidebar and not the board.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setPatchPick } from '../patch-look';
import { DEFAULT_SIDEBAR_STATE, type SidebarState } from '../sidebar-sections';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { RailsWorkspace, type RailsWorkspaceProps } from './RailsWorkspace';
import { resetWorkspaceStep, setWorkspaceStep, STEP_STORAGE_KEY } from './use-step';

let boardMounts = 0;
const Board = () => {
  useEffect(() => {
    boardMounts++;
  }, []);
  return <div data-testid="board" />;
};
const board = <Board />;

const apply = (call: unknown, from: SidebarState = DEFAULT_SIDEBAR_STATE) =>
  (call as (s: SidebarState) => SidebarState)(from);

function setup(props: Partial<RailsWorkspaceProps> = {}) {
  const onSidebar = vi.fn();
  const onShowSidebar = vi.fn();
  const drawingFor = vi.fn((step: string) => <div data-testid="drawing">{step}</div>);
  const all: RailsWorkspaceProps = {
    board,
    looks: <button type="button">Looks</button>,
    drawingFor,
    sidebar: <aside aria-label="Board panels">sidebar</aside>,
    compact: false,
    onSidebar,
    sidebarTab: 'specs',
    onShowSidebar,
    ...props,
  };
  const view = render(<RailsWorkspace {...all} />);
  const nav = () => screen.getByRole('navigation', { name: 'Design steps' });
  const step = (name: string) => within(nav()).getByRole('button', { name });
  const drawing = () => screen.getByTestId('drawing').textContent;
  return { ...view, all, onSidebar, onShowSidebar, drawingFor, nav, step, drawing };
}

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStep();
  act(() => setPatchPick(null));
  boardMounts = 0;
});

describe('the layout', () => {
  it('has the design list, the board in a panel headed 3D with the look controls, the divider, the drawing and the sidebar', () => {
    setup();
    expect(screen.getByRole('navigation', { name: 'Design steps' })).toBeTruthy();
    const heading = screen.getByRole('heading', { name: '3D' });
    const panel = heading.closest('div.rounded-lg')!;
    expect(within(panel as HTMLElement).getByRole('button', { name: 'Looks' })).toBeTruthy();
    expect(within(panel as HTMLElement).getByTestId('board')).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByTestId('drawing')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Board panels' })).toBeTruthy();
  });

  it('puts the board above the drawing, and the sidebar last', () => {
    setup();
    const order = Array.from(
      document.querySelectorAll(
        '[data-testid=board], [role=separator], [data-testid=drawing], aside',
      ),
    );
    expect(
      order.map((e) => e.getAttribute('data-testid') ?? e.getAttribute('role') ?? e.tagName),
    ).toEqual(['board', 'separator', 'drawing', 'ASIDE']);
  });

  it('has no sidebar of its own below lg, where the shell’s sheet holds it', () => {
    setup({ sidebar: undefined, compact: true });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('is an icon column below lg and a column of names from lg up', () => {
    const wide = setup();
    expect(wide.nav().className).toContain('w-[168px]');
    wide.unmount();
    const narrow = setup({ compact: true });
    expect(narrow.nav().className).toContain('w-14');
  });
});

describe('the drawing', () => {
  it('is the drawing for the step the last visit ended on', () => {
    localStorage.setItem(STEP_STORAGE_KEY, JSON.stringify('bottom'));
    resetWorkspaceStep();
    const { drawing } = setup();
    expect(drawing()).toBe('bottom');
  });

  it('is the outline’s to begin with, and follows a step chosen in the list', () => {
    const { drawing, step, drawingFor } = setup();
    expect(drawing()).toBe('outline');
    fireEvent.click(step('Deck'));
    expect(drawing()).toBe('deck');
    expect(drawingFor).toHaveBeenLastCalledWith('deck');
    fireEvent.click(step('Fins'));
    expect(drawing()).toBe('fins');
  });

  it('follows a step chosen by a key (the shell sets it) and marks it in the list', () => {
    const { drawing, step } = setup();
    act(() => setWorkspaceStep('rocker'));
    expect(drawing()).toBe('rocker');
    expect(step('Rocker and foil').getAttribute('aria-current')).toBe('step');
  });
});

describe('the board', () => {
  it('is mounted once, and stays mounted through steps, a tier change and the sidebar coming and going', () => {
    const { step, rerender, all } = setup();
    expect(boardMounts).toBe(1);
    for (const name of ['Deck', 'Rocker and foil', 'Rails', 'Outline']) fireEvent.click(step(name));
    expect(boardMounts).toBe(1);
    rerender(<RailsWorkspace {...all} compact sidebar={undefined} />);
    expect(boardMounts).toBe(1);
    rerender(<RailsWorkspace {...all} compact={false} />);
    expect(boardMounts).toBe(1);
    act(() => setPatchPick({ patch: 'bottom', side: 'plus', x: 3, y: 1 }));
    expect(boardMounts).toBe(1);
  });
});

describe('the sidebar', () => {
  it('is set for the step when the workspace opens, and again for each step chosen', () => {
    const { onSidebar, step } = setup();
    expect(onSidebar).toHaveBeenCalledTimes(1);
    expect(apply(onSidebar.mock.calls[0]![0]).open).toContain('controlPoint');
    fireEvent.click(step('Fins'));
    expect(onSidebar).toHaveBeenCalledTimes(2);
    const next = apply(onSidebar.mock.calls[1]![0]);
    expect(next.activeTab).toBe('build');
    expect(next.open).toContain('fins');
  });

  it('is set for the step the last visit ended on, when the workspace opens', () => {
    localStorage.setItem(STEP_STORAGE_KEY, JSON.stringify('tail'));
    resetWorkspaceStep();
    const { onSidebar } = setup();
    const state = apply(onSidebar.mock.calls[0]![0]);
    expect(state.activeTab).toBe('shape');
    expect(state.open).toContain('boardShape');
  });

  it('is not asked again for a step it already has', () => {
    const { onSidebar, step } = setup();
    fireEvent.click(step('Outline'));
    expect(onSidebar).toHaveBeenCalledTimes(1);
  });

  it('shows the tab of a panel entry, and raises the sheet', () => {
    const { onSidebar, onShowSidebar, step } = setup();
    onSidebar.mockClear();
    fireEvent.click(step('Build'));
    expect(onSidebar).toHaveBeenCalledTimes(1);
    expect(apply(onSidebar.mock.calls[0]![0]).activeTab).toBe('build');
    expect(onShowSidebar).toHaveBeenCalledTimes(1);
    fireEvent.click(step('Compare'));
    expect(apply(onSidebar.mock.calls[1]![0]).activeTab).toBe('reference');
    expect(onShowSidebar).toHaveBeenCalledTimes(2);
  });

  it('leaves the sheet where it is for a design step', () => {
    const { onShowSidebar, step } = setup();
    fireEvent.click(step('Tail'));
    expect(onShowSidebar).not.toHaveBeenCalled();
  });

  it('does not need to raise a sheet where there is none', () => {
    const { step, onSidebar } = setup({ onShowSidebar: undefined });
    onSidebar.mockClear();
    expect(() => fireEvent.click(step('Specs'))).not.toThrow();
    expect(onSidebar).toHaveBeenCalledTimes(1);
  });

  it('marks the panel entry whose tab it is showing', () => {
    const { step } = setup({ sidebarTab: 'build' });
    expect(step('Build').getAttribute('aria-current')).toBe('true');
    expect(step('Specs').hasAttribute('aria-current')).toBe(false);
  });
});

describe('a tap on the board', () => {
  it('chooses the step it names, and the sidebar follows', () => {
    const { drawing, onSidebar, step } = setup();
    onSidebar.mockClear();
    act(() => setPatchPick({ patch: 'rail', side: 'minus', x: 30, y: -5, zone: 0 }));
    expect(drawing()).toBe('rails');
    expect(step('Rails').getAttribute('aria-current')).toBe('step');
    expect(onSidebar).toHaveBeenCalledTimes(1);
  });

  it('chooses the station nearest a tap on the deck, by its slice index', async () => {
    await showRails({ plus: [key(20, 0.5)] });
    const onTapStation = vi.fn();
    const { drawing } = setup({ onTapStation });
    const x = railsStore.getState().doc!.stations[3]!.x;
    act(() => setPatchPick({ patch: 'deck', side: 'plus', x: x + 0.2, y: 2 }));
    expect(drawing()).toBe('deck');
    expect(onTapStation).toHaveBeenCalledWith(4);
    act(() => setPatchPick({ patch: 'bottom', side: 'plus', x, y: 2 }));
    expect(onTapStation).toHaveBeenCalledTimes(1);
    activeStore.use(boardStore);
  });

  it('changes no step when it lands on nothing', () => {
    const { drawing } = setup();
    act(() => setPatchPick({ patch: 'bottom', side: 'plus', x: 30, y: 5 }));
    expect(drawing()).toBe('bottom');
    act(() => setPatchPick(null));
    expect(drawing()).toBe('bottom');
  });
});
