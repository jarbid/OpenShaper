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
