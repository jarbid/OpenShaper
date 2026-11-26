// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The colour of a kind of contour, the same in the list, the slice, the plan and the rocker view's depth
 * strip of the old layout (`BOTTOM_FEATURES`): a contour is its colour wherever it is drawn.
 */
import type { ContourKind } from '@openshaper/store/rails';
import { BOTTOM_FEATURES } from '../bottom-features';

export const colourOfKind = (kind: ContourKind): string =>
  BOTTOM_FEATURES.find((k) => k.value === kind)?.color ?? 'currentColor';
