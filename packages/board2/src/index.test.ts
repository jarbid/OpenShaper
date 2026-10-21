// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Public-API pin and conventions (docs/design/board2.md §11, decision 31).
 *
 * - The runtime export lists of both entry points are pinned exactly, sorted.
 *   Each build step adds its values here in the same diff, so an API change shows
 *   in review. Step S1 (document, laws, validation) is in; `./classic` is still
 *   types only.
 * - A sample document round-trips through JSON unchanged: `BoardDoc` is plain
 *   data (decision 1). The sample (`testing/sample-doc.ts`) is typed `BoardDoc`.
 * - Type-level checks pin the conventions the types encode (lanes, rows that may
 *   carry offsets, Phase 2's symmetry and tail options).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as board2 from './index';
import * as classic from './classic/index';
import { sampleDoc } from './testing/sample-doc';
import type {
  BandRow,
  BoardDoc,
  BuildParams,
  OffsetRow,
  RailLane,
  Symmetry,
  TailSpec,
} from './index';
import type { ClassicBoard, DeviationCause } from './classic/index';
import type { BezierBoard } from '@openshaper/kernel';

/** Every runtime (value) export of `@openshaper/board2`, sorted. */
const PUBLIC_VALUES: readonly string[] = [
  'BOARD2_ISSUE_CODES',
  'DEFAULT_BUILD_PARAMS',
  'DEFAULT_RAIL_LAWS',
  'RAIL_LANES',
  'board2Err',
  'board2Ok',
  'boardDocToJson',
  'evaluateLaw',
  'hasErrors',
  'lawEvaluator',
  'lawSegments',
  'reviveBoardDoc',
  'validateBoard',
  'validateBuildParams',
];
/** Every runtime export of `@openshaper/board2/classic`, sorted. */
const CLASSIC_VALUES: readonly string[] = [];

describe('@openshaper/board2 public API', () => {
  it('exports exactly the pinned values (and the classic entry none yet)', () => {
    expect(Object.keys(board2).sort()).toEqual(PUBLIC_VALUES);
    expect(Object.keys(classic).sort()).toEqual(CLASSIC_VALUES);
  });

  it('a BoardDoc is plain data: a JSON round trip is lossless', () => {
    const sample: BoardDoc = sampleDoc();
    const text = JSON.stringify(sample);
    expect(JSON.parse(text)).toEqual(sample);
    // Stable: serialising the parsed copy gives the same bytes.
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
  });

  it('pins the conventions the types encode', () => {
    expectTypeOf<RailLane>().toEqualTypeOf<
      'deckInset' | 'tuckInset' | 'apexHeight' | 'upperFullness' | 'lowerFullness' | 'edgeHardness'
    >();
    // Every band row but the apex may carry an offset (§6.1): the apex moves only
    // with the outline and the apex-height law.
    expectTypeOf<OffsetRow>().toEqualTypeOf<Exclude<BandRow, 'apex'>>();
    expectTypeOf<'apex'>().not.toExtend<OffsetRow>();
    expectTypeOf<Symmetry>().toEqualTypeOf<'mirror-y' | 'none'>();
    expectTypeOf<TailSpec['kind']>().toEqualTypeOf<'standard'>();
    // Build parameters are part of the document, so a board rebuilds identically.
    expectTypeOf<BoardDoc['build']>().toEqualTypeOf<BuildParams>();
    // The classic entry starts from the kernel's board, whatever reader made it.
    expectTypeOf<ClassicBoard>().toEqualTypeOf<BezierBoard>();
    expectTypeOf<'station-crease'>().toExtend<DeviationCause>();
  });
});
