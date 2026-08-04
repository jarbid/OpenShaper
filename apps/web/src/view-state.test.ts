/**
 * View-state persistence — active view/tab, per-pane 2D framing (world center +
 * scale), and the 3D camera pose, as one versioned localStorage blob under
 * 'bs.viewState'. NOTE: localStorage is reset between tests via beforeEach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VIEW_STATE,
  loadViewState,
  saveViewState,
  VIEW_STATE_VERSION,
  type ViewState,
} from './view-state';
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
      view3d: { ...DEFAULT_VIEW_3D, showStringer: true, showSections: true, meshQuality: 'fine' },
    };
    saveViewState(s);
    expect(loadViewState().view3d).toEqual(s.view3d);
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
    localStorage.setItem('bs.viewState', JSON.stringify(raw));

    const v = loadViewState().view3d!;
    expect(v.lighting).toBe(DEFAULT_VIEW_3D.lighting);
    expect(v.meshQuality).toBe(DEFAULT_VIEW_3D.meshQuality);
    expect(v.showStringer).toBe(DEFAULT_VIEW_3D.showStringer);
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
  });
});
