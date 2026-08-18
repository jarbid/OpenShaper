/**
 * Settings for the rail-bands export dialog: how many bands, at what angles, and how
 * often along the rail. Persisted as a versioned JSON blob in localStorage under
 * 'bs.railBands'. Modeled on step-export-settings.ts.
 *
 * Every length is stored in **centimetres**, like all internal geometry; the dialog
 * renders and parses them in the editor's own unit (see apps/web/CLAUDE.md). Band
 * counts and angles are dimensionless and stay unitless.
 */
import { RAIL_ANGLE_MODES, type RailAngleMode } from '@openshaper/kernel';

const STORAGE_KEY = 'bs.railBands';

/** Bump when the shape of RailBandsSettings changes in a breaking way. */
export const RAIL_BANDS_VERSION = 2;

export interface RailBandsSettings {
  version: number;
  /** Deck-side band count. */
  bands: number;
  /** How the angles are chosen — see `rail-facet-fit.ts` for what each one leaves. */
  angleMode: RailAngleMode;
  /** Tuck angle off the bottom plane, degrees — usually the plane's own setting. */
  bottomAngle: number;
  /**
   * Target spacing between stations, cm. Default 30.48 = 12 in. Fitted to the banded
   * length rather than walked, so stations land on both end margins.
   */
  stationSpacingCm: number;
  /** How much of each tip to leave alone, cm. */
  endMarginCm: number;
  /** Include the per-station 1:1 pages. */
  detailPages: boolean;
  /** Draw the finished rail behind the facets. */
  ghostSection: boolean;
  /** Print the 1:1 calibration ruler. */
  calibration: boolean;
  paperId: string;
}

export const DEFAULT_RAIL_BANDS: RailBandsSettings = {
  version: RAIL_BANDS_VERSION,
  // Three bands is what most shapers cut on the deck side.
  bands: 3,
  angleMode: 'balanced',
  // 30° is a common block-plane / power-planer setting for the tuck.
  bottomAngle: 30,
  stationSpacingCm: 30.48,
  endMarginCm: 20,
  detailPages: true,
  ghostSection: true,
  calibration: true,
  paperId: 'a4',
};

export function migrateRailBands(blob: RailBandsSettings): RailBandsSettings {
  // v2 added `angleMode`. A v1 blob gets the new default rather than `'ladder'`: the
  // halving ladder was never a choice anybody made, it was the only behaviour there was,
  // so carrying it forward would preserve a preference nobody expressed.
  //
  // v1 called the spacing `stationIntervalCm` and walked it out from the widepoint. That
  // number *did* mean what the user thought it meant — how far apart they want the
  // stations — so it carries across rather than being silently reset.
  const legacy = (blob as Partial<RailBandsSettings> & { stationIntervalCm?: number })
    .stationIntervalCm;
  const merged = { ...DEFAULT_RAIL_BANDS, ...blob, version: RAIL_BANDS_VERSION };
  // A placement that no longer exists falls back to the default rather than being passed
  // through to the kernel, where an unknown mode would quietly behave as some other one.
  if (!RAIL_ANGLE_MODES.includes(merged.angleMode)) {
    merged.angleMode = DEFAULT_RAIL_BANDS.angleMode;
  }
  if (blob?.stationSpacingCm === undefined && typeof legacy === 'number') {
    merged.stationSpacingCm = legacy;
  }
  delete (merged as { stationIntervalCm?: number }).stationIntervalCm;
  return merged;
}

export function loadRailBands(): RailBandsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RAIL_BANDS;
    return migrateRailBands(JSON.parse(raw) as RailBandsSettings);
  } catch {
    return DEFAULT_RAIL_BANDS;
  }
}

export function saveRailBands(s: RailBandsSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
