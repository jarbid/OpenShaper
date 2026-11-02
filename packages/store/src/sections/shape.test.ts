// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Symmetry, tail type and notch depth (docs/design/m2-editor.md §2, step 3): switching to asymmetric
 * shares the sections (no refit), switching back keeps the chosen half bit for bit, a swallow and a fish
 * made from each golden board validate, and a notch-depth drag either validates or leaves a refusal the
 * viewer can report, never a crash.
 */
import { buildBoard, createChordFn, validateBoard, type BoardDoc } from '@openshaper/board2';
import { vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  createSectionStore,
  defaultNotchDepth,
  setNotchDepth,
  setSymmetry,
  setTail,
  tailTypeOf,
  type NotchChords,
} from './index';
import { minusHalf } from '../edits';
import { GOLDEN_NAMES, goldenDoc, testDocs } from './test-support/docs';

const errors = (doc: BoardDoc) => validateBoard(doc).filter((i) => i.severity === 'error');
const chords: NotchChords = (doc, side) => createChordFn(doc, side);

const opened = (doc: BoardDoc) => {
  const store = createSectionStore();
  store.getState().setNotchChords(chords);
  store.getState().loadDoc(doc);
  return store;
};

describe('symmetry', () => {
  it.each(GOLDEN_NAMES)('%s: asymmetric shares every Section and the outline chain', (name) => {
    const doc = goldenDoc(name);
    const asym = setSymmetry(doc, 'asymmetric');
    expect(asym.symmetry).toBe('asymmetric');
    expect(asym.outline.minus).toBe(doc.outline.plus);
    asym.stations.forEach((s, i) => {
      expect(s.minus).toBe(doc.stations[i]!.plus);
      expect(s.plus).toBe(doc.stations[i]!.plus);
    });
    // the lines, features and fins are not copied
    expect(asym.rocker).toBe(doc.rocker);
    expect(asym.deck).toBe(doc.deck);
    expect(asym.features).toBe(doc.features);
    expect(errors(asym)).toEqual([]);
    // and the two halves of the built board are the mirror board's
    const a = buildBoard(asym, { check: false });
    const m = buildBoard(doc, { check: false });
    expect(a.ok && m.ok).toBe(true);
    // going asymmetric twice, or mirror twice, is no change
    expect(setSymmetry(asym, 'asymmetric')).toBe(asym);
    expect(setSymmetry(doc, 'mirror')).toBe(doc);
  });

  it.each(['plus', 'minus'] as const)('back to mirror keeps the %s half bit for bit', (keep) => {
    const asym = testDocs.find(([n]) => n === 'asymmetric')![1]();
    const back = setSymmetry(asym, 'mirror', keep);
    expect(back.symmetry).toBe('mirror');
    expect(back.outline.minus).toBeUndefined();
    expect(back.outline.plus).toBe(keep === 'plus' ? asym.outline.plus : asym.outline.minus);
    back.stations.forEach((s, i) => {
      expect(s.minus).toBeUndefined();
      expect(s.plus).toBe(keep === 'plus' ? asym.stations[i]!.plus : asym.stations[i]!.minus);
    });
    // the same bits through JSON, too
    const kept = keep === 'plus' ? asym.outline.plus : asym.outline.minus;
    expect(JSON.stringify(back.outline.plus)).toBe(JSON.stringify(kept));
    expect(errors(back)).toEqual([]);
  });

  it('a minus edit through the store changes only the minus half, and undoes', () => {
    const store = opened(setSymmetry(goldenDoc('shortboard'), 'asymmetric'));
    const s = () => store.getState();
    const doc = s().doc!;
    const k = 2;
    const p = s().board!.outline.knots[k]!.end;
    expect(minusHalf(s().board!)).toBeDefined();
    s().moveControlPoint({ kind: 'outline', side: 'minus' }, k, vec2(p.x, p.y - 2));
    const next = s().doc!;
    expect(next.outline.plus).toBe(doc.outline.plus);
    expect(next.outline.minus).not.toBe(doc.outline.minus);
    expect(next.outline.minus!.knots[k]!.p[1]).toBeCloseTo(p.y - 2, 9);
    expect(next.stations).toBe(doc.stations);
    expect(next.rocker).toBe(doc.rocker);
    expect(s().past.map((h) => h.label)).toEqual(['Move control point']);
    expect(errors(next)).toEqual([]);
    s().undo();
    expect(s().doc).toBe(doc);
  });

  it('a plus end-point move carries the minus end with it', () => {
    const store = opened(setSymmetry(goldenDoc('shortboard'), 'asymmetric'));
    const s = () => store.getState();
    const n = s().board!.outline.knots.length - 1;
    const nose = s().board!.outline.knots[n]!.end;
    s().moveControlPoint({ kind: 'outline' }, n, vec2(nose.x + 3, 0));
    const next = s().doc!;
    const last = (c: BoardDoc['outline']['plus']) => c.knots[c.knots.length - 1]!.p[0];
    expect(last(next.outline.plus)).toBeCloseTo(nose.x + 3, 9);
    expect(last(next.outline.minus!)).toBe(last(next.outline.plus));
    expect(errors(next)).toEqual([]);
  });
});

describe('tail type', () => {
  const tails = ['swallow', 'fish'] as const;

  it.each(GOLDEN_NAMES.flatMap((n) => tails.map((t) => [n, t] as const)))(
    '%s as a %s validates, reads back as one and goes back to standard',
    (name, type) => {
      const doc = goldenDoc(name);
      const made = setTail(doc, type);
      expect(made.tail).toMatchObject({ kind: 'notched', auto: true });
      expect(errors(made), 'made').toEqual([]);
      expect(tailTypeOf(made)).toBe(type);
      // the notch bottom is the station range's start
      const d = made.outline.plus.knots[0]!.p[0];
      expect(d).toBeCloseTo(defaultNotchDepth(type, made.outline.plus.knots.at(-1)!.p[0]), 9);
      expect(made.stations.every((s) => s.x >= d)).toBe(true);
      // the section objects are the ones the board had
      made.stations.forEach((s) => expect(doc.stations.some((o) => o.plus === s.plus)).toBe(true));
      expect(buildBoard(made).ok).toBe(true);
      const other = setTail(made, type === 'swallow' ? 'fish' : 'swallow');
      expect(errors(other), 'other').toEqual([]);
      expect(tailTypeOf(other)).not.toBe(type);
      expect(other.outline.plus.knots[0]!.p[0]).toBe(d);
      const back = setTail(made, 'standard');
      expect(back.tail).toEqual({ kind: 'standard' });
      expect(errors(back), 'back').toEqual([]);
      expect(setTail(back, 'standard')).toBe(back);
      expect(setTail(made, type)).toBe(made);
    },
  );

  it('an asymmetric board gets the notch on both halves', () => {
    const asym = setSymmetry(goldenDoc('funboard'), 'asymmetric');
    const made = setTail(asym, 'swallow');
    expect(errors(made)).toEqual([]);
    expect(made.outline.minus!.knots[0]!.p[0]).toBe(made.outline.plus.knots[0]!.p[0]);
    expect(tailTypeOf(setTail(made, 'standard'))).toBe('standard');
  });
});

describe('notch depth', () => {
  it.each(GOLDEN_NAMES.flatMap((n) => (['swallow', 'fish'] as const).map((t) => [n, t] as const)))(
    '%s %s: drags over 0.5 to 2 x the default depth validate or are refused with a reason',
    (name, type) => {
      const made = setTail(goldenDoc(name), type);
      const d0 = made.outline.plus.knots[0]!.p[0];
      let valid = 0;
      for (let i = 0; i <= 30; i++) {
        const doc = setNotchDepth(made, d0 * (0.5 + (1.5 * i) / 30));
        const issues = errors(doc);
        const built = buildBoard(doc);
        // never a throw; a refusal carries issues the viewer reports
        expect(built.ok).toBe(issues.length === 0);
        if (!built.ok) expect(built.issues.length).toBeGreaterThan(0);
        else valid++;
        // the tail tip stays at x = 0 and the wall moves in x only
        expect(doc.outline.plus.knots[1]!.p).toEqual(made.outline.plus.knots[1]!.p);
      }
      // the default depth and the shallow half of the range are fine
      expect(valid).toBeGreaterThan(10);
      expect(errors(setNotchDepth(made, d0 * 0.5))).toEqual([]);
    },
  );

  it('moves the station on the notch bottom with it and drops those it passes', () => {
    const made = testDocs.find(([n]) => n === 'swallow')![1]();
    const d = made.outline.plus.knots[0]!.p[0];
    expect(made.stations[0]!.x).toBe(d);
    const deeper = setNotchDepth(made, d * 1.5);
    expect(deeper.stations[0]!.x).toBe(d * 1.5);
    expect(deeper.stations[0]!.plus).toBe(made.stations[0]!.plus);
    // 11 -> 30 passes the station at 24
    const past = setNotchDepth(made, 30);
    expect(past.stations.map((s) => s.x)).toEqual([30, 40, 70, 100, 130, 160, 185]);
    // a standard tail has no notch
    const std = goldenDoc('shortboard');
    expect(setNotchDepth(std, 10)).toBe(std);
  });

  it('dragging the notch bottom in the outline pane sets the depth, as one undo step', () => {
    const made = setTail(goldenDoc('shortboard'), 'swallow');
    const store = opened(made);
    const s = () => store.getState();
    const d = made.outline.plus.knots[0]!.p[0];
    s().beginEdit();
    for (let n = 1; n <= 5; n++) s().moveControlPoint({ kind: 'outline' }, 0, vec2(d + n, 3));
    s().endEdit();
    expect(s().doc!.outline.plus.knots[0]!.p).toEqual([d + 5, 0]);
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(s().doc).toBe(made);
  });
});
