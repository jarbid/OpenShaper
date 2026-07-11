/**
 * Settings for the Hollow Wood Frame (HWS) template panel: the builder params plus
 * the panel's output/layout choices (paper tiling, material-sheet nesting). Persisted
 * as one versioned JSON blob in localStorage under 'bs.hwsParams'. Modeled on
 * settings.ts / pdf-export-settings.ts.
 */
import { DEFAULT_HWS_PARAMS, type HwsParams } from '@openshaper/export';

const STORAGE_KEY = 'bs.hwsParams';

/** Bump when the shape of HwsSettings changes in a breaking way. */
export const HWS_SETTINGS_VERSION = 1;

/** Panel output/layout choices that live outside the builder's HwsParams. */
export interface HwsOutputSettings {
  /** 'plot' = one oversized PDF page per part; else a PAPER_SIZES id to tile onto. */
  paperId: string;
  /** Shared overlap strip between PDF tiles (internal centimetres). */
  overlapCm: number;
  /** Pack parts onto material sheets in the DXF/SVG layout. */
  nest: boolean;
  /** Material sheet size (internal centimetres). */
  nestWidthCm: number;
  nestHeightCm: number;
  /** Allow 90° part rotation while packing. */
  nestAllowRotate: boolean;
}

export interface HwsSettings {
  version: number;
  params: HwsParams;
  output: HwsOutputSettings;
}

export const DEFAULT_HWS_OUTPUT: HwsOutputSettings = {
  paperId: 'plot',
  overlapCm: 1,
  nest: false,
  nestWidthCm: 244, // a standard 2440 × 1220 mm ply sheet
  nestHeightCm: 122,
  nestAllowRotate: true,
};

export const DEFAULT_HWS_SETTINGS: HwsSettings = {
  version: HWS_SETTINGS_VERSION,
  params: DEFAULT_HWS_PARAMS,
  output: DEFAULT_HWS_OUTPUT,
};

/**
 * Copy onto `defaults` only the blob keys that still exist there with a matching
 * type — silently dropping stale keys (e.g. the removed `kerfDiameter`) and
 * junk values, so old blobs never leak unknown fields into the params.
 */
const pickKnown = <T extends object>(defaults: T, blob: unknown): T => {
  const out = { ...defaults };
  if (blob && typeof blob === 'object') {
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      const v = (blob as Record<string, unknown>)[k as string];
      if (v !== undefined && typeof v === typeof defaults[k]) out[k] = v as T[keyof T];
    }
  }
  return out;
};

export function migrateHwsSettings(blob: unknown): HwsSettings {
  const b = (blob ?? {}) as Partial<HwsSettings>;
  return {
    version: HWS_SETTINGS_VERSION,
    params: pickKnown(DEFAULT_HWS_PARAMS, b.params),
    output: pickKnown(DEFAULT_HWS_OUTPUT, b.output),
  };
}

export function loadHwsSettings(): HwsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_HWS_SETTINGS;
    return migrateHwsSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_HWS_SETTINGS;
  }
}

export function saveHwsSettings(s: HwsSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
