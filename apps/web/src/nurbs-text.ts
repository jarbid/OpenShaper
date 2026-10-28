// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The words of the NURBS viewer's badge and popover, as pure functions so they are
 * testable and every length goes through `format.ts` in the editor's display unit
 * (apps/web/CLAUDE.md).
 */
import { fmtSmallLen, type LengthUnit } from './format';
import type { ViewerState } from './nurbs-viewer';

/**
 * Rewrite the lengths in a converter message ("error 0.0675 cm above the target
 * 0.005 cm") into the display unit. Only a number directly followed by the word `cm`
 * is a length: areas and volumes (`cm²`, `cm³`) and any other text are left alone.
 */
export const localizeLengths = (message: string, units: LengthUnit): string =>
  message.replace(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) cm(?![\w²³])/gi, (_m, value: string) =>
    fmtSmallLen(Number(value), units),
  );

/** "12 s", "1 min 5 s": elapsed time as a person reads it. */
export const elapsedText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * Why the converter refuses a board, in the words of someone editing it. The raw message
 * (with its numbers) follows in the popover; this is the part that says what to do.
 * Null for a code with nothing to add.
 */
export const refusalHint = (code: string, message: string): string | null => {
  switch (code) {
    case 'thickness':
      return 'The board has no thickness at one end (the deck meets the rocker). Give the tail and the nose a little thickness.';
    case 'tail-start':
    case 'outline-endpoints':
      return 'A blunt tail has to start on the stringer. Add an outline point on the stringer (y = 0) at the tail.';
    case 'convert-slice':
      return /bottom centre|off the stringer|centre/i.test(message)
        ? 'A cross-section has a V bottom (its centre sits off the stringer), which the NURBS model cannot hold yet.'
        : 'A cross-section cannot be converted to the NURBS model.';
    case 'convert-plan':
      return 'The outline, rocker or deck is not a function of x (it folds back on itself).';
    case 'too-few-sections':
      return 'The board needs at least one cross-section between the tail and the nose.';
    default:
      return null;
  }
};

/**
 * The status line under the badge. `elapsedMs` is how long the busy job has run (the
 * caller ticks it); `showing` says which surface is on screen; `testBoard` names the
 * test board when one is shown.
 */
export const statusText = (
  state: ViewerState,
  showing: 'nurbs' | 'classic',
  elapsedMs: number,
  testBoard: string | null = null,
): string => {
  const { phase, job } = state;
  if (job) return `Updating the NURBS surface… ${elapsedText(elapsedMs)}`;
  switch (phase) {
    case 'converting':
      return 'Converting to NURBS… · classic shown meanwhile';
    case 'failed':
      return 'NURBS refused this board · classic shown (see details)';
    case 'ready':
      if (showing === 'classic') return 'Showing classic';
      return testBoard ? `Showing the ${testBoard} test board` : 'Showing the NURBS surface';
    default:
      return '';
  }
};
