// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from '../bezier-spline';
import { knot } from '../knot';
import { vec2 } from '../vec2';
import { bladeSection, moveFoilThickest, prepareBlade, sectionThickest } from './blade';
import { defaultFinDesign, defaultKeel, defaultSingleFin, defaultTwinFin } from './fin-defaults';
import type { FinDesign, FinTwist } from './fin-design';
import {
  defaultTipLine,
  outlineAtFraction,
  sweepFrame,
  tipLineOf,
  tipTurnFraction,
} from './swept-loft';

const here = dirname(fileURLToPath(import.meta.url));

/** An owner's fin from docs/specs/fins (mm → cm), slices and twist included. */
const ownerFin = (name: string): FinDesign => {
  type Row = { e: [number, number]; p: [number, number]; n: [number, number]; c: boolean };
  type Section = { outside: Row[]; inside: Row[] | null };
  const file = JSON.parse(
    readFileSync(resolve(here, '../../../../docs/specs/fins', name), 'utf8'),
  ) as {
    hand: 'left' | 'right';
    cant?: number;
    outline: Row[];
    section: Section;
    slices?: { height: number; section: Section; twist?: FinTwist }[];
    taper: Row[];
    tipLine?: { start: number; end: number };
    tipSection?: Section;
    thicknessMid?: number;
  };
  const spline = (rows: Row[], fx: number, fy: number) =>
    splineFromKnots(
      rows.map((k) =>
        knot(
          vec2(k.e[0] * fx, k.e[1] * fy),
          vec2(k.p[0] * fx, k.p[1] * fy),
          vec2(k.n[0] * fx, k.n[1] * fy),
          k.c,
        ),
      ),
    );
  const section = (sec: Section) => ({
    outside: spline(sec.outside, 1, 1),
    inside: sec.inside ? spline(sec.inside, 1, 1) : null,
  });
  return {
    ...defaultFinDesign('side', file.hand),
    cant: file.cant ?? 0,
    outline: spline(file.outline, 0.1, 0.1),
    section: section(file.section),
    slices: (file.slices ?? []).map((sl) => ({
      height: sl.height,
      section: section(sl.section),
      ...(sl.twist ? { twist: sl.twist } : {}),
    })),
    taper: spline(file.taper, 1, 0.1),
    ...(file.tipLine ? { tipLine: file.tipLine } : {}),
    ...(file.tipSection ? { tipSection: section(file.tipSection) } : {}),
    ...(file.thicknessMid !== undefined ? { thicknessMid: file.thicknessMid } : {}),
  };
};

const FINS: [string, () => FinDesign][] = [
  ['side', () => defaultFinDesign('side', 'left')],
  ['right side', () => defaultFinDesign('side', 'right')],
  ['centre', () => defaultFinDesign('centre')],
  ['keel', () => defaultKeel()],
  ['twin', () => defaultTwinFin()],
  ['single', () => defaultSingleFin()],
  ['hatchet', () => ownerFin('hatchet_hook.fin.json')],
  ['A4C', () => ownerFin('a4c_raised_rear.fin.json')],
  ['corner test fin', () => ownerFin('corner_creases.fin.json')],
  ['steep tip line', () => ownerFin('steep_tip_line.fin.json')],
];

describe('the sides of the profile', () => {
  it.each(FINS)('puts the default tip line across the tip, on the outline: %s', (_, make) => {
    const d = make();
    const [a, b] = defaultTipLine(d);
    const depth = prepareBlade(d).depth;
    for (const p of [a, b]) expect(p.y).toBeGreaterThan(0.6 * depth);
    // Its leading-edge end no further round than where the leading edge turns onto the top.
    expect(tipLineOf({ ...d, tipLine: undefined }).start).toBeLessThanOrEqual(
      tipTurnFraction(d.outline) + 1e-9,
    );
    expect(sweepFrame(d).base.pts[0]!.y).toBeCloseTo(0, 9);
  });

  it('follows a tip line the user has moved', () => {
    const d = defaultFinDesign('side', 'left');
    const line = { start: 0.35, end: 0.6 };
    expect(tipLineOf({ ...d, tipLine: line }).start).toBeCloseTo(0.35, 3);
    const f = sweepFrame({ ...d, tipLine: line });
    const want = outlineAtFraction(d.outline, 0.35);
    expect(f.tipStart.x).toBeCloseTo(want.x, 9);
    expect(f.tipStart.y).toBeCloseTo(want.y, 9);
  });

  it('moves a foil’s thickest point, keeping its ends', () => {
    const d = defaultFinDesign('side', 'left');
    for (const to of [0.2, 0.3, 0.5, 0.6]) {
      const m = moveFoilThickest(d.section, to);
      expect(sectionThickest(m).at).toBeCloseTo(to, 2);
      expect(m.outside.knots[0]!.end).toEqual(d.section.outside.knots[0]!.end);
      expect(m.outside.knots.at(-1)!.end).toEqual(d.section.outside.knots.at(-1)!.end);
    }
  });

  it('thickens the edges and tip to it, the rest on its thickness curve', () => {
    const base = defaultFinDesign('side', 'left');
    // The taper's tip lifted with it, as the store does.
    const last = base.taper.knots.length - 1;
    const taper = splineFromKnots(
      base.taper.knots.map((k, i) =>
        i === last ? knot(vec2(1, 0.1), vec2(k.tangentToPrev.x, 0.1), vec2(1, 0.1), false) : k,
      ),
    );
    const d = { ...base, taper, minThickness: 0.1 };
    const b = prepareBlade(d);
    const width = (s: ReturnType<typeof bladeSection>, j: number) =>
      Math.abs(s.outside[j]!.y - s.inside[j]!.y);
    expect(b.minThickness).toBe(0.1);
    for (const eta of [0.2, 0.5, 0.8]) {
      const s = bladeSection(b, eta * b.depth, [0, 0.5, 1]);
      // Across a horizontal cut, wider by the cant's 1/cos.
      expect(width(s, 0)).toBeCloseTo(0.1 * b.widen, 6);
      expect(width(s, 2)).toBeCloseTo(0.1 * b.widen, 6);
      expect(width(s, 1)).toBeGreaterThan(0.1);
    }
    // An export's minimum still thickens it further, never thinner.
    expect(prepareBlade(d, undefined, 0.2).minThickness).toBe(0.2);
    expect(prepareBlade(d, undefined, 0.05).minThickness).toBe(0.1);
  });
});
