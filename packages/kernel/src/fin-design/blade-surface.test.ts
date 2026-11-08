// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { evalSurface, knotMultiplicities } from '../bspline-surface';
import { FIN_TIP_CAP, bladeTop, chordAt, prepareBlade } from './blade';
import {
  BLADE_CI_TOLERANCE,
  BLADE_DEFAULTS,
  bladeSurfaceDeviation,
  fitBladeSurface,
} from './blade-surface';
import { defaultFinDesign, defaultKeel, defaultTwinFin } from './fin-defaults';
import { finMesh } from './fin-mesh';
import { FIN_POSITIONS, type FinDesign } from './fin-design';

const designs: [string, FinDesign][] = [
  ...FIN_POSITIONS.map((p): [string, FinDesign] => [p, defaultFinDesign(p, 'right')]),
  ['left side', defaultFinDesign('side', 'left')],
  ['side at 20° cant', { ...defaultFinDesign('side', 'right'), cant: 20 }],
];

describe.each(designs)('fitBladeSurface(%s)', (_, d) => {
  const m = fitBladeSurface(d);
  const s = m.surface;

  it('meets its own accuracy target', () => {
    expect(m.deviation).toBeLessThanOrEqual(BLADE_DEFAULTS.tolerance);
  });

  it('follows the blade when measured on different slices than the fit used', () => {
    const b = prepareBlade(d);
    expect(bladeSurfaceDeviation(b, s, m.topZ, 31, 211)).toBeLessThanOrEqual(BLADE_CI_TOLERANCE);
    // Everything but the last 0.5% under the tip holds the fit target itself.
    expect(bladeSurfaceDeviation(b, s, m.topZ, 31, 211, 0.995)).toBeLessThanOrEqual(
      BLADE_DEFAULTS.tolerance,
    );
  });

  it('closes on its seam exactly', () => {
    expect(s.ctrl[s.ctrl.length - 1]).toEqual(s.ctrl[0]);
  });

  it('sits its root on the tab top and its top just under the tip', () => {
    for (const row of s.ctrl) {
      expect(Math.abs(row[0]!.z)).toBeLessThan(1e-12);
      expect(Math.abs(row[row.length - 1]!.z - m.topZ)).toBeLessThan(1e-12);
    }
    expect(m.topZ).toBeCloseTo(bladeTop(prepareBlade(d), BLADE_DEFAULTS.tipGap), 12);
  });

  it('creases at the four section corners and nowhere else around', () => {
    const { mults } = knotMultiplicities(s.uKnots);
    // Three interior corners; the fourth is the seam at u = 0 / 1.
    expect(mults.slice(1, -1).filter((k) => k === s.uDegree)).toHaveLength(3);
    expect(m.corners).toHaveLength(3);
  });

  it('stays smooth up the blade past the outline corner', () => {
    // The FinFoil outline has one sharp knot, on the trailing edge near the tip. The foil
    // is laid over smoothed edges, so it no longer creases the blade all the way round.
    const { mults } = knotMultiplicities(s.vKnots);
    expect(mults.slice(1, -1).filter((k) => k === s.vDegree)).toHaveLength(0);
  });
});

describe('bladeSurfaceDeviation', () => {
  it('notices a fit that is too coarse', () => {
    // Guards the metric itself: a 4-row, 4-station grid cannot follow the blade.
    const d = defaultFinDesign('side');
    const m = fitBladeSurface(d, { rows: 4, stations: 4, maxRefinements: 0 });
    expect(m.deviation).toBeGreaterThan(10 * BLADE_DEFAULTS.tolerance);
  });
});

describe("the cap under the tip (round 4 testing: a flat on the keel's top edge)", () => {
  const chord = (b: ReturnType<typeof prepareBlade>, h: number) => {
    const c = chordAt(b, h);
    return c.leading - c.trailing;
  };
  const gap = BLADE_DEFAULTS.tipGap;

  it.each([
    ['keel', defaultKeel()],
    ['twin', defaultTwinFin()],
    ['side', defaultFinDesign('side', 'right')],
  ] as const)('is at most FIN_TIP_CAP long, and never lower than the gap: %s', (_, d) => {
    const b = prepareBlade(d);
    const top = bladeTop(b, gap);
    expect(top).toBeGreaterThanOrEqual(b.depth - gap);
    expect(top).toBeLessThan(b.depth);
    expect(chord(b, top)).toBeLessThanOrEqual(FIN_TIP_CAP + 1e-9);
    // Raised only as far as it takes.
    if (top > b.depth - gap) expect(chord(b, top)).toBeCloseTo(FIN_TIP_CAP, 6);
  });

  it('closes the keel and twin with a short cap in the STEP surface and the mesh', () => {
    for (const d of [defaultKeel(), defaultTwinFin()]) {
      const b = prepareBlade(d);
      // What a cap at the old fixed gap would have been: several mm of flat.
      expect(chord(b, b.depth - gap)).toBeGreaterThan(0.5);
      const m = fitBladeSurface(d);
      const xs = Array.from({ length: 401 }, (_, i) => evalSurface(m.surface, i / 400, 1).x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(FIN_TIP_CAP + 1e-3);
      for (const row of m.surface.ctrl) {
        expect(Math.abs(row[row.length - 1]!.z - m.topZ)).toBeLessThan(1e-12);
      }
      const mesh = finMesh(d).blade;
      const p = mesh.positions;
      let zMax = -Infinity;
      for (let i = 2; i < p.length; i += 3) zMax = Math.max(zMax, p[i]!);
      const top: number[] = [];
      for (let i = 0; i < p.length; i += 3) if (p[i + 2] === zMax) top.push(p[i]!);
      expect(zMax).toBeCloseTo(b.depth, 2); // up to the top of the tip
      expect(top.length).toBeGreaterThan(0);
    }
  });
});
