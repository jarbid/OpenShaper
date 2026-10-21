// SPDX-License-Identifier: GPL-3.0-or-later
/** Issue codes and result helpers (decision 29). */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { BOARD2_ISSUE_CODES, board2Err, board2Ok, causeOf, hasErrors, makeIssue } from './issues';
import { GeomError } from '@openshaper/geom';
import type { Board2IssueCode } from './types';

describe('issues', () => {
  it('the runtime code list and the type union are the same set', () => {
    expectTypeOf<(typeof BOARD2_ISSUE_CODES)[number]>().toEqualTypeOf<Board2IssueCode>();
    expect(new Set(BOARD2_ISSUE_CODES).size).toBe(BOARD2_ISSUE_CODES.length);
  });

  it('makeIssue defaults to an error, omits absent extras and freezes', () => {
    const i = makeIssue('doc-malformed', 'x');
    expect(i).toEqual({ code: 'doc-malformed', severity: 'error', message: 'x' });
    expect('at' in i).toBe(false);
    expect(Object.isFrozen(i)).toBe(true);
    const w = makeIssue('geom', 'w', {
      severity: 'warning',
      at: { lane: 'apexHeight', key: 2 },
      value: 3,
    });
    expect(w).toMatchObject({ severity: 'warning', at: { lane: 'apexHeight', key: 2 }, value: 3 });
    expect(Object.isFrozen(w.at)).toBe(true);
  });

  it('results mirror geom: ok may carry warnings, not ok carries errors; both frozen', () => {
    const warn = makeIssue('geom', 'w', { severity: 'warning' });
    const err = makeIssue('doc-version', 'e');
    const ok = board2Ok(42, [warn]);
    expect(ok.ok).toBe(true);
    expect(ok.issues).toEqual([warn]);
    expect(Object.isFrozen(ok)).toBe(true);
    expect(Object.isFrozen(ok.issues)).toBe(true);
    const bad = board2Err<number>([err]);
    expect(bad.ok).toBe(false);
    expect(hasErrors(bad.issues)).toBe(true);
    expect(hasErrors([warn])).toBe(false);
    expect(hasErrors([])).toBe(false);
  });

  it('causeOf turns a GeomError into its plain issue and ignores everything else', () => {
    const c = causeOf(new GeomError('knots-decreasing', 'bad knots', { index: 3 }));
    expect(c).toMatchObject({ code: 'knots-decreasing', severity: 'error', at: { index: 3 } });
    expect(causeOf(new Error('x'))).toBeUndefined();
    expect(causeOf('x')).toBeUndefined();
  });
});
