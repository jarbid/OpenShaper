// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin designer's File settings (owner request): how lengths are shown, the profile
 * view's grid, and the exports' minimum thickness. Remembered
 * in this browser, like the export options were. The core export's laminate lives with
 * its dialog (CoreExportDialog.tsx), and the panel's thickness with the fin itself
 * (FinDesign.panel); both are edited from the same dialog.
 */
import { FIN_EXPORT_MIN_THICKNESS } from '@openshaper/kernel';
import { lengthUnitByKey, type LengthUnit } from '../format';
import { readStored, writeStored } from '../persisted';

export type FinUnit = 'mm' | 'in';

/** Inch fractions, by denominator: sixteenths down to halves. */
export const INCH_FRACTIONS = [16, 8, 4, 2] as const;
export type InchFraction = (typeof INCH_FRACTIONS)[number];

export interface FinSettings {
  readonly unit: FinUnit;
  /** Inches only: lengths are shown to the nearest 1/fraction". */
  readonly fraction: InchFraction;
  /** The profile view's grid spacing (cm), or null to fit the zoom. */
  readonly grid: number | null;
  /** The exports' minimum thickness (cm; see FIN_EXPORT_MIN_THICKNESS). */
  readonly exportMin: number;
}

export const DEFAULT_FIN_SETTINGS: FinSettings = {
  unit: 'mm',
  fraction: 16,
  grid: null,
  exportMin: FIN_EXPORT_MIN_THICKNESS.default,
};

const INCH = 2.54;

/** Grid spacings (cm) offered for each unit: 1, 5, 10 mm, or 1/8, 1/4, 1/2, 1 inch. */
export const GRID_OPTIONS: Record<FinUnit, readonly { cm: number; label: string }[]> = {
  mm: [
    { cm: 0.1, label: '1 mm' },
    { cm: 0.5, label: '5 mm' },
    { cm: 1, label: '10 mm' },
  ],
  in: [
    { cm: INCH / 8, label: '1/8"' },
    { cm: INCH / 4, label: '1/4"' },
    { cm: INCH / 2, label: '1/2"' },
    { cm: INCH, label: '1"' },
  ],
};

/** The display unit for the settings: mm, or inches to the chosen fraction. */
export const finLengthUnit = (s: FinSettings): LengthUnit =>
  s.unit === 'mm' ? lengthUnitByKey('mm') : { ...lengthUnitByKey('in'), fraction: s.fraction };

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** `s` with `change` applied, kept valid: a grid the new unit doesn't offer goes to Auto. */
export const withFinSettings = (s: FinSettings, change: Partial<FinSettings>): FinSettings => {
  const next = { ...s, ...change };
  const { min, max } = FIN_EXPORT_MIN_THICKNESS;
  const grid =
    next.grid !== null && GRID_OPTIONS[next.unit].some((o) => near(o.cm, next.grid!))
      ? next.grid
      : null;
  return { ...next, grid, exportMin: Math.min(max, Math.max(min, next.exportMin)) };
};

const KEY = 'bs.fin.settings';
/** Where the export minimum was kept before the settings panel. */
const OLD_EXPORT_MIN_KEY = 'bs.fin.exportMin';

/** What's stored, checked field by field: anything missing or invalid is the default. */
export const readFinSettings = (): FinSettings => {
  const { min, max } = FIN_EXPORT_MIN_THICKNESS;
  const okMin = (v: unknown): v is number =>
    typeof v === 'number' && v >= min - 1e-9 && v <= max + 1e-9;
  const oldMin = readStored(OLD_EXPORT_MIN_KEY, DEFAULT_FIN_SETTINGS.exportMin, (v) =>
    okMin(v) ? v : DEFAULT_FIN_SETTINGS.exportMin,
  );
  return readStored(KEY, { ...DEFAULT_FIN_SETTINGS, exportMin: oldMin }, (v) => {
    const s = (v ?? {}) as Partial<Record<keyof FinSettings, unknown>>;
    const unit: FinUnit = s.unit === 'in' ? 'in' : 'mm';
    const fraction = INCH_FRACTIONS.find((f) => f === s.fraction) ?? 16;
    const grid = typeof s.grid === 'number' ? s.grid : null;
    const exportMin = okMin(s.exportMin) ? s.exportMin : oldMin;
    return withFinSettings(DEFAULT_FIN_SETTINGS, { unit, fraction, grid, exportMin });
  });
};

export const writeFinSettings = (s: FinSettings): void => {
  writeStored(KEY, s);
};
