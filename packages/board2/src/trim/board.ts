// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The types of an in-memory rails board (docs/design/trim-blend-engine.md, "The rails board"):
 * a board that keeps its outline, rocker, deck, features and build settings as a sections board
 * does, and carries corner radii, stations with a bottom and a deck curve per side, and rail
 * keys per side. Types only.
 */
import type {
  BoardMeta,
  BottomFeature,
  BuildSettings,
  Chain,
  JsonValue,
  Outline,
  Symmetry,
} from '../types';
import type { RailRecipe } from './rails';

/**
 * The two curves of one side of a station. A curve is a chain in normalised (u, v): u runs from
 * the stringer (0) to the wall (1), v is the height above the rocker over the thickness. It is
 * a function of u, and flat at u = 0.
 */
export interface StationCurves {
  readonly bottom: Chain;
  readonly deck: Chain;
}

/** A station: the curves of its plus side, and of its minus side on an asymmetric board. */
export interface RailsStation {
  readonly id: string;
  /** Place along the board, cm from the tail. */
  readonly x: number;
  readonly plus: StationCurves;
  /** Present on an asymmetric board only. */
  readonly minus?: StationCurves;
}

/**
 * A rail key: a place along the board and a rail there. Each of the rail's seven numbers runs
 * between keys as a keyed curve, held outside them.
 */
export interface RailKey {
  /** Place along the board, cm from the tail. */
  readonly x: number;
  readonly rail: RailRecipe;
}

/**
 * The radii (cm) of the outline's rounded corners. `plus` and `minus` hold one radius per corner
 * knot of that side's outline chain, tail to nose.
 */
export interface RailsCorners {
  /** The ball on the nose. */
  readonly nose: number;
  /** The corner where the two sides meet at the tail: the tail point, or the crotch of a notch. */
  readonly tail: number;
  readonly plus: readonly number[];
  /** Present on an asymmetric board only; a mirror board's minus side has the plus radii. */
  readonly minus?: readonly number[];
}

/** A rails board. */
export interface RailsBoard {
  readonly model: 'rails';
  readonly meta: BoardMeta;
  readonly symmetry: Symmetry;
  readonly outline: Outline;
  readonly corners: RailsCorners;
  readonly rocker: Chain;
  readonly deck: Chain;
  readonly stations: readonly RailsStation[];
  /** The rail keys of each side, sorted by x; `minus` on an asymmetric board only. */
  readonly rails: { readonly plus: readonly RailKey[]; readonly minus?: readonly RailKey[] };
  readonly features: readonly BottomFeature[];
  /** Classic fin configuration, opaque here. */
  readonly fins?: JsonValue;
  readonly build: BuildSettings;
}
