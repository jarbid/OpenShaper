/**
 * Settings for the STEP export dialog: output unit and how closely the fitted
 * surfaces track the design. Persisted as a versioned JSON blob in localStorage
 * under 'bs.step'. Modeled on pdf-export-settings.ts.
 */
import type { SheetUnit } from '@openshaper/export';

const STORAGE_KEY = 'bs.step';

/** Bump when the shape of StepSettings changes in a breaking way. */
export const STEP_VERSION = 1;

/** `'auto'` follows the editor's unit selector; anything else pins the file's unit. */
export type StepUnitChoice = 'auto' | SheetUnit;

export type StepAccuracy = 'draft' | 'standard' | 'fine';

/**
 * How close the fitted surface is held to the lofted hull, in centimetres.
 *
 * These are targets for the fit's refinement loop, not guarantees — what it
 * actually achieves is reported back and shown in the dialog. The scale to judge
 * them against is physical: a CNC blank cutter finishes at 0.1–0.5 mm, hand
 * sanding removes at least 1 mm, and blank stock varies by ±1 mm. So even 'draft'
 * is at the edge of what a machine can resolve, and 'fine' is well past the point
 * of mattering to a board — it exists for people taking the surface into CAD to
 * build something else from.
 */
export const STEP_TOLERANCE_CM: Record<StepAccuracy, number> = {
  draft: 0.02,
  standard: 0.005,
  fine: 0.002,
};

export interface StepSettings {
  version: number;
  unit: StepUnitChoice;
  accuracy: StepAccuracy;
}

export const DEFAULT_STEP: StepSettings = {
  version: STEP_VERSION,
  // Millimetres is the STEP convention, and the file declares its unit explicitly,
  // so an importer lands the board at the right size whatever this says. 'auto'
  // follows the editor instead, which is friendlier for anyone reading the numbers.
  unit: 'auto',
  accuracy: 'standard',
};

export function migrateStep(blob: StepSettings): StepSettings {
  return { ...DEFAULT_STEP, ...blob, version: STEP_VERSION };
}

export function loadStep(): StepSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STEP;
    return migrateStep(JSON.parse(raw) as StepSettings);
  } catch {
    return DEFAULT_STEP;
  }
}

export function saveStep(s: StepSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
