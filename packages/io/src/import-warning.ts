// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A non-fatal note emitted by a file reader when it repairs an imported board.
 * `severity` lets the UI decide how loud to be:
 *   - 'dropped' — geometry was REMOVED (data-loss). The UI confirms before load.
 *   - 'info'    — a non-destructive repair (fallback, synthesized/derived data,
 *                 clamp). The UI shows a dismissible notice.
 */
export type ImportWarningSeverity = 'dropped' | 'info';

export interface ImportWarning {
  readonly severity: ImportWarningSeverity;
  readonly message: string;
}
