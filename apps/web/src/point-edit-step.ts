import { cmToUnitNumber, lengthEditStep, type LengthUnit } from './format';

/** About two CSS pixels per nudge, rounded to a readable 1/2/5 unit increment. */
export function pointEditStep(units: LengthUnit, pixelsPerCm?: number): number {
  if (!pixelsPerCm || !Number.isFinite(pixelsPerCm) || pixelsPerCm <= 0) {
    return lengthEditStep(units) / 2;
  }
  const desired = cmToUnitNumber(2 / pixelsPerCm, units);
  if (!Number.isFinite(desired) || desired <= 0) return lengthEditStep(units) / 2;
  const power = 10 ** Math.floor(Math.log10(desired));
  const fraction = desired / power;
  const rounded =
    fraction < Math.sqrt(2) ? 1 : fraction < Math.sqrt(10) ? 2 : fraction < Math.sqrt(50) ? 5 : 10;
  return Number((rounded * power).toPrecision(12));
}
