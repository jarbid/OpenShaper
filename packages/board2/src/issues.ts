// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Issue codes and result helpers.
 *
 * `Board2Result<T>` is shaped like geom's `Result`: `ok: true` may carry warnings,
 * `ok: false` carries at least one error. Everything returned is frozen, so a
 * result can be shared between undo versions and posted to a worker.
 */
import type { Board2Issue, Board2IssueCode, Board2Result } from './types';

/**
 * Every {@link Board2IssueCode}, in the order of the type. The `satisfies` and the
 * exhaustiveness test in `issues.test.ts` keep this list and the union identical,
 * so a code added to one cannot be forgotten in the other.
 */
export const BOARD2_ISSUE_CODES = [
  'doc-malformed',
  'doc-version',
  'symmetry-fields',
  'too-few-sections',
  'chain-too-short',
  'station-order',
  'station-id',
  'outline-endpoints',
  'tail-start',
  'outline-not-function',
  'notch-zone',
  'notch-tip',
  'notch-chords-cross',
  'notch-chord-angle',
  'line-domain',
  'line-not-function',
  'thickness',
  'section-centre-moved',
  'section-centre-tangent',
  'section-apex-index',
  'section-apex-moved',
  'section-out-of-bounds',
  'feature-invalid',
  'build-invalid',
  'section-fit',
  'blend-overshoot',
  'geom',
] as const satisfies readonly Board2IssueCode[];

/** The optional parts of an issue. `severity` defaults to `'error'`. */
export interface IssueExtras {
  readonly severity?: 'error' | 'warning';
  readonly at?: Board2Issue['at'];
  readonly value?: number;
}

/** A frozen issue. Absent extras are omitted, not set to `undefined`. */
export function makeIssue(
  code: Board2IssueCode,
  message: string,
  extras: IssueExtras = {},
): Board2Issue {
  const issue: Board2Issue = {
    code,
    severity: extras.severity ?? 'error',
    message,
    ...(extras.at === undefined ? {} : { at: Object.freeze({ ...extras.at }) }),
    ...(extras.value === undefined ? {} : { value: extras.value }),
  };
  return Object.freeze(issue);
}

/** A successful result, possibly carrying warnings. */
export function board2Ok<T>(value: T, issues: readonly Board2Issue[] = []): Board2Result<T> {
  return Object.freeze({ ok: true as const, value, issues: Object.freeze([...issues]) });
}

/** A failed result: `issues` must hold at least one error. */
export function board2Err<T>(issues: readonly Board2Issue[]): Board2Result<T> {
  return Object.freeze({ ok: false as const, issues: Object.freeze([...issues]) });
}

/** True if any issue is an error (warnings do not fail a result). */
export function hasErrors(issues: readonly Board2Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
