// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from '../bezier-spline';
import { knot } from '../knot';
import type { BoardMesh } from '../tessellate';
import { cosineStations } from './blade';
import { vec2 } from '../vec2';
import { yAtX } from './curve-shape';
import {
  FIN_SLICE_REACH,
  bladeFoilAt,
  bladeSection,
  chordAt,
  moveFoilThickest,
  prepareBlade,
  sectionThickest,
  sliceFoilMovedTo,
  sliceFreeSpan,
  sliceTipCrossing,
  sliceTipPoint,
  sliceWeight,
  thicknessAlongSweep,
  thicknessAt,
  thicknessPathOf,
  tipFoilOf,
  tipLineEta,
} from './blade';
import { defaultFinDesign, defaultKeel, defaultSingleFin, defaultTwinFin } from './fin-defaults';
import type { FinDesign, FinTwist } from './fin-design';
import { finMesh } from './fin-mesh';
import {
  defaultTipLine,
  outlineAtFraction,
  sweepFrame,
  sweepGrid,
  sweepPointOn,
  sweepTipEdge,
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

const volume = ({ positions: P, indices: I }: BoardMesh): number => {
  let v = 0;
  for (let i = 0; i < I.length; i += 3) {
    const [a, b, c] = [I[i]! * 3, I[i + 1]! * 3, I[i + 2]! * 3];
    v +=
      P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
      P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
      P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
  }
  return v / 6;
};

describe('the swept loft', () => {
  it.each(FINS)('never folds its sections over each other: %s', (_, make) => {
    const g = sweepGrid(make());
    // Every cell of the base-to-tip-line sweep turns the same way round.
    const sign = (i: number, j: number) => {
      const k = i * g.cols + j;
      const ax = g.x[k + g.cols]! - g.x[k]!;
      const az = g.z[k + g.cols]! - g.z[k]!;
      const bx = g.x[k + 1]! - g.x[k]!;
      const bz = g.z[k + 1]! - g.z[k]!;
      return Math.sign(ax * bz - az * bx);
    };
    const s0 = sign(1, 1);
    for (let i = 0; i < g.tipRow; i++) {
      for (let j = 0; j < g.cols - 1; j++) expect(sign(i, j)).toBe(s0);
    }
  });

  it.each(FINS)('meshes a closed blade: %s', (_, make) => {
    const mesh = finMesh(make()).blade;
    const edges = new Map<string, number>();
    const I = mesh.indices;
    for (let i = 0; i < I.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${I[i + k]},${I[i + ((k + 1) % 3)]}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of edges) {
      const [a, b] = key.split(',');
      expect(n).toBe(1);
      expect(edges.get(`${b},${a}`)).toBe(1);
    }
    expect(volume(mesh)).toBeGreaterThan(0);
    for (const v of mesh.positions) expect(Number.isFinite(v)).toBe(true);
  });

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

  it('counts a flat top as tip: cuts near the top are thickest toward the front', () => {
    // Owner testing (rule 3): with the top on the leading edge, the sections up there
    // slanted steeply down to the hook, and every cut near the top was thickest toward
    // its trailing edge, at 74% of the chord 94 mm up.
    // The default tip line: the owner's own is further round, where they put it.
    const { tipLine: _own, ...rest } = ownerFin('steep_tip_line.fin.json');
    void _own;
    const d = { ...rest, slices: [] };
    expect(tipLineOf(d).start).toBeCloseTo(tipTurnFraction(d.outline), 9);
    const turn = outlineAtFraction(d.outline, tipTurnFraction(d.outline));
    expect(turn.y).toBeGreaterThan(9); // 95 mm up, where the top begins
    expect(turn.y).toBeLessThan(9.8);
    const b = prepareBlade(d);
    const st = Array.from({ length: 101 }, (_, i) => i / 100);
    for (const h of [9.0, 9.42, 9.7]) {
      const s = bladeSection(b, h, st);
      const t = st.map((_, j) => Math.abs(s.outside[j]!.y - s.inside[j]!.y));
      const at = st[t.indexOf(Math.max(...t))]!;
      expect(at).toBeGreaterThan(0.25);
      expect(at).toBeLessThan(0.5);
    }
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

  it('puts the root’s thickest point on the thickness path', () => {
    const d = defaultFinDesign('side', 'left');
    const thickestAt = (dd: FinDesign) => {
      const s = bladeSection(prepareBlade(dd), 0, cosineStations(400));
      const w = s.outside.map((p, j) => p.y - s.inside[j]!.y);
      return s.stations[w.indexOf(Math.max(...w))]!;
    };
    // The path's base end is the base foil's thickest point: reshape the foil, it moves.
    expect(thickestAt({ ...d, section: moveFoilThickest(d.section, 0.45) })).toBeCloseTo(0.45, 2);
    expect(thickestAt({ ...d, section: moveFoilThickest(d.section, 0.25) })).toBeCloseTo(0.25, 2);
  });

  it('blends from the base foil to the tip foil, each section thickest on the path', () => {
    const d = defaultFinDesign('side', 'left');
    const tip = moveFoilThickest(d.section, 0.25);
    const path = thicknessPathOf({ ...d, tipSection: tip });
    expect(path[0]).toBeCloseTo(sectionThickest(d.section).at, 9);
    expect(path[2]).toBeCloseTo(0.25, 2);
    expect(path[1]).toBeCloseTo((path[0] + path[2]) / 2, 9);
    expect(thicknessPathOf({ ...d, tipSection: tip, thicknessMid: 0.5 })[1]).toBe(0.5);
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

  it('rounds the tip off past the tip line, to the minimum at the edge', () => {
    const d = defaultKeel();
    const b = prepareBlade(d);
    const near = bladeSection(b, b.depth * 0.995, cosineStations(200));
    const widest = Math.max(...near.outside.map((p, j) => p.y - near.inside[j]!.y));
    expect(widest).toBeLessThan(2 * b.minThickness);
  });

  it('hands the slices back to the sweep at the base and over their reach above', () => {
    const d = ownerFin('a4c_raised_rear.fin.json');
    const b = prepareBlade(d);
    expect(sliceWeight(d, 0)).toBe(0);
    expect(sliceWeight(d, d.slices[0]!.height)).toBe(1);
    expect(sliceWeight(d, Math.min(1, d.slices.at(-1)!.height + FIN_SLICE_REACH))).toBe(0);
    expect(tipLineEta(b)).toBeGreaterThan(0.5);
  });

  it.each(FINS)('thins to the minimum right round the tip’s edge, not square: %s', (_, make) => {
    // Owner testing: straight rows across the tip left the outline's bulge beyond them as
    // thick as the row nearest it, a square end in a cut through the tip.
    const d = make();
    const b = prepareBlade(d);
    const f = sweepFrame(d);
    const mid = { x: (f.tipStart.x + f.tipEnd.x) / 2, y: (f.tipStart.y + f.tipEnd.y) / 2 };
    const edge = sweepTipEdge(d);
    for (let k = 1; k < 10; k++) {
      const e = edge[Math.round((k / 10) * (edge.length - 1))]!;
      const len = Math.hypot(mid.x - e.x, mid.y - e.y);
      if (!(len > 0.05)) continue;
      // A tenth of a millimetre in from the edge, toward the tip line's middle: the tip
      // rounds off like a nose, so further in it is still most of its thickness.
      const q = { x: e.x + ((mid.x - e.x) * 0.01) / len, y: e.y + ((mid.y - e.y) * 0.01) / len };
      if (!(q.y > 0 && q.y < b.depth)) continue;
      const c = chordAt(b, q.y);
      const u = (q.x - c.leading) / (c.trailing - c.leading);
      if (!(u > 0 && u < 1)) continue;
      const s = bladeSection(b, q.y, [u]);
      const t = Math.abs(s.outside[0]!.y - s.inside[0]!.y);
      expect(t).toBeLessThan(0.4 * thicknessAt(b, f.tipStart.y) + 2 * b.minThickness);
    }
  });

  it('keeps a slice’s foil to around its height', () => {
    const d = {
      ...defaultFinDesign('side', 'left'),
      slices: [{ height: 0.8, section: defaultFinDesign('centre').section }],
    };
    expect(sliceWeight(d, 0.8)).toBe(1);
    expect(sliceWeight(d, 0.8 - FIN_SLICE_REACH)).toBe(0);
    expect(sliceWeight(d, 0.3)).toBe(0); // a third of the way up: untouched
    expect(sliceWeight(d, 0.8 - FIN_SLICE_REACH / 2)).toBeCloseTo(0.5, 9);
  });

  it.each(FINS)(
    'only thins going out from the tip foil’s high point to the tip edge: %s',
    (_, make) => {
      // The owner's tip loft: spokes from the high point out to the edge, each thinning
      // all the way (a slope cap on the thickness near the edge left a divot).
      const d = make();
      const b = prepareBlade(d);
      const g = sweepGrid(d);
      const high = sweepPointOn(g, g.tipRow, thicknessPathOf(d)[2]);
      const edge = sweepTipEdge(d);
      const at = (x: number, z: number): number | null => {
        if (!(z > 0 && z < b.depth)) return null;
        const c = chordAt(b, z);
        const u = (x - c.leading) / (c.trailing - c.leading);
        if (!(u > 0 && u < 1)) return null;
        const s = bladeSection(b, z, [u]);
        return Math.abs(s.outside[0]!.y - s.inside[0]!.y);
      };
      for (let k = 1; k < 12; k++) {
        const e = edge[Math.round((k / 12) * (edge.length - 1))]!;
        let last = Infinity;
        for (let j = 1; j < 20; j++) {
          const t = j / 20;
          const v = at(high.x + (e.x - high.x) * t, high.y + (e.y - high.y) * t);
          if (v === null) continue;
          expect(v).toBeLessThanOrEqual(last + 2e-4); // to 0.002 mm, the grid's reading
          last = v;
        }
      }
    },
  );

  it.each(FINS)('has no divot in an upright cut through the tip: %s', (_, make) => {
    // Owner testing: cuts across the tip went thin, thick, thin again. Up any upright
    // line through the tip the blade now thickens to one peak and thins after it.
    const d = make();
    const b = prepareBlade(d);
    const f = sweepFrame(d);
    const low = Math.min(f.tipStart.y, f.tipEnd.y) - 1;
    const x0 = Math.min(...f.tipEdge.pts.map((p) => p.x));
    const x1 = Math.max(f.tipStart.x, f.tipEnd.x);
    for (let k = 1; k < 8; k++) {
      const x = x0 + ((x1 - x0) * k) / 8;
      const ts: number[] = [];
      for (let z = Math.max(0.01, low); z < b.depth; z += 0.02) {
        const c = chordAt(b, z);
        if (!(x < c.leading && x > c.trailing)) {
          if (ts.length) break;
          continue;
        }
        const s = bladeSection(b, z, [(x - c.leading) / (c.trailing - c.leading)]);
        ts.push(Math.abs(s.outside[0]!.y - s.inside[0]!.y));
      }
      // No dip: never down and then up again by more than 0.03 mm (the grid reads to a
      // few thousandths; an outline corner right at the tip line adds a little more).
      let fell = false;
      for (let i = 1; i < ts.length; i++) {
        if (ts[i]! < ts[i - 1]! - 3e-3) fell = true;
        else if (fell) expect(ts[i]!).toBeLessThanOrEqual(ts[i - 1]! + 3e-3);
      }
    }
  });
});

describe('slices and the tip line (owner’s rules)', () => {
  /** The owner's side fin with a long, steep tip line, and its slice at 90.2 mm. */
  const steep = ownerFin('steep_tip_line.fin.json');
  const plain = { ...steep, slices: [] };
  const eta = steep.slices[0]!.height;
  const derived = { ...plain, slices: [{ height: eta, section: bladeFoilAt(plain, eta) }] };
  const width = (s: ReturnType<typeof bladeSection>, j: number) =>
    Math.abs(s.outside[j]!.y - s.inside[j]!.y);

  it('meets the sweep level along the tip line: no crease in a cut across it', () => {
    // Owner testing: cuts across a long, steep tip line turned a corner there (the tip
    // was lofted from its high point, at an angle to the sweep along most of the line).
    // Now the slope eases round: at 0.2 mm steps it turns by no more than 0.008 mm a
    // step (it turned by up to 0.024).
    const b = prepareBlade(plain);
    const g = sweepGrid(plain);
    const s = sweepPointOn(g, g.tipRow, 0);
    const e = sweepPointOn(g, g.tipRow, 1);
    for (const h of [8.7, 9.02, 9.2, 9.4, 9.6]) {
      const x = s.x + ((e.x - s.x) * (h - s.y)) / (e.y - s.y);
      const c = chordAt(b, h);
      const dir = Math.sign(c.trailing - c.leading);
      const us = Array.from(
        { length: 9 },
        (_, k) => (x + dir * (k - 3) * 0.02 - c.leading) / (c.trailing - c.leading),
      );
      const sec = bladeSection(b, h, us);
      const t = us.map((_, j) => width(sec, j));
      for (let j = 1; j < t.length - 1; j++) {
        expect(Math.abs(t[j + 1]! - 2 * t[j]! + t[j - 1]!)).toBeLessThan(8e-4);
      }
    }
  });

  it('changes nothing for a slice made from the fin', () => {
    const a = prepareBlade(derived);
    const c = prepareBlade(plain);
    const st = cosineStations(80);
    for (let h = 7.4; h < 9.95; h += 0.15) {
      const p = bladeSection(a, h, st);
      const q = bladeSection(c, h, st);
      // To 0.05 mm: the slice is fitted with a few points, to a percent of its thickness.
      st.forEach((_, j) => expect(Math.abs(width(p, j) - width(q, j))).toBeLessThan(5e-3));
    }
  });

  it('moves a slice made from the fin as the fin’s section at its new height', () => {
    // Owner testing: dragged from where it was added up to the tip, a slice carried the
    // section from down there. Moving a slice repositions it, as the analysis cut moves.
    const low = { ...plain, slices: [{ height: 0.6, section: bladeFoilAt(plain, 0.6) }] };
    const moved = {
      ...plain,
      slices: [{ height: eta, section: sliceFoilMovedTo(low, 0, eta) }],
    };
    const a = prepareBlade(moved);
    const c = prepareBlade(plain);
    const st = cosineStations(60);
    for (const h of [8.0, 8.6, 9.02, 9.4]) {
      const p = bladeSection(a, h, st);
      const q = bladeSection(c, h, st);
      st.forEach((_, j) => expect(Math.abs(width(p, j) - width(q, j))).toBeLessThan(5e-3));
    }
    const tp = sliceTipPoint(moved, 0)!;
    expect(yAtX(moved.slices[0]!.section.outside, tp.at)).toBeCloseTo(tp.outside, 3);
  });

  it('carries what a slice was reshaped by when it moves, and back again', () => {
    const at = 0.6;
    const made = bladeFoilAt(plain, at);
    // Reshaped: its thickest point moved well forward.
    const reshaped = moveFoilThickest(made, 0.2);
    const d = { ...plain, slices: [{ height: at, section: reshaped }] };
    const up = { ...plain, slices: [{ height: 0.7, section: sliceFoilMovedTo(d, 0, 0.7) }] };
    // Still reshaped up there: not the fin's section.
    const b = prepareBlade(up);
    const h = 0.7 * b.depth;
    const p = bladeSection(b, h, [0.15]);
    const q = bladeSection(prepareBlade(plain), h, [0.15]);
    expect(Math.abs(width(p, 0) - width(q, 0))).toBeGreaterThan(1e-2);
    // And back where it was, as it was, to the fit (twice over: a percent each way).
    const back = sliceFoilMovedTo(up, 0, at);
    for (const u of [0.1, 0.3, 0.5, 0.7]) {
      expect(Math.abs(yAtX(back.outside, u) - yAtX(reshaped.outside, u))).toBeLessThan(
        0.03 * sectionThickest(reshaped).thickness,
      );
    }
  });

  it('carries a foil’s edge off the chord line to the blade’s edge, and into a new slice', () => {
    // Owner's request, to blend twists: the root foil's trailing edge moved 1% of the
    // chord outboard, both faces with it.
    const side = defaultFinDesign('side');
    const lift = (s: FinDesign['section']['outside']) =>
      splineFromKnots(
        s.knots.map((k) => {
          const up = (p: { x: number; y: number }) => vec2(p.x, p.y + 0.01 * p.x);
          return knot(up(k.end), up(k.tangentToPrev), up(k.tangentToNext), k.continuous);
        }),
      );
    const moved = {
      ...side,
      section: { outside: lift(side.section.outside), inside: lift(side.section.inside!) },
    };
    const a = prepareBlade(side);
    const b = prepareBlade(moved);
    const st = [0.99, 0.999, 1];
    const mid = (s: ReturnType<typeof bladeSection>, j: number) =>
      (s.outside[j]!.y + s.inside[j]!.y) / 2;
    for (const eta of [0.1, 0.3]) {
      const p = bladeSection(a, eta * a.depth, st);
      const q = bladeSection(b, eta * b.depth, st);
      // The edge itself moves, as far as the face just short of it: no crease there.
      const shift = Math.abs(mid(q, 2) - mid(p, 2));
      expect(shift).toBeGreaterThan(0.02);
      expect(Math.abs(mid(q, 1) - mid(p, 1) - (mid(q, 2) - mid(p, 2)))).toBeLessThan(0.1 * shift);
      // Still the minimum there.
      expect(width(q, 2)).toBeCloseTo(width(p, 2), 6);
    }
    // A new slice copies the edge, its faces meeting there.
    const sec = bladeFoilAt({ ...moved, slices: [] }, 0.3);
    const end = (s: FinDesign['section']['outside']) => s.knots[s.knots.length - 1]!.end.y;
    expect(end(sec.outside)).toBeGreaterThan(0.002);
    expect(end(sec.inside!)).toBe(end(sec.outside));
  });

  it('fits a new slice with as few points as a foil drawn by hand', () => {
    // Owner testing: a slice came with seven points where one between the edges drew
    // the same curve. The default fin's section is its three-point foil, scaled.
    const twin = { ...ownerFin('twin_fin_default.fin.json'), slices: [] };
    expect(bladeFoilAt(twin, 0.4).outside.knots).toHaveLength(3);
    // A swept fin whose section ends in a thick edge's drop: not a point per step of it
    // (nine, before the fit chose the slope there).
    const swept = { ...ownerFin('swept_back_two_foils.fin.json'), slices: [] };
    expect(bladeFoilAt(swept, 0.6).outside.knots.length).toBeLessThanOrEqual(4);
  });

  it('moves a slice that was never reshaped as the fin’s own section', () => {
    // Its fit's own error is not a reshaping, even at a steep nose (the raised-rear fin
    // read as reshaped at every height before the miss was taken square to the face).
    const fin = { ...ownerFin('a4c_raised_rear.fin.json'), slices: [] };
    for (const at of [0.3, 0.75]) {
      const d = { ...fin, slices: [{ height: at, section: bladeFoilAt(fin, at) }] };
      expect(sliceFoilMovedTo(d, 0, at + 0.05)).toEqual(bladeFoilAt(fin, at + 0.05));
    }
  });

  it('leaves the tip past the tip line to the tip foil', () => {
    // The owner's slice is the base foil, not the fin's section: it reshapes the chord up
    // to the tip line, and not past it.
    const h = eta * prepareBlade(plain).depth;
    const [from, to] = sliceFreeSpan(steep, eta);
    expect(from).toBe(0);
    expect(to).toBeGreaterThan(0.3);
    expect(to).toBeLessThan(1);
    const st = Array.from({ length: 41 }, (_, k) => to + ((1 - to) * k) / 40);
    const p = bladeSection(prepareBlade(steep), h, st);
    const q = bladeSection(prepareBlade(plain), h, st);
    st.forEach((_, j) => expect(width(p, j)).toBeCloseTo(width(q, j), 9));
    // Short of it, the slice counts.
    const mid = bladeSection(prepareBlade(steep), h, [to / 5]);
    const was = bladeSection(prepareBlade(plain), h, [to / 5]);
    expect(Math.abs(width(mid, 0) - width(was, 0))).toBeGreaterThan(5e-3);
  });

  it('hands the slice back to the sweep over its reach above, not at the tip line', () => {
    // Owner testing: eased out by the tip line's height, 1.7 mm above it, a kink. Now
    // over its reach, or to the top where that is nearer: here 9.8 mm.
    const reach = Math.min(FIN_SLICE_REACH, 1 - eta);
    expect(reach).toBeGreaterThan(0.09);
    expect(sliceWeight(steep, eta + reach / 2)).toBeCloseTo(0.5, 9);
  });

  it('shows where a slice crosses the tip line, as thick as the fin there', () => {
    const tp = sliceTipPoint(derived, 0)!;
    expect(tp.at).toBeCloseTo(sliceFreeSpan(derived, eta)[1], 12);
    expect(tp.outside).toBeGreaterThan(0);
    expect(tp.inside).toBe(0); // the flat inside face
    expect(sliceTipPoint(defaultFinDesign('side', 'left'), 0)).toBeNull();
  });
});

describe('a heavily swept-back fin (the owner’s, docs/specs/fins/swept_back_tip.fin.json)', () => {
  it('reads every other fin’s thickness curve by height, exactly as before', () => {
    for (const [, make] of FINS.filter(([n]) => n !== 'steep tip line')) {
      expect(thicknessAlongSweep(make())).toBe(0);
    }
  });

  it('reads its thickness curve along the sweep: the arm thins toward the tip', () => {
    // Owner testing: read by height, the arm reaching back to the tip spans little height,
    // so it kept its full thickness to the tip line, then fell to the minimum in 20 mm.
    const d = { ...ownerFin('swept_back_tip.fin.json'), slices: [] };
    expect(thicknessAlongSweep(d)).toBeGreaterThan(0.9);
    const b = prepareBlade(d);
    const st = Array.from({ length: 101 }, (_, i) => i / 100);
    for (const h of [17.7, 18.3]) {
      const s = bladeSection(b, h, st);
      const t = st.map((_, j) => Math.abs(s.outside[j]!.y - s.inside[j]!.y));
      const most = Math.max(...t);
      // Most of the way back it has thinned well down (it was still at its thickest).
      expect(t[88]!).toBeLessThan(0.75 * most);
      // And thins on steadily to the edge: no cliff over the last tenth.
      for (let j = 90; j < 100; j++) expect(t[j]! - t[j + 1]!).toBeLessThan(0.2 * most);
    }
  });

  it('shows each foil the other where a slice made from the fin crosses the tip line', () => {
    // Owner's rules: a green dot in the slice for the tip, an aqua one in the tip foil for
    // the slice. A slice made from the fin is the fin there, so the two agree.
    const plain = { ...ownerFin('swept_back_tip.fin.json'), slices: [] };
    const eta = 0.872;
    const d = { ...plain, slices: [{ height: eta, section: bladeFoilAt(plain, eta) }] };
    const c = sliceTipCrossing(d, 0)!;
    expect(c.sliceAt).toBeGreaterThan(0.5);
    expect(c.tipInSlice.outside).toBeCloseTo(yAtX(d.slices[0]!.section.outside, c.sliceAt), 3);
    const tip = tipFoilOf(d);
    const rel = c.sliceInTip.outside / yAtX(tip.outside, c.tipAt);
    expect(Math.abs(rel - 1)).toBeLessThan(0.03); // to the fit, a percent or two
    expect(sliceTipCrossing(defaultFinDesign('side', 'left'), 0)).toBeNull();
  });

  it('steps nowhere where its base and tip foils are thickest in different places', () => {
    // Owner testing: a base foil thickest at 32% and a tip foil at 49%. Blended, the foil
    // had two humps nearly as high, and where the blend was thickest jumped from one to the
    // other between two rows: 1.1 mm down across 3 mm of a cut 152 mm up. Now each foil is
    // laid on the path and then blended. (What's left is the tip foil's own shoulder
    // between its points at 45% and 49%, 0.026 mm here.)
    const d = { ...ownerFin('swept_back_two_foils.fin.json'), slices: [] };
    const b = prepareBlade(d);
    const st = Array.from({ length: 301 }, (_, i) => i / 300);
    for (const h of [15.21, 17.83]) {
      const s = bladeSection(b, h, st);
      const t = st.map((_, i) => Math.abs(s.outside[i]!.y - s.inside[i]!.y));
      for (let i = 20; i < 280; i++) {
        expect(Math.abs(t[i + 1]! - 2 * t[i]! + t[i - 1]!)).toBeLessThan(5e-3); // was 0.023
      }
    }
  });
});

describe('a slice’s toe (owner testing)', () => {
  it('turns the sections smoothly up the blade: no grooves', () => {
    // The owner's hatchet, its slice 1.5° less toe than the root: grooves every few mm up
    // the upper blade, 0.07 mm steps, in the STEP too. Each section turned about its
    // thickest station, which jumped from one to the next, and on this flat-topped foil
    // the thickest point itself runs back and forth along the chord.
    const d = ownerFin('hatchet_slice_toe.fin.json');
    const b = prepareBlade(d);
    const st = cosineStations(48);
    const hs: number[] = [];
    for (let h = 0.4 * b.depth; h < 0.95 * b.depth; h += 0.02) hs.push(h);
    const secs = hs.map((h) => bladeSection(b, h, st));
    for (const j of [14, 24, 34]) {
      const ys = secs.map((s) => s.outside[j]!.y);
      for (let i = 1; i < ys.length - 1; i++) {
        // Cuts 0.2 mm apart: under 0.01 mm off a straight line through their neighbours
        // (0.001-0.006 mm, as with no toe; was 0.068).
        expect(Math.abs(ys[i + 1]! - 2 * ys[i]! + ys[i - 1]!)).toBeLessThan(1e-3);
      }
    }
  });
});
