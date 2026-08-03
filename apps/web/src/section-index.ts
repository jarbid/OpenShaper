// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Clamp a cross-section index to the board's real, selectable stations.
 *
 * Index 0 and the last index are the nose/tail dummies, so the selectable range
 * is 1..count-2. The active index is raw state that survives edits, and deleting
 * a station leaves it pointing past the end — deriving through this on every
 * render is what keeps the selection (and the 3D highlight) on a station that
 * exists.
 */
export const clampSectionIndex = (csIndex: number, sectionCount: number): number => {
  const lastReal = Math.max(1, sectionCount - 2);
  return Math.min(Math.max(csIndex, 1), lastReal);
};
