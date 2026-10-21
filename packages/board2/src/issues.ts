// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Issue codes and result helpers (docs/design/board2.md decision 29, §11.1).
 *
 * `Board2Result<T>` is shaped like geom's `Result`: `ok: true` may carry warnings,
 * `ok: false` carries at least one error. Where geom reports a failure, the
 * `GeomIssue` travels in `cause` (see {@link causeOf}). Everything returned is
 * frozen, so a result can be shared between undo versions and posted to a worker.
 */
import { issueOf, isGeomError } from '@openshaper/geom';
import type { GeomIssue } from '@openshaper/geom';
import type { Board2Issue, Board2IssueCode, Board2Result } from './types';

/**
 * Every {@link Board2IssueCode}, in the order of the type. The `satisfies` and the
 * exhaustiveness test in `issues.test.ts` keep this list and the union identical,
 * so a code added to one cannot be forgotten in the other.
 */
export const BOARD2_ISSUE_CODES = [
  'doc-malformed',
  'doc-version',
  'tail-not-standard',
  'plan-corner',
  'plan-radius',
  'tail-not-at-origin',
  'asymmetric-unsupported',
  'symmetry-broken',
  'law-keys-unsorted',
  'law-tip-slope',
  'law-out-of-range',
  'inset-invalid',
  'inset-loop-invalid',
  'rail-height',
  'rail-profile-invalid',
  'domain-too-small',
  'feature-invalid',
  'not-converged',
  'unsupported-tail',
  'too-few-sections',
  'geom',
] as const satisfies readonly Board2IssueCode[];

/** The optional parts of an issue. `severity` defaults to `'error'`. */
export interface IssueExtras {
  readonly severity?: 'error' | 'warning';
  readonly at?: Board2Issue['at'];
  readonly value?: number;
  readonly cause?: GeomIssue;
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
    ...(extras.cause === undefined ? {} : { cause: extras.cause }),
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

/** The plain `GeomIssue` of a thrown geom error, or `undefined` for anything else. */
export function causeOf(e: unknown): GeomIssue | undefined {
  return isGeomError(e) ? issueOf(e) : undefined;
}
