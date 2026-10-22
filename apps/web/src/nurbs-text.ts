// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The words of the NURBS viewer's badge and popover, as pure functions so they are
 * testable and every length goes through `format.ts` in the editor's display unit
 * (apps/web/CLAUDE.md).
 */
import { fmtSmallLen, type LengthUnit } from './format';
import type { ViewerState } from './nurbs-viewer';
import type { NurbsStage } from './workers/nurbs-protocol';

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

/** What the engine is doing, for the badge's status line; null when there is nothing to say. */
export const stageText = (stage: NurbsStage): string =>
  stage === 'converting'
    ? 'Converting to NURBS…'
    : stage === 'building'
      ? 'Rebuilding the NURBS surface…'
      : stage === 'meshing'
        ? 'Meshing the NURBS surface…'
        : 'Measuring against the classic surface…';

/**
 * The status line under the badge. `elapsedMs` is how long the current job has run
 * (the caller ticks it); `showing` says which surface is on screen.
 */
export const statusText = (
  state: ViewerState,
  showing: 'nurbs' | 'classic',
  elapsedMs: number,
): string => {
  const { phase, job } = state;
  if (job) {
    const base = stageText(job.stage);
    return job.kind === 'convert'
      ? `${base} ${elapsedText(elapsedMs)} · classic shown meanwhile`
      : `${base} ${elapsedText(elapsedMs)}`;
  }
  switch (phase) {
    case 'waiting':
      return 'Waiting for your edits to settle · classic shown';
    case 'failed':
      return 'NURBS conversion failed · classic shown';
    case 'ready':
      return showing === 'nurbs' ? 'Showing the NURBS surface' : 'Showing classic';
    default:
      return '';
  }
};
