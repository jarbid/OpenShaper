// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fmtSmallLen, lengthUnitByKey } from './format';
import { elapsedText, localizeLengths, refusalHint, statusText } from './nurbs-text';
import { VIEWER_IDLE, type ViewerState } from './nurbs-viewer';

describe('localizeLengths', () => {
  it('rewrites a length in cm into the display unit', () => {
    const msg = 'band: error 0.0675 cm above the target 0.005 cm';
    expect(localizeLengths(msg, lengthUnitByKey('mm'))).toBe(
      `band: error ${fmtSmallLen(0.0675, lengthUnitByKey('mm'))} above the target ${fmtSmallLen(0.005, lengthUnitByKey('mm'))}`,
    );
    const inches = localizeLengths(msg, lengthUnitByKey('in'));
    expect(inches).not.toMatch(/\bcm\b/);
    expect(inches).toContain(' in ');
  });

  it('leaves areas, volumes, ratios and other text alone', () => {
    const msg = 'law fidelity at 42.25 × its target near u = 0.5; volume 12000 cm³ over 300 cm²';
    expect(localizeLengths(msg, lengthUnitByKey('mm'))).toBe(msg);
  });

  it('keeps exponent notation intact', () => {
    expect(localizeLengths('identity 2.8e-14 cm', lengthUnitByKey('cm'))).toBe(
      `identity ${fmtSmallLen(2.8e-14, lengthUnitByKey('cm'))}`,
    );
  });
});

describe('elapsedText', () => {
  it('reads seconds, then minutes', () => {
    expect(elapsedText(0)).toBe('0 s');
    expect(elapsedText(12_400)).toBe('12 s');
    expect(elapsedText(65_000)).toBe('1 min 5 s');
    expect(elapsedText(-5)).toBe('0 s');
  });
});

describe('statusText', () => {
  const state = (patch: Partial<ViewerState>): ViewerState => ({ ...VIEWER_IDLE, ...patch });

  it('says what the first conversion is doing, and that classic stays up', () => {
    const text = statusText(state({ phase: 'converting' }), 'classic', 0);
    expect(text).toContain('Converting to NURBS…');
    expect(text).toContain('classic shown meanwhile');
  });

  it('shows a slow update with its elapsed time', () => {
    const text = statusText(state({ phase: 'ready', job: { startedAt: 0 } }), 'nurbs', 12_000);
    expect(text).toContain('Updating the NURBS surface');
    expect(text).toContain('12 s');
  });

  it('describes a refusal and the ready views, including a test board', () => {
    expect(statusText(state({ phase: 'failed' }), 'classic', 0)).toContain('refused');
    expect(statusText(state({ phase: 'ready' }), 'nurbs', 0)).toBe('Showing the NURBS surface');
    expect(statusText(state({ phase: 'ready' }), 'nurbs', 0, 'fish')).toBe(
      'Showing the fish test board',
    );
    expect(statusText(state({ phase: 'ready' }), 'classic', 0)).toBe('Showing classic');
    expect(statusText(VIEWER_IDLE, 'nurbs', 0)).toBe('');
  });
});

describe('refusalHint', () => {
  it('explains the refusals a person can act on', () => {
    expect(refusalHint('thickness')).toMatch(/not above the rocker/);
    expect(refusalHint('tail-start')).toMatch(/x = 0/);
    expect(refusalHint('convert-slice')).toMatch(/cannot be converted/);
    expect(refusalHint('convert-plan')).toMatch(/function of x/);
    expect(refusalHint('geom')).toBeNull();
  });
});
