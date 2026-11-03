// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Gestures are pure functions of the pointer (M2 review R5, R6): the notch depth is computed from the
 * document the drag began with, so going back restores the stations and feature keys a deeper notch
 * dropped or squeezed; an outline edit brings channels inside the chord, from the drag's features.
 */
import { validateBoard } from '@openshaper/board2';
import { vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { addFeature, featureLimits, setFeatureParams } from './features';
import { createSectionStore } from './index';
import { setTail } from './shape';
import { goldenDoc } from './test-support/docs';

const errors = (doc: Parameters<typeof validateBoard>[0]) =>
  validateBoard(doc).filter((i) => i.severity === 'error');

describe('notch depth drag', () => {
  it('deepen past a station and back in one drag restores the stations and the feature keys', () => {
    const base = addFeature(setTail(goldenDoc('shortboard'), 'swallow'), 'double-concave');
    const store = createSectionStore();
    store.getState().loadDoc(base);
    const d0 = base.outline.plus.knots[0]!.p[0];
    const L = base.outline.plus.knots.at(-1)!.p[0];
    // past the first station, within the notch limit (30% of the length)
    const deep = base.stations[0]!.x + 1;
    expect(deep).toBeLessThan(0.3 * L);

    const s = store.getState();
    s.beginEdit();
    s.moveControlPoint({ kind: 'outline' }, 0, vec2(deep, 0));
    expect(store.getState().doc!.stations.length).toBeLessThan(base.stations.length);
    s.moveControlPoint({ kind: 'outline' }, 0, vec2(d0, 0));
    s.endEdit();

    const doc = store.getState().doc!;
    expect(doc.stations.length).toBe(base.stations.length);
    expect(doc.features).toEqual(base.features);
    // one undo step for the whole gesture
    expect(store.getState().past).toHaveLength(1);
  });
});

describe('channels follow an outline edit', () => {
  it('narrowing the outline under the channels raises no feature-invalid, plus and minus', () => {
    for (const asym of [false, true]) {
      let base = addFeature(goldenDoc('shortboard'), 'channels');
      // as many, as wide and as far out as the board allows now
      const ch = base.features.find((f) => f.kind === 'channels')!;
      const lim = featureLimits(base, ch);
      base = setFeatureParams(base, ch.id, { count: lim.count!.max });
      base = setFeatureParams(base, ch.id, { pitch: featureLimits(base, ch).pitch!.max });
      const store = createSectionStore();
      store.getState().loadDoc(base);
      if (asym) store.getState().setSymmetry('asymmetric');
      base = store.getState().doc!;
      const knots = base.outline.plus.knots;
      const i = 1;
      const [x, y] = knots[i]!.p;
      for (const side of asym ? (['plus', 'minus'] as const) : (['plus'] as const)) {
        const s = createSectionStore();
        s.getState().loadDoc(base);
        s.getState().beginEdit();
        s.getState().moveControlPoint({ kind: 'outline', side }, i, vec2(x, y * 0.1));
        s.getState().endEdit();
        const doc = s.getState().doc!;
        expect(doc).not.toBe(base);
        expect(errors(doc).filter((e) => /feature/.test(e.code ?? ''))).toEqual([]);
        expect(errors(doc)).toEqual([]);
      }
    }
  });
});
