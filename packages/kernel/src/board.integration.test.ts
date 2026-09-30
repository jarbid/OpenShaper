// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration-resolution contract for getVolume / getArea / getCenterOfMass.
 *
 * The longitudinal integral now defaults to {@link adaptiveSimpson} (the
 * cross-section trapezoid stays fixed-split / legacy-pinned). This file pins
 * two things:
 *  1. The legacy fixed-split values are still reproducible *on demand* via the
 *     explicit overrides (IntegrationOptions / getArea's `splits` arg), and they
 *     match the standalone {@link simpsonIntegral} reference exactly.
 *  2. The new adaptive default is converged — it sits on top of a much finer
 *     fixed-split integral (the convergence oracle), so it is at least as
 *     accurate as the legacy default, not a regression.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getArea,
  getCenterOfMass,
  getCrossSectionAreaAt,
  getLength,
  getMaxThickness,
  getMaxThicknessAndPos,
  getMaxThicknessPos,
  getVolume,
  getVolumeAndCenterOfMass,
  getWidthAtPos,
} from './board';
import { T_ZERO } from './constants';
import { adaptiveSimpson, simpsonIntegral } from './math';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

// Legacy fixed-split resolutions (BezierBoard.*_SPLITS), reproduced on demand.
const LEGACY_VOLUME = { sectionSplits: 10, lengthSplits: 30 } as const;
const LEGACY_AREA_SPLITS = 10;
const LEGACY_MASS = { sectionSplits: 10, lengthSplits: 10 } as const;

for (const name of ['shortboard', 'funboard', 'longboard']) {
  describe(`integration resolution: ${name}`, () => {
    const b = loadBoard(name);

    it('adaptive volume default is converged (near a 4x-finer fixed integral)', () => {
      const adaptive = getVolume(b);
      const fine = getVolume(b, { sectionSplits: 40, lengthSplits: 120 });
      expect(Math.abs(adaptive - fine) / fine).toBeLessThan(0.005);
    });

    it('adaptive area default equals the converged area to <0.01%', () => {
      // AREA_SPLITS=10 is the least-converged legacy resolution; adaptive lands
      // on the converged value. Oracle: a 1e-9 adaptive integral of the width.
      const adaptive = getArea(b);
      const converged = adaptiveSimpson((x) => getWidthAtPos(b, x), 0, getLength(b), 1e-9);
      expect(Math.abs(adaptive - converged) / converged).toBeLessThan(0.0001);
    });

    it('adaptive CoM default is converged (near a 4x-finer fixed integral)', () => {
      const adaptive = getCenterOfMass(b);
      const fine = getCenterOfMass(b, { sectionSplits: 40, lengthSplits: 120 });
      expect(Math.abs(adaptive - fine)).toBeLessThan(0.25);
    });

    it('explicit legacy splits reproduce the standalone fixed-split reference', () => {
      const len = getLength(b);
      // Same integrand, bounds and split count getVolume's legacy default used.
      const refVol = simpsonIntegral(
        (x) => getCrossSectionAreaAt(b, x, LEGACY_VOLUME.sectionSplits),
        0.01,
        len - 0.01,
        LEGACY_VOLUME.lengthSplits,
      );
      expect(getVolume(b, LEGACY_VOLUME)).toBe(refVol);

      // getArea integrates over [T_ZERO, len - T_ZERO]; match it bit-for-bit.
      const refArea = simpsonIntegral(
        (x) => getWidthAtPos(b, x),
        T_ZERO,
        len - T_ZERO,
        LEGACY_AREA_SPLITS,
      );
      expect(getArea(b, LEGACY_AREA_SPLITS)).toBe(refArea);
    });

    it('legacy explicit splits differ from the adaptive default (the divergence is real)', () => {
      // Sanity: the new default is genuinely a different number from the legacy
      // fixed-split value (otherwise the divergence ledger entry would be moot).
      expect(getArea(b, LEGACY_AREA_SPLITS)).not.toBe(getArea(b));
    });

    it('explicit legacy CoM splits stay available and finite', () => {
      const com = getCenterOfMass(b, LEGACY_MASS);
      expect(Number.isFinite(com)).toBe(true);
      expect(com).toBeGreaterThan(0);
      expect(com).toBeLessThan(getLength(b));
    });
  });
}

describe('combined getters return exactly what the separate ones do', () => {
  for (const name of ['shortboard', 'funboard', 'longboard']) {
    it(`${name}: volume + CoM share one integral, bit for bit`, () => {
      const b = loadBoard(name);
      const both = getVolumeAndCenterOfMass(b);
      expect(both.volume).toBe(getVolume(b));
      expect(both.centerOfMass).toBe(getCenterOfMass(b));
      const s = { ...b, interpolationType: 'sLinear' as const };
      expect(getVolumeAndCenterOfMass(s)).toEqual({
        volume: getVolume(s),
        centerOfMass: getCenterOfMass(s),
      });
    });

    it(`${name}: max thickness and its position from one scan`, () => {
      const b = loadBoard(name);
      expect(getMaxThicknessAndPos(b)).toEqual({
        max: getMaxThickness(b),
        pos: getMaxThicknessPos(b),
      });
    });
  }
});
