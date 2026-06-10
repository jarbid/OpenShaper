// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Convergence of the (parameterizable) integration resolutions: the legacy
 * default splits must already be near the converged value, so the golden
 * pinning and any caller-supplied higher resolution agree to well under the
 * 1% golden band. Guards the "defaults are converged" claim in board.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getArea, getCenterOfMass, getVolume } from './board';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

for (const name of ['shortboard', 'funboard', 'longboard']) {
  describe(`integration convergence: ${name}`, () => {
    const b = loadBoard(name);

    it('volume at 4× the legacy resolution moves < 0.5%', () => {
      const coarse = getVolume(b);
      const fine = getVolume(b, { sectionSplits: 40, lengthSplits: 120 });
      expect(Math.abs(fine - coarse) / coarse).toBeLessThan(0.005);
    });

    it('area at 4× the legacy resolution stays inside the 1% golden band', () => {
      // The legacy AREA_SPLITS=10 is the least-converged resolution: the
      // longboard's area moves ~0.63% under refinement (volume/CoM < 0.1%).
      const coarse = getArea(b);
      const fine = getArea(b, 40);
      expect(Math.abs(fine - coarse) / coarse).toBeLessThan(0.01);
    });

    it('center of mass at 4× the legacy resolution moves < 0.25 cm', () => {
      const coarse = getCenterOfMass(b);
      const fine = getCenterOfMass(b, { sectionSplits: 40, lengthSplits: 40 });
      expect(Math.abs(fine - coarse)).toBeLessThan(0.25);
    });

    it('explicit legacy splits reproduce the defaults exactly', () => {
      expect(getVolume(b, { sectionSplits: 10, lengthSplits: 30 })).toBe(getVolume(b));
      expect(getArea(b, 10)).toBe(getArea(b));
      expect(getCenterOfMass(b, { sectionSplits: 10, lengthSplits: 10 })).toBe(getCenterOfMass(b));
    });
  });
}
