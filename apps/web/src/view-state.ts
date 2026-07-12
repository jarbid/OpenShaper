/**
 * View-state persistence — reopen looking at exactly what you were looking at.
 *
 * Stores the active view/tab, each 2D pane's framing, and the 3D camera pose as
 * one versioned JSON blob in localStorage under 'bs.viewState' (small, unlike
 * the board itself — see session-store.ts). Modeled on settings.ts.
 *
 * 2D framing is stored in world terms (center in board cm + scale in px/cm),
 * not as the pixel-anchored Viewport, so restoring into a different window or
 * pane size re-centers correctly.
 */
import type { EditorKind, View } from './view-toolkit';

const STORAGE_KEY = 'bs.viewState';

/** Bump when the ViewState shape changes in a breaking way. */
export const VIEW_STATE_VERSION = 1;

/** A 2D pane's framing: world point under the canvas center + zoom (px/cm). */
export interface View2D {
  cx: number;
  cy: number;
  scale: number;
}

/** 3D orbit pose: camera position and look-at target, world cm. */
export interface Camera3D {
  position: [number, number, number];
  target: [number, number, number];
}

export interface ViewState {
  version: number;
  /** Active view/tab (quad, one of the editors, or 3d). */
  view: View;
  /** Per-pane 2D framing; a missing entry means "auto-fit as usual". */
  views2d: Partial<Record<EditorKind, View2D>>;
  camera3d?: Camera3D;
}

export const DEFAULT_VIEW_STATE: ViewState = {
  version: VIEW_STATE_VERSION,
  view: 'quad',
  views2d: {},
};

const VIEWS: readonly View[] = ['quad', 'outline', 'rocker', 'crossSection', '3d'];
const KINDS: readonly EditorKind[] = ['outline', 'rocker', 'crossSection'];

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const sanitizeView2D = (v: unknown): View2D | undefined => {
  const o = v as Partial<View2D> | null;
  return o && isFiniteNum(o.cx) && isFiniteNum(o.cy) && isFiniteNum(o.scale) && o.scale > 0
    ? { cx: o.cx, cy: o.cy, scale: o.scale }
    : undefined;
};

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(isFiniteNum);

const sanitizeCamera = (v: unknown): Camera3D | undefined => {
  const o = v as Partial<Camera3D> | null;
  return o && isVec3(o.position) && isVec3(o.target)
    ? { position: o.position, target: o.target }
    : undefined;
};

/**
 * Read the persisted view state. Returns defaults when the key is absent, the
 * JSON is malformed, or the schema version doesn't match; individually invalid
 * fields are dropped rather than rejecting the whole blob.
 */
export function loadViewState(): ViewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VIEW_STATE;
    const parsed = JSON.parse(raw) as Partial<ViewState> | null;
    if (!parsed || parsed.version !== VIEW_STATE_VERSION) return DEFAULT_VIEW_STATE;

    const views2d: ViewState['views2d'] = {};
    for (const kind of KINDS) {
      const v = sanitizeView2D((parsed.views2d as Record<string, unknown> | undefined)?.[kind]);
      if (v) views2d[kind] = v;
    }
    const camera3d = sanitizeCamera(parsed.camera3d);
    return {
      version: VIEW_STATE_VERSION,
      view: VIEWS.includes(parsed.view as View) ? (parsed.view as View) : DEFAULT_VIEW_STATE.view,
      views2d,
      ...(camera3d ? { camera3d } : {}),
    };
  } catch {
    return DEFAULT_VIEW_STATE;
  }
}

/** Persist the view state. Storage failures are swallowed. */
export function saveViewState(s: ViewState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, version: VIEW_STATE_VERSION }));
  } catch {
    // QuotaExceededError or private browsing — degrade silently.
  }
}
