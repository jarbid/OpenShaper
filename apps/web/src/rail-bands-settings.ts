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
export const RAIL_BANDS_VERSION = 3;

export interface RailBandsSettings {
  version: number;
  /** Deck-side band count. */
  bands: number;
  /** How the angles are chosen — see `rail-facet-fit.ts` for what each one leaves. */
  angleMode: RailAngleMode;
  /** Manual mode: the shaper's own numbers, as angles or as marks. */
  manualBy: 'angle' | 'distance';
  manualAngles: number[];
  /**
   * Band 1's rail mark, as a percentage of the blank's thickness up from the bottom
   * corner. A percentage rather than a length because it then holds as the board thins —
   * the "board thickness multiplier" a shaper applies by eye at the nose and tail.
   *
   * Not the rail's *name*: "60/40" counts from the deck and describes where the finished
   * apex lands along the rail curve, which sits below this mark.
   */
  railPercent: number;
  /** Optional tip values; null means "hold the centre percentage all the way". */
  railPercentTail: number | null;
  railPercentNose: number | null;
  /**
   * Extra scale on the deck and tuck marks toward each tip, as a percentage. 100 = let
   * thickness alone do it. Thickness scaling suits the rail mark and only approximates
   * the rest, because the rail's character changes toward the tips and not just its size.
   */
  markScaleTailPct: number | null;
  markScaleNosePct: number | null;
  /** Deck marks at the widepoint (cm), in from the top corner. */
  deckInCm: number[];
  /** Tuck marks at the widepoint (cm). */
  tuckUpCm: number;
  tuckInCm: number;
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
  angleMode: 'least-foam',
  manualBy: 'distance',
  manualAngles: [45, 22.5, 11.25],
  // Measured across the three golden boards, the fitted mode's own band-1 rail mark lands
  // at 45-56% of thickness; Greenlight's worked example is 65%. 60 sits in that range.
  railPercent: 60,
  railPercentTail: null,
  railPercentNose: null,
  markScaleTailPct: null,
  markScaleNosePct: null,
  deckInCm: [2.5, 5.5, 9],
  // A modern tucked-under edge. Greenlight's egg-rail chart says 1/2 in up by 7/8 in in,
  // which is right for an egg and cuts 5-6 mm *into* the rail of a performance shortboard
  // — measured on the golden boards, whose own 30 degree tuck touches under 2 mm up. The
  // safe direction to err is small: leftover foam is a blending job, an overcut is a
  // ruined rail. "Use the fitted marks" in the dialog beats either guess.
  tuckUpCm: 0.2,
  tuckInCm: 0.35,
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
  // v3 dropped the `balanced` placement, which duplicated `least-foam` everywhere but its
  // first band; the sanitiser below maps a stored one onto the default.
  //
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
