import { readStored, writeStored } from './persisted';

/**
 * The tolerance reference points are judged against (cm): within it a point shows green,
 * beyond it red. A per-viewer preference, like the export settings, not board data.
 */
const STORAGE_KEY = 'bs.refTolerance';

/** 1 mm: about what a careful tape measurement of a blank is good to. */
export const DEFAULT_REF_TOLERANCE = 0.1;

export const migrateRefTolerance = (stored: unknown): number =>
  typeof stored === 'number' && Number.isFinite(stored) && stored > 0
    ? stored
    : DEFAULT_REF_TOLERANCE;

export const loadRefTolerance = (): number =>
  readStored(STORAGE_KEY, DEFAULT_REF_TOLERANCE, migrateRefTolerance);

export const saveRefTolerance = (cm: number): void => {
  writeStored(STORAGE_KEY, cm);
};
