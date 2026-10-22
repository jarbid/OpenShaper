// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Preset recovery on the shortboard (docs/design/board2.md §13.2 `convert`,
 * step S7): the apex suite of `test-support/presets.ts`, then the monotone
 * maps of the other two dials, one classic parameter varied at a time from the
 * 60/40 preset (the suite's own conversion reused):
 *
 * - **Edge**: the classic edge is binary (soft below `HARD_EDGE` 0.75 in the
 *   kernel, where `edge` changes nothing; a crease above), so 0.5 (the preset)
 *   against 1: the recovered hardness rises at every station outside the tip
 *   windows.
 * - **Fullness**: 0.2, 0.6 (the preset), 0.9: the recovered upper and lower
 *   fullness rise strictly at every such station.
 *
 * The recovered values are the laws measured on the fitted band at the
 * stations (`ConversionReport.stationLaws`), before they are clamped into the
 * keys: the hard edge reads above 1 there (S7 as built).
 */
import { RAIL_PRESETS } from '@openshaper/kernel';
import type { RailProfileParams } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import type { RailLawValues } from '../types';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import { convertPreset, PRESET_TIMEOUT, presetSuite } from './test-support/presets';
import type { PresetRun } from './test-support/presets';
import { classicSample } from './test-support/samples';

const GOLDEN = 'golden/shortboard.brd';
const cache = new Map<string, PresetRun>();
presetSuite(GOLDEN, cache);

const base60 = RAIL_PRESETS.find((p) => p.id === '60-40-tucked')!.params;

/** The station laws outside the tip windows, by station x. */
function stationLaws(r: PresetRun): Map<number, RailLawValues> {
  const length = r.run.geometry.length;
  return new Map(
    r.run.conversion.report.stationLaws
      .filter((s) => s.x > O.tipWindow && s.x < length - O.tipWindow)
      .map((s) => [s.x, s.laws]),
  );
}

function run(params: RailProfileParams): Map<number, RailLawValues> {
  return stationLaws(convertPreset(classicSample(GOLDEN).load(), params));
}

function preset60(): Map<number, RailLawValues> {
  const r = cache.get('60-40-tucked');
  return r === undefined ? run(base60) : stationLaws(r);
}

describe('preset recovery: monotone hardness and fullness (shortboard)', () => {
  it(
    'a hard edge reads harder than a soft one at every station',
    () => {
      const soft = preset60();
      const hard = run({ ...base60, edge: 1 });
      expect(soft.size).toBeGreaterThanOrEqual(2);
      for (const [x, s] of soft) {
        expect(hard.get(x)!.edgeHardness, `x ${x}`).toBeGreaterThan(s.edgeHardness);
      }
    },
    2 * PRESET_TIMEOUT,
  );

  it(
    'fuller classic rails read fuller, upper and lower, at every station',
    () => {
      const runs = [
        run({ ...base60, fullness: 0.2 }),
        preset60(),
        run({ ...base60, fullness: 0.9 }),
      ];
      for (const [x] of runs[1]!) {
        for (const lane of ['upperFullness', 'lowerFullness'] as const) {
          const v = runs.map((r) => r.get(x)![lane]);
          expect(v[1]!, `${lane} x ${x}`).toBeGreaterThan(v[0]!);
          expect(v[2]!, `${lane} x ${x}`).toBeGreaterThan(v[1]!);
        }
      }
    },
    3 * PRESET_TIMEOUT,
  );
});
