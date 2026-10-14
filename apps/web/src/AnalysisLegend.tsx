// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The computed analysis modes' legend, laid over the 3D pane: what the colours mean,
 * where the scale ends, and — while the worker computes — that it is busy.
 *
 * The 3D view reports an `AnalysisStatus` and draws no text of its own, so every
 * length here goes through `format.ts` in the editor's display unit, like every
 * other length in the app. Curvature is labelled as a radius ("as curved as a ball
 * of radius R"), which keeps the scale in plain lengths in any unit; the deviation
 * from a ghost is a length already.
 */
import type { AnalysisStatus } from '@openshaper/render3d';
import { LoaderCircle } from 'lucide-react';
import { fmtLen, fmtSmallLen, type LengthUnit } from './format';
import {
  analysisLabel,
  EXACT_ANALYSIS_CONCAVE_TAIL,
  GHOST_DEVIATION_NO_GHOST,
} from './view3d-settings';

type Ready = Extract<AnalysisStatus, { state: 'ready' }>;
type DeviationReady = Extract<Ready, { mode: 'ghost-deviation' }>;

/** A small length with its sign spelled out: "+4.3 mm", "−2.1 mm", "0 mm". */
const signedSmallLen = (cm: number, units: LengthUnit): string =>
  `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${fmtSmallLen(Math.abs(cm), units)}`;

/** The three tick labels under the bar and the line under them. */
export const legendText = (
  status: Ready,
  units: LengthUnit,
): { low: string; mid: string; high: string; note: string } => {
  const L = (cm: number) => fmtLen(cm, units);
  if (status.mode === 'ghost-deviation') {
    const band = fmtSmallLen(status.band, units);
    return {
      low: `−${band}`,
      mid: '0',
      high: `+${band}`,
      note: `Blue: less foam than the ghost. Red: more. Full colour at ${band} or more.`,
    };
  }
  const { scale } = status;
  switch (status.mode) {
    case 'mean-curvature':
      return {
        low: 'Concave',
        mid: 'Flat',
        high: 'Convex',
        note: `Full colour: as curved as a ball of radius ${L(1 / scale.mean)}, or more.`,
      };
    case 'gaussian-curvature':
      return {
        low: 'Saddle',
        mid: '0',
        high: 'Dome',
        note: `Full colour: as curved as a ball of radius ${L(1 / Math.sqrt(scale.gaussian))}, or more. 0 is flat, or bent one way only.`,
      };
    case 'rail-radius':
      return {
        low: `${L(scale.radius[0])} or tighter`,
        mid: '',
        high: `${L(scale.radius[1])} or flatter`,
        note: 'The tightest radius of curvature at each point.',
      };
  }
};

/** What the deviation map found on the board shown, in a line. */
export const deviationRangeText = (status: DeviationReady, units: LengthUnit): string =>
  status.range
    ? `On this board: ${signedSmallLen(status.range[0], units)} to ${signedSmallLen(status.range[1], units)}.`
    : 'No part of this board lies within the ghost’s length.';

/** "Computing curvature…" and its kin, per mode. */
const busyText = (status: Exclude<AnalysisStatus, { state: 'off' }>): string =>
  status.mode === 'ghost-deviation' ? 'Measuring against the ghost…' : 'Computing curvature…';

export function AnalysisLegend({ status, units }: { status: AnalysisStatus; units: LengthUnit }) {
  if (status.state === 'off') return null;
  const title = analysisLabel(status.mode);
  return (
    <div
      role="status"
      aria-label={`${title} legend`}
      className="pointer-events-none absolute left-2 top-2 z-[1] w-60 max-w-[calc(100%-1rem)] rounded-md border border-border bg-card/90 px-2 py-1.5 text-xs text-card-foreground shadow-lg"
    >
      <div className="font-medium">{title}</div>
      {status.state === 'computing' && (
        <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          {busyText(status)}
        </div>
      )}
      {status.state === 'unavailable' && status.reason === 'concave-tail' && (
        <p className="mt-0.5 text-muted-foreground">
          {EXACT_ANALYSIS_CONCAVE_TAIL} Showing <strong>Normal change (approx.)</strong> instead.
        </p>
      )}
      {status.state === 'unavailable' && status.reason === 'no-ghost' && (
        <p className="mt-0.5 text-muted-foreground">{GHOST_DEVIATION_NO_GHOST}</p>
      )}
      {status.state === 'failed' && (
        <p className="mt-0.5 text-muted-foreground">
          {status.mode === 'ghost-deviation'
            ? 'Could not measure against the ghost'
            : 'Could not compute curvature'}
          : {status.message}
        </p>
      )}
      {status.state === 'ready' && <LegendScale status={status} units={units} />}
    </div>
  );
}

function LegendScale({ status, units }: { status: Ready; units: LengthUnit }) {
  const { low, mid, high, note } = legendText(status, units);
  return (
    <>
      <div
        data-testid="analysis-legend-ramp"
        className="mt-1 h-2.5 rounded-sm"
        style={{ background: `linear-gradient(to right, ${status.ramp.join(', ')})` }}
      />
      <div className="mt-0.5 grid grid-cols-3 gap-1 tabular-nums">
        <span>{low}</span>
        <span className="text-center">{mid}</span>
        <span className="text-right">{high}</span>
      </div>
      <p className="mt-0.5 text-muted-foreground">{note}</p>
      {status.mode === 'ghost-deviation' && (
        <>
          <p className="mt-0.5 tabular-nums">{deviationRangeText(status, units)}</p>
          <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
            {/* Diagonal stripes in the two no-data greys, as the hull draws them. */}
            <span
              data-testid="analysis-legend-no-data"
              aria-hidden="true"
              className="inline-block h-2.5 w-5 shrink-0 rounded-sm"
              style={{
                background: `repeating-linear-gradient(135deg, ${status.stripes[0]} 0 3px, ${status.stripes[1]} 3px 6px)`,
              }}
            />
            No data: past the ghost’s ends, and at the board’s own ends.
          </div>
        </>
      )}
    </>
  );
}
