// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Deck panel's words and numbers, with no React: the shapes it offers and what each is, the crown
 * dial's steps and what a position on it means, how a crown is written and typed in the display unit,
 * and the plain reasons the dial is off.
 */
import type { DeckCrownRange, DeckShapeId, DeckShapeName } from '@openshaper/store/rails';
import {
  cmToUnitNumber,
  fineLengthStep,
  fmtLen,
  parseTypedLen,
  unitDecimals,
  type LengthUnit,
} from '../format';

/** The shapes the select offers, in order. A Custom deck is shown by name and is not a choice. */
export const SHAPE_CHOICES: readonly { readonly id: DeckShapeId; readonly label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'domed', label: 'Domed' },
];

/** A shape's name as the panel writes it. */
export const shapeLabel = (shape: DeckShapeName): string =>
  shape === 'custom' ? 'Custom' : (SHAPE_CHOICES.find((c) => c.id === shape)?.label ?? 'Custom');

/** What each shape is, in a sentence of a shaper's words. */
export const SHAPE_NOTES: Readonly<Record<DeckShapeName, string>> = {
  flat: 'Level from the stringer to the rail. The deck is as high at the rail as at the stringer, so the rail is as thick as the board there.',
  domed:
    'A dome: level at the stringer and falling towards the rail. The crown is how far it has fallen where the rail starts to roll over it.',
  custom:
    'A curve drawn point by point, or changed since a shape was chosen. Choose a shape to replace it; undo brings it back.',
};

/** Positions on the crown slider, from the least crown to the most the station can hold. */
export const CROWN_STEPS = 200;

/** A crown held to a range. */
const held = (crown: number, range: DeckCrownRange): number =>
  Math.min(range.max, Math.max(range.min, crown));

/** The slider position (0 to {@link CROWN_STEPS}) of a crown, held to the range. A range of no width is the least end. */
export function crownPosition(crown: number, range: DeckCrownRange): number {
  const span = range.max - range.min;
  if (!(span > 0)) return 0;
  return Math.round(((held(crown, range) - range.min) / span) * CROWN_STEPS);
}

/** The crown (cm) at a slider position. */
export function crownFromPosition(position: number, range: DeckCrownRange): number {
  const span = range.max - range.min;
  return range.min + (Math.min(CROWN_STEPS, Math.max(0, position)) / CROWN_STEPS) * span;
}

/** An arrow key's step, cm: the display unit's fine step (a millimetre in cm, half a millimetre in mm, a sixteenth of an inch), ten times that with Shift. */
export const crownStep = (units: LengthUnit, big: boolean): number =>
  (fineLengthStep(units) * (big ? 10 : 1)) / cmToUnitNumber(1, units);

/** A crown as the field shows it: the number in the display unit, at the unit's decimals. */
export const crownNumber = (crown: number, units: LengthUnit): string =>
  cmToUnitNumber(crown, units).toFixed(unitDecimals(units));

/** Typed text as a crown (cm), or null when it is not a number. */
export const parseCrown = (text: string, units: LengthUnit): number | null =>
  parseTypedLen(text, units);

/**
 * Why the crown dial is off, in a sentence, or null when it is on. A Flat deck has no crown; a Custom
 * one is the shaper's own curve, which a crown would replace; and a station can be too thin to hold one.
 */
export function crownOffReason(shape: DeckShapeName, canHold: boolean): string | null {
  if (shape === 'flat') return 'A flat deck has no crown. Choose Domed to give it one.';
  if (shape === 'custom') {
    return 'This curve is drawn by hand, and a crown would replace it. Choose Domed first.';
  }
  return canHold ? null : 'This station is too thin to hold a crown.';
}

/** How far (cm) a crown may be past the most a station holds before it counts as held: the rounding of that most. */
const HELD_SLACK = 1e-9;

/** What to say when a crown asked for was held at the most the station can hold, or null when it was not. */
export function heldNote(
  asked: number,
  range: DeckCrownRange | null,
  units: LengthUnit,
): string | null {
  if (range === null || !(asked > range.max + HELD_SLACK)) return null;
  return `Held at the most this station can hold, ${fmtLen(range.max, units)}.`;
}
