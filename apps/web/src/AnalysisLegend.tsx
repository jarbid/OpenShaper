// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The exact curvature modes' legend, laid over the 3D pane: what the colours mean,
 * where the scale ends, and — while the worker fits the hull — that it is busy.
 *
 * The 3D view reports an `AnalysisStatus` and draws no text of its own, so every
 * length here goes through `format.ts` in the editor's display unit, like every
 * other length in the app. Curvature is labelled as a radius ("as curved as a ball
 * of radius R"), which keeps the scale in plain lengths in any unit.
 */
import type { AnalysisStatus } from '@openshaper/render3d';
import { LoaderCircle } from 'lucide-react';
import { fmtLen, type LengthUnit } from './format';
import { analysisLabel, EXACT_ANALYSIS_CONCAVE_TAIL } from './view3d-settings';

type Ready = Extract<AnalysisStatus, { state: 'ready' }>;

/** The three tick labels under the bar and the line under them. */
export const legendText = (
  status: Ready,
  units: LengthUnit,
): { low: string; mid: string; high: string; note: string } => {
  const L = (cm: number) => fmtLen(cm, units);
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
          Computing curvature…
        </div>
      )}
      {status.state === 'unavailable' && (
        <p className="mt-0.5 text-muted-foreground">
          {EXACT_ANALYSIS_CONCAVE_TAIL} Showing <strong>Normal change (approx.)</strong> instead.
        </p>
      )}
      {status.state === 'failed' && (
        <p className="mt-0.5 text-muted-foreground">
          Could not compute curvature: {status.message}
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
    </>
  );
}
