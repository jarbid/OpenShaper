// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The computed analyses' legend: every length in the editor's display unit, the
 * colour bar drawn with the ramp the hull is painted with, and an honest word for
 * each state the analysis can be in.
 */
import type { AnalysisStatus } from '@openshaper/render3d';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnalysisLegend, deviationRangeText, legendText } from './AnalysisLegend';
import { fmtLen, fmtSmallLen, lengthUnitByKey } from './format';
import { EXACT_ANALYSIS_CONCAVE_TAIL, GHOST_DEVIATION_NO_GHOST } from './view3d-settings';

const scale = { mean: 1 / 3.3, gaussian: 1 / (24 * 24), radius: [1.2, 150] as const };
const RAMP = ['#000000', '#888888', '#ffffff'];
const ready = (mode: 'mean-curvature' | 'gaussian-curvature' | 'rail-radius'): AnalysisStatus => ({
  state: 'ready',
  mode,
  scale,
  ramp: RAMP,
});

describe('AnalysisLegend', () => {
  it('shows nothing while no exact mode is on', () => {
    const { container } = render(
      <AnalysisLegend status={{ state: 'off' }} units={lengthUnitByKey('mm')} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('says it is computing, under the mode’s name', () => {
    render(
      <AnalysisLegend
        status={{ state: 'computing', mode: 'mean-curvature' }}
        units={lengthUnitByKey('mm')}
      />,
    );
    const legend = screen.getByRole('status', { name: 'Mean curvature legend' });
    expect(legend.textContent).toContain('Computing curvature…');
  });

  it('gives the concave-tail reason and names the fallback', () => {
    render(
      <AnalysisLegend
        status={{ state: 'unavailable', mode: 'rail-radius', reason: 'concave-tail' }}
        units={lengthUnitByKey('mm')}
      />,
    );
    const legend = screen.getByRole('status', { name: 'Rail radius legend' });
    expect(legend.textContent).toContain(EXACT_ANALYSIS_CONCAVE_TAIL);
    expect(legend.textContent).toContain('Normal change (approx.)');
  });

  it('passes a failure on rather than hiding it', () => {
    render(
      <AnalysisLegend
        status={{ state: 'failed', mode: 'gaussian-curvature', message: 'fit failed' }}
        units={lengthUnitByKey('mm')}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('fit failed');
  });

  it('draws the bar with the hull’s own ramp', () => {
    render(<AnalysisLegend status={ready('mean-curvature')} units={lengthUnitByKey('mm')} />);
    const bar = screen.getByTestId('analysis-legend-ramp');
    // jsdom normalises colours to rgb(); the order and count are what matter.
    expect(bar.style.background).toMatch(
      /linear-gradient\(to right, rgb\(0, 0, 0\), rgb\(136, 136, 136\), rgb\(255, 255, 255\)\)/,
    );
  });
});

describe('legend lengths follow the display unit', () => {
  // Every unit the toolbar offers, so a fixed suffix anywhere would show up.
  for (const key of ['mm', 'cm', 'in', 'ftin']) {
    const units = lengthUnitByKey(key);

    it(`mean curvature labels its scale as a radius in ${key}`, () => {
      render(<AnalysisLegend status={ready('mean-curvature')} units={units} />);
      const text = screen.getByRole('status').textContent!;
      expect(text).toContain(fmtLen(3.3, units));
      expect(text).toContain('Concave');
      expect(text).toContain('Convex');
    });

    it(`Gaussian curvature labels its scale as a radius in ${key}`, () => {
      render(<AnalysisLegend status={ready('gaussian-curvature')} units={units} />);
      const text = screen.getByRole('status').textContent!;
      expect(text).toContain(fmtLen(24, units));
      expect(text).toContain('Saddle');
      expect(text).toContain('Dome');
    });

    it(`rail radius gives both ends of its range in ${key}`, () => {
      const t = legendText(
        ready('rail-radius') as Extract<AnalysisStatus, { state: 'ready' }>,
        units,
      );
      expect(t.low).toBe(`${fmtLen(1.2, units)} or tighter`);
      expect(t.high).toBe(`${fmtLen(150, units)} or flatter`);
    });
  }

  it('never prints a centimetre value to an inch user', () => {
    render(<AnalysisLegend status={ready('rail-radius')} units={lengthUnitByKey('in')} />);
    const text = screen.getByRole('status').textContent!;
    expect(text).not.toMatch(/\bcm\b|\bmm\b/);
    expect(text).toContain(fmtLen(150, lengthUnitByKey('in')));
  });
});

describe('the deviation map’s legend', () => {
  const deviation = (
    band: number,
    range: readonly [number, number] | null = [-0.21, 0.43],
  ): Extract<AnalysisStatus, { state: 'ready'; mode: 'ghost-deviation' }> => ({
    state: 'ready',
    mode: 'ghost-deviation',
    band,
    range,
    ramp: RAMP,
    stripes: ['#111111', '#222222'],
  });

  it('says it is measuring, under the mode’s name', () => {
    render(
      <AnalysisLegend
        status={{ state: 'computing', mode: 'ghost-deviation' }}
        units={lengthUnitByKey('mm')}
      />,
    );
    const legend = screen.getByRole('status', { name: 'Deviation from ghost legend' });
    expect(legend.textContent).toContain('Measuring against the ghost…');
    expect(legend.textContent).not.toContain('curvature');
  });

  it('says how to load a ghost when there is none', () => {
    render(
      <AnalysisLegend
        status={{ state: 'unavailable', mode: 'ghost-deviation', reason: 'no-ghost' }}
        units={lengthUnitByKey('mm')}
      />,
    );
    const text = screen.getByRole('status').textContent!;
    expect(text).toContain(GHOST_DEVIATION_NO_GHOST);
    expect(text).not.toContain('Normal change');
  });

  it('passes a failure on, as a measurement', () => {
    render(
      <AnalysisLegend
        status={{ state: 'failed', mode: 'ghost-deviation', message: 'boom' }}
        units={lengthUnitByKey('mm')}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Could not measure against the ghost: boom',
    );
  });

  it('draws the bar with the hull’s ramp and keys the no-data stripes', () => {
    render(<AnalysisLegend status={deviation(0.5)} units={lengthUnitByKey('mm')} />);
    expect(screen.getByTestId('analysis-legend-ramp').style.background).toMatch(
      /linear-gradient\(to right, rgb\(0, 0, 0\), rgb\(136, 136, 136\), rgb\(255, 255, 255\)\)/,
    );
    const swatch = screen.getByTestId('analysis-legend-no-data');
    expect(swatch.style.background).toMatch(/repeating-linear-gradient/);
    expect(swatch.style.background).toMatch(/rgb\(17, 17, 17\).*rgb\(34, 34, 34\)/);
    expect(screen.getByRole('status').textContent).toContain('No data');
  });

  // Every unit the toolbar offers, so a fixed suffix anywhere would show up.
  for (const key of ['mm', 'cm', 'in', 'ftin']) {
    const units = lengthUnitByKey(key);

    it(`gives the band and the range found in ${key}`, () => {
      const status = deviation(0.5);
      const t = legendText(status, units);
      expect(t.low).toBe(`−${fmtSmallLen(0.5, units)}`);
      expect(t.mid).toBe('0');
      expect(t.high).toBe(`+${fmtSmallLen(0.5, units)}`);
      expect(deviationRangeText(status, units)).toBe(
        `On this board: −${fmtSmallLen(0.21, units)} to +${fmtSmallLen(0.43, units)}.`,
      );
      render(<AnalysisLegend status={status} units={units} />);
      const text = screen.getByRole('status').textContent!;
      expect(text).toContain(t.low);
      expect(text).toContain(t.high);
      expect(text).toContain(deviationRangeText(status, units));
    });
  }

  it('reads less foam as blue, more as red', () => {
    const t = legendText(deviation(0.5), lengthUnitByKey('mm'));
    expect(t.low).toBe('−5 mm');
    expect(t.high).toBe('+5 mm');
    expect(t.note).toMatch(/Blue: less foam than the ghost\. Red: more\./);
  });

  it('never prints a metric band or range to an inch user', () => {
    render(
      <AnalysisLegend status={deviation(1.27, [-0.254, 0.635])} units={lengthUnitByKey('in')} />,
    );
    const text = screen.getByRole('status').textContent!;
    expect(text).not.toMatch(/\bcm\b|\bmm\b/);
    expect(text).toContain('+0.5 in');
    expect(text).toContain('On this board: −0.1 in to +0.25 in.');
  });

  it('says so when no part of the board could be measured', () => {
    expect(deviationRangeText(deviation(0.5, null), lengthUnitByKey('mm'))).toMatch(
      /No part of this board/,
    );
  });
});
