// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { engineFromSearch, nurbsEngineOn } from './nurbs-flag';

describe('engineFromSearch', () => {
  it('is on for ?engine=nurbs, in any case and among other parameters', () => {
    expect(engineFromSearch('?engine=nurbs')).toBe(true);
    expect(engineFromSearch('engine=nurbs')).toBe(true);
    expect(engineFromSearch('?engine=NURBS')).toBe(true);
    expect(engineFromSearch('?a=1&engine=nurbs&b=2')).toBe(true);
  });

  it('is off for everything else', () => {
    for (const s of [
      '',
      '?',
      '?engine=classic',
      '?engine=',
      '?engine',
      '?engines=nurbs',
      '?x=engine=nurbs',
      '?mode=nurbs',
    ]) {
      expect(engineFromSearch(s), s).toBe(false);
    }
  });
});

describe('nurbsEngineOn', () => {
  it('is on from either the setting or the URL, and off by default', () => {
    expect(nurbsEngineOn(false, '')).toBe(false);
    expect(nurbsEngineOn(true, '')).toBe(true);
    expect(nurbsEngineOn(false, '?engine=nurbs')).toBe(true);
    expect(nurbsEngineOn(true, '?engine=nurbs')).toBe(true);
  });
});
