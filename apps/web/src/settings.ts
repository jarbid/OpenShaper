/**
 * Editor visual settings: curve colors, ghost color, grid color, 3D fin
 * color, control-point size, and curve stroke thickness. Persisted as a single
 * versioned JSON blob in localStorage under 'bs.settings'.
 */

const STORAGE_KEY = 'bs.settings';

/** Bump this when the shape of EditorSettings changes in a breaking way. */
export const SETTINGS_VERSION = 2;

export interface EditorSettings {
  /** Schema version — used to migrate old blobs. */
  version: number;
  /** Stroke color for the outline half-spline. */
  outlineColor: string;
  /** Stroke color for the deck spline (rocker view). */
  deckColor: string;
  /** Stroke color for the bottom spline (rocker view). */
  bottomColor: string;
  /** Stroke color for the active cross-section spline. */
  crossSectionColor: string;
  /** Ghost / reference board overlay color. */
  ghostColor: string;
  /** Grid minor-line color (CSS hex). */
  gridColor: string;
  /** Fin blade color in the 3D view (CSS hex). */
  finColor: string;
  /** Control-point dot/square radius in px. */
  controlPointSize: number;
  /** Curve stroke width in px. */
  curveThickness: number;
  /**
   * When true (default), editing the rocker/deck/outline resizes the cross-sections to
   * match (thickness & width slaved to the board). When false, sections keep their own
   * profile and a curve edit leaves them alone (legacy `adjustCrossectionThickness`).
   */
  adjustCrossSectionThickness: boolean;
}

/**
 * Factory-default values that reflect today's hardcoded theme. Any field not
 * present in a saved blob is filled from here by loadSettings / migrateSettings.
 */
export const DEFAULT_SETTINGS: EditorSettings = {
  version: SETTINGS_VERSION,
  // Outline: single cyan curve (matches the PALETTE[0] default in SplineEditor).
  outlineColor: '#22D3EE',
  // Rocker: deck = cyan, bottom = pink (the two-color rocker hardcode in paneProps).
  deckColor: '#22D3EE',
  bottomColor: '#F472B6',
  // Cross-section: a single teal curve.
  crossSectionColor: '#2DD4BF',
  // Ghost overlay: semi-transparent silver (as in drawGhostSpline).
  ghostColor: '#B4B8C4',
  // Grid minor lines: matches the rgba(138,155,179,0.40) axis color in drawGrid.
  gridColor: '#8A9BB3',
  // Fin blades: the OpenShaper brand cyan (matches the FIN_COLOR default in Fins3D).
  finColor: '#22D3EE',
  controlPointSize: 5,
  curveThickness: 2,
  // Slave cross-sections to the rocker/deck/outline by default (today's behavior).
  adjustCrossSectionThickness: true,
};

/**
 * Bring any persisted blob up to the current version, filling in missing keys
 * from defaults. The original blob is never mutated.
 */
export function migrateSettings(blob: EditorSettings): EditorSettings {
  return { ...DEFAULT_SETTINGS, ...blob, version: SETTINGS_VERSION };
}

/**
 * Read EditorSettings from localStorage. Returns defaults when the key is
 * absent, the JSON is malformed, or any required field is missing.
 */
export function loadSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return migrateSettings(parsed as EditorSettings);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Persist the given EditorSettings blob to localStorage.
 */
export function saveSettings(s: EditorSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
