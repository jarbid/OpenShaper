// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails store on a mirror board, an asymmetric board, a swallow and a fish: every edit leaves
 * a document the engine builds and meshes closed; undo and redo restore the exact documents; a drag
 * is one step; untouched curves keep their objects; the classic slices are read-only; slices,
 * corners, stations, symmetry, tails and features behave as the store promises.
 */
import type { RailsBoard } from '@openshaper/board2';
import { RADIUS_CROTCH, RADIUS_TAIL } from '@openshaper/board2/defaults';
import { vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { applyRailsEdit, cornerKnots } from './edits';
import { projectRails } from './project';
import { createRailsStore } from './rails-store';
import { tailTypeOf } from './shape';
import { engineVerdict, railsBoard, railsBoards } from './test-support/boards';
import { SCENARIOS } from './test-support/scenarios';
import { sliceOfStation } from './types';

const storeWith = (doc: RailsBoard) => {
  const store = createRailsStore();
  store.getState().loadDoc(doc);
  return store;
};

describe.each(railsBoards)('the rails store on the %s board', (_name, make) => {
  const doc = make();

  it.each(SCENARIOS)('%s: leaves a board the engine builds and meshes closed', (_s, run) => {
    const store = storeWith(doc);
    run(store.getState);
    const v = engineVerdict(store.getState().doc!);
    expect(v.why).toBe('');
    expect(v.ok).toBe(true);
  });

  it.each(SCENARIOS)(
    '%s: undo all restores the loaded document, redo all the edited one',
    (_s, run) => {
      const store = storeWith(doc);
      const g = store.getState;
      run(g);
      const after = g().doc;
      const steps = g().past.length;
      while (g().canUndo()) g().undo();
      expect(g().doc).toBe(doc);
      expect(g().board).toBe(projectRails(doc));
      for (let i = 0; i < steps; i++) g().redo();
      if (steps > 0 && g().future.length === 0) expect(g().doc).toBe(after);
    },
  );

  it('writes back an unchanged projection as the same document', () => {
    const p = projectRails(doc);
    expect(applyRailsEdit(doc, p, p)).toBe(doc);
  });

  it('makes a drag one undo step and keeps every curve it does not touch', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const s = g().board!.stationCurves[1]!.bottom;
    const i = s.knots.length > 2 ? 1 : s.knots.length - 1;
    g().beginEdit();
    for (let j = 1; j <= 5; j++) {
      g().moveControlPoint(
        { kind: 'stationBottom', index: 1 },
        i,
        vec2(s.knots[i]!.end.x, s.knots[i]!.end.y + j * 0.04),
      );
    }
    g().endEdit();
    const next = g().doc!;
    expect(g().past).toHaveLength(1);
    expect(next).not.toBe(doc);
    expect(next.outline).toBe(doc.outline);
    expect(next.rocker).toBe(doc.rocker);
    expect(next.deck).toBe(doc.deck);
    expect(next.corners).toBe(doc.corners);
    expect(next.rails).toBe(doc.rails);
    expect(next.features).toBe(doc.features);
    next.stations.forEach((st, k) => {
      if (k !== 1) expect(st).toBe(doc.stations[k]);
    });
    expect(next.stations[1]!.plus.deck).toBe(doc.stations[1]!.plus.deck);
    expect(next.stations[1]!.plus.bottom).not.toBe(doc.stations[1]!.plus.bottom);
    if (doc.stations[1]!.minus) expect(next.stations[1]!.minus).toBe(doc.stations[1]!.minus);
    // the edit itself, divided by the frame it was drawn in
    const e = projectRails(doc).stationCurves[1]!;
    expect(next.stations[1]!.plus.bottom.knots[i]!.p[1]).toBeCloseTo(
      (s.knots[i]!.end.y + 0.2) / e.T,
      12,
    );
    g().undo();
    expect(g().doc).toBe(doc);
    g().redo();
    expect(g().doc).toBe(next);
  });

  it('an outline edit keeps every station, rail key and the rocker and deck', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const k = g().board!.outline.knots[2]!;
    g().moveControlPoint({ kind: 'outline' }, 2, vec2(k.end.x, k.end.y + 0.3));
    const next = g().doc!;
    expect(next.outline.plus).not.toBe(doc.outline.plus);
    expect(next.stations).toBe(doc.stations);
    expect(next.rails).toBe(doc.rails);
    expect(next.rocker).toBe(doc.rocker);
    expect(next.corners).toBe(doc.corners);
  });

  it('reads the classic slices only: their spline actions do nothing', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const t = { kind: 'crossSection', index: 2 } as const;
    const k = g().board!.crossSections[2]!.spline.knots[1]!;
    g().moveControlPoint(t, 1, vec2(k.end.x + 1, k.end.y + 1));
    g().setContinuous(t, 1, false);
    g().addControlPoint(t, vec2(1, 1));
    g().pasteCrossSection(2, g().board!.crossSections[1]!.spline);
    g().applyRailPreset(2, '60-40-tucked');
    expect(g().doc).toBe(doc);
    expect(g().past).toHaveLength(0);
  });

  it('commits a document made elsewhere as one step, inside a drag as part of it', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const a = { ...doc, meta: { ...doc.meta, name: 'a' } };
    const b = { ...doc, meta: { ...doc.meta, name: 'b' } };
    g().commitDoc(doc, 'nothing');
    expect(g().past).toHaveLength(0);
    g().beginEdit();
    g().commitDoc(a, 'Engine edit');
    g().commitDoc(b, 'Engine edit');
    g().endEdit();
    expect(g().past.map((p) => p.label)).toEqual(['Engine edit']);
    expect(g().doc).toBe(b);
    g().undo();
    expect(g().doc).toBe(doc);
  });
});

describe('slices', () => {
  const doc = railsBoard('mirror');

  it('are drawn, not undone, kept through edits, and leave with their station', () => {
    const store = storeWith(doc);
    const g = store.getState;
    const [a, b] = doc.stations;
    const slices = {
      [a!.id]: { plus: [0, 0, 5, 0, 5, 5, 0, 6] },
      [b!.id]: { plus: [0, 0, 4, 4, 0, 5] },
    };
    g().setSlices(slices);
    expect(g().past).toHaveLength(0);
    expect(g().board!.crossSections[sliceOfStation(0)]!.spline.knots).toHaveLength(4);
    // an edit keeps them (stale until the app sends new ones)
    const k = g().board!.deck.knots[1]!;
    g().moveControlPoint({ kind: 'deck' }, 1, vec2(k.end.x, k.end.y + 0.2));
    expect(g().slices).toBe(slices);
    expect(g().board!.crossSections[sliceOfStation(0)]!.spline.knots).toHaveLength(4);
    // a station's slice follows its id when a station is added before it
    g().addCrossSection((doc.stations[0]!.x + doc.outline.plus.knots[0]!.p[0]) / 2 + 0.5);
    const i = g().doc!.stations.findIndex((s) => s.id === a!.id);
    expect(g().board!.crossSections[sliceOfStation(i)]!.spline.knots).toHaveLength(4);
    // removing a station drops its slice; undo brings the station back, drawn from its curves
    g().deleteCrossSection(sliceOfStation(i));
    expect(Object.keys(g().slices!)).toEqual([b!.id]);
    g().undo();
    const j = g().doc!.stations.findIndex((s) => s.id === a!.id);
    expect(g().board!.crossSections[sliceOfStation(j)]!.spline.knots.length).toBeGreaterThan(4);
    // a load drops them
    g().loadDoc(doc);
    expect(g().slices).toBeNull();
  });
});

describe('corners', () => {
  const doc = railsBoard('mirror');

  it('follow the outline: a new corner takes the default radius, the others keep theirs', () => {
    const custom: RailsBoard = {
      ...doc,
      corners: { ...doc.corners, plus: doc.corners.plus.map((_, i) => 0.1 * (i + 1)) },
    };
    const store = storeWith(custom);
    const g = store.getState;
    const corners0 = cornerKnots(custom.outline.plus);
    const o = g().board!.outline;
    // a smooth knot made a corner, after the existing corners
    let smooth = -1;
    for (let i = o.knots.length - 2; i > 0; i--)
      if (o.knots[i]!.continuous) {
        smooth = i;
        break;
      }
    expect(smooth).toBeGreaterThan(0);
    g().setContinuous({ kind: 'outline' }, smooth, false);
    const now = cornerKnots(g().doc!.outline.plus);
    expect(now).toHaveLength(corners0.length + 1);
    const at = now.indexOf(smooth);
    const radii = g().doc!.corners.plus;
    expect(radii[at]).toBe(RADIUS_TAIL);
    expect(radii.filter((_, j) => j !== at)).toEqual(custom.corners.plus);
    // a knot inserted before it moves nothing
    const seg = g().board!.outline;
    const p0 = seg.knots[1]!.end;
    const p1 = seg.knots[2]!.end;
    g().addControlPoint({ kind: 'outline' }, vec2((p0.x + p1.x) / 2, (p0.y + p1.y) / 2));
    expect(g().doc!.corners.plus).toEqual(radii);
    // deleting the new corner drops its radius
    const idx = cornerKnots(g().doc!.outline.plus)[at]!;
    g().deleteControlPoint({ kind: 'outline' }, idx);
    expect(g().doc!.corners.plus).toEqual(custom.corners.plus);
  });

  it('follow a tail change: crotch on a new notch, tip a fresh corner, tail radius back on standard', () => {
    const store = storeWith(doc);
    const g = store.getState;
    g().setTail('swallow');
    let d = g().doc!;
    expect(tailTypeOf(d)).toBe('swallow');
    expect(d.corners.tail).toBe(RADIUS_CROTCH);
    expect(d.corners.plus).toHaveLength(cornerKnots(d.outline.plus).length);
    expect(d.corners.plus[0]).toBe(RADIUS_TAIL);
    const tipped = { ...d.corners, plus: d.corners.plus.map((r, i) => (i === 0 ? 0.33 : r)) };
    g().commitDoc({ ...d, corners: tipped }, 'radius');
    g().setTail('fish');
    d = g().doc!;
    expect(tailTypeOf(d)).toBe('fish');
    expect(d.corners.plus[0]).toBe(0.33);
    expect(d.corners.tail).toBe(RADIUS_CROTCH);
    g().setTail('standard');
    d = g().doc!;
    expect(d.corners.tail).toBe(RADIUS_TAIL);
    expect(d.corners.plus).toEqual(doc.corners.plus);
  });
});

describe('stations', () => {
  it.each(railsBoards)(
    'on the %s board: blended between neighbours, held between them, at least two',
    (_n, make) => {
      const doc = make();
      const store = storeWith(doc);
      const g = store.getState;
      const [, a, b] = doc.stations;
      const x = (a!.x + b!.x) / 2;
      const i = g().addCrossSection(x);
      const st = g().doc!.stations[i - 1]!;
      expect(st.x).toBe(x);
      expect(new Set(g().doc!.stations.map((s) => s.id)).size).toBe(g().doc!.stations.length);
      if (a!.plus.bottom.knots.length === b!.plus.bottom.knots.length) {
        const k = st.plus.bottom.knots[1]!;
        expect(k.p[0]).toBeCloseTo(
          (a!.plus.bottom.knots[1]!.p[0] + b!.plus.bottom.knots[1]!.p[0]) / 2,
          12,
        );
      }
      expect(g().addCrossSection(x)).toBe(-1);
      expect(st.minus !== undefined).toBe(doc.symmetry === 'asymmetric');
      g().moveCrossSection(i, b!.x + 50);
      expect(g().doc!.stations[i - 1]!.x).toBeLessThan(b!.x);
      expect(g().doc!.stations[i - 1]!.x).toBeGreaterThan(b!.x - 0.01);
      while (g().doc!.stations.length > 2) g().deleteCrossSection(1);
      g().deleteCrossSection(1);
      expect(g().doc!.stations).toHaveLength(2);
    },
  );
});

describe('scale', () => {
  it('scales rails across by the width and along by the length, corners and curves unchanged', () => {
    const doc = railsBoard('asymmetric');
    const store = storeWith(doc);
    const g = store.getState;
    g().scaleBoard(1.1, 0.9, 1.2);
    const d = g().doc!;
    const k0 = doc.rails.plus[0]!;
    const k1 = d.rails.plus[0]!;
    expect(k1.x).toBeCloseTo(k0.x * 1.1, 9);
    expect(k1.rail.band).toBeCloseTo(k0.rail.band * 0.9, 12);
    expect(k1.rail.tuck).toBeCloseTo(k0.rail.tuck * 0.9, 12);
    expect(k1.rail.apex).toBe(k0.rail.apex);
    expect(k1.rail.hardness).toBe(k0.rail.hardness);
    expect(d.corners).toBe(doc.corners);
    d.stations.forEach((s, i) => {
      expect(s.x).toBeCloseTo(doc.stations[i]!.x * 1.1, 9);
      expect(s.plus).toBe(doc.stations[i]!.plus);
    });
    expect(d.outline.minus!.knots.at(-1)!.p[0]).toBe(d.outline.plus.knots.at(-1)!.p[0]);
  });
});

describe('symmetry', () => {
  it('shares the plus side going asymmetric, and keeps the side named going back', () => {
    const doc = railsBoard('mirror');
    const store = storeWith(doc);
    const g = store.getState;
    g().setSymmetry('asymmetric');
    const d = g().doc!;
    expect(d.outline.minus).toBe(doc.outline.plus);
    expect(d.corners.minus).toBe(doc.corners.plus);
    expect(d.rails.minus).toBe(doc.rails.plus);
    d.stations.forEach((s) => expect(s.minus).toBe(s.plus));
    expect(g().board!.minus!.stationCurves).toHaveLength(d.stations.length);
    g().setSymmetry('mirror', 'plus');
    expect(g().doc!.outline.plus).toBe(doc.outline.plus);
    expect(g().doc!.outline.minus).toBeUndefined();
    expect(g().doc!.corners.minus).toBeUndefined();
    expect(g().doc!.stations[0]!.minus).toBeUndefined();
  });
});

describe('features', () => {
  it('are the section store edits, measured against the engine half width on a notched board', () => {
    const doc = railsBoard('swallow');
    const store = storeWith(doc);
    const g = store.getState;
    g().addFeature('channels');
    const f = g().doc!.features.at(-1)!;
    expect(g().featureLimits(f.id)?.count?.max).toBeGreaterThanOrEqual(1);
    g().setFeatureParams(f.id, { count: 4, railInset: 100 });
    const lim = g().featureLimits(f.id)!;
    const now = g().doc!.features.at(-1)!;
    expect(now.kind === 'channels' && now.railInset).toBeLessThanOrEqual(lim.railInset!.max);
    expect(g().doc!.stations).toBe(doc.stations);
    expect(g().past.map((p) => p.label)).toEqual(['Add Channels', 'Set channels']);
  });
});
