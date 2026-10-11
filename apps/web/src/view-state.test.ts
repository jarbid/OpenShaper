/**
 * View-state persistence — active view/tab, per-pane 2D framing (world center +
 * scale), and the 3D camera pose, as one versioned localStorage blob under
 * 'bs.viewState'. NOTE: localStorage is reset between tests via beforeEach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPLIT,
  DEFAULT_VIEW_STATE,
  loadViewState,
  saveViewState,
  VIEW_STATE_VERSION,
  type ViewState,
} from './view-state';
import { DEFAULT_SIDEBAR_STATE } from './sidebar-sections';
import { DEFAULT_VIEW_3D } from './view3d-settings';

beforeEach(() => {
  localStorage.clear();
});

const sample: ViewState = {
  version: VIEW_STATE_VERSION,
  view: 'rocker',
  views2d: {
    outline: { cx: 91.5, cy: 0, scale: 4.2 },
    rocker: { cx: 80, cy: 3.1, scale: 6 },
  },
  camera3d: { position: [0, -250, 110], target: [0, 10, 0] },
  sidebar: {
    collapsed: true,
    activeTab: 'build',
    pinnedTab: 'specs',
    open: ['specs', 'trace'],
    touched: ['trace'],
    specGroups: ['nose', 'overall'],
  },
};

describe('view-state', () => {
  it('returns defaults when localStorage is empty', () => {
    expect(loadViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it('round-trips a saved view state', () => {
    saveViewState(sample);
    expect(loadViewState()).toEqual(sample);
  });

  it('returns defaults on corrupt JSON', () => {
    localStorage.setItem('bs.viewState', 'not-json{{{');
    expect(loadViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it('falls back to the default active view when the stored one is unknown', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.view = 'hologram';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    const loaded = loadViewState();
    expect(loaded.view).toBe(DEFAULT_VIEW_STATE.view);
    // The rest of the blob is still honoured.
    expect(loaded.views2d).toEqual(sample.views2d);
  });

  it('drops 2D entries with non-finite numbers', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.views2d.outline.scale = null;
    raw.views2d.crossSection = { cx: 'NaN', cy: 0, scale: 2 };
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    const loaded = loadViewState();
    expect(loaded.views2d.outline).toBeUndefined();
    expect(loaded.views2d.crossSection).toBeUndefined();
    expect(loaded.views2d.rocker).toEqual(sample.views2d.rocker);
  });

  it('drops a malformed 3D camera', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.camera3d = { position: [0, 1], target: 'origin' };
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().camera3d).toBeUndefined();
  });

  it('treats a blob from another schema version as absent', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.version = VIEW_STATE_VERSION + 1;
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it('does not throw when localStorage writes fail (quota exceeded)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => saveViewState(sample)).not.toThrow();
    spy.mockRestore();
  });
});

describe('view3d persistence', () => {
  it('round-trips the 3D settings', () => {
    const s: ViewState = {
      ...DEFAULT_VIEW_STATE,
      view3d: {
        ...DEFAULT_VIEW_3D,
        showStringer: true,
        showSections: true,
        showApex: true,
        meshQuality: 'fine',
      },
    };
    saveViewState(s);
    expect(loadViewState().view3d).toEqual(s.view3d);
  });

  it('restores a blob saved before the apex guide existed, apex off and the rest intact', () => {
    // Written by a build whose 3D settings had no showApex: still version 1, so the
    // saved panes and camera must survive the upgrade rather than reset to defaults.
    const old = { ...DEFAULT_VIEW_3D, showStringer: true } as Partial<typeof DEFAULT_VIEW_3D>;
    delete old.showApex;
    localStorage.setItem(
      'bs.viewState',
      JSON.stringify({ ...DEFAULT_VIEW_STATE, view: 'rocker', view3d: old }),
    );

    const v = loadViewState();
    expect(v.view).toBe('rocker');
    expect(v.view3d).toEqual({ ...DEFAULT_VIEW_3D, showStringer: true, showApex: false });
  });

  it('falls back per field, leaving valid siblings intact', () => {
    saveViewState({
      ...DEFAULT_VIEW_STATE,
      view3d: { ...DEFAULT_VIEW_3D, showSections: true },
    });
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.view3d.lighting = 'disco';
    raw.view3d.meshQuality = 42;
    raw.view3d.showStringer = 'yes';
    raw.view3d.showApex = 1;
    localStorage.setItem('bs.viewState', JSON.stringify(raw));

    const v = loadViewState().view3d!;
    expect(v.lighting).toBe(DEFAULT_VIEW_3D.lighting);
    expect(v.meshQuality).toBe(DEFAULT_VIEW_3D.meshQuality);
    expect(v.showStringer).toBe(DEFAULT_VIEW_3D.showStringer);
    expect(v.showApex).toBe(DEFAULT_VIEW_3D.showApex);
    expect(v.showSections).toBe(true); // the one good field survives
  });

  it('rejects a colour that is not a hex triplet', () => {
    saveViewState({ ...DEFAULT_VIEW_STATE, view3d: DEFAULT_VIEW_3D });
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.view3d.color = 'javascript:alert(1)';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().view3d!.color).toBe(DEFAULT_VIEW_3D.color);
  });

  it('omits view3d entirely when the stored blob has none', () => {
    saveViewState(DEFAULT_VIEW_STATE);
    expect(loadViewState().view3d).toBeUndefined();
  });

  it('still restores an older blob written before view3d existed', () => {
    // The no-bump guarantee: adding an optional field must not orphan saved
    // camera poses and pane framing.
    localStorage.setItem(
      'bs.viewState',
      JSON.stringify({
        version: 1,
        view: 'outline',
        views2d: { outline: { cx: 1, cy: 2, scale: 3 } },
        camera3d: { position: [1, 2, 3], target: [0, 0, 0] },
      }),
    );
    const v = loadViewState();
    expect(v.view).toBe('outline');
    expect(v.views2d.outline).toEqual({ cx: 1, cy: 2, scale: 3 });
    expect(v.camera3d).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    expect(v.view3d).toBeUndefined();
    // Same guarantee, now claimed for the sidebar: a blob written before the
    // accordion existed keeps its panes and picks up the default sidebar.
    expect(v.sidebar).toEqual(DEFAULT_SIDEBAR_STATE);
  });
});

describe('sidebar persistence', () => {
  it('round-trips the rail, the open set and the touched set', () => {
    saveViewState(sample);
    expect(loadViewState().sidebar).toEqual(sample.sidebar);
  });

  it('drops section ids it does not recognise, keeping the rest', () => {
    // A section removed in a later release must not be able to resurrect itself
    // out of an old blob and reach the renderer.
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.sidebar.open = ['specs', 'construction', 'fins'];
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().sidebar!.open).toEqual(['specs', 'fins']);
  });

  it('re-imposes registry order on a hand-edited blob', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.sidebar.open = ['trace', 'specs', 'resize'];
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().sidebar!.open).toEqual(['specs', 'resize', 'trace']);
  });

  it('falls back per field rather than rejecting the whole sidebar', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.sidebar.collapsed = 'yes';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    const s = loadViewState().sidebar!;
    expect(s.collapsed).toBe(DEFAULT_SIDEBAR_STATE.collapsed);
    expect(s.open).toEqual(['specs', 'trace']); // the good fields survive
  });

  it('falls back to defaults when the stored sidebar is not an object', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.sidebar = 'collapsed';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().sidebar).toEqual(DEFAULT_SIDEBAR_STATE);
  });

  it('round-trips the active and pinned tabs', () => {
    saveViewState(sample);
    const s = loadViewState().sidebar!;
    expect(s.activeTab).toBe('build');
    expect(s.pinnedTab).toBe('specs');
  });

  it('falls back to Specs when the stored tab no longer exists', () => {
    // A removed tab must not stay selectable: it would render an empty panel beside a
    // strip with nothing lit.
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.sidebar.activeTab = 'construction';
    raw.sidebar.pinnedTab = 'construction';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    const s = loadViewState().sidebar!;
    expect(s.activeTab).toBe(DEFAULT_SIDEBAR_STATE.activeTab);
    expect(s.pinnedTab).toBeNull();
    expect(s.open).toEqual(['specs', 'trace']); // the good fields still survive
  });

  it('round-trips the spec bands and drops ids it does not know', () => {
    saveViewState(sample);
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.sidebar.specGroups = ['overall', 'rail', 'nose'];
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    // Filtered, and back in registry order rather than the order they were written.
    expect(loadViewState().sidebar!.specGroups).toEqual(['nose', 'overall']);
  });

  it('keeps an empty open set, which is what collapse-all writes', () => {
    // `[]` must survive as itself — falling back to the defaults here would
    // silently re-open three sections on every reload after a collapse-all.
    saveViewState({
      ...DEFAULT_VIEW_STATE,
      sidebar: { ...DEFAULT_SIDEBAR_STATE, open: [], touched: [] },
    });
    expect(loadViewState().sidebar!.open).toEqual([]);
  });
});

describe('split persistence', () => {
  it('round-trips a split pairing', () => {
    const s: ViewState = {
      ...DEFAULT_VIEW_STATE,
      view: 'split',
      split: { top: 'crossSection', bottom: '3d' },
    };
    saveViewState(s);
    const loaded = loadViewState();
    expect(loaded.view).toBe('split');
    expect(loaded.split).toEqual(s.split);
  });

  it('omits split entirely when the stored blob has none', () => {
    saveViewState(DEFAULT_VIEW_STATE);
    expect(loadViewState().split).toBeUndefined();
  });

  it('drops a pairing naming a pane that does not exist', () => {
    saveViewState({ ...DEFAULT_VIEW_STATE, split: DEFAULT_SPLIT });
    const raw = JSON.parse(localStorage.getItem('bs.viewState')!);
    raw.split.bottom = 'hologram';
    localStorage.setItem('bs.viewState', JSON.stringify(raw));
    expect(loadViewState().split).toBeUndefined();
  });

  it('drops a pairing with the same pane in both halves', () => {
    // The app can't produce one — picking the other half's pane swaps them — so a
    // doubled-up blob has been tampered with, and the layout keys its panes by kind.
    saveViewState({ ...DEFAULT_VIEW_STATE, split: { top: 'rocker', bottom: 'rocker' } });
    expect(loadViewState().split).toBeUndefined();
  });

  it('still restores an older blob written before split existed', () => {
    localStorage.setItem(
      'bs.viewState',
      JSON.stringify({ version: 1, view: 'rocker', views2d: {} }),
    );
    const v = loadViewState();
    expect(v.view).toBe('rocker');
    expect(v.split).toBeUndefined();
  });
});
