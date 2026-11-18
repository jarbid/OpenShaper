// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Patches palette under colour-blind sight. Every colour of the look is simulated as a person
 * with deuteranopia, protanopia or tritanopia sees it (Machado, Oliveira and Fernandes 2009, full
 * severity, in linear light), and as anyone does, and each pair is measured in OKLab, scaled by
 * 100 (about 1 is a step just seen, 10 plainly another colour).
 *
 * The floor, `MIN_DISTANCE`, comes from a palette made for this: Okabe and Ito's seven colours,
 * whose closest pair is 7.6 in this measure (the first test checks it), so the bar is one a
 * colour-blind safe palette clears and not one fitted to this look. Every pair that involves a
 * colour chosen for this look clears it. The colours the reference page gave (the two panels and
 * the first three zones) were not chosen here: pairs among them are held to the distances they
 * have, and the closest pair of all is one of them, teal against blue under tritanopia.
 */
import { describe, expect, it } from 'vitest';
import { PATCH_COLORS, RAIL_NO_ZONES_COLOR, RAIL_ZONE_COLORS, hexToLinear } from './patches';

type Vec3 = readonly [number, number, number];

/** The three simulations, 3 x 3 matrices on linear RGB (Machado et al. 2009, severity 1.0). */
const VISION: Readonly<Record<string, readonly (readonly number[])[] | null>> = {
  normal: null,
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** A linear colour as seen with `vision`. */
const seen = (c: Vec3, vision: string): Vec3 => {
  const m = VISION[vision];
  if (!m) return c;
  const [r, g, b] = m.map((row) => clamp01(row[0]! * c[0] + row[1]! * c[1] + row[2]! * c[2]));
  return [r!, g!, b!];
};

/** A linear sRGB colour in OKLab (Ottosson). */
const oklab = ([r, g, b]: Vec3): Vec3 => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

/** The distance of two hex colours as someone with `vision` sees them. */
const distance = (a: string, b: string, vision: string): number => {
  const p = oklab(seen(hexToLinear(a), vision));
  const q = oklab(seen(hexToLinear(b), vision));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

interface Closest {
  readonly a: string;
  readonly b: string;
  readonly vision: string;
  readonly d: number;
}

/** The closest pair, over every vision, among `colours` whose pair `skip` does not exclude. */
function closest(
  colours: readonly string[],
  skip: (a: string, b: string) => boolean = () => false,
): Closest {
  let best: Closest = { a: '', b: '', vision: '', d: Infinity };
  for (const vision of Object.keys(VISION)) {
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        const a = colours[i]!;
        const b = colours[j]!;
        if (skip(a, b)) continue;
        const d = distance(a, b, vision);
        if (d < best.d) best = { a, b, vision, d };
      }
    }
  }
  return best;
}

/** The bar: just under the closest pair of Okabe and Ito's palette in this measure. */
const MIN_DISTANCE = 7.5;
/** What the colours the reference gave keep among themselves (their own closest pair is 5.0). */
const GIVEN_FLOOR = 4.9;

const OKABE_ITO = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'];

const { deck, bottom, tailEdge, corner } = PATCH_COLORS;
/** What the reference page gave: the panels, and the first three zones. */
const GIVEN = new Set([deck, bottom, ...RAIL_ZONE_COLORS.slice(0, 3)].map((c) => c.toLowerCase()));
const given = (c: string): boolean => GIVEN.has(c.toLowerCase());
const lookColours = [deck, bottom, ...RAIL_ZONE_COLORS, tailEdge, corner];

describe('the colour-blind simulation', () => {
  it('keeps white white: every row of every matrix sums to 1', () => {
    for (const m of Object.values(VISION)) {
      for (const row of m ?? []) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
    for (const vision of Object.keys(VISION)) {
      const white = seen([1, 1, 1], vision);
      for (const c of white) expect(c).toBeCloseTo(1, 5);
    }
  });

  it('sets a bar that a palette made for colour-blind sight clears, and a look that does not, does not', () => {
    const oi = closest(OKABE_ITO);
    expect(oi.d).toBeGreaterThan(MIN_DISTANCE);
    expect(oi.d).toBeLessThan(MIN_DISTANCE + 0.5);
    // red and green, which deuteranopia and protanopia merge, are far under the bar
    expect(distance('#C0392B', '#2E8B3A', 'deuteranopia')).toBeLessThan(MIN_DISTANCE);
  });
});

describe('the palette under colour-blind sight', () => {
  it('has no colour twice', () => {
    expect(new Set(lookColours.map((c) => c.toLowerCase())).size).toBe(lookColours.length);
  });

  it('keeps every colour chosen for this look clear of every other, in all four sights', () => {
    const c = closest(lookColours, (a, b) => given(a) && given(b));
    expect(c.d, `${c.a} and ${c.b}, ${c.vision}`).toBeGreaterThan(MIN_DISTANCE);
  });

  it('keeps the colours the reference gave apart as far as they ever were', () => {
    const c = closest([...GIVEN]);
    expect(c.d, `${c.a} and ${c.b}, ${c.vision}`).toBeGreaterThan(GIVEN_FLOOR);
  });

  it('has the closest pair of the whole look in the reference: teal and blue under tritanopia', () => {
    const c = closest(lookColours);
    const [teal, blue] = RAIL_ZONE_COLORS;
    expect(new Set([c.a, c.b])).toEqual(new Set([teal, blue]));
    expect(c.vision).toBe('tritanopia');
    expect(c.d).toBeGreaterThan(GIVEN_FLOOR);
    expect(c.d).toBeLessThan(MIN_DISTANCE);
  });

  it('keeps zones that neighbour along the board clear of one another, the last of the first', () => {
    const n = RAIL_ZONE_COLORS.length;
    for (let i = 0; i < n; i++) {
      const a = RAIL_ZONE_COLORS[i]!;
      const b = RAIL_ZONE_COLORS[(i + 1) % n]!;
      const floor = given(a) && given(b) ? GIVEN_FLOOR : MIN_DISTANCE;
      for (const vision of Object.keys(VISION)) {
        expect(distance(a, b, vision), `zone ${i + 1} and the next, ${vision}`).toBeGreaterThan(
          floor,
        );
      }
    }
  });

  it('sets the tail edge and the corner apart from every zone and from each other', () => {
    for (const patch of [tailEdge, corner]) {
      for (const other of [...RAIL_ZONE_COLORS, patch === tailEdge ? corner : tailEdge]) {
        for (const vision of Object.keys(VISION)) {
          expect(
            distance(patch, other, vision),
            `${patch} and ${other}, ${vision}`,
          ).toBeGreaterThan(MIN_DISTANCE);
        }
      }
    }
  });

  it('keeps the rail where it has no zones clear of the panels, the tail edge and the corner', () => {
    for (const other of [deck, bottom, tailEdge, corner]) {
      for (const vision of Object.keys(VISION)) {
        expect(distance(RAIL_NO_ZONES_COLOR, other, vision), `${other}, ${vision}`).toBeGreaterThan(
          MIN_DISTANCE,
        );
      }
    }
  });

  it('keeps the two panels a clear but quiet step apart, in every sight', () => {
    for (const vision of Object.keys(VISION)) {
      const d = distance(deck, bottom, vision);
      expect(d, vision).toBeGreaterThan(GIVEN_FLOOR);
      expect(d, vision).toBeLessThan(MIN_DISTANCE + 2);
    }
  });
});
