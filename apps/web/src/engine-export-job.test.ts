// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { engineQuickJob, stepUnitOf } from './engine-export-job';
import { EXPORT_FORMATS } from './file-io';
import { DEFAULT_STEP } from './step-export-settings';
import { LENGTH_UNITS } from './format';
import type { QuickJobContext } from './engine-export-job';

const ctx: QuickJobContext = {
  slug: 'board',
  ghost: null,
  fins: [],
  pdf: { units: 'cm' },
  stepUnit: 'mm',
};

describe('the one-click exports with the NURBS board open', () => {
  it('every format but rail bands runs as an engine job, so none reaches exportBoard', () => {
    for (const f of EXPORT_FORMATS) {
      const job = engineQuickJob(f, ctx);
      if (f === 'rail-bands') expect(job).toBeNull();
      else expect(job?.format).toBe(f === 'dxf-spline' ? 'dxf' : f);
    }
  });

  it('the quick PDF carries the saved 1:1 options and STEP the chosen unit', () => {
    expect(engineQuickJob('pdf-1to1', ctx)).toMatchObject({ options: ctx.pdf });
    expect(engineQuickJob('step', { ...ctx, stepUnit: 'in' })).toMatchObject({ unit: 'in' });
  });

  it('"auto" STEP units follow the editor, anything else is pinned', () => {
    const [mm, , inch] = LENGTH_UNITS;
    expect(stepUnitOf(DEFAULT_STEP, mm!)).toBe('mm');
    expect(stepUnitOf(DEFAULT_STEP, inch!)).toBe('in');
    expect(stepUnitOf({ ...DEFAULT_STEP, unit: 'cm' }, mm!)).toBe('cm');
  });
});
