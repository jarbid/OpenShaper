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
import {
  DEFAULT_SIDEBAR_STATE,
  isSectionId,
  isSpecGroupId,
  isTabId,
  sectionIds,
  specGroupIds,
  type SidebarState,
} from './sidebar-sections';
import { SPLIT_PANE_KINDS, type EditorKind, type SplitPaneKind, type View } from './view-toolkit';
import {
  ANALYSIS_3D,
  DEFAULT_VIEW_3D,
  DEVIATION_BAND,
  LIGHTING_3D,
  MATERIAL_3D,
  MODE_3D,
  QUALITY_3D,
  type View3DSettings,
} from './view3d-settings';

const STORAGE_KEY = 'bs.viewState';

/**
 * Bump when the ViewState shape changes in a breaking way.
 *
 * `sidebar` did not warrant one: it is optional and additive, so an older blob
 * restores its panes and camera exactly as before and simply picks up the default
 * sidebar. Bumping would have thrown away every saved framing and camera pose on
 * upgrade to buy nothing.
 */
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

/** Which pane each half of the split layout is showing. */
export interface SplitPanes {
  top: SplitPaneKind;
  bottom: SplitPaneKind;
}

export interface ViewState {
  version: number;
  /** Active view/tab (quad, split, one of the editors, or 3d). */
  view: View;
  /** Per-pane 2D framing; a missing entry means "auto-fit as usual". */
  views2d: Partial<Record<EditorKind, View2D>>;
  camera3d?: Camera3D;
  /** 3D appearance + analysis settings; absent on blobs written before they were saved. */
  view3d?: View3DSettings;
  /**
   * The split layout's two pane choices. Remembered whether or not split is the
   * active view, so returning to it restores the pairing that was set up rather
   * than the default one.
   */
  split?: SplitPanes;
  /**
   * Sidebar shape: the active and pinned tabs, whether the panel is folded away, and
   * which sections and spec bands are expanded (see `sidebar-sections.ts`). Absent on
   * blobs written before the sidebar grew tabs.
   */
  sidebar?: SidebarState;
}

/**
 * Outline over rocker: the pairing a shaper reads together — the plan shape and
 * the profile of the same board, sharing a length axis down the middle of the
 * window.
 */
export const DEFAULT_SPLIT: SplitPanes = { top: 'outline', bottom: 'rocker' };

export const DEFAULT_VIEW_STATE: ViewState = {
  version: VIEW_STATE_VERSION,
  view: 'quad',
  views2d: {},
  sidebar: DEFAULT_SIDEBAR_STATE,
};

const VIEWS: readonly View[] = ['quad', 'split', 'outline', 'rocker', 'crossSection', '3d'];
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

/**
 * A split pairing is kept only when both halves name a real pane and name
 * different ones — the app never produces a doubled-up split (picking the other
 * half's pane swaps them), and the two halves being distinct is what lets the
 * layout key its panes by pane kind. A blob failing either test falls back
 * whole rather than being patched a half at a time, so what comes back is a
 * pairing someone actually chose.
 */
const sanitizeSplit = (v: unknown): SplitPanes | undefined => {
  const o = v as Partial<SplitPanes> | null;
  const ok = (k: unknown): k is SplitPaneKind => SPLIT_PANE_KINDS.includes(k as SplitPaneKind);
  return o && ok(o.top) && ok(o.bottom) && o.top !== o.bottom
    ? { top: o.top, bottom: o.bottom }
    : undefined;
};

const sanitizeCamera = (v: unknown): Camera3D | undefined => {
  const o = v as Partial<Camera3D> | null;
  return o && isVec3(o.position) && isVec3(o.target)
    ? { position: o.position, target: o.target }
    : undefined;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly { value: T }[], fallback: T): T =>
  allowed.some((o) => o.value === v) ? (v as T) : fallback;

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/**
 * Per-field sanitising: an unrecognised value falls back to that field's default
 * and leaves its siblings alone, matching the policy the 2D and camera
 * sanitisers follow. A colour must be a hex triplet — it reaches a DOM attribute.
 */
const sanitizeView3D = (v: unknown): View3DSettings | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const d = DEFAULT_VIEW_3D;
  return {
    mode: oneOf(o.mode, MODE_3D, d.mode),
    lighting: oneOf(o.lighting, LIGHTING_3D, d.lighting),
    material: oneOf(o.material, MATERIAL_3D, d.material),
    color: typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : d.color,
    analysis: oneOf(o.analysis, ANALYSIS_3D, d.analysis),
    meshQuality: oneOf(o.meshQuality, QUALITY_3D, d.meshQuality),
    showStringer: bool(o.showStringer, d.showStringer),
    showSections: bool(o.showSections, d.showSections),
    // Absent from blobs saved before the apex guide existed: it falls back like any
    // invalid field, so adding it needed no VIEW_STATE_VERSION bump.
    showApex: bool(o.showApex, d.showApex),
    // Likewise the deviation band; out of range is as good as absent.
    deviationBand:
      typeof o.deviationBand === 'number' &&
      o.deviationBand >= DEVIATION_BAND.min &&
      o.deviationBand <= DEVIATION_BAND.max
        ? o.deviationBand
        : d.deviationBand,
  };
};

/**
 * Sidebar shape, with unknown section ids dropped rather than trusted.
 *
 * Ids are the join between this blob and `SIDEBAR_SECTIONS`; a section removed in a
 * later release must not be able to resurrect itself from an old blob, and an id that
 * was never ours must not reach the renderer. Filtering also re-imposes registry order,
 * so a hand-edited blob cannot reorder the sidebar.
 */
const sanitizeSidebar = (v: unknown): SidebarState | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const ids = (raw: unknown) => {
    if (!Array.isArray(raw)) return undefined;
    const kept = new Set(raw.filter(isSectionId));
    return sectionIds().filter((id) => kept.has(id));
  };
  const open = ids(o.open);
  const touched = ids(o.touched);
  // A blob with neither list is not a sidebar, whatever else it holds.
  if (!open && !touched) return undefined;
  const bands = Array.isArray(o.specGroups)
    ? (() => {
        const kept = new Set(o.specGroups.filter(isSpecGroupId));
        return specGroupIds().filter((id) => kept.has(id));
      })()
    : undefined;
  return {
    collapsed: bool(o.collapsed, DEFAULT_SIDEBAR_STATE.collapsed),
    // A tab that no longer exists must not be selectable: it would render an empty
    // panel beside a strip with nothing lit.
    activeTab: isTabId(o.activeTab) ? o.activeTab : DEFAULT_SIDEBAR_STATE.activeTab,
    pinnedTab: isTabId(o.pinnedTab) ? o.pinnedTab : null,
    open: open ?? DEFAULT_SIDEBAR_STATE.open,
    touched: touched ?? DEFAULT_SIDEBAR_STATE.touched,
    specGroups: bands ?? DEFAULT_SIDEBAR_STATE.specGroups,
  };
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
    const view3d = sanitizeView3D(parsed.view3d);
    const split = sanitizeSplit(parsed.split);
    return {
      version: VIEW_STATE_VERSION,
      view: VIEWS.includes(parsed.view as View) ? (parsed.view as View) : DEFAULT_VIEW_STATE.view,
      views2d,
      ...(camera3d ? { camera3d } : {}),
      ...(view3d ? { view3d } : {}),
      ...(split ? { split } : {}),
      sidebar: sanitizeSidebar(parsed.sidebar) ?? DEFAULT_SIDEBAR_STATE,
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
