// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `defaults.ts` is imported at run time by code that must not load the engine (the store, in the
 * app's main chunk), so it may import nothing: one import would pull its module, and that
 * module's, into that chunk. The engine's own parameters are the same numbers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RADIUS_CROTCH, RADIUS_NOSE, RADIUS_TAIL, RAIL_LIMITS } from './defaults';
import { RAIL_DOMAIN, TRIM } from './params';

const here = dirname(fileURLToPath(import.meta.url));

/** The file's code with its comments taken out, so a comment that mentions an import does not count. */
function code(): string {
  return readFileSync(join(here, 'defaults.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('board2/defaults', () => {
  it('imports nothing, statically or dynamically', () => {
    const src = code();
    expect(src).not.toMatch(/\bimport\b/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bexport\b[^;]*\bfrom\b/);
  });

  it('is where the engine takes its corner radii from', () => {
    expect(TRIM.radiusNose).toBe(RADIUS_NOSE);
    expect(TRIM.radiusTail).toBe(RADIUS_TAIL);
    expect(TRIM.radiusCrotch).toBe(RADIUS_CROTCH);
  });

  it("is where the engine takes its rail clamps from, and holds the engine's own", () => {
    expect(TRIM.bandMin).toBe(RAIL_LIMITS.band[0]);
    expect(TRIM.bandMin).toBe(RAIL_LIMITS.tuck[0]);
    // the widest band: bandHard of the feature size the loop caps
    expect(TRIM.bandHard * TRIM.featureCap).toBe(RAIL_LIMITS.band[1]);
    expect(RAIL_LIMITS.tuck[1]).toBe(RAIL_LIMITS.band[1]);
    expect(RAIL_LIMITS.hardness).toEqual([TRIM.rhoInset, 1 - TRIM.rhoInset]);
    expect(RAIL_LIMITS.tuckShape).toEqual([TRIM.rhoInset, 1 - TRIM.rhoInset]);
    expect(RAIL_LIMITS.apex).toEqual([TRIM.apexInset, 1 - TRIM.apexInset]);
  });

  it('is inside the range a board may hold (RAIL_DOMAIN)', () => {
    for (const name of Object.keys(RAIL_LIMITS) as (keyof typeof RAIL_LIMITS)[]) {
      expect(RAIL_DOMAIN[name][0]).toBeLessThanOrEqual(RAIL_LIMITS[name][0]);
      expect(RAIL_DOMAIN[name][1]).toBeGreaterThanOrEqual(RAIL_LIMITS[name][1]);
    }
  });
});
