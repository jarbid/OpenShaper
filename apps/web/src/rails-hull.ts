// SPDX-License-Identifier: GPL-3.0-or-later
import type { RailsBoard } from '@openshaper/board2';

/**
 * Whether two rails boards have the same hull: the same outline and corners, lines, stations, rails,
 * features, symmetry and settings, by identity (an edit replaces exactly the parts it changes). What
 * is left out is the fins, which sit beside the hull and cost the engine nothing.
 */
export const sameRailsHull = (a: RailsBoard, b: RailsBoard): boolean =>
  a === b ||
  (a.outline === b.outline &&
    a.corners === b.corners &&
    a.rocker === b.rocker &&
    a.deck === b.deck &&
    a.stations === b.stations &&
    a.rails === b.rails &&
    a.features === b.features &&
    a.symmetry === b.symmetry &&
    a.build === b.build);
