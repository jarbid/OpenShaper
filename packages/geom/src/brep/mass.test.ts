// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mass properties of B-reps (`mass.ts`; design §16 `integrate`, `mass` row):
 * volume, area and centroid against the closed forms.
 *
 * | solid                         | volume              | area                        | centroid        |
 * | ----------------------------- | ------------------- | --------------------------- | --------------- |
 * | box `a × b × c` (from 0)      | `abc`               | `2(ab + bc + ca)`           | `(a, b, c)/2`   |
 * | cylinder `r, h` (base at 0)   | `π r² h`            | `2π r h + 2π r²`            | `(0, 0, h/2)`   |
 * | sphere zone `r, φ`            | `π (r² h − h³/12)`  | `2π r h + 2π (r cos φ)²`    | origin          |
 * | torus `R, r`                  | `2π² R r²`          | `4π² R r`                   | origin          |
 * | plate `a × b × c`, hole `r`   | `abc − π r² c`      | `2(ab + bc + ca) + 2π r (c − r)` | `(a, b, c)/2` |
 *
 * Tolerances: polynomial faces integrate with exact Gauss rules, so only
 * rounding remains (`1e-13` relative; the centroid divides two such sums);
 * rational faces use adaptive Gauss–Kronrod with `quadRel = 1e-10` per nested
 * integral, so the stated bound is `1e-9` relative (volume, area) and `1e-9`
 * absolute on a centroid coordinate of solids of size ≤ 5.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES, makeBrep, massProperties, transformBrep } from '../index';
import type { Affine3, Brep } from '../index';
import {
  boxSolid,
  cylinderSolid,
  ellipticPuckSolid,
  plateWithHoleSolid,
  sphericalZoneSolid,
  torusSolid,
} from '../testing';
import { checksum } from '../testing';

const PI = Math.PI;

interface Case {
  readonly name: string;
  readonly brep: () => Brep;
  readonly volume: number;
  readonly area: number;
  readonly centroid: readonly [number, number, number];
  /** Relative tolerance of volume and area; absolute tolerance of the centroid. */
  readonly tol: number;
}
const zoneH = (r: number, phi: number): number => 2 * r * Math.sin(phi);
const CASES: readonly Case[] = [
  {
    name: 'box',
    brep: () => boxSolid(2, 3, 5),
    volume: 30,
    area: 62,
    centroid: [1, 1.5, 2.5],
    tol: 1e-13,
  },
  {
    name: 'trimmed box',
    brep: () => boxSolid(2, 3, 5, { trimmed: true }),
    volume: 30,
    area: 62,
    centroid: [1, 1.5, 2.5],
    tol: 1e-13,
  },
  {
    // Faces with hole loops: the closed form subtracts the hole's volume and area
    // (two discs of area π r², the wall adds 2π r c).
    name: 'plate with a hole',
    brep: () => plateWithHoleSolid(6, 5, 2, 1),
    volume: 60 - 2 * PI,
    area: 104 + 2 * PI,
    centroid: [3, 2.5, 1],
    tol: 1e-9,
  },
  {
    name: 'cylinder',
    brep: () => cylinderSolid(1.5, 4),
    volume: PI * 1.5 * 1.5 * 4,
    area: 2 * PI * 1.5 * 4 + 2 * PI * 1.5 * 1.5,
    centroid: [0, 0, 2],
    tol: 1e-9,
  },
  {
    name: 'zone',
    brep: () => sphericalZoneSolid(2, 1),
    volume: PI * (4 * zoneH(2, 1) - zoneH(2, 1) ** 3 / 12),
    area: 2 * PI * 2 * zoneH(2, 1) + 2 * PI * (2 * Math.cos(1)) ** 2,
    centroid: [0, 0, 0],
    tol: 1e-9,
  },
  {
    name: 'split zone',
    brep: () => sphericalZoneSolid(2, 1, { split: true }),
    volume: PI * (4 * zoneH(2, 1) - zoneH(2, 1) ** 3 / 12),
    area: 2 * PI * 2 * zoneH(2, 1) + 2 * PI * (2 * Math.cos(1)) ** 2,
    centroid: [0, 0, 0],
    tol: 1e-9,
  },
  {
    name: 'torus',
    brep: () => torusSolid(3, 1),
    volume: 2 * PI * PI * 3,
    area: 4 * PI * PI * 3,
    centroid: [0, 0, 0],
    tol: 1e-9,
  },
];

describe('massProperties against closed forms', () => {
  for (const c of CASES) {
    it(`${c.name}: volume, area, centroid`, () => {
      const b = c.brep();
      const before = checksum(b);
      const m = massProperties(b);
      expect(checksum(b), 'the input was written').toBe(before);
      expect(Math.abs(m.volume.value / c.volume - 1), 'volume').toBeLessThan(c.tol);
      expect(Math.abs(m.area.value / c.area - 1), 'area').toBeLessThan(c.tol);
      c.centroid.forEach((x, k) => {
        const got = [m.centroid.x, m.centroid.y, m.centroid.z][k]!;
        expect(Math.abs(got - x), `centroid ${'xyz'[k]}`).toBeLessThan(
          c.tol * Math.max(1, Math.abs(x)) * 5,
        );
      });
      expect(m.volume.converged).toBe(true);
      expect(m.area.converged).toBe(true);
      expect(Object.isFrozen(m)).toBe(true);
    });
  }
});

describe('massProperties invariants', () => {
  const move: Affine3 = [1, 0, 0, 100, 0, 1, 0, -50, 0, 0, 1, 20];
  it('translation by 100 cm leaves volume and area unchanged and moves the centroid', () => {
    for (const c of CASES) {
      const a = massProperties(c.brep());
      const m = massProperties(transformBrep(c.brep(), move));
      // Exact rules lose ≤ 3 digits to the 100 cm offset; adaptive ones keep quadRel. 1e-9 covers both.
      expect(Math.abs(m.volume.value / a.volume.value - 1), c.name).toBeLessThan(1e-9);
      expect(Math.abs(m.area.value / a.area.value - 1), c.name).toBeLessThan(1e-9);
      expect(m.centroid.x, c.name).toBeCloseTo(a.centroid.x + 100, 7);
      expect(m.centroid.y, c.name).toBeCloseTo(a.centroid.y - 50, 7);
      expect(m.centroid.z, c.name).toBeCloseTo(a.centroid.z + 20, 7);
    }
  });

  it('an inside-out shell has the negated volume (the sign is the measurement)', () => {
    const b = cylinderSolid(1.5, 4);
    const made = makeBrep({
      vertices: b.vertices,
      edges: b.edges,
      shells: b.shells,
      solids: b.solids,
      faces: b.faces.map((f) => ({
        ...f,
        sameSense: !f.sameSense,
        outer: {
          coedges: f.outer.coedges
            .slice()
            .reverse()
            .map((c) => ({ ...c, sense: !c.sense })),
        },
      })),
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const v = massProperties(b).volume.value;
    const w = massProperties(made.value).volume.value;
    expect(Math.abs(w + v) / v).toBeLessThan(1e-9);
  });

  it('flags that disagree with the loops are rejected, not integrated', () => {
    const b = cylinderSolid(1.5, 4);
    const bad = makeBrep({
      vertices: b.vertices,
      edges: b.edges,
      shells: b.shells,
      solids: b.solids,
      faces: b.faces.map((f, i) => (i === 0 ? { ...f, sameSense: !f.sameSense } : f)),
    });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(() => massProperties(bad.value)).toThrow(/not a valid trimmed surface/);
  });

  it('the comparison can fail: a box scaled by 1 + 1e-6 is not the box', () => {
    const scale: Affine3 = [1.000001, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const m = massProperties(transformBrep(boxSolid(2, 3, 5), scale));
    expect(Math.abs(m.volume.value / 30 - 1)).toBeGreaterThan(5e-7);
  });
});

/** Rotation by `angle` about `axis` (Rodrigues), then translation `t` (as in step.occt.test.ts). */
function rotation(
  axis: readonly [number, number, number],
  angle: number,
  t: readonly [number, number, number],
): Affine3 {
  const n = Math.hypot(...axis);
  const [x, y, z] = axis.map((a) => a / n) as [number, number, number];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    t[0],
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    t[1],
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
    t[2],
  ];
}

describe('the absolute quadrature targets (G2) keep the relative contract', () => {
  const QREL = DEFAULT_TOLERANCES.quadRel;
  const rot = rotation([1, 2, 3], 0.6, [5, -3, 2]);
  /** The V5 board of the OCCT corpus: a rational band, a planar bottom trimmed by a rational ellipse. */
  const board = (): Brep => ellipticPuckSolid(90, 27, 6, { bicubicDeck: true, tilt: 0.04 });

  it('the volume error target scales with the solid, not its control box: a rotation leaves it unchanged', () => {
    // The target is quadRel · (Σ_f ∫|f_f| / 3 + |V|) (enclosedVolume), invariant under a rigid
    // motion of these symmetric nets (the box centre moves with the solid); a box-scaled target
    // grew 6 to 13 times under this rotation (cylinder 2.2e-9 → 1.5e-8). Estimates of the two
    // runs agree to 1e-3 (measured 2.5e-6: the same nested partitions up to rounding).
    const cases: readonly (readonly [string, () => Brep, boolean])[] = [
      ['cylinder', () => cylinderSolid(1.5, 4), true],
      ['zone', () => sphericalZoneSolid(2, 1), true],
      ['torus', () => torusSolid(3, 1), false],
    ];
    for (const [name, make, starShaped] of cases) {
      const a = massProperties(make()).volume;
      const r = massProperties(transformBrep(make(), rot)).volume;
      expect(Math.abs(r.errorEstimate / a.errorEstimate - 1), name).toBeLessThan(1e-3);
      // Star-shaped about the box centre: Σ ∫|f| / 3 = |V|, so the target is 2 · quadRel · |V|.
      if (starShaped) expect(r.errorEstimate, name).toBeLessThanOrEqual(2 * QREL * r.value);
    }
  });

  it('the rational corpus keeps the values the integrators gave before the absolute targets', () => {
    // Characterization (full precision, from the parent of the G2 commit): none of these
    // faces reaches the absolute target before the relative one, so nothing moves.
    const before: readonly (readonly [string, () => Brep, number, readonly number[]])[] = [
      [
        'cylinder',
        () => cylinderSolid(1.5, 4),
        28.27433388230814,
        [4.440892098500626e-16, 4.440892098500626e-16, 1.9999999999999998],
      ],
      [
        'rotated cylinder',
        () => transformBrep(cylinderSolid(1.5, 4), rot),
        28.274333882308145,
        [5.678484359742949, -3.1521017672747016, 3.875239724935483],
      ],
      [
        'torus',
        () => torusSolid(3, 1),
        59.21762640653616,
        [-1.3322676295501878e-15, -8.881784197001252e-16, -1.1102230246251565e-16],
      ],
      [
        'rotated torus',
        () => transformBrep(torusSolid(3, 1), rot),
        59.217626406536176,
        [4.999999999999997, -3, 1.9999999999999998],
      ],
      ['zone', () => sphericalZoneSolid(2, 1), 32.313830876438026, [0, 0, 0]],
      [
        'rotated zone',
        () => transformBrep(sphericalZoneSolid(2, 1), rot),
        32.31383087643803,
        [4.999999999999999, -2.999999999999999, 2.0000000000000004],
      ],
      [
        'board',
        board,
        45804.42088884546,
        [13.500000089500844, 1.94023641597596e-9, 3.269999997234596],
      ],
    ];
    for (const [name, make, volume, centroid] of before) {
      const m = massProperties(make());
      expect(m.volume.value, name).toBe(volume);
      expect([m.centroid.x, m.centroid.y, m.centroid.z], name).toEqual(centroid);
    }
  });

  it('a face through the reference point (noise) converges on the absolute target, cheaply', () => {
    // Rotated, the board's planar bottom passes through the control box's centre up to
    // rounding: its volume integrand is noise. Before the absolute targets it refined to
    // 381,528 evaluations; now 14,328 (with the scale pass). The result moves by rounding only:
    // 1.6e-16 relative and 5.7e-14 cm measured, held to 1e-15 and 1e-12 (reach ~100 cm × 1e-14).
    const m = massProperties(transformBrep(board(), rot));
    expect(m.volume.converged).toBe(true);
    expect(m.volume.evaluations).toBeLessThan(50_000);
    expect(Math.abs(m.volume.value / 45804.42088538938 - 1)).toBeLessThan(1e-15);
    [17.41977829687093, 3.1999020520979684, 1.4968057186457884].forEach((x, k) =>
      expect(Math.abs([m.centroid.x, m.centroid.y, m.centroid.z][k]! - x)).toBeLessThan(1e-12),
    );
    expect(m.centroidConverged).toBe(true);
    for (const k of ['x', 'y', 'z'] as const) {
      // The reported bound is the integrators' estimates carried through c + M / V: an honest,
      // loose bound (Green's estimates grow with the trims' v-variation, §15.7). Measured
      // 7.9e-6 cm on a 255 cm reach; held to 1e-4 cm, and it must cover the move above.
      expect(m.centroidError[k]).toBeGreaterThan(1e-12);
      expect(m.centroidError[k]).toBeLessThan(1e-4);
    }
  });
});
