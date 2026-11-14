// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The words that say which patch of the board a tap chose, as a pure function so they are testable
 * and every length goes through `format.ts` in the editor's display unit (apps/web/CLAUDE.md).
 */
import type { PatchPick, Side } from '@openshaper/render3d';
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
