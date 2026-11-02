// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The tail types the "Board shape" section offers (NURBS engine only). Kept as data, apart from the
 * component, so the docs coverage test can diff it against `/docs` (`docs/coverage.test.ts`).
 */
import type { TailType } from '@openshaper/store/sections';

export const TAIL_TYPES: readonly { value: TailType; label: string; hint: string }[] = [
  {
    value: 'standard',
    label: 'Standard',
    hint: 'A pointed or round tail: the outline ends at the tail tip.',
  },
  {
    value: 'swallow',
    label: 'Swallow',
    hint: 'A V notch with a straight inner wall and two corner tips.',
  },
  { value: 'fish', label: 'Fish', hint: 'A shallower notch with a rounded inner wall.' },
];
