// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  anyOpen,
  applyViewChange,
  DEFAULT_SIDEBAR_STATE,
  isSectionId,
  isSpecGroupId,
  isTabId,
  revealSection,
  sectionIds,
  sectionsInTab,
  selectTab,
  setAll,
  setAllSpecGroups,
  shownTabs,
  SIDEBAR_SECTIONS,
  SIDEBAR_TABS,
  SPEC_GROUPS,
  specGroupIds,
  tabById,
  toggleSection,
  togglePin,
  toggleSpecGroup,
  type SidebarState,
} from './sidebar-sections';

const state = (over: Partial<SidebarState> = {}): SidebarState => ({
  ...DEFAULT_SIDEBAR_STATE,
  ...over,
});

describe('the section registry', () => {
  it('has no duplicate ids — the persisted open/touched sets are keyed by them', () => {
    expect(new Set(sectionIds()).size).toBe(SIDEBAR_SECTIONS.length);
  });

  it('assigns every section to a declared tab', () => {
    for (const { id, tab } of SIDEBAR_SECTIONS) {
      expect(isTabId(tab), `${id} sits in an unknown tab`).toBe(true);
    }
  });

  it('leaves no tab empty — a strip button that opens nothing is a dead control', () => {
    for (const tab of SIDEBAR_TABS) {
      expect(sectionsInTab(tab.id).length, tab.id).toBeGreaterThan(0);
    }
  });

  it('keeps each tab contiguous in the table, so render order matches the strip', () => {
    const seen = new Set<string>();
    let previous = '';
    for (const { tab } of SIDEBAR_SECTIONS) {
      if (tab === previous) continue;
      expect(seen.has(tab), `${tab} is split across the table`).toBe(false);
      seen.add(tab);
      previous = tab;
    }
  });

  it('gives every tab a caption short enough for the 64px strip', () => {
    for (const tab of SIDEBAR_TABS) {
      expect(tab.label.length, `${tab.id} caption "${tab.label}"`).toBeLessThanOrEqual(6);
    }
  });

  it('leads with Specs — the readout is the one section worth defaulting open', () => {
    expect(SIDEBAR_SECTIONS[0]?.id).toBe('specs');
    expect(SIDEBAR_SECTIONS[0]?.defaultOpen).toBe(true);
  });

  it('rejects unknown ids, so a stale persisted blob cannot resurrect a removed section', () => {
    expect(isSectionId('specs')).toBe(true);
    expect(isSectionId('construction')).toBe(false);
    expect(isSectionId(null)).toBe(false);
  });
});

describe('applyViewChange', () => {
  it('opens the trace controls in the views that can hold a trace', () => {
    expect(applyViewChange(state(), 'outline').open).toContain('trace');
    expect(applyViewChange(state(), 'rocker').open).toContain('trace');
  });

  it('closes them again in a view that cannot', () => {
    const outline = applyViewChange(state(), 'outline');
    expect(applyViewChange(outline, '3d').open).not.toContain('trace');
  });

  it('opens Fins in 3D, where fins are the thing you can actually see', () => {
    expect(applyViewChange(state(), '3d').open).toContain('fins');
    expect(applyViewChange(state(), 'crossSection').open).not.toContain('fins');
  });

  it('leaves an always-relevant section open in every view', () => {
    for (const view of ['quad', 'split', 'outline', 'rocker', 'crossSection', '3d'] as const) {
      expect(applyViewChange(state(), view).open, view).toContain('specs');
    }
  });

  it('never auto-opens a section marked as reference material', () => {
    for (const view of ['quad', 'split', 'outline', 'rocker', 'crossSection', '3d'] as const) {
      expect(applyViewChange(state(), view).open, view).not.toContain('history');
    }
  });

  it('leaves a hand-opened section open in a view it is not relevant to', () => {
    // The whole point of `touched`: "I opened Fins, stop closing it."
    const s = toggleSection(state(), 'fins', true);
    expect(applyViewChange(s, 'crossSection').open).toContain('fins');
  });

  it('leaves a hand-closed section closed in a view it *is* relevant to', () => {
    const s = toggleSection(applyViewChange(state(), 'outline'), 'trace', false);
    expect(applyViewChange(s, 'rocker').open).not.toContain('trace');
  });

  it('preserves the collapsed rail — a view change is not a reason to unfold', () => {
    expect(applyViewChange(state({ collapsed: true }), 'outline').collapsed).toBe(true);
  });

  it('returns ids in registry order, so render order cannot drift from the table', () => {
    const { open } = applyViewChange(state(), 'outline');
    const order = sectionIds();
    const positions = open.map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('setAll', () => {
  it('closes everything, then opens everything', () => {
    expect(setAll(state(), false).open).toEqual([]);
    expect(setAll(state(), true).open).toEqual([...sectionIds()]);
  });

  it('survives the next view change', () => {
    // Without marking everything touched, switching view would silently re-open half
    // of what was just collapsed and the master toggle would read as broken.
    const collapsed = setAll(state(), false);
    expect(applyViewChange(collapsed, 'outline').open).toEqual([]);
  });

  it('holds an expand-all open in a view where most sections are irrelevant', () => {
    const expanded = setAll(state(), true);
    expect(applyViewChange(expanded, '3d').open).toEqual([...sectionIds()]);
  });

  it('round-trips', () => {
    const s = state();
    expect(setAll(setAll(s, false), true).open).toEqual([...sectionIds()]);
  });

  it('leaves the rail alone — collapsing sections is not collapsing the sidebar', () => {
    expect(setAll(state({ collapsed: true }), false).collapsed).toBe(true);
  });
});

describe('anyOpen', () => {
  it('drives which way the master toggle points', () => {
    expect(anyOpen(state())).toBe(true);
    expect(anyOpen(setAll(state(), false))).toBe(false);
  });
});

describe('the tab strip', () => {
  it('looks up a tab and rejects one it does not have', () => {
    expect(tabById('shape').title).toBe('Shape');
    expect(() => tabById('construction' as never)).toThrow();
    expect(isTabId('reference')).toBe(true);
    expect(isTabId('design')).toBe(false);
  });

  it('switches tab without disturbing the accordion', () => {
    const s = toggleSection(state(), 'weight', true);
    const next = selectTab(s, 'build');
    expect(next.activeTab).toBe('build');
    expect(next.open).toEqual(s.open);
    expect(next.touched).toEqual(s.touched);
  });

  it('unfolds when a tab is picked while folded', () => {
    // Reaching for a tool is a request to see it, not merely to select it.
    const next = selectTab(state({ collapsed: true, activeTab: 'build' }), 'build');
    expect(next.collapsed).toBe(false);
  });

  it('is a no-op when the tab is already active and showing', () => {
    const s = state({ activeTab: 'shape' });
    expect(selectTab(s, 'shape')).toBe(s);
  });

  it('shows one panel by default', () => {
    expect(shownTabs(state())).toEqual(['specs']);
  });

  it('shows the pinned tab above the active one', () => {
    const s = selectTab(togglePin(state(), 'specs'), 'shape');
    expect(shownTabs(s)).toEqual(['specs', 'shape']);
  });

  it('shows one panel when the pinned tab is also the active one', () => {
    // Allowed on purpose: pinning the tab you are in should not have to move you.
    const s = togglePin(state({ activeTab: 'shape' }), 'shape');
    expect(s.pinnedTab).toBe('shape');
    expect(shownTabs(s)).toEqual(['shape']);
  });

  it('caps pinning at one tab', () => {
    const s = togglePin(togglePin(state(), 'specs'), 'build');
    expect(s.pinnedTab).toBe('build');
  });

  it('unpins on a second toggle', () => {
    expect(togglePin(togglePin(state(), 'specs'), 'specs').pinnedTab).toBeNull();
  });

  it('keeps the pin across a view change', () => {
    const s = selectTab(togglePin(state(), 'specs'), 'shape');
    const next = applyViewChange(s, 'outline');
    expect(next.pinnedTab).toBe('specs');
    expect(next.activeTab).toBe('shape');
  });

  it('never lets a view change move the user to another tab', () => {
    // The panel jumping tabs because you glanced at the outline would be the worst
    // kind of surprise: the tab is the user's navigation, not the app's.
    for (const view of ['quad', 'outline', 'rocker', 'crossSection', '3d'] as const) {
      expect(applyViewChange(state({ activeTab: 'build' }), view).activeTab, view).toBe('build');
    }
  });
});

describe('revealSection', () => {
  it('brings a tool on screen from a folded sidebar on another tab', () => {
    // Board ▸ Resize… from the default layout with the panel folded away.
    const next = revealSection(state({ collapsed: true }), 'resize');
    expect(next.collapsed).toBe(false);
    expect(next.activeTab).toBe('shape');
    expect(next.open).toContain('resize');
  });

  it("marks the section the user's, so the next view change leaves it open", () => {
    // Resize is relevant to no view: untouched, the first view change would shut it.
    const next = applyViewChange(revealSection(state(), 'resize'), 'outline');
    expect(next.open).toContain('resize');
  });

  it('leaves the rest of the accordion alone', () => {
    const s = toggleSection(state(), 'fins', true);
    const next = revealSection(s, 'resize');
    expect(next.open.filter((id) => id !== 'resize')).toEqual(s.open);
    expect(next.touched).toEqual(['resize', 'fins']);
  });

  it('keeps the working tab when the tool is already on screen in the pinned panel', () => {
    // Shape pinned above Build: switching to Shape would take away the Build panel.
    const s = selectTab(togglePin(state(), 'shape'), 'build');
    const next = revealSection(s, 'resize');
    expect(next.activeTab).toBe('build');
    expect(next.pinnedTab).toBe('shape');
    expect(next.open).toContain('resize');
  });

  it('still unfolds a sidebar whose pinned panel holds the tool', () => {
    const s = { ...selectTab(togglePin(state(), 'shape'), 'build'), collapsed: true };
    expect(revealSection(s, 'resize').collapsed).toBe(false);
  });

  it('rejects an unknown section', () => {
    expect(() => revealSection(state(), 'construction' as never)).toThrow();
  });
});

describe('setAll scoped to a tab', () => {
  it("collapses only that tab's sections", () => {
    const shape = sectionsInTab('shape').map((s) => s.id);
    const s = setAll(state(), true); // everything open
    const next = setAll(s, false, shape);
    for (const id of shape) expect(next.open).not.toContain(id);
    // Another tab's rows are untouched — you cannot see them to have meant them.
    expect(next.open).toContain('fins');
  });

  it("only marks the scoped sections as the user's", () => {
    const next = setAll(state(), false, ['weight']);
    expect(next.touched).toEqual(['weight']);
  });

  it('reports open-ness for the rows it governs, not the whole sidebar', () => {
    const s = state({ open: ['fins'], touched: [] });
    expect(
      anyOpen(
        s,
        sectionsInTab('build').map((x) => x.id),
      ),
    ).toBe(true);
    expect(
      anyOpen(
        s,
        sectionsInTab('shape').map((x) => x.id),
      ),
    ).toBe(false);
  });
});

describe('the spec readout bands', () => {
  it('starts with Overall alone, so the readout fits a laptop', () => {
    expect(DEFAULT_SIDEBAR_STATE.specGroups).toEqual(['overall']);
  });

  it('covers the four bands the readout is written in', () => {
    expect(SPEC_GROUPS.map((g) => g.id)).toEqual(['nose', 'center', 'tail', 'overall']);
    expect(isSpecGroupId('nose')).toBe(true);
    expect(isSpecGroupId('rail')).toBe(false);
  });

  it('opens and closes one band', () => {
    const s = toggleSpecGroup(state(), 'nose', true);
    expect(s.specGroups).toEqual(['nose', 'overall']); // registry order, not click order
    expect(toggleSpecGroup(s, 'overall', false).specGroups).toEqual(['nose']);
  });

  it('opens and closes all of them', () => {
    expect(setAllSpecGroups(state(), true).specGroups).toEqual([...specGroupIds()]);
    expect(setAllSpecGroups(state(), false).specGroups).toEqual([]);
  });

  it('leaves the section accordion alone', () => {
    const s = state();
    expect(toggleSpecGroup(s, 'tail', true).open).toEqual(s.open);
  });
});

/**
 * Split shows two panes at once, so the sidebar follows the panes rather than the
 * layout: a tool is relevant there whenever *either* half is a view that wants it.
 */
describe('applyViewChange across a split', () => {
  it('opens what either half asks for', () => {
    // Trace belongs to outline/rocker; fins to 3D. One half of each, both open.
    const open = applyViewChange(state(), ['outline', '3d']).open;
    expect(open).toContain('trace');
    expect(open).toContain('fins');
  });

  it('closes what neither half asks for', () => {
    const open = applyViewChange(state(), ['crossSection', '3d']).open;
    expect(open, 'neither half can hold a trace').not.toContain('trace');
  });

  it('re-points with the halves — swapping 3D out closes Fins again', () => {
    const with3d = applyViewChange(state(), ['outline', '3d']);
    expect(with3d.open).toContain('fins');
    expect(applyViewChange(with3d, ['outline', 'rocker']).open).not.toContain('fins');
  });

  it('still honours a hand-opened section', () => {
    const s = toggleSection(state(), 'fins', true);
    expect(applyViewChange(s, ['outline', 'rocker']).open).toContain('fins');
  });

  it('matches the single view when both halves name the same one', () => {
    // Not a state the app can reach — the picker swaps instead of doubling up —
    // but it pins the "any half counts" rule to the one-view behaviour.
    expect(applyViewChange(state(), ['outline', 'outline']).open).toEqual(
      applyViewChange(state(), 'outline').open,
    );
  });
});
