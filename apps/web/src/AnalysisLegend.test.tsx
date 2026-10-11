// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The exact curvature legend: every length in the editor's display unit, the
 * colour bar drawn with the ramp the hull is painted with, and an honest word for
 * each state the analysis can be in.
 */
import type { AnalysisStatus } from '@openshaper/render3d';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnalysisLegend, legendText } from './AnalysisLegend';
import { fmtLen, lengthUnitByKey } from './format';
import { EXACT_ANALYSIS_CONCAVE_TAIL } from './view3d-settings';

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
