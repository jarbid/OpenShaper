// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The kinds of board the New board gallery offers: what each is, the size it is drawn at, and the least and
 * greatest length, width and thickness at which it is still that board.
 *
 * A kind is one of the starter templates (`templates.ts`), so its name is the template's. Its drawn size and
 * its plan outline are not typed here: they are read from the template by `tools/make-nurbs-templates.ts` and
 * committed in `board-type-shapes.ts`, which a test holds to the templates. This module is plain data and
 * arithmetic, with nothing of the engine or the store in it, so a page that quotes a range does not carry
 * them; `board-sizing.ts` makes the board at a size.
 *
 * ## The ranges
 *
 * The engine is not what limits a range. `board-types.measure.test.ts` scales each template to 0.5, 0.6, ...
 * 1.7 times its drawn length, width and thickness, each on its own and all three together (240 boards): every
 * one builds with no issue, its mesh is closed, and its volume is the drawn volume times the three factors to
 * within 0.1%. So a range says what the board is, and is the shaping norm for that kind of board in the
 * shaper's inches (below), kept inside what the engine was seen to build with a wide margin (about 0.8 to
 * 1.2 times the drawn size). `board-types.gate.test.ts` builds each kind at its least and its greatest
 * corner, and `board-types.test.ts` holds the drawn size inside every range.
 *
 * Thickness is the one the specs show and Resize scales: the deck's height over the bottom's at mid-length,
 * which is a little under the board's thickest place.
 */
import { INCH, INCHES_PR_FOOT } from '@openshaper/units';
import { BOARD_TYPE_SHAPES } from './board-type-shapes';

/** A length, a width and a thickness, all in cm: the numbers the specs show and the Resize section scales to. */
export interface BoardSize {
  readonly length: number;
  readonly width: number;
  readonly thickness: number;
}

/** One of the three, by the name its key has in a {@link BoardSize}. */
export type Dimension = keyof BoardSize;

/** The dimensions in the order the gallery asks for them. */
export const DIMENSIONS: readonly Dimension[] = ['length', 'width', 'thickness'];

/** The least and greatest a dimension may be, in cm. */
export interface Range {
  readonly least: number;
  readonly greatest: number;
}

/** What a kind of board allows of each dimension. */
export type BoardRanges = Readonly<Record<Dimension, Range>>;

/** A length in cm from feet and inches: the ranges are set in the shaper's units and held in cm, as every length is. */
const feet = (ft: number, inches = 0): number => (ft * INCHES_PR_FOOT + inches) * INCH;
const inches = (n: number): number => n * INCH;

/**
 * Shortboard: 5'0" to 7'2" long, from a small groveler to a step-up; 17" to 21" wide, a narrow performance
 * board to a wide one for small waves; 1 7/8" to 2 3/4" thick, a thin board for a light surfer to a full one.
 * At the corners of this box the board holds 16 to 42 litres.
 */
export const SHORTBOARD_RANGES: BoardRanges = {
  length: { least: feet(5, 0), greatest: feet(7, 2) },
  width: { least: inches(17), greatest: inches(21) },
  thickness: { least: inches(1.875), greatest: inches(2.75) },
};

/**
 * Funboard: 6'6" to 8'6" long, a small mini-mal to a long one; 20" to 23 1/2" wide; 2 3/8" to 3 1/8" thick.
 * At the corners of this box the board holds 33 to 67 litres.
 */
export const FUNBOARD_RANGES: BoardRanges = {
  length: { least: feet(6, 6), greatest: feet(8, 6) },
  width: { least: inches(20), greatest: inches(23.5) },
  thickness: { least: inches(2.375), greatest: inches(3.125) },
};

/**
 * Longboard: 8'6" to 11'0" long, the shortest a longboard is called one to a classic single fin; 21 1/2" to
 * 24 1/2" wide; 2 5/8" to 3 1/2" thick. At the corners of this box the board holds 52 to 103 litres.
 */
export const LONGBOARD_RANGES: BoardRanges = {
  length: { least: feet(8, 6), greatest: feet(11, 0) },
  width: { least: inches(21.5), greatest: inches(24.5) },
  thickness: { least: inches(2.625), greatest: inches(3.5) },
};

/**
 * Swallow shortboard: 5'4" to 7'0" long (a swallow is a shortboard tail, and a step-up carries one);
 * 17 1/2" to 21" wide; 1 7/8" to 2 3/4" thick. At the corners of this box the board holds 18 to 42 litres.
 */
export const SWALLOW_RANGES: BoardRanges = {
  length: { least: feet(5, 4), greatest: feet(7, 0) },
  width: { least: inches(17.5), greatest: inches(21) },
  thickness: { least: inches(1.875), greatest: inches(2.75) },
};

/**
 * Fish shortboard: 4'10" to 6'8" long, a fish being short for its width; 18" to 22 1/2" wide; 1 7/8" to 2 5/8"
 * thick. At the corners of this box the board holds 17 to 41 litres.
 */
export const FISH_RANGES: BoardRanges = {
  length: { least: feet(4, 10), greatest: feet(6, 8) },
  width: { least: inches(18), greatest: inches(22.5) },
  thickness: { least: inches(1.875), greatest: inches(2.625) },
};

/** One kind of board: a starter template, drawn at a size, that may be opened at any size inside its ranges. */
export interface BoardType {
  /** The template's name (`NURBS_TEMPLATES`), which is what the New menu lists and the docs name. */
  readonly name: string;
  /** One line in a shaper's words: the tail, the rail, how it rides. */
  readonly description: string;
  /** The size the template is drawn at. */
  readonly drawn: BoardSize;
  /** The plan outline of the board's plus half, an SVG path in cm with the tail at x = 0 and y up from the stringer. */
  readonly plan: string;
  readonly ranges: BoardRanges;
}

/** What each kind is, and the ranges it allows, in the order the gallery lists them. */
const KINDS: readonly {
  readonly name: string;
  readonly description: string;
  readonly ranges: BoardRanges;
}[] = [
  {
    name: 'Shortboard',
    description:
      'Squash tail and a tucked rail that stays hard at the tail. Quick to turn and loose off the tail, for waves with some push.',
    ranges: SHORTBOARD_RANGES,
  },
  {
    name: 'Funboard',
    description:
      'Round tail, a full outline and plenty of foam. Paddles early and rides smooth and forgiving, from small waves to head high.',
    ranges: FUNBOARD_RANGES,
  },
  {
    name: 'Longboard',
    description:
      'Round tail, a wide full outline and a long even rail. Glides on small soft waves and trims in a straight line.',
    ranges: LONGBOARD_RANGES,
  },
  {
    name: 'Swallow shortboard',
    description:
      'A swallow tail on the shortboard outline. Two points hold in the turn while the notch lets the tail release, so it feels lively and quick.',
    ranges: SWALLOW_RANGES,
  },
  {
    name: 'Fish shortboard',
    description:
      'A fish tail: a shallow notch and a wide, full tail. Planes early and holds its speed through flat sections of small waves.',
    ranges: FISH_RANGES,
  },
];

function shapeOf(name: string) {
  const shape = BOARD_TYPE_SHAPES[name];
  if (shape === undefined) {
    throw new Error(`No drawn size for the "${name}" template: regenerate board-type-shapes.ts.`);
  }
  return shape;
}

/** The kinds of board, in the order the gallery shows them. */
export const BOARD_TYPES: readonly BoardType[] = KINDS.map(({ name, description, ranges }) => {
  const { length, width, thickness, plan } = shapeOf(name);
  return { name, description, drawn: { length, width, thickness }, plan, ranges };
});

/** The kind with this name, if the gallery offers one. */
export const boardTypeNamed = (name: string): BoardType | undefined =>
  BOARD_TYPES.find((t) => t.name === name);

/**
 * `value` held to the range: the least when it is below it and the greatest when it is above, so a number
 * a shaper types past an end becomes the end and is never an error.
 */
export const holdToRange = (value: number, range: Range): number =>
  Math.min(range.greatest, Math.max(range.least, value));

/** `size` with each dimension held to the ranges of `type`. */
export const holdSize = (type: BoardType, size: BoardSize): BoardSize => ({
  length: holdToRange(size.length, type.ranges.length),
  width: holdToRange(size.width, type.ranges.width),
  thickness: holdToRange(size.thickness, type.ranges.thickness),
});

/** The size at the least end of every range of `type`, and the one at the greatest end of every range. */
export const leastSize = (type: BoardType): BoardSize => ({
  length: type.ranges.length.least,
  width: type.ranges.width.least,
  thickness: type.ranges.thickness.least,
});
export const greatestSize = (type: BoardType): BoardSize => ({
  length: type.ranges.length.greatest,
  width: type.ranges.width.greatest,
  thickness: type.ranges.thickness.greatest,
});
