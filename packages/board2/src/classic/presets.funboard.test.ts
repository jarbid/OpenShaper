// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Preset recovery on the funboard (docs/design/board2.md §13.2 `convert`, step
 * S7): see `test-support/presets.ts` for the oracles and the tolerance.
 */
import { presetSuite } from './test-support/presets';
import type { PresetRun } from './test-support/presets';

presetSuite('golden/funboard.brd', new Map<string, PresetRun>());
