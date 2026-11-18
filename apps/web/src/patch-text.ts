// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The words that say which patch of the board a tap chose, as a pure function so they are testable
 * and every length goes through `format.ts` in the editor's display unit (apps/web/CLAUDE.md).
 */
import type { PatchPick, Side } from '@openshaper/render3d';
import {
  MAX_ZONES,
  PATCH_COLORS,
  RAIL_NO_ZONES_COLOR,
  type RailZones,
} from '@openshaper/render3d/patches';
import { fmtLen, type LengthUnit } from './format';

/**
 * The side as a person on the board says it. The plus side is y >= 0; with x running from the tail to
 * the nose and z up, that is the left of someone standing on the board facing the nose.
 */
export const sideWord = (side: Side): string => (side === 'plus' ? 'left' : 'right');

/** "Rail, left side, zone 2, 112 cm from the tail": what `pick` is, and where it was tapped. */
export function patchPhrase(pick: PatchPick, units: LengthUnit): string {
  const where = `${fmtLen(pick.x, units)} from the tail`;
  switch (pick.patch) {
    case 'deck':
      return `Deck, ${where}`;
    case 'bottom':
      return `Bottom, ${where}`;
    case 'tailEdge':
      return `Tail edge, ${where}`;
    case 'corner':
      return `Corner, ${where}`;
    case 'rail': {
      const side = `${sideWord(pick.side)} side`;
      if (pick.zone !== undefined) return `Rail, ${side}, zone ${pick.zone + 1}, ${where}`;
      if (pick.blend !== undefined) {
        return `Rail, ${side}, blend between zones ${pick.blend + 1} and ${pick.blend + 2}, ${where}`;
      }
      return `Rail, ${side}, ${where}`;
    }
  }
}

/** One line of the key to the Patches look: a part of the board and the colour it is drawn in. */
export interface PatchKeyEntry {
  /** Unique in the key and the same from one render to the next. */
  readonly id: string;
  readonly label: string;
  /** `#rrggbb`: the colour the 3D view paints the part in. */
  readonly color: string;
}

/**
 * The key to the Patches look, in the order a person reads the board: the deck and the bottom, the
 * rail's zones along it from the tail, the tail's straight edge and the corners. The colours are
 * the look's own, taken from the palette module and the zones the 3D view paints from, so the key
 * cannot say what the board does not. A zone is "Rail 1", "Rail 2", … until zones have names (the
 * colour belongs to the zone's place along its side, so the two sides of a board whose rails have
 * different zones share the longer side's list); a board with no zones has one "Rail".
 */
export function patchKeyEntries(zones: RailZones): PatchKeyEntry[] {
  const count = Math.min(Math.max(zones.plus.length, zones.minus.length), MAX_ZONES);
  const rail: PatchKeyEntry[] =
    count === 0
      ? [{ id: 'rail', label: 'Rail', color: RAIL_NO_ZONES_COLOR }]
      : Array.from({ length: count }, (_, i) => ({
          id: `rail-${i}`,
          label: `Rail ${i + 1}`,
          color: (zones.plus[i] ?? zones.minus[i])!.color,
        }));
  return [
    { id: 'deck', label: 'Deck', color: PATCH_COLORS.deck },
    { id: 'bottom', label: 'Bottom', color: PATCH_COLORS.bottom },
    ...rail,
    { id: 'tailEdge', label: 'Tail edge', color: PATCH_COLORS.tailEdge },
    { id: 'corner', label: 'Corner', color: PATCH_COLORS.corner },
  ];
}
