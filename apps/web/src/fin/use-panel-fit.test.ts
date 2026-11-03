// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign, defaultKeel, placeOnBase, type FinDesign } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { bestPoseOf, panelFitOf, panelOutline } from './use-panel-fit';

/** A side fin on an FCS tab with no cant, cut from a panel `mm` thick. */
const fcsFin = (mm: number, angle = 0): FinDesign => ({
  ...placeOnBase(defaultFinDesign('side', 'left'), 'fcs-single'),
  panel: { thickness: mm / 10, angle },
});

type P = readonly [number, number, number];
const sub = (a: P, b: P) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const;
const len = (v: readonly number[]) => Math.hypot(...v);

/** Per test, for the pose searches: slow on a loaded CI runner. */
const HEAVY = 20_000;

describe('panel fit in the app', () => {
  it('has nothing to say without a panel', () => {
    expect(panelFitOf(defaultFinDesign('side', 'left'), 0.1)).toBeNull();
  });

  it('fits an 8 mm FCS fin in a 3/8" panel, not in a 1/4" one', () => {
    expect(panelFitOf(fcsFin(9.525), 0.1)!.fits).toBe(true);
    const thin = panelFitOf(fcsFin(6.35), 0.1)!;
    expect(thin.fits).toBe(false);
    expect(thin.width * 10).toBeCloseTo(8, 1);
  });

  it('outlines an upright panel round the fin: its thickness across, the fin’s height up', () => {
    const d = fcsFin(9.525);
    const fit = panelFitOf(d, 0.1)!;
    const o = panelOutline(fit);
    const [a, b, c, dd] = o.corners as [P, P, P, P];
    expect(o.fits).toBe(true);
    // Across (Y, at angle 0) by the panel's thickness, upright, round the whole fin.
    expect(len(sub(b, a))).toBeCloseTo(0.9525, 9);
    expect(b[1] - a[1]).toBeCloseTo(0.9525, 9);
    const zs = fit.points.map((p) => p.z);
    expect(a[2]).toBeCloseTo(Math.min(...zs), 9);
    expect(c[2]).toBeCloseTo(Math.max(...zs), 9);
    expect(dd[1]).toBeCloseTo(a[1], 9);
    // Centred on the fin.
    expect((a[1] + b[1]) / 2).toBeCloseTo((fit.lo + fit.hi) / 2, 9);
  });

  it('turns the outline with the fin: across the panel, square to the angle', () => {
    const o = panelOutline(panelFitOf(fcsFin(9.525, 10), 0.1)!);
    const [a, b] = o.corners as [P, P];
    const across = sub(b, a);
    expect((Math.atan2(across[1], across[0]) * 180) / Math.PI).toBeCloseTo(100, 6);
    expect(o.angle).toBe(10);
  });

  it(
    'fits a canted Futures keel in a 3/8" panel by tilting it, and leans the outline',
    () => {
      const keel = defaultKeel();
      const d: FinDesign = { ...keel, panel: { thickness: 0.9525, angle: 0 } };
      expect(panelFitOf(d, 0.1)!.fits).toBe(false); // upright, the leaning blade sticks out
      const pose = bestPoseOf(d, 0.1);
      expect(pose.tilt).toBeGreaterThan(0);
      const fit = panelFitOf({ ...d, panel: { ...d.panel!, ...pose } }, 0.1)!;
      expect(fit.fits).toBe(true);
      // A left fin leans to +Y: the outline's long sides lean that way by the tilt.
      const [a, , , dd] = panelOutline(fit).corners as [P, P, P, P];
      const up = sub(dd, a);
      expect((Math.atan2(up[1], up[2]) * 180) / Math.PI).toBeCloseTo(pose.tilt, 6);
      // A right keel is the mirror: its outline leans to −Y.
      const right: FinDesign = { ...defaultKeel('right'), panel: { thickness: 0.9525, ...pose } };
      const [ra, , , rd] = panelOutline(panelFitOf(right, 0.1)!).corners as [P, P, P, P];
      expect(rd[1] - ra[1]).toBeCloseTo(-up[1], 3);
    },
    HEAVY,
  );
});
