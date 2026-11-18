// SPDX-License-Identifier: GPL-3.0-or-later
import { railZoneColor } from '@openshaper/render3d/patches';
import type { RailZones } from '@openshaper/render3d/patches';

/**
 * Zones of no length at the given places (cm from the tail), coloured by index, as the Patches look
 * draws a rail with one key at each place. A side left out has the plus side's places; `null` is a
 * board with no zones.
 */
export function zonesAt(
  keys: { readonly plus: readonly number[]; readonly minus?: readonly number[] } | null,
): RailZones {
  if (keys === null) return { plus: [], minus: [] };
  const side = (xs: readonly number[]) =>
    xs.map((x, i) => ({ from: x, to: x, color: railZoneColor(i) }));
  const plus = side(keys.plus);
  return { plus, minus: keys.minus === undefined ? plus : side(keys.minus) };
}
