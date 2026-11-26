// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Tail panel's words and numbers, with no React: the shapes it offers, what each is and how it is drawn as a
 * thumbnail, the dials' steps and what a position on one means, how a length is written and typed in the display
 * unit, and the plain reasons a dial is off.
 */
import { isNotchedShape, type TailShapeId, type TailShapeName } from '@openshaper/store/rails';
import {
  cmToUnitNumber,
  fineLengthStep,
  fmtLen,
  parseTypedLen,
  unitDecimals,
  type LengthUnit,
} from '../format';

/** The shapes the picker offers, in order. A Custom tail is shown by name and is not a choice. */
export const SHAPE_CHOICES: readonly { readonly id: TailShapeId; readonly label: string }[] = [
  { id: 'squash', label: 'Squash' },
  { id: 'round', label: 'Round' },
  { id: 'pin', label: 'Pin' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'swallow', label: 'Swallow' },
  { id: 'fish', label: 'Fish' },
];

/** A shape's name as the panel writes it. */
export const shapeLabel = (shape: TailShapeName): string =>
  shape === 'custom' ? 'Custom' : (SHAPE_CHOICES.find((c) => c.id === shape)?.label ?? 'Custom');

/** A name with its first letter capital: how a corner's name starts a line. */
export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What each shape is, in a sentence of a shaper's words. */
export const SHAPE_NOTES: Readonly<Record<TailShapeName, string>> = {
  squash:
    'A flat tail end, square to the stringer, with a corner each side. The width is from corner to corner.',
  round:
    'No corners: the outline sweeps round the tail in one curve. The width is read where the tail ends and the rail begins.',
  pin: 'The two sides come in to a point at the tail. The width is read where the tail ends and the rail begins.',
  diamond:
    'Straight sides run in to a point, with a corner each side where the rail takes over. The width is from corner to corner.',
  swallow:
    'A notch cut into the tail with a straight wall, leaving two tips. The width is from tip to tip.',
  fish: 'A shallow notch with a rounded wall between wide tips. The width is from tip to tip.',
  custom:
    'The tail’s points were drawn, or moved since a shape was chosen. Choose a shape to replace them; undo brings them back.',
};

/**
 * A thumbnail of each shape's plan: the tail at the left, the whole width of the board's tail end, drawn in a
 * 40 by 28 box as one open path (the two sides and the tail end). Hand drawn: a picture of the name, not of any board.
 */
export const THUMBNAILS: Readonly<Record<TailShapeId, string>> = {
  squash: 'M38 4 C26 5 12 7 7 9 L7 19 C12 21 26 23 38 24',
  round: 'M38 4 C22 5 5 8 5 14 C5 20 22 23 38 24',
  pin: 'M38 4 C26 6 12 11 4 14 C12 17 26 22 38 24',
  diamond: 'M38 5 C28 6 17 8 13 8.5 L4 14 L13 19.5 C17 20 28 22 38 23',
  swallow: 'M38 4 C26 5 12 6 5 7 L14 14 L5 21 C12 22 26 23 38 24',
  fish: 'M38 4 C26 5 10 6 5 7 C9 10 12 12 11 14 C12 16 9 18 5 21 C10 22 26 23 38 24',
};

/** Positions on a slider, from the least a dial holds to the most. */
export const DIAL_STEPS = 200;

/** A range a dial holds a number to. */
export interface DialRange {
  readonly min: number;
  readonly max: number;
}

const held = (value: number, range: DialRange): number =>
  Math.min(range.max, Math.max(range.min, value));

/** The slider position (0 to {@link DIAL_STEPS}) of a value, held to the range. A range of no width is the least end. */
export function dialPosition(value: number, range: DialRange): number {
  const span = range.max - range.min;
  if (!(span > 0)) return 0;
  return Math.round(((held(value, range) - range.min) / span) * DIAL_STEPS);
}

/** The value (cm) at a slider position. */
export function dialFromPosition(position: number, range: DialRange): number {
  const span = range.max - range.min;
  return range.min + (Math.min(DIAL_STEPS, Math.max(0, position)) / DIAL_STEPS) * span;
}

/** An arrow key's step, cm: the display unit's fine step (a millimetre in cm, half a millimetre in mm, a sixteenth of an inch), ten times that with Shift. */
export const lengthStep = (units: LengthUnit, big: boolean): number =>
  (fineLengthStep(units) * (big ? 10 : 1)) / cmToUnitNumber(1, units);

/** A length as a field shows it: the number in the display unit, at the unit's decimals. */
export const lengthNumber = (cm: number, units: LengthUnit): string =>
  cmToUnitNumber(cm, units).toFixed(unitDecimals(units));

/** Typed text as a length (cm), or null when it is not a number. */
export const parseLength = (text: string, units: LengthUnit): number | null =>
  parseTypedLen(text, units);

/** Why the width dial is off, or null when it is on. */
export function widthOffReason(shape: TailShapeName): string | null {
  return shape === 'custom'
    ? 'This tail is drawn by hand, and a width would replace it. Choose a shape first.'
    : null;
}

/** Why the notch depth dial is off, or null when it is on. */
export function notchOffReason(shape: TailShapeName): string | null {
  if (shape === 'custom') {
    return 'This tail is drawn by hand, and a notch would replace it. Choose Swallow or Fish first.';
  }
  return isNotchedShape(shape)
    ? null
    : `A ${shapeLabel(shape).toLowerCase()} tail has no notch. Choose Swallow or Fish to cut one.`;
}

/** How far (cm) a number may be past the most a tail holds before it counts as held: the rounding of that most. */
const HELD_SLACK = 1e-9;

/**
 * What to say when a number asked for was held at the edge of its range, or null when it was not: `what` names the
 * dial ("Width", "Notch depth", "Radius").
 */
export function heldNote(
  what: string,
  asked: number,
  range: DialRange | null,
  units: LengthUnit,
): string | null {
  if (range === null) return null;
  if (asked > range.max + HELD_SLACK) {
    return `${what} held at the most this tail can have, ${fmtLen(range.max, units)}.`;
  }
  if (asked < range.min - HELD_SLACK) {
    return `${what} held at the least this tail can have, ${fmtLen(range.min, units)}.`;
  }
  return null;
}
