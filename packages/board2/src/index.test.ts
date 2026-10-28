// SPDX-License-Identifier: GPL-3.0-or-later
/** Public-API pin: the runtime export lists of the entry points, sorted. */
import { describe, expect, it } from 'vitest';
import * as board2 from './index';
import * as classic from './classic/index';
import * as testing from './testing/index';

describe('@openshaper/board2 public API', () => {
  it('exports exactly the pinned runtime values', () => {
    expect(Object.keys(board2).sort()).toEqual(
      [
        'BOARD2_ISSUE_CODES',
        'DEFAULT_BUILD',
        'MEASURE',
        'board2Err',
        'board2Ok',
        'boardDocToJson',
        'buildBoard',
        'createEvaluator',
        'hasErrors',
        'reviveBoardDoc',
        'validateBoard',
      ].sort(),
    );
  });

  it('the classic entry has no values yet (the converter is M1 step 2)', () => {
    expect(Object.keys(classic)).toEqual([]);
  });

  it('the testing entry exports the boards and the oracles', () => {
    expect(Object.keys(testing).sort()).toEqual(
      [
        'analyticBoard',
        'analyticFacts',
        'asymmetricBoard',
        'chain',
        'chainPoint',
        'chainZ',
        'distanceToChain',
        'distanceToPolyline',
        'fishBoard',
        'knot',
        'sampleChain',
        'section',
        'swallowBoard',
        'testBoards',
      ].sort(),
    );
  });
});
