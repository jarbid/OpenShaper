// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The column construction (docs/design/board2.md §5.3, §5.7, §13.2 `profile`).
 *
 * Oracles, all on planar deck and bottom samplers (`z = c + g·(x, y)`, so the
 * slopes along ô are the closed forms `−g · n̂`) in station planes at random
 * plan angles (seeded):
 *
 * - **Closed form**: every row equals the §5.3 construction written out
 *   independently in 3D vectors (corner points, handle fractions, the rotated
 *   tuck handle by `cos`/`sin` of the summed angle). 1e-12 × scale: a few flops
 *   on cm-sized values.
 * - **f = 2/3 is the exact parabola**: P1, P2 are the degree elevation
 *   `(E + 2C)/3`, `(2C + A)/3` of the quadratic (E, C_u, A). 1e-12 × scale.
 * - **Inverse**: {@link measureColumn} returns the inputs (insets, apex height,
 *   fullnesses, hardness) of a column with no offsets. 1e-12 (fractions; insets
 *   relative to the scale): the inverse formulas are a handful of flops.
 * - **Tuck crease = h · φ_chord** in the station plane, from the points (the
 *   angle of P5 − T from the bottom tangent). 1e-12 rad.
 * - **Convexity on a law grid**: the seven-point polygon turns one way only
 *   (cross products of consecutive edges ≤ rounding), for apex height, both
 *   fullnesses and hardness over their ranges on a sloped deck and bottom.
 * - **Structure**: P2, P3, P4 share x and y bitwise (the apex G1 identity of
 *   §3.5), P0 and P6 lie on the samplers exactly, the weights are all 1.
 * - **Issues**: H_u ≤ 0, H_l ≤ 0, rail height below the minimum, a deck or tuck
 *   handle past the apex vertical, each with its code and σ; a good column has none.
 * - **apexLower offset**: P5 and the crease bitwise kept; measured hardness is
 *   `h · φ_law / φ_actual` (closed form, 1e-12).
 * - **Offsets** move only their rows, along their frame vectors, by their
 *   values (1e-12 × scale).
 */
import { mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import type { HeightSample } from '../height-field';
import { ZERO_OFFSETS } from '../offsets';
import type { OffsetValues } from '../offsets';
import type { PlanFrame } from '../plan';
import { RAIL_LANES } from '../params';
import { measureColumn, profileRows } from './profile';
import type { ColumnSpec } from './profile';

const BUILD = { minRailHeight: 0.1 };
const AT = { sigma: 0.2, u: 0.2 };

type V = readonly [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (k: number, a: V): V => [k * a[0], k * a[1], k * a[2]];
const len = (a: V): number => Math.hypot(a[0], a[1], a[2]);

/** The plane `z = c + gx (x − 50) + gy y` (centred on the columns' x range). */
function plane(c: number, gx: number, gy: number): (x: number, y: number) => HeightSample {
  return (x, y) => ({ z: c + gx * (x - 50) + gy * y, dzdx: gx, dzdy: gy });
}

function frameAt(angle: number): PlanFrame {
  const t = { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
  return { tangent: t, inward: { x: -t.y, y: t.x, z: 0 } };
}

function spec(
  rng: () => number,
  over: Partial<ColumnSpec> = {},
): ColumnSpec & { readonly offsets: OffsetValues } {
  return {
    ax: 50 + 20 * rng() - 10,
    ay: 20 * rng() - 10,
    frame: frameAt(2 * Math.PI * rng()),
    deckInset: 1 + 6 * rng(),
    tuckInset: 0.5 + 3 * rng(),
    apexHeight: 0.2 + 0.6 * rng(),
    upperFullness: 0.1 + 0.85 * rng(),
    lowerFullness: 0.1 + 0.85 * rng(),
    edgeHardness: rng(),
    offsets: ZERO_OFFSETS,
    ...over,
  };
}

const pt = (p: Float64Array, r: number): V => [p[3 * r]!, p[3 * r + 1]!, p[3 * r + 2]!];

describe('profileRows: the §5.3 construction', () => {
  it('rows equal the closed-form construction (random planar deck and bottom, random frames)', () => {
    const rng = mulberry32(31);
    for (let k = 0; k < 200; k++) {
      // Gentle slopes, so every profile is valid; the deck well above the bottom.
      const deck = plane(8 + 2 * rng(), 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const bottom = plane(0.5 * rng(), 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const s = spec(rng);
      const col = profileRows(s, deck, bottom, BUILD, AT);
      expect(col.issues, `case ${k}`).toEqual([]);
      const n: V = [s.frame.inward.x, s.frame.inward.y, 0];
      const o: V = mul(-1, n);
      const z: V = [0, 0, 1];
      const A0: V = [s.ax, s.ay, 0];
      const E0 = add(A0, mul(s.deckInset, n));
      const T0 = add(A0, mul(s.tuckInset, n));
      const dE = deck(E0[0], E0[1]);
      const dT = bottom(T0[0], T0[1]);
      const E: V = [E0[0], E0[1], dE.z];
      const T: V = [T0[0], T0[1], dT.z];
      const sd = dE.dzdx * o[0] + dE.dzdy * o[1];
      const sb = dT.dzdx * o[0] + dT.dzdy * o[1];
      const A: V = [s.ax, s.ay, T[2] + s.apexHeight * (E[2] - T[2])];
      const Cu = add(add(E, mul(s.deckInset, o)), mul(sd * s.deckInset, z));
      const Cl = add(add(T, mul(s.tuckInset, o)), mul(sb * s.tuckInset, z));
      const Hu = Cu[2] - A[2];
      const Hl = A[2] - Cl[2];
      const ub = mul(1 / len(sub(Cl, T)), sub(Cl, T));
      const P4 = sub(A, mul(s.lowerFullness * Hl, z));
      const chord = sub(P4, T);
      // φ_chord: the angle from û_b to the chord in the (ô, ẑ) plane (signed: chord above).
      const ang = (v: V): number => Math.atan2(v[2], v[0] * o[0] + v[1] * o[1]);
      const phi = ang(chord) - ang(ub);
      const th = ang(ub) + s.edgeHardness * phi;
      const dir = add(mul(Math.cos(th), o), mul(Math.sin(th), z));
      const want: V[] = [
        E,
        add(E, mul(s.upperFullness, sub(Cu, E))),
        add(A, mul(s.upperFullness * Hu, z)),
        A,
        sub(A, mul(s.lowerFullness * Hl, z)),
        add(T, mul(s.lowerFullness * len(sub(Cl, T)), dir)),
        T,
      ];
      const scale = 250;
      for (let r = 0; r < 7; r++) {
        const got = pt(col.points, r);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(got[c]! - want[r]![c]!), `case ${k} row ${r}`).toBeLessThanOrEqual(
            1e-12 * scale,
          );
        }
      }
      expect(Math.abs(col.hu - Hu)).toBeLessThanOrEqual(1e-12 * scale);
      expect(Math.abs(col.hl - Hl)).toBeLessThanOrEqual(1e-12 * scale);
      expect(Math.abs(col.phiChord - phi)).toBeLessThanOrEqual(1e-12);
      // Structure: the apex handles share A's x, y bitwise; the edges are on the surfaces.
      for (const r of [2, 4]) {
        expect(col.points[3 * r]).toBe(col.points[9]);
        expect(col.points[3 * r + 1]).toBe(col.points[10]);
      }
      expect(col.points[2]).toBe(deck(col.points[0]!, col.points[1]!).z);
      expect(col.points[20]).toBe(bottom(col.points[18]!, col.points[19]!).z);
      expect(Array.from(col.weights)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    }
  });

  it('fullness 2/3 is the degree elevation of the quadratic (E, C_u, A): an exact parabola', () => {
    const rng = mulberry32(7);
    for (let k = 0; k < 50; k++) {
      const deck = plane(9, 0.08 * rng() - 0.04, 0.08 * rng() - 0.04);
      const bottom = plane(0, 0.05 * rng(), 0.05 * rng());
      const s = spec(rng, { upperFullness: 2 / 3 });
      const col = profileRows(s, deck, bottom, BUILD, AT);
      const E = pt(col.points, 0);
      const A = pt(col.points, 3);
      // The corner from the construction's own numbers: (A.xy, E.z + s_d w_d).
      const C: V = [A[0], A[1], E[2] + col.sd * s.deckInset];
      const p1 = mul(1 / 3, add(E, mul(2, C)));
      const p2 = mul(1 / 3, add(mul(2, C), A));
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(pt(col.points, 1)[c]! - p1[c]!)).toBeLessThanOrEqual(1e-12 * 250);
        expect(Math.abs(pt(col.points, 2)[c]! - p2[c]!)).toBeLessThanOrEqual(1e-12 * 250);
      }
    }
  });

  it('measureColumn returns the inputs, and the tuck crease is h · φ_chord', () => {
    const rng = mulberry32(11);
    for (let k = 0; k < 200; k++) {
      const deck = plane(8 + 2 * rng(), 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const bottom = plane(0.5 * rng(), 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const s = spec(rng);
      const col = profileRows(s, deck, bottom, BUILD, AT);
      const m = measureColumn(col.points, s.frame, col.sb);
      for (const lane of RAIL_LANES) {
        const want = s[lane];
        expect(Math.abs(m[lane] - want), `case ${k} ${lane}`).toBeLessThanOrEqual(
          1e-12 * Math.max(1, Math.abs(want)) * (lane.endsWith('Inset') ? 250 : 1),
        );
      }
      // The crease from the points: the angle of P5 − T from the bottom tangent.
      const T = pt(col.points, 6);
      const d = sub(pt(col.points, 5), T);
      const o = [-s.frame.inward.x, -s.frame.inward.y] as const;
      const crease = Math.atan2(d[2], d[0] * o[0] + d[1] * o[1]) - Math.atan2(col.sb, 1);
      expect(Math.abs(crease - s.edgeHardness * col.phiChord)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(col.crease - s.edgeHardness * col.phiChord)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('an apexLower offset keeps P5 and the crease; measured hardness reads the actual P4', () => {
    // The construction rotates towards the law's P4 (before the offset, deviation 1),
    // measureColumn towards the surface's actual P4: the crease (geometry) is kept,
    // and the measured hardness is h · φ_law / φ_actual (closed form).
    const rng = mulberry32(17);
    for (let k = 0; k < 50; k++) {
      const deck = plane(8 + 2 * rng(), 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const bottom = plane(0.5 * rng(), 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const s = spec(rng);
      const a = profileRows(s, deck, bottom, BUILD, AT);
      const off = { ...ZERO_OFFSETS, apexLowerZ: 0.1 + 0.2 * rng() };
      const b = profileRows({ ...s, offsets: off }, deck, bottom, BUILD, AT);
      expect(pt(b.points, 5)).toEqual(pt(a.points, 5));
      expect(b.crease).toBe(a.crease);
      expect(b.phiChord).toBe(a.phiChord);
      const T = pt(b.points, 6);
      const d4 = sub(pt(b.points, 4), T);
      const n = s.frame.inward;
      const phiActual = Math.atan2(d4[2], -(d4[0] * n.x + d4[1] * n.y)) - Math.atan2(b.sb, 1);
      const m = measureColumn(b.points, s.frame, b.sb);
      const want = (s.edgeHardness * a.phiChord) / phiActual;
      expect(Math.abs(m.edgeHardness - want), `case ${k}`).toBeLessThanOrEqual(1e-12);
      if (s.edgeHardness > 0.05) expect(m.edgeHardness).not.toBeCloseTo(s.edgeHardness, 6);
    }
  });

  it('every profile on a law grid is convex (one turning sense along P0 … P6)', () => {
    const deck = plane(9, 0.02, 0.06);
    const bottom = plane(0, -0.03, 0.04);
    const grid = [0.05, 0.3, 0.6, 0.95];
    const full = [0.05, 0.4, 2 / 3, 1];
    let cases = 0;
    for (const apexHeight of grid) {
      for (const upperFullness of full) {
        for (const lowerFullness of full) {
          for (const edgeHardness of [0, 0.25, 0.5, 0.75, 1]) {
            const s = spec(mulberry32(3), {
              apexHeight,
              upperFullness,
              lowerFullness,
              edgeHardness,
            });
            const col = profileRows(s, deck, bottom, BUILD, AT);
            if (col.issues.length > 0) continue;
            cases++;
            // Station-plane coordinates (o, z) of the seven points.
            const n = s.frame.inward;
            const q = Array.from({ length: 7 }, (_, r) => {
              const p = pt(col.points, r);
              return [-((p[0] - s.ax) * n.x + (p[1] - s.ay) * n.y), p[2]] as const;
            });
            for (let r = 0; r + 2 < 7; r++) {
              const a = [q[r + 1]![0] - q[r]![0], q[r + 1]![1] - q[r]![1]];
              const b = [q[r + 2]![0] - q[r + 1]![0], q[r + 2]![1] - q[r + 1]![1]];
              // Clockwise in (o, z) from the deck edge over the apex to the tuck.
              const cr = a[0]! * b[1]! - a[1]! * b[0]!;
              expect(
                cr,
                `apex ${apexHeight} fu ${upperFullness} fl ${lowerFullness} h ${edgeHardness} r ${r}`,
              ).toBeLessThanOrEqual(1e-12 * 100);
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(300);
  });
});

describe('profileRows: issues', () => {
  const rng = mulberry32(5);
  const base = spec(rng, {
    frame: frameAt(0),
    ax: 50,
    ay: -20,
    deckInset: 5,
    tuckInset: 2,
    apexHeight: 0.4,
  });
  const flatDeck = plane(6, 0, 0);
  const flatBottom = plane(0, 0, 0);

  it('a good column has none', () => {
    expect(profileRows(base, flatDeck, flatBottom, BUILD, AT).issues).toEqual([]);
  });

  it('a deck falling below the apex height is rail-profile-invalid (H_u ≤ 0)', () => {
    // At angle 0, n̂ = +ŷ and ô = −ŷ: z = 6 + 0.5 y drops 0.5 per cm outwards.
    const deck = plane(6, 0, 0.5);
    const issues = profileRows({ ...base, apexHeight: 0.9 }, deck, flatBottom, BUILD, AT).issues;
    expect(issues.map((i) => i.code)).toContain('rail-profile-invalid');
    expect(issues[0]!.at).toMatchObject({ sigma: AT.sigma });
  });

  it('a bottom rising above the apex height is rail-profile-invalid (H_l ≤ 0)', () => {
    const bottom = plane(0, 0, -1.5);
    const issues = profileRows({ ...base, apexHeight: 0.1 }, flatDeck, bottom, BUILD, AT).issues;
    expect(issues.map((i) => i.code)).toContain('rail-profile-invalid');
  });

  it('a rail lower than minRailHeight is rail-height', () => {
    const issues = profileRows(base, plane(0.05, 0, 0), flatBottom, BUILD, AT).issues;
    expect(issues.map((i) => i.code)).toContain('rail-height');
    expect(issues.find((i) => i.code === 'rail-height')!.value).toBeCloseTo(0.05, 12);
  });

  it('a deck handle pushed past the apex vertical is rail-profile-invalid; on the vertical is fine', () => {
    // Fullness 1 puts P1 on the apex vertical (the corner C_u); a positive deckHandle
    // offset then slides it outboard along the deck tangent (flat deck: by its value).
    const boxy = { ...base, upperFullness: 1 };
    expect(profileRows(boxy, flatDeck, flatBottom, BUILD, AT).issues).toEqual([]);
    const off = { ...ZERO_OFFSETS, deckHandleL: 1 };
    const col = profileRows({ ...boxy, offsets: off }, flatDeck, flatBottom, BUILD, AT);
    expect(col.issues.map((i) => i.code)).toEqual(['rail-profile-invalid']);
    expect(col.issues[0]!.value).toBeCloseTo(-1, 12);
  });

  it('a tuck handle pushed past the apex vertical is rail-profile-invalid', () => {
    const off = { ...ZERO_OFFSETS, tuckHandleN: -5 };
    const issues = profileRows({ ...base, offsets: off }, flatDeck, flatBottom, BUILD, AT).issues;
    expect(issues.map((i) => i.code)).toEqual(['rail-profile-invalid']);
  });
});

describe('profileRows: offsets move only their rows, along their frame vectors', () => {
  it('l along the unit deck tangent, z along ẑ, n along n̂', () => {
    const rng = mulberry32(13);
    for (let k = 0; k < 50; k++) {
      const deck = plane(9, 0.1 * rng() - 0.05, 0.1 * rng() - 0.05);
      const bottom = plane(0, 0.05 * rng(), 0.05 * rng());
      const s = spec(rng);
      const off: OffsetValues = {
        ...ZERO_OFFSETS,
        deckHandleL: 0.3 * rng(),
        apexUpperZ: 0.2 * rng(),
        apexLowerZ: 0.2 * rng(),
        tuckHandleN: 0.2 * rng(),
        tuckHandleZ: 0.2 * rng(),
      };
      const a = profileRows(s, deck, bottom, BUILD, AT);
      const b = profileRows({ ...s, offsets: off }, deck, bottom, BUILD, AT);
      const n: V = [s.frame.inward.x, s.frame.inward.y, 0];
      const td = mul(1 / Math.hypot(1, a.sd), add(mul(-1, n), [0, 0, a.sd]));
      const moves: V[] = [
        [0, 0, 0],
        mul(off.deckHandleL, td),
        [0, 0, off.apexUpperZ],
        [0, 0, 0],
        [0, 0, off.apexLowerZ],
        add(mul(off.tuckHandleN, n), [0, 0, off.tuckHandleZ]),
        [0, 0, 0],
      ];
      for (let r = 0; r < 7; r++) {
        const d = sub(pt(b.points, r), pt(a.points, r));
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(d[c]! - moves[r]![c]!), `case ${k} row ${r}`).toBeLessThanOrEqual(
            1e-12 * 250,
          );
        }
      }
      // Rows 0, 3 and 6 are untouched bitwise.
      for (const r of [0, 3, 6]) expect(pt(b.points, r)).toEqual(pt(a.points, r));
    }
  });
});
