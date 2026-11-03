// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A long-based fin with a raised rear: the blade overhangs the tab's rear end, and its
 * underside rises from the base to a low point behind the tab, so the fin can be
 * rocked onto the box's rear pin without its tail hitting the board. The outline is
 * one chain that comes down the trailing edge to that low point, then runs forward
 * and down along the underside to the base. Height falls all the way from the tip,
 * so the slicing needs nothing new; these tests prove it end to end. The foil is laid
 * over smoothed edges (blade.ts), which below the low point run behind the underside:
 * the foil is cut off at it, so the underside has the foil's thickness (rounds 1–2).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from '../bezier-spline';
import { knot } from '../knot';
import { value } from '../bezier-curve';
import { vec2, type Vec2 } from '../vec2';
import {
  RAISED_BASE_END,
  RAISED_LOW,
  hookedTipDesign,
  raisedRearDesign,
} from '../test-support/fin-designs';
import { FIN_MIN_THICKNESS, FIN_POSITIONS } from './fin-design';
import { FIN_RAISED_REAR_MAX } from './raised-rear';
import { defaultFinDesign, defaultKeel, defaultTwinFin } from './fin-defaults';
import { finMesh } from './fin-mesh';
import {
  bladeFoilAt,
  bladeSection,
  chordAt,
  cosineStations,
  findRaisedRear,
  foilAt,
  prepareBlade,
  thicknessAt,
} from './blade';
import { BLADE_CI_TOLERANCE, bladeSurfaceDeviation, fitBladeSurface } from './blade-surface';
import { splineExtremes } from './curve-shape';
import type { FinDesign, FinTwist } from './fin-design';
import { finReadouts } from './fin-readouts';
import { validateFinDesign } from './fin-rules';

const here = dirname(fileURLToPath(import.meta.url));

const LOW = RAISED_LOW;
const BASE_END = RAISED_BASE_END;
const raisedRear = raisedRearDesign;

const shoelace = (d: FinDesign, n = 4000): number => {
  const pts: Vec2[] = [];
  d.outline.coeffs.forEach((k, s) => {
    for (let i = s === 0 ? 0 : 1; i <= n; i++) pts.push(value(k, i / n));
  });
  let sum = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    sum += p.x * q.y - q.x * p.y;
  });
  return Math.abs(sum) / 2;
};

describe('a raised rear', () => {
  const d = raisedRear();

  it('is a valid design', () => {
    expect(validateFinDesign(d)).toEqual([]);
  });

  it('keeps everything behind the tab clear of the base', () => {
    // Behind the tab's rear end (x < 0) the outline never comes down to the base: the
    // lowest it gets is where the underside passes x = 0.
    let lowest = Infinity;
    d.outline.coeffs.forEach((k) => {
      for (let i = 0; i <= 2000; i++) {
        const p = value(k, i / 2000);
        if (p.x < 0) lowest = Math.min(lowest, p.y);
      }
    });
    expect(lowest).toBeGreaterThan(0.05);
    expect(splineExtremes(d.outline, 'y').min.point.y).toBeCloseTo(0, 15); // on the base, at the roots
  });

  it('reads the base length to where the underside meets the base', () => {
    const r = finReadouts(d);
    expect(r.rootChord).toBeCloseTo(d.outline.knots[0]!.end.x - BASE_END.x, 12);
    expect(Math.abs(r.area - shoelace(d))).toBeLessThan(1e-5);
  });

  it('slices below the low point end on the underside, above it on the trailing edge', () => {
    const b = prepareBlade(d);
    const below = chordAt(b, 0.25).trailing;
    const above = chordAt(b, 1).trailing;
    // Under the low point the chord stops short on the rising underside...
    expect(below).toBeGreaterThan(LOW.x);
    expect(below).toBeLessThan(BASE_END.x);
    // ...and just above it reaches back past the low point's x, on the trailing edge.
    expect(above).toBeLessThan(below);
    expect(chordAt(b, 0).trailing).toBeCloseTo(BASE_END.x, 12);
  });

  it('builds sections all the way up', () => {
    const b = prepareBlade(d);
    for (const h of [0, 0.25, LOW.y, 1, 5, b.depth * 0.9]) {
      const s = bladeSection(b, h);
      expect(s.leadingX).toBeGreaterThan(s.trailingX);
    }
  });

  // Seconds of real geometry, as the A4C's fit below: over 20 s on a loaded CI runner.
  it(
    'fits a blade surface within tolerance, smooth past the sharp low point',
    { timeout: 60_000 },
    () => {
      const m = fitBladeSurface(d);
      expect(
        bladeSurfaceDeviation(prepareBlade(d), m.surface, m.topZ, 31, 211),
      ).toBeLessThanOrEqual(BLADE_CI_TOLERANCE);
    },
  );
});

describe('the underside of a raised rear', () => {
  const d = raisedRear();
  const b = prepareBlade(d);
  const atTe = (h: number) => {
    const s = bladeSection(b, h);
    const j = s.stations.length - 1;
    return Math.abs(s.outside[j]!.y - s.inside[j]!.y);
  };

  it('is found where the outline turns up into the trailing edge', () => {
    const r = b.raisedRear!;
    expect(r.cornerX).toBeCloseTo(LOW.x, 9);
    expect(r.cornerZ).toBeCloseTo(LOW.y, 9);
  });

  it('is not found on a fin whose trailing edge rises steeply from the base', () => {
    for (const position of FIN_POSITIONS) {
      expect(findRaisedRear(defaultFinDesign(position).outline)).toBeNull();
    }
  });

  it('has the foil’s thickness, thinning toward the low point', () => {
    // The foil runs over the smoothed trailing edge, well behind the underside, and is
    // cut off at it: a real edge, not the minimum-thickness flap a slice ending there
    // would give.
    expect(atTe(0)).toBeGreaterThan(2 * FIN_MIN_THICKNESS);
    let last = Infinity;
    for (const f of [0, 0.2, 0.4, 0.6, 0.8]) {
      const t = atTe(LOW.y * f);
      expect(t).toBeLessThan(last);
      last = t;
    }
  });

  it('meshes the underside with rings of its own', () => {
    const m = finMesh(d);
    const zs = new Set<number>();
    for (let i = 2; i < m.blade.positions.length; i += 3) zs.add(m.blade.positions[i]!);
    expect([...zs].filter((z) => z > 0 && z < LOW.y).length).toBeGreaterThanOrEqual(3);
  });
});

describe('a hooked tip', () => {
  const b = prepareBlade(hookedTipDesign());
  /** The outside face's offset where it crosses x, at height h (cm). */
  const outsideAt = (h: number, x: number): number => {
    const s = bladeSection(b, h);
    for (let j = 0; j < s.outside.length - 1; j++) {
      const p = s.outside[j]!;
      const q = s.outside[j + 1]!;
      if ((p.x - x) * (q.x - x) <= 0 && p.x !== q.x) {
        return p.y + ((q.y - p.y) * (x - p.x)) / (q.x - p.x);
      }
    }
    return NaN;
  };

  it('is valid', () => expect(validateFinDesign(hookedTipDesign())).toEqual([]));

  it('ends both edges at the minimum, hook and all', () => {
    // Round 2 testing: cutting the foil off at the real edge bulged the trailing edge
    // wherever it bent. Only a raised rear's underside keeps a thick edge.
    const above = b.raisedRear!.cornerZ + 0.05;
    for (let h = above; h < b.depth * 0.995; h += 0.1) {
      const s = bladeSection(b, h, [0, 1]);
      for (const j of [0, 1]) {
        const w = Math.abs(s.outside[j]!.y - s.inside[j]!.y) * Math.cos(7 * (Math.PI / 180));
        expect(w).toBeCloseTo(FIN_MIN_THICKNESS, 12);
      }
    }
  });

  it('meshes both rear tips whole: the hook and the raised rear’s corner', () => {
    // Round 3 testing: the 3D view cut both points off between evenly spaced rings.
    const d = hookedTipDesign();
    const m = finMesh(d);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < m.blade.positions.length; i += 3) {
      xs.push(m.blade.positions[i]!);
      zs.push(m.blade.positions[i + 2]!);
    }
    // The hook's rearmost point, and how far back the mesh reaches near it.
    const hook = splineExtremes(d.outline, 'x').min.point;
    expect(Math.min(...xs)).toBeLessThan(hook.x + 0.005); // within 0.05 mm
    // The raised rear's corner: the mesh reaches it at its height.
    const corner = b.raisedRear!;
    const near = xs.filter((_, i) => Math.abs(zs[i]! - corner.cornerZ) < 0.002);
    expect(Math.min(...near)).toBeLessThan(corner.cornerX + 0.005);
  });

  it('has no crease across the blade where the trailing edge turns', () => {
    // Before: the face bent at up to 19 /cm right at the turn (9.74 cm up), 3 cm behind
    // the tab. Smoothing the edges the foil is laid over spreads that out. Within the
    // last stretch before the edge (it is 5.4 cm back here) the face follows the edge's
    // own sharp turn, so the edge can stay at the minimum.
    const step = 0.01;
    for (const x of [0.2, -2, -3]) {
      const ys: number[] = [];
      for (let h = 9.4; h <= 10.1; h += step) ys.push(outsideAt(h, x));
      for (let i = 1; i < ys.length - 1; i++) {
        const bend = Math.abs(ys[i - 1]! - 2 * ys[i]! + ys[i + 1]!) / (step * step);
        expect(bend).toBeLessThan(4);
      }
    }
  });
});

describe('a raised rear behind a steep start at the root (the owner’s twin fin)', () => {
  const d = defaultTwinFin('right');
  const b = prepareBlade(d);

  it('is found, though the outline leaves the root steeply for its first millimetre', () => {
    // The root's handle points nearly straight up: the underside starts just above it.
    const k = d.outline.knots.at(-1)!;
    expect(Math.abs(k.tangentToPrev.y / (k.tangentToPrev.x - k.end.x))).toBeGreaterThan(1);
    expect(b.raisedRear).not.toBeNull();
    expect(b.raisedRear!.cornerX).toBeCloseTo(d.outline.knots.at(-2)!.end.x, 9);
    expect(b.raisedRear!.cornerZ).toBeCloseTo(d.outline.knots.at(-2)!.end.y, 9);
  });

  it('keeps the foil’s thickness along the underside, not a minimum-thickness flap', () => {
    const atTe = (h: number) => {
      const s = bladeSection(b, h);
      const j = s.stations.length - 1;
      return Math.abs(s.outside[j]!.y - s.inside[j]!.y);
    };
    expect(atTe(0.05)).toBeGreaterThan(3 * FIN_MIN_THICKNESS);
    expect(atTe(0.2)).toBeGreaterThan(2 * FIN_MIN_THICKNESS);
  });

  it('fits a blade surface within tolerance', () => {
    const m = fitBladeSurface(d);
    expect(bladeSurfaceDeviation(b, m.surface, m.topZ)).toBeLessThanOrEqual(BLADE_CI_TOLERANCE);
  });

  it('isn’t found on a trailing edge that sweeps back gently high up', () => {
    // Owner testing: a trailing edge that leaves the root steeply, bulges forward, then
    // sweeps back gently a long way to a hooked tip read as an underside up to 80% of
    // the depth, and the base ran up it: a section standing almost upright.
    const outline = splineFromKnots([
      knot(vec2(19, 0), vec2(19, 0), vec2(18.6, 6), false),
      knot(vec2(-12, 20), vec2(5, 20.5), vec2(-15, 19.8), true),
      knot(vec2(-15, 16), vec2(-15.5, 18.5), vec2(-12, 14.5), true),
      knot(vec2(3, 9), vec2(-3, 11.5), vec2(6, 7.5), true),
      knot(vec2(0, 0), vec2(2.6, 3), vec2(0, 0), false),
    ]);
    expect(findRaisedRear(outline)).toBeNull();
    // The owners' raised rears are all well under the limit.
    for (const d of [ownerFin('a4c_raised_rear.fin.json'), defaultKeel(), defaultTwinFin()]) {
      const r = findRaisedRear(d.outline)!;
      expect(r.cornerZ).toBeLessThan(FIN_RAISED_REAR_MAX * prepareBlade(d).depth);
    }
  });

  it('still isn’t found where the trailing edge rises from the root for longer', () => {
    // The default fins: steep from the root all the way up.
    for (const position of FIN_POSITIONS) {
      expect(findRaisedRear(defaultFinDesign(position).outline)).toBeNull();
    }
  });
});

/** An owner's fin, read straight from its file in docs/specs/fins (mm → cm), slices and twist included. */
const ownerFin = (name: string): FinDesign => {
  type Row = { e: [number, number]; p: [number, number]; n: [number, number]; c: boolean };
  type Section = { outside: Row[]; inside: Row[] | null };
  const file = JSON.parse(
    readFileSync(resolve(here, '../../../../docs/specs/fins', name), 'utf8'),
  ) as {
    hand: 'left' | 'right';
    outline: Row[];
    section: Section;
    slices: { height: number; section: Section; twist?: FinTwist }[];
    taper: Row[];
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
    outline: spline(file.outline, 0.1, 0.1),
    section: section(file.section),
    slices: file.slices.map((sl) => ({
      height: sl.height,
      section: section(sl.section),
      ...(sl.twist ? { twist: sl.twist } : {}),
    })),
    taper: spline(file.taper, 1, 0.1),
  };
};

describe('a raised rear behind a tall steep start (the owner’s A4C, docs/specs/fins/a4c_raised_rear.fin.json)', () => {
  const a4c = () => ownerFin('a4c_raised_rear.fin.json');
  const d = a4c();
  const b = prepareBlade(d);
  const atTe = (h: number) => {
    const s = bladeSection(b, h);
    const j = s.stations.length - 1;
    return Math.abs(s.outside[j]!.y - s.inside[j]!.y);
  };

  it('is a valid design, slices and twist included', () => {
    expect(validateFinDesign(d)).toEqual([]);
    expect(d.slices).toHaveLength(3);
  });

  it('is found, though the outline rises steeply off the root for 7 mm first', () => {
    // Was null: only a 3 mm lead-in was allowed. The underside then runs 30 mm back.
    expect(b.raisedRear).not.toBeNull();
    expect(b.raisedRear!.cornerZ).toBeGreaterThan(1.5);
    expect(b.raisedRear!.cornerZ).toBeLessThan(d.outline.knots.at(-2)!.end.y);
  });

  it('keeps the foil’s thickness at the base of the trailing edge, not pinched to the minimum', () => {
    // Was the minimum (0.5 mm) behind 5.6 mm of foil just ahead of it.
    expect(atTe(0.05)).toBeGreaterThan(10 * FIN_MIN_THICKNESS);
    expect(atTe(0.6)).toBeGreaterThan(8 * FIN_MIN_THICKNESS);
    // Thinning up the underside toward the corner.
    expect(atTe(1.2)).toBeLessThan(atTe(0.6));
  });

  // Its thickness curve falls steeply to the minimum over the last few millimetres, which
  // the tip follows by height: about 7 s alone, more under the full `pnpm test` load.
  it('fits a blade surface within tolerance', { timeout: 60_000 }, () => {
    const m = fitBladeSurface(d);
    expect(bladeSurfaceDeviation(b, m.surface, m.topZ)).toBeLessThanOrEqual(BLADE_CI_TOLERANCE);
  });
});

describe('the corner of a raised rear that curls up into a point (the owner’s keel)', () => {
  /**
   * The sharpest bend (per cm of height) in thickness going straight up past the corner,
   * a short way in front of it: a ridge across the blade shows here.
   */
  const worstBend = (d: ReturnType<typeof defaultKeel>) => {
    const b = prepareBlade(d);
    const r = b.raisedRear!;
    let worst = 0;
    for (const ahead of [0.05, 0.1, 0.15]) {
      const x = r.cornerX + ahead;
      const hs: number[] = [];
      const ts: number[] = [];
      // Every half millimetre: finer, the second difference reads the sweep grid's
      // ripple (a few thousandths of a millimetre) rather than a ridge you could see.
      for (let h = Math.max(0.01, r.cornerZ - 0.5); h <= r.cornerZ + 1.5; h += 0.05) {
        const c = chordAt(b, h);
        if (!(x < c.leading && x > c.trailing)) continue;
        const s = bladeSection(b, h, [0, (x - c.leading) / (c.trailing - c.leading), 1]);
        hs.push(h);
        ts.push(Math.abs(s.outside[1]!.y - s.inside[1]!.y));
      }
      for (let i = 1; i < ts.length - 1; i++) {
        const bend =
          (ts[i + 1]! - 2 * ts[i]! + ts[i - 1]!) / ((hs[i + 1]! - hs[i]!) * (hs[i]! - hs[i - 1]!));
        worst = Math.max(worst, Math.abs(bend));
      }
    }
    return worst;
  };

  it('puts the corner at the point, not where the underside starts to curl up', () => {
    const d = defaultKeel('right');
    const point = d.outline.knots.at(-2)!.end;
    const r = prepareBlade(d).raisedRear!;
    expect(r.cornerX).toBeCloseTo(point.x, 12);
    expect(r.cornerZ).toBeCloseTo(point.y, 12);
  });

  it('has no ridge across the blade just above the corner', () => {
    // It was 2.1 /cm, with the corner short of the point and a 3 mm hand-over.
    expect(worstBend(defaultKeel('right'))).toBeLessThan(0.8);
    expect(worstBend(defaultTwinFin('right'))).toBeLessThan(0.8);
  });

  it('fits a blade surface within tolerance', () => {
    const d = defaultKeel('right');
    const m = fitBladeSurface(d);
    expect(bladeSurfaceDeviation(prepareBlade(d), m.surface, m.topZ)).toBeLessThanOrEqual(
      BLADE_CI_TOLERANCE,
    );
  });
});

describe('corners in an edge (the owner’s test fin, docs/specs/fins/corner_creases.fin.json)', () => {
  /** The test fin, read straight from its file (mm → cm). */
  const testFin = (): FinDesign => {
    type Row = { e: [number, number]; p: [number, number]; n: [number, number]; c: boolean };
    const file = JSON.parse(
      readFileSync(resolve(here, '../../../../docs/specs/fins/corner_creases.fin.json'), 'utf8'),
    ) as { outline: Row[]; section: { outside: Row[]; inside: Row[] }; taper: Row[] };
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
    return {
      ...defaultFinDesign('side', 'right'),
      outline: spline(file.outline, 0.1, 0.1),
      section: {
        outside: spline(file.section.outside, 1, 1),
        inside: spline(file.section.inside, 1, 1),
      },
      taper: spline(file.taper, 1, 0.1),
    };
  };

  it('is a valid design with four sharp corners in its trailing edge', () => {
    const d = testFin();
    expect(validateFinDesign(d)).toEqual([]);
    expect(d.outline.knots.slice(1, -1).filter((k) => !k.continuous)).toHaveLength(4);
  });

  it('keeps each corner’s crease close to the edge, not carried across the blade', () => {
    const d = testFin();
    const b = prepareBlade(d);
    const t = (x: number, h: number) => {
      const c = chordAt(b, h);
      const s = bladeSection(b, h, [0, (x - c.leading) / (c.trailing - c.leading), 1]);
      return Math.abs(s.outside[1]!.y - s.inside[1]!.y);
    };
    const corners = d.outline.knots.slice(1, -1).filter((k) => !k.continuous);
    expect(corners).toHaveLength(4);
    for (const k of corners) {
      const h = k.end.y;
      // 1 and 2 cm in from the edge. With the top counted as tip (owner's rule 3), the
      // sweep's sections run near level by the 45 mm corner, and its crease reaches 5 mm
      // in (1.9 there, 0.07 at 1 cm; it was 0.08 at 5 mm), though no sharper at 2.5 mm
      // (2.1 either way).
      for (const ahead of [1, 2]) {
        const x = chordAt(b, h).trailing + ahead;
        const e = 0.03;
        // The change in slope going up through the corner's height (mm per cm).
        const below = (t(x, h - e) - t(x, h - 2 * e)) / e;
        const above = (t(x, h + 2 * e) - t(x, h + e)) / e;
        // Was 1.0–2.7 with the foil drawn to the real edge across a third of the chord.
        expect(Math.abs(above - below) * 10).toBeLessThan(0.5);
      }
    }
  });

  it('fits a blade surface within tolerance', () => {
    const d = testFin();
    const m = fitBladeSurface(d);
    expect(bladeSurfaceDeviation(prepareBlade(d), m.surface, m.topZ)).toBeLessThanOrEqual(
      BLADE_CI_TOLERANCE,
    );
  });

  // Round 4 testing: under the keel's rounded top the foil folded over at each edge, a
  // bulge and then a flat at the minimum, 0.07 mm deep (0.05 mm at this fin's corners).
  it.each([
    ['test fin', testFin],
    ['keel', defaultKeel],
    ['twin', defaultTwinFin],
    ['side', () => defaultFinDesign('side', 'right')],
  ] as const)('never folds the foil over at an edge: %s', (_, make) => {
    const d = make();
    const b = prepareBlade(d);
    const st = Array.from({ length: 401 }, (_, i) => i / 400);
    const corners = d.outline.knots
      .slice(1, -1)
      .filter((k) => !k.continuous)
      .flatMap((k) => Array.from({ length: 31 }, (_, i) => k.end.y + (i - 15) * 0.02));
    const top = [3, 2, 1, 0.5, 0.3, 0.2, 0.1, 0.05, 0.02].map((mm) => b.depth - mm / 10);
    const along = Array.from({ length: 99 }, (_, i) => (b.depth * (i + 1)) / 100);
    for (const h of [...corners, ...top, ...along].filter((h) => h > 0 && h < b.depth)) {
      const s = bladeSection(b, h, st);
      const t = st.map((_, i) => Math.abs(s.outside[i]!.y - s.inside[i]!.y));
      // Walking in from either edge over the last 6% of chord, it only thickens.
      for (const run of [t.slice(0, 25), t.slice(376).reverse()]) {
        for (let i = 1; i < run.length; i++) {
          // To 0.015 mm: the sweep is read off a grid, which ripples by up to 0.01 mm where
          // a cut just under the tip crosses from the sweep into the rounded tip. The fold
          // this guards against was 0.07 mm.
          expect(run[i]!).toBeGreaterThanOrEqual(run[i - 1]! - 1.5e-3);
        }
      }
    }
  });
});

describe('the underside of a hooked tip (the owner’s hatchet, docs/specs/fins/hatchet_hook.fin.json)', () => {
  const d = ownerFin('hatchet_hook.fin.json');
  const b = prepareBlade(d);
  /** A section's thickness at chord fraction `u`, over what its foil there says. */
  const share = (h: number, u: number) => {
    const s = bladeSection(b, h, [u]);
    const foil = foilAt(d, h / b.depth);
    const [o, i] = foil.shapeAt(u);
    const t = thicknessAt(b, h);
    const m = b.minThickness;
    const designed = ((o - i) / foil.thickest.thickness) * (t - m) + m;
    return (
      Math.hypot(s.outside[0]!.x - s.inside[0]!.x, s.outside[0]!.y - s.inside[0]!.y) / designed
    );
  };

  it('keeps the back of the section to its foil at the slice up the hook', () => {
    // Was 0.73 at 95% of the chord 105 mm up: the trailing third a quarter too thin. At its
    // height a slice is its foil, as thick as the fin without it.
    const h = d.slices[1]!.height * b.depth;
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9, 0.95]) {
      expect(share(h, u)).toBeGreaterThan(0.97);
      expect(share(h, u)).toBeLessThan(1.04);
    }
  });

  it('leaves the hook as it was under a slice made from it', () => {
    // A slice starts as the fin's own section (bladeFoilAt) and adds only what it is
    // edited to: added there, unedited, the hook keeps its shape all round it.
    const plain = { ...d, slices: [] };
    const eta = d.slices[1]!.height;
    const sliced = prepareBlade({
      ...plain,
      slices: [{ height: eta, section: bladeFoilAt(plain, eta) }],
    });
    const pb = prepareBlade(plain);
    const st = cosineStations(60);
    for (let h = 9.0; h <= 12.4; h += 0.2) {
      const a = bladeSection(sliced, h, st);
      const c = bladeSection(pb, h, st);
      // To 0.05 mm: the slice is fitted with a few points, to a percent of its thickness.
      a.outside.forEach((p, j) => expect(Math.abs(p.y - c.outside[j]!.y)).toBeLessThan(5e-3));
      a.inside.forEach((p, j) => expect(Math.abs(p.y - c.inside[j]!.y)).toBeLessThan(5e-3));
    }
  });
});
