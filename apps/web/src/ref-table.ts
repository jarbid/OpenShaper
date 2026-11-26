/**
 * The reference-point table's arithmetic, kept apart from the panel so it can be tested
 * without rendering anything.
 *
 * Positions are stored as model x (cm from the tail, straight). The table shows them the
 * way a shaper measured them: from the tail or the nose, and straight or over the curve
 * (the app's existing measurement setting, `Longitudinal`).
 */
import type { Longitudinal } from './longitudinal';
import { parseTypedLen, type LengthUnit } from './format';

export type StationOrigin = 'tail' | 'nose';

/** Model x → the distance shown in the table. `length` is the board's model length (cm). */
export const stationToDisplay = (
  x: number,
  origin: StationOrigin,
  longitudinal: Longitudinal,
  length: number,
): number =>
  origin === 'tail'
    ? longitudinal.toDisplay(x)
    : longitudinal.toDisplay(length) - longitudinal.toDisplay(x);

/** A typed table distance → model x; the inverse of {@link stationToDisplay}. */
export const stationToModel = (
  distance: number,
  origin: StationOrigin,
  longitudinal: Longitudinal,
  length: number,
): number =>
  longitudinal.toModel(origin === 'tail' ? distance : longitudinal.toDisplay(length) - distance);

/**
 * Stations every `interval` (cm, in the table's own distance) from the chosen end,
 * starting one interval in and stopping before the far end: a station at the very tip
 * measures nothing. Returned as model x, in table order. Empty for a non-positive
 * interval; capped so a tiny interval cannot flood the table.
 */
export const generateStations = (
  interval: number,
  origin: StationOrigin,
  longitudinal: Longitudinal,
  length: number,
  max = 200,
): number[] => {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const total = longitudinal.toDisplay(length);
  const out: number[] = [];
  for (let d = interval; d < total - 1e-9 && out.length < max; d += interval) {
    out.push(stationToModel(d, origin, longitudinal, length));
  }
  return out;
};

/** A round default spacing in the display unit: 6 in, or 10 cm. */
export const defaultInterval = (units: LengthUnit): number =>
  units.key === 'in' || units.key === 'ftin' ? 6 * 2.54 : 10;

/**
 * Rows pasted from a spreadsheet or typed list: two lengths per line. A line is split on
 * the first separator it uses, in this order: tab (a spreadsheet copy), semicolon (a
 * European CSV, whose decimals are commas), comma, then spaces. Lengths are in the
 * display unit and may be fractions ("21 1/2") or carry a unit ("54cm"); a comma inside
 * a tab- or semicolon-separated cell is a decimal comma, as everywhere else in the app.
 * Blank lines are skipped; any other line that is not two lengths is reported by its
 * 1-based number rather than guessed at.
 */
export const parsePastedRows = (
  text: string,
  units: LengthUnit,
): { rows: [number, number][]; bad: number[] } => {
  const rows: [number, number][] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const separator = ['\t', ';', ','].find((c) => trimmed.includes(c));
    const cells = separator ? trimmed.split(separator).map((c) => c.trim()) : trimmed.split(/\s+/);
    const values = cells.filter((c) => c !== '').map((c) => parseTypedLen(c, units));
    if (values.length === 2 && values.every((v) => v !== null && Number.isFinite(v))) {
      rows.push([values[0]!, values[1]!]);
    } else {
      bad.push(i + 1);
    }
  });
  return { rows, bad };
};
