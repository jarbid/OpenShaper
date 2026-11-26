// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a step does to the sidebar. The view part is `applyViewChange`'s and is not re-tested; what
 * is pinned here is what a step adds to it: a tab, sections opened without being marked as the
 * user's, and nothing at all against a section the user took over.
 */
import { describe, expect, it } from 'vitest';
import {
  applyViewChange,
  DEFAULT_SIDEBAR_STATE,
  toggleSection,
  type SidebarState,
} from '../sidebar-sections';
import { sidebarForPanel, sidebarForStep } from './sidebar-for-step';
import { DESIGN_STEPS, PANEL_ENTRIES } from './steps';

const start: SidebarState = DEFAULT_SIDEBAR_STATE;

describe('a design step', () => {
  it('opens the sections its view opens, through applyViewChange', () => {
    for (const s of DESIGN_STEPS) {
      const next = sidebarForStep(start, s.id);
      const viewOnly = applyViewChange(start, s.sidebar.view);
      // what a step shuts is what its own panel does the work of
      for (const id of viewOnly.open.filter((q) => !s.sidebar.shut?.includes(q))) {
        expect(next.open, `${s.id}: ${id}`).toContain(id);
      }
    }
    expect(sidebarForStep(start, 'rocker').open).toEqual(applyViewChange(start, 'rocker').open);
  });

  it('leaves the tab alone when it names none', () => {
    const onBuild: SidebarState = { ...start, activeTab: 'build' };
    for (const id of ['outline', 'rocker', 'deck', 'rails'] as const) {
      expect(sidebarForStep(onBuild, id).activeTab, id).toBe('build');
    }
  });

  it('Bottom shows the Shape tab and leaves the old bottom features section shut: the contours are in the panel', () => {
    const next = sidebarForStep(start, 'bottom');
    expect(next.activeTab).toBe('shape');
    expect(next.open).not.toContain('bottomFeatures');
    // the cross-section view opens it by itself: the step shuts it
    expect(applyViewChange(start, 'crossSection').open).toContain('bottomFeatures');
    // a section the user opened by hand is theirs
    const theirs = toggleSection(start, 'bottomFeatures', true);
    expect(theirs.open).toContain('bottomFeatures');
    expect(sidebarForStep(theirs, 'bottom').open).toContain('bottomFeatures');
  });

  it('Tail shows the Shape tab with the board shape (the tail) open', () => {
    const next = sidebarForStep(start, 'tail');
    expect(next.activeTab).toBe('shape');
    expect(next.open).toContain('boardShape');
  });

  it('Fins shows the Build tab with the fins open, which the outline view alone would not open', () => {
    expect(applyViewChange(start, 'outline').open).not.toContain('fins');
    const next = sidebarForStep(start, 'fins');
    expect(next.activeTab).toBe('build');
    expect(next.open).toContain('fins');
  });

  it('shuts what it opened when the next step does not want it', () => {
    const fins = sidebarForStep(start, 'fins');
    expect(sidebarForStep(fins, 'outline').open).not.toContain('fins');
    expect(sidebarForStep(sidebarForStep(start, 'bottom'), 'outline').open).not.toContain(
      'bottomFeatures',
    );
    // ...but keeps it for a step whose view wants it as well (bottom features show in the rocker too)
    expect(sidebarForStep(sidebarForStep(start, 'bottom'), 'rocker').open).toContain(
      'bottomFeatures',
    );
  });

  it('does not mark what it opened as the user’s own', () => {
    for (const id of ['bottom', 'tail', 'fins'] as const) {
      expect(sidebarForStep(start, id).touched, id).toEqual([]);
    }
  });

  it('keeps a section the user shut shut, and a section the user opened open', () => {
    const shut = toggleSection(start, 'fins', false);
    expect(sidebarForStep(shut, 'fins').open).not.toContain('fins');
    const opened = toggleSection(start, 'fins', true);
    expect(sidebarForStep(opened, 'rocker').open).toContain('fins');
  });

  it('keeps registry order in the open list', () => {
    const open = sidebarForStep(start, 'fins').open;
    const order = ['specs', 'boardShape', 'controlPoint', 'analysis', 'fins', 'trace', 'compare'];
    expect(open).toEqual(order.filter((id) => (open as readonly string[]).includes(id)));
  });

  it('returns the very state it was given when it has nothing to change', () => {
    for (const s of DESIGN_STEPS) {
      const once = sidebarForStep(start, s.id);
      expect(sidebarForStep(once, s.id), s.id).toBe(once);
    }
  });

  it('leaves a folded sidebar folded: a step changes what it shows, it does not ask to see it', () => {
    const folded: SidebarState = { ...start, collapsed: true };
    const next = sidebarForStep(folded, 'tail');
    expect(next.collapsed).toBe(true);
    expect(next.activeTab).toBe('shape');
  });
});

describe('a panel entry', () => {
  it('shows the tab of its name', () => {
    expect(sidebarForPanel(start, 'build').activeTab).toBe('build');
    expect(sidebarForPanel({ ...start, activeTab: 'shape' }, 'specs').activeTab).toBe('specs');
  });

  it('Compare shows the Reference tab with the Compare section open', () => {
    const shut: SidebarState = { ...start, open: start.open.filter((id) => id !== 'compare') };
    const next = sidebarForPanel(shut, 'compare');
    expect(next.activeTab).toBe('reference');
    expect(next.open).toContain('compare');
    expect(next.touched).toEqual([]);
  });

  it('unfolds a folded sidebar: choosing a panel is a request to see it', () => {
    const next = sidebarForPanel({ ...start, collapsed: true }, 'specs');
    expect(next.collapsed).toBe(false);
  });

  it('returns the same state when the tab is already showing', () => {
    for (const p of PANEL_ENTRIES) {
      const once = sidebarForPanel(start, p.id);
      expect(sidebarForPanel(once, p.id), p.id).toBe(once);
    }
  });

  it('does not touch the design step’s sections', () => {
    const fins = sidebarForStep(start, 'fins');
    expect(sidebarForPanel(fins, 'specs').open).toEqual(fins.open);
  });
});
