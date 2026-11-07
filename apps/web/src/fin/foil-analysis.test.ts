// SPDX-License-Identifier: GPL-3.0-or-later
import {
  bladeFoilAt,
  chordAt,
  defaultFinDesign,
  prepareBlade,
  type FinDesign,
} from '@openshaper/kernel';
import { TIP_FOIL } from '@openshaper/store';
import { describe, expect, it } from 'vitest';
import { FOIL_ANALYSIS_DEFAULT, foilGhosts, ghostAt, type FoilAnalysis } from './foil-analysis';

/** The default side fin with control sections at 30% and 70%. */
const fin = (): FinDesign => {
  const d = defaultFinDesign('side', 'left');
  return {
    ...d,
    slices: [0.3, 0.7].map((height) => ({ height, section: bladeFoilAt(d, height) })),
  };
};
const at = (patch: Partial<FoilAnalysis>): FoilAnalysis => ({
  ...FOIL_ANALYSIS_DEFAULT,
  on: true,
  ...patch,
});
/** A ghost's leading and trailing edges: the middle of its faces' first and last points. */
const edges = (o: readonly { x: number; y: number }[]) => {
  const n = o.length / 2;
  const le = { x: (o[0]!.x + o[o.length - 1]!.x) / 2, y: (o[0]!.y + o[o.length - 1]!.y) / 2 };
  const te = { x: (o[n - 1]!.x + o[n]!.x) / 2, y: (o[n - 1]!.y + o[n]!.y) / 2 };
  return { le, te };
};

describe('the foil view’s analysis', () => {
  const d = fin();

  it('shows the base and tip foils and the other control sections, lowest first', () => {
    const g = foilGhosts(d, 1, at({}));
    expect(g.map((x) => x.kind)).toEqual(['base', 'control', 'tip']);
    expect(g.map((x) => x.level)).toEqual([...g.map((x) => x.level)].sort((p, q) => p - q));
    // The active foil itself is not a ghost.
    expect(foilGhosts(d, 0, at({})).map((x) => x.kind)).toEqual(['control', 'control', 'tip']);
    expect(foilGhosts(d, TIP_FOIL, at({})).some((x) => x.kind === 'tip')).toBe(false);
  });

  it('lines the sections up at the front, the rear or the thickest point', () => {
    for (const g of foilGhosts(d, 1, at({ align: 'front' }))) {
      const { le } = edges(g.outline);
      expect(Math.hypot(le.x, le.y)).toBeLessThan(1e-9);
    }
    for (const g of foilGhosts(d, 1, at({ align: 'rear' }))) {
      const { te } = edges(g.outline);
      expect(Math.hypot(te.x - 1, te.y)).toBeLessThan(1e-9);
    }
    // Thickest: each ghost's thickest point on the active foil's.
    const thick = (o: readonly { x: number; y: number }[]) => {
      const n = o.length / 2;
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (o[i]!.y - o[o.length - 1 - i]!.y > o[k]!.y - o[o.length - 1 - k]!.y) k = i;
      }
      return {
        x: (o[k]!.x + o[o.length - 1 - k]!.x) / 2,
        y: (o[k]!.y + o[o.length - 1 - k]!.y) / 2,
      };
    };
    const [first, ...rest] = foilGhosts(d, 1, at({ align: 'thickest' })).map((g) =>
      thick(g.outline),
    );
    for (const p of rest) {
      expect(p.x).toBeCloseTo(first!.x, 6);
      expect(p.y).toBeCloseTo(first!.y, 6);
    }
  });

  it('keeps each section where it sits on the tab, like the 3D view’s cuts', () => {
    // From the base foil: a control section higher up starts further back, by as much as
    // the leading edge sweeps back to its height, in base chords.
    const b = prepareBlade(d);
    const base = chordAt(b, 0);
    const up = chordAt(b, 0.7 * b.depth);
    const g = foilGhosts(d, 0, at({ align: 'tab' })).find(
      (x) => x.kind === 'control' && x.level > 0.5,
    )!;
    const { le } = edges(g.outline);
    expect(le.x).toBeCloseTo((base.leading - up.leading) / (base.leading - base.trailing), 2);
    // The cant leans it out: off the base foil's chord line, toward the outside face.
    expect(le.y).toBeGreaterThan(0.01);
  });

  it('cuts the blade every so many millimetres instead', () => {
    const g = foilGhosts(d, 0, at({ show: 'every', every: 1 }));
    expect(g.every((x) => x.kind === 'cut')).toBe(true);
    // 0, 10, 20 … up to just short of the 100 mm top.
    expect(g.map((x) => Math.round(x.height * 10))).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);
  });

  it('finds the section under the pointer', () => {
    const g = foilGhosts(d, 1, at({ align: 'front' }));
    const p = g[0]!.outline[10]!;
    expect(ghostAt(g, p, 0.01)).toBe(0);
    expect(ghostAt(g, { x: 5, y: 5 }, 0.01)).toBe(-1);
  });
});
