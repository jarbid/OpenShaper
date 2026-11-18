// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The step table is read by the list, the keys, the drawing, the sidebar and the tap, so a mistake
 * in it is a mistake in all five. These pin what each entry must hold.
 */
import { describe, expect, it } from 'vitest';
import { SIDEBAR_SECTIONS, SIDEBAR_TABS } from '../sidebar-sections';
import {
  DEFAULT_STEP,
  DESIGN_STEPS,
  isStepId,
  PANEL_ENTRIES,
  panelById,
  stepById,
  WORKSPACE_ENTRIES,
} from './steps';

const VIEWS = ['quad', 'split', 'outline', 'rocker', 'crossSection', '3d'];
const EDITORS = ['outline', 'rocker', 'crossSection'];
const tabIds = SIDEBAR_TABS.map((t) => t.id);
const sectionTab = (id: string) => SIDEBAR_SECTIONS.find((s) => s.id === id)?.tab;

describe('the list', () => {
  it('is the seven design steps, then Specs, Build and Compare, in the order the list shows', () => {
    expect(WORKSPACE_ENTRIES.map((e) => e.label)).toEqual([
      'Outline',
      'Rocker and foil',
      'Deck',
      'Bottom',
      'Rails',
      'Tail',
      'Fins',
      'Specs',
      'Build',
      'Compare',
    ]);
    expect(DESIGN_STEPS.every((e) => e.kind === 'design')).toBe(true);
    expect(PANEL_ENTRIES.every((e) => e.kind === 'panel')).toBe(true);
  });

  it('has a unique id for every one of the ten entries', () => {
    const ids = WORKSPACE_ENTRIES.map((e) => e.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('gives every entry a label and an icon', () => {
    for (const e of WORKSPACE_ENTRIES) {
      expect(e.label.trim().length, e.id).toBeGreaterThan(0);
      expect(e.icon, e.id).toBeTruthy();
    }
  });

  it('starts on the outline', () => {
    expect(DEFAULT_STEP).toBe('outline');
    expect(DESIGN_STEPS[0]!.id).toBe('outline');
  });
});

describe('a design step', () => {
  it('has the keys 1 to 7, in order, one each', () => {
    expect(DESIGN_STEPS.map((s) => s.key)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('has a drawing in an editor the app has, with a heading', () => {
    for (const s of DESIGN_STEPS) {
      expect(EDITORS, s.id).toContain(s.drawing.editor);
      expect(s.drawing.title.trim().length, s.id).toBeGreaterThan(0);
    }
  });

  it('names the curve a cross-section drawing edits, and only a cross-section drawing does', () => {
    for (const s of DESIGN_STEPS) {
      if (s.drawing.editor === 'crossSection') {
        expect(['deck', 'bottom', null], s.id).toContain(s.drawing.curve);
      } else {
        expect(s.drawing.curve, s.id).toBeUndefined();
      }
    }
    const curve = (id: Parameters<typeof stepById>[0]) => stepById(id).drawing.curve;
    expect(curve('deck')).toBe('deck');
    expect(curve('bottom')).toBe('bottom');
    expect(curve('rails')).toBeNull();
  });

  it('shows the rail keys under the Rails drawing and nothing under any other', () => {
    for (const s of DESIGN_STEPS) {
      expect(s.drawing.footer, s.id).toBe(s.id === 'rails' ? 'railKeys' : undefined);
    }
  });

  it('draws what the brief says', () => {
    const editor = (id: Parameters<typeof stepById>[0]) => stepById(id).drawing.editor;
    expect(editor('outline')).toBe('outline');
    expect(editor('rocker')).toBe('rocker');
    expect(editor('tail')).toBe('outline');
    expect(editor('fins')).toBe('outline');
    expect(editor('deck')).toBe('crossSection');
    expect(editor('bottom')).toBe('crossSection');
    expect(editor('rails')).toBe('crossSection');
  });

  it('maps to a sidebar view the app has', () => {
    for (const s of DESIGN_STEPS) expect(VIEWS, s.id).toContain(s.sidebar.view);
    const view = (id: Parameters<typeof stepById>[0]) => stepById(id).sidebar.view;
    expect(view('outline')).toBe('outline');
    expect(view('rocker')).toBe('rocker');
    expect(view('deck')).toBe('crossSection');
    expect(view('bottom')).toBe('crossSection');
    expect(view('rails')).toBe('crossSection');
    expect(view('tail')).toBe('outline');
    expect(view('fins')).toBe('outline');
  });

  it('opens only sections that exist, in the tab it shows', () => {
    for (const s of DESIGN_STEPS) {
      if (s.sidebar.tab) expect(tabIds, s.id).toContain(s.sidebar.tab);
      for (const id of s.sidebar.open ?? []) {
        // a section opened in a tab that is not shown opens where nobody can see it
        expect(sectionTab(id), `${s.id}: ${id}`).toBe(s.sidebar.tab);
      }
    }
  });

  it('chooses the tab and sections the brief names for Bottom, Tail and Fins', () => {
    expect(stepById('bottom').sidebar).toMatchObject({ tab: 'shape', open: ['bottomFeatures'] });
    expect(stepById('tail').sidebar).toMatchObject({ tab: 'shape', open: ['boardShape'] });
    expect(stepById('fins').sidebar).toMatchObject({ tab: 'build', open: ['fins'] });
  });
});

describe('a panel entry', () => {
  it('shows a tab the sidebar has, and opens only sections that sit in it', () => {
    for (const p of PANEL_ENTRIES) {
      expect(tabIds, p.id).toContain(p.tab);
      for (const id of p.open ?? []) expect(sectionTab(id), `${p.id}: ${id}`).toBe(p.tab);
    }
  });

  it('is the tab of its name, and for Compare the tab that holds the Compare section', () => {
    expect(panelById('specs').tab).toBe('specs');
    expect(panelById('build').tab).toBe('build');
    expect(panelById('compare').tab).toBe('reference');
    expect(sectionTab('compare')).toBe('reference');
  });
});

describe('lookups', () => {
  it('know a step id from anything else', () => {
    for (const s of DESIGN_STEPS) expect(isStepId(s.id)).toBe(true);
    for (const v of ['specs', 'compare', '', 'Outline', null, 3, undefined]) {
      expect(isStepId(v), String(v)).toBe(false);
    }
  });

  it('throw on an id that is not there', () => {
    expect(() => stepById('nope' as never)).toThrow(/Unknown workspace step/);
    expect(() => panelById('nope' as never)).toThrow(/Unknown workspace panel/);
  });
});
