// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section editor (docs/design/m2-editor.md §3, step 2): a slice drag obeys the Phase 0 rules and
 * refits one section, no drag of any handle breaks a `section-*` rule, an added station sits on the
 * surface it was added to, and every station action undoes and redoes.
 */
import type { BoardDoc } from '@openshaper/board2';
import {
  buildBoard,
  createChordFn,
  createEvaluator,
  probeSection,
  validateBoard,
} from '@openshaper/board2';
import { vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { createSectionStore, projectDoc, setSymmetry, type NotchChords } from './index';
import { minusHalf } from '../edits';
import { GOLDEN_NAMES, goldenDoc, testDocs } from './test-support/docs';

const chords: NotchChords = (doc, side) => createChordFn(doc, side);

const opened = (doc: BoardDoc) => {
  const store = createSectionStore();
  store.getState().setNotchChords(chords);
  store.getState().loadDoc(doc);
  return store;
};

const errors = (doc: BoardDoc) => validateBoard(doc).filter((i) => i.severity === 'error');
const sectionErrors = (doc: BoardDoc) => errors(doc).filter((i) => i.code.startsWith('section-'));

const lcg = (seed: number) => () =>
  (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

describe('slice edits', () => {
  it.each(GOLDEN_NAMES)('%s: a section drag replaces exactly one Section', (name) => {
    const doc = goldenDoc(name);
    const store = opened(doc);
    const index = 3;
    const target = { kind: 'crossSection' as const, index };
    const slice = store.getState().board!.crossSections[index]!.spline;
    const k = Math.floor(slice.knots.length / 2);
    const p = slice.knots[k]!.end;
    store.getState().beginEdit();
    for (let n = 1; n <= 5; n++) {
      store.getState().moveControlPoint(target, k, vec2(p.x * (1 - 0.01 * n), p.y + 0.05 * n));
    }
    store.getState().endEdit();
    const next = store.getState().doc!;
    expect(next).not.toBe(doc);
    // the lines, the fins and every other Section are the very objects they were
    expect(next.outline).toBe(doc.outline);
    expect(next.rocker).toBe(doc.rocker);
    expect(next.deck).toBe(doc.deck);
    expect(next.stations).not.toBe(doc.stations);
    next.stations.forEach((s, i) => {
      if (i === index - 1) expect(s.plus).not.toBe(doc.stations[i]!.plus);
      else expect(s).toBe(doc.stations[i]);
    });
    expect(next.stations[index - 1]!.id).toBe(doc.stations[index - 1]!.id);
    expect(store.getState().past).toHaveLength(1);
    expect(sectionErrors(next)).toEqual([]);
  });

  it('the centre points are held and the apex only moves vertically', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const index = 4;
    const target = { kind: 'crossSection' as const, index };
    const section = () => store.getState().doc!.stations[index - 1]!.plus;
    const was = section();
    const last = was.chain.knots.length - 1;
    const apex = was.apex;
    store.getState().moveControlPoint(target, 0, vec2(0.5, 0.5));
    store.getState().moveControlPoint(target, last, vec2(0.5, 0.5));
    expect(store.getState().doc!.stations[index - 1]!.plus).toBe(was);
    const slice = store.getState().board!.crossSections[index]!.spline;
    const a = slice.knots[apex]!.end;
    store.getState().moveControlPoint(target, apex, vec2(a.x - 1, a.y + 0.1));
    const moved = section().chain.knots[apex]!;
    expect(moved.p[0]).toBe(1);
    expect(moved.p[1]).toBeCloseTo(
      was.chain.knots[apex]!.p[1] + 0.1 / slice.knots.at(-1)!.end.y,
      9,
    );
    expect(sectionErrors(store.getState().doc!)).toEqual([]);
  });

  it('a notch-zone station is projected on its chord, not the plan half-width', () => {
    const doc = testDocs.find(([n]) => n === 'swallow')![1]();
    const chord = createChordFn(doc);
    const without = projectDoc(doc);
    const withChords = projectDoc(doc, chords);
    let differs = 0;
    doc.stations.forEach((st, i) => {
      const width = (b: typeof without) =>
        Math.max(...b.crossSections[i + 1]!.spline.knots.map((k) => k.end.x));
      expect(width(withChords)).toBeCloseTo(chord(st.x), 9);
      if (Math.abs(width(withChords) - width(without)) > 1e-6) differs++;
    });
    expect(differs).toBeGreaterThan(0);
  });
});

describe('fuzz: no drag of any handle of any station breaks a section rule', () => {
  /**
   * Seeded random drags of every knot and both handles of each, of every station of `doc`, on the side
   * `side` (the minus half of an asymmetric board, or the only half of a mirror one).
   */
  const fuzz = (doc: BoardDoc, side: 'plus' | 'minus') => {
    const rand = lcg(20261102);
    const store = opened(doc);
    const stations = store.getState().doc!.stations.length;
    const half = () =>
      side === 'minus' ? minusHalf(store.getState().board!)! : store.getState().board!;
    let moves = 0;
    for (let index = 1; index <= stations; index++) {
      const target =
        side === 'minus'
          ? { kind: 'crossSection' as const, index, side: 'minus' as const }
          : { kind: 'crossSection' as const, index };
      const count = half().crossSections[index]!.spline.knots.length;
      for (let k = 0; k < count; k++) {
        for (const handle of ['end', 'prev', 'next'] as const) {
          for (let n = 0; n < 4; n++) {
            const spline = half().crossSections[index]!.spline;
            const knot = spline.knots[k]!;
            const at =
              handle === 'end'
                ? knot.end
                : handle === 'prev'
                  ? knot.tangentToPrev
                  : knot.tangentToNext;
            // drags far larger than the section: past the apex line, across the stringer, below the bottom
            const to = vec2(at.x + (rand() - 0.5) * 12, at.y + (rand() - 0.5) * 6);
            store.getState().beginEdit();
            if (handle === 'end') store.getState().moveControlPoint(target, k, to);
            else store.getState().moveTangent(target, k, handle, to);
            store.getState().endEdit();
            moves++;
            const bad = sectionErrors(store.getState().doc!);
            expect(bad, `station ${index} knot ${k} ${handle} drag ${n}`).toEqual([]);
          }
        }
      }
    }
    expect(moves).toBeGreaterThan(100);
    const first = store.getState().past[0]!.doc;
    const last = store.getState().doc!;
    // the lines never moved
    expect(last.outline).toBe(first.outline);
    expect(last.rocker).toBe(first.rocker);
    expect(last.deck).toBe(first.deck);
    return { first, last };
  };

  it.each(testDocs.filter(([n]) => n !== 'asymmetric'))('%s', (_name, make) => {
    fuzz(make(), 'plus');
  });

  it.each(['asymmetric', ...GOLDEN_NAMES])('%s as an asymmetric board: the minus side', (name) => {
    const made = testDocs.find(([n]) => n === name)![1];
    const doc = setSymmetry(made(), 'asymmetric');
    const { first, last } = fuzz(doc, 'minus');
    // only the minus sections changed
    last.stations.forEach((s, i) => expect(s.plus).toBe(first.stations[i]!.plus));
    expect(last.stations.some((s, i) => s.minus !== first.stations[i]!.minus)).toBe(true);
  });

  it('the plus side of an asymmetric board, with the minus left alone', () => {
    const doc = testDocs.find(([n]) => n === 'asymmetric')![1]();
    const { first, last } = fuzz(doc, 'plus');
    last.stations.forEach((s, i) => expect(s.minus).toBe(first.stations[i]!.minus));
  });
});

describe('add, remove and move a station', () => {
  /** The largest distance (cm) from the points of `a` to the polyline `b`. */
  const away = (a: number[], b: number[]): number => {
    let worst = 0;
    for (let i = 0; i < a.length; i += 2) {
      let best = Infinity;
      for (let j = 0; j + 3 < b.length; j += 2) {
        const [x0, y0, x1, y1] = [b[j]!, b[j + 1]!, b[j + 2]!, b[j + 3]!];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = dx * dx + dy * dy;
        const t =
          len === 0
            ? 0
            : Math.max(0, Math.min(1, ((a[i]! - x0) * dx + (a[i + 1]! - y0) * dy) / len));
        best = Math.min(best, Math.hypot(a[i]! - (x0 + t * dx), a[i + 1]! - (y0 + t * dy)));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };

  const section = (doc: BoardDoc, xi: number) => {
    const r = buildBoard(doc, { check: false });
    if (!r.ok) throw new Error('did not build');
    return probeSection(r.value, createEvaluator(r.value), 0, xi, 96);
  };

  it.each(GOLDEN_NAMES)(
    '%s: an added station is within 1.1 mm of the surface it was added to',
    (name) => {
      const doc = goldenDoc(name);
      const L = doc.outline.plus.knots.at(-1)!.p[0];
      let worst = 0;
      // between every pair of stations (the blend is furthest from the classic loft mid-way)
      const xs = [0, ...doc.stations.map((s) => s.x), L];
      for (let i = 0; i + 1 < xs.length; i++) {
        const x = (xs[i]! + xs[i + 1]!) / 2;
        const store = opened(doc);
        const index = store.getState().addCrossSection(x);
        expect(index).toBeGreaterThan(0);
        const next = store.getState().doc!;
        expect(next.stations).toHaveLength(doc.stations.length + 1);
        expect(next.stations[index - 1]!.x).toBe(x);
        expect(errors(next)).toEqual([]);
        const before = section(doc, x);
        const after = section(next, x);
        worst = Math.max(worst, away(after, before), away(before, after));
      }
      expect(worst).toBeLessThan(0.11);
    },
  );

  it('adds, removes and moves a station, and each undoes and redoes', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const s = () => store.getState();
    const x = (doc.stations[2]!.x + doc.stations[3]!.x) / 2;
    const index = s().addCrossSection(x);
    const added = s().doc!;
    expect(added.stations).toHaveLength(doc.stations.length + 1);
    s().moveCrossSection(index, x + 1);
    const moved = s().doc!;
    expect(moved.stations[index - 1]!.x).toBeCloseTo(x + 1, 9);
    expect(moved.stations[index - 1]!.plus).toBe(added.stations[index - 1]!.plus);
    // a station cannot pass its neighbour
    s().moveCrossSection(index, 1e6);
    expect(s().doc!.stations[index - 1]!.x).toBeLessThan(doc.stations[3]!.x);
    s().deleteCrossSection(index);
    expect(s().doc!.stations).toHaveLength(doc.stations.length);
    expect(s().doc!.stations.map((st) => st.id)).toEqual(doc.stations.map((st) => st.id));
    expect(s().past.map((h) => h.label)).toEqual([
      'Add cross-section',
      'Move cross-section',
      'Move cross-section',
      'Delete cross-section',
    ]);
    s().undo();
    expect(s().doc!.stations).toHaveLength(doc.stations.length + 1);
    s().undo();
    s().undo();
    expect(s().doc).toBe(added);
    s().undo();
    expect(s().doc).toBe(doc);
    s().redo();
    expect(s().doc).toBe(added);
    s().redo();
    s().redo();
    s().redo();
    expect(s().doc!.stations).toHaveLength(doc.stations.length);
    // the section store's board follows the document
    expect(s().board).toBe(projectDoc(s().doc!, chords));
  });

  it('keeps at least two stations and refuses an add outside the board or on a station', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const L = doc.outline.plus.knots.at(-1)!.p[0];
    expect(store.getState().addCrossSection(-1)).toBe(-1);
    expect(store.getState().addCrossSection(L + 1)).toBe(-1);
    expect(store.getState().addCrossSection(doc.stations[2]!.x)).toBe(-1);
    for (let n = 0; n < doc.stations.length; n++) store.getState().deleteCrossSection(1);
    expect(store.getState().doc!.stations).toHaveLength(2);
  });

  it('paste and a rail preset write one valid section', () => {
    const doc = goldenDoc('funboard');
    const store = opened(doc);
    const s = () => store.getState();
    const from = s().board!.crossSections[3]!.spline;
    s().pasteCrossSection(5, from);
    const pasted = s().doc!;
    expect(pasted.stations.filter((st, i) => st !== doc.stations[i])).toHaveLength(1);
    expect(sectionErrors(pasted)).toEqual([]);
    s().applyRailPreset(3, '60-40-tucked');
    const preset = s().doc!;
    expect(preset.stations.filter((st, i) => st !== pasted.stations[i])).toHaveLength(1);
    expect(sectionErrors(preset)).toEqual([]);
    expect(s().past.map((h) => h.label)).toEqual([
      'Paste cross-section',
      expect.stringContaining('Rail preset'),
    ]);
  });
});
