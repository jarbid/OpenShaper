// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section store (docs/design/m2-editor.md §1, step 1): the classic projection round trips, the
 * line editors write back only what they touch and keep every Section object, and history works on
 * documents.
 */
import type { BoardDoc } from '@openshaper/board2';
import { validateBoard } from '@openshaper/board2';
import { vec2, type BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../board-store';
import {
  chainToSpline,
  createSectionStore,
  projectDoc,
  sectionToSlice,
  sliceToSection,
  splineToChain,
  splineToDeckChain,
} from './index';
import { GOLDEN_NAMES, goldenDoc, testDocs } from './test-support/docs';

const errorsOf = (doc: BoardDoc) => validateBoard(doc).filter((i) => i.severity === 'error');

const opened = (doc: BoardDoc) => {
  const store = createSectionStore();
  store.getState().loadDoc(doc);
  return store;
};

const sections = (doc: BoardDoc) =>
  doc.stations.flatMap((s) => (s.minus ? [s.plus, s.minus] : [s.plus]));

describe('projection', () => {
  it.each(testDocs)('%s: chain -> spline -> chain is bit-identical', (_name, make) => {
    const doc = make();
    const b = projectDoc(doc);
    expect(splineToChain(chainToSpline(doc.outline.plus))).toEqual(doc.outline.plus);
    expect(splineToChain(b.outline)).toEqual(doc.outline.plus);
    expect(splineToChain(b.bottom)).toEqual(doc.rocker);
    expect(splineToDeckChain(b.deck)).toEqual(doc.deck);
    // and the numbers are the very same bits (toEqual would pass 0 and -0 alike)
    const bits = (c: { knots: readonly { p: readonly number[] }[] }) =>
      JSON.stringify(c.knots.map((k) => k.p.map((v) => Object.is(v, -0))));
    expect(bits(splineToChain(b.outline))).toBe(bits(doc.outline.plus));
  });

  it.each(testDocs)('%s: classic shape (dummy end slices, walls, fins)', (_name, make) => {
    const doc = make();
    const b = projectDoc(doc);
    expect(b.crossSections).toHaveLength(doc.stations.length + 2);
    const L = doc.outline.plus.knots.at(-1)!.p[0];
    expect(b.crossSections[0]!.position).toBe(0);
    expect(b.crossSections.at(-1)!.position).toBe(L);
    expect(b.crossSections[0]!.spline.knots).toHaveLength(1);
    expect(b.deck.knots).toHaveLength(doc.deck.knots.length + 2);
    // the walls sit at the rocker's end heights, so the junction pass keeps the thickness
    expect(b.deck.knots[0]!.end.y).toBe(doc.rocker.knots[0]!.p[1]);
    expect(b.deck.knots.at(-1)!.end.y).toBe(doc.rocker.knots.at(-1)!.p[1]);
    expect(projectDoc(doc)).toBe(b);
  });

  it.each(GOLDEN_NAMES)('%s: slice <-> section is exact to 1e-12', (name) => {
    const doc = goldenDoc(name);
    const b = projectDoc(doc);
    let worst = 0;
    doc.stations.forEach((st, i) => {
      const slice = b.crossSections[i + 1]!.spline;
      const w = Math.max(...slice.knots.map((k) => k.end.x));
      const T = slice.knots.at(-1)!.end.y - slice.knots[0]!.end.y;
      const back = sliceToSection(slice, w, T, st.plus.apex);
      expect(back.apex).toBe(st.plus.apex);
      expect(back.chain.knots).toHaveLength(st.plus.chain.knots.length);
      back.chain.knots.forEach((k, j) => {
        const was = st.plus.chain.knots[j]!;
        for (const key of ['p', 'in', 'out'] as const) {
          worst = Math.max(
            worst,
            Math.abs(k[key][0] - was[key][0]),
            Math.abs(k[key][1] - was[key][1]),
          );
        }
      });
      // a slice made from the section is what the projection shows
      const again = sectionToSlice(st.plus, w, T);
      expect(again.knots.map((k) => k.end)).toEqual(slice.knots.map((k) => k.end));
    });
    expect(worst).toBeLessThan(1e-12);
  });

  it('keeps a fin edit out of the hull: same curves, same slices, new fins', () => {
    const doc = goldenDoc('shortboard');
    const a = projectDoc(doc);
    const b = projectDoc({ ...doc, fins: { ...(doc.fins as object), setup: 'thruster' } });
    expect(b.outline).toBe(a.outline);
    expect(b.deck).toBe(a.deck);
    expect(b.crossSections).toBe(a.crossSections);
    expect(b.fins).not.toBe(a.fins);
  });
});

/**
 * What a drag may legitimately break and leave to the user, as in classic: a rocker dragged above the
 * deck, a knot dragged past its neighbour. The validator reports them, the 3D view keeps the last good
 * surface, and the user drags back. The junction rules must still hold everything else.
 */
const SOFT = new Set([
  'thickness',
  'outline-not-function',
  'line-not-function',
  'notch-chord-angle',
]);

describe('line editors', () => {
  /** The first interior knot of the outline, nearest the middle. */
  const midKnot = (b: BezierBoard) => Math.floor(b.outline.knots.length / 2);

  it.each(GOLDEN_NAMES)(
    '%s: an outline, rocker or deck edit keeps every Section object',
    (name) => {
      const doc = goldenDoc(name);
      const store = opened(doc);
      const before = sections(doc);
      const b = store.getState().board!;
      const k = midKnot(b);
      const p = b.outline.knots[k]!.end;
      store.getState().moveControlPoint({ kind: 'outline' }, k, vec2(p.x + 1, p.y + 0.5));
      const rk = Math.floor(b.bottom.knots.length / 2);
      const rp = b.bottom.knots[rk]!.end;
      store.getState().moveControlPoint({ kind: 'bottom' }, rk, vec2(rp.x, rp.y + 0.3));
      const dk = Math.floor(b.deck.knots.length / 2);
      const dp = b.deck.knots[dk]!.end;
      store.getState().moveControlPoint({ kind: 'deck' }, dk, vec2(dp.x + 2, dp.y + 0.2));
      const next = store.getState().doc!;
      expect(next).not.toBe(doc);
      expect(next.outline.plus).not.toBe(doc.outline.plus);
      expect(next.rocker).not.toBe(doc.rocker);
      expect(next.deck).not.toBe(doc.deck);
      const after = sections(next);
      expect(after).toHaveLength(before.length);
      after.forEach((s, i) => expect(s).toBe(before[i]));
      expect(errorsOf(next)).toEqual([]);
    },
  );

  it('writes back only the touched curve', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const b = store.getState().board!;
    const rk = Math.floor(b.bottom.knots.length / 2);
    const rp = b.bottom.knots[rk]!.end;
    store.getState().moveControlPoint({ kind: 'bottom' }, rk, vec2(rp.x, rp.y + 0.3));
    const next = store.getState().doc!;
    expect(next.rocker).not.toBe(doc.rocker);
    expect(next.outline).toBe(doc.outline);
    expect(next.deck).toBe(doc.deck);
    expect(next.stations).toBe(doc.stations);
    expect(next.fins).toBe(doc.fins);
  });

  it('applies the classic edit and rules: the same curve as the classic store', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const classic = createBoardStore();
    classic.getState().load(store.getState().board!);
    const b = store.getState().board!;
    const k = midKnot(b);
    const p = b.outline.knots[k]!.end;
    const edits: ((s: ReturnType<typeof createBoardStore>) => void)[] = [
      (s) => s.getState().moveControlPoint({ kind: 'outline' }, k, vec2(p.x + 1.5, p.y - 0.7)),
      (s) => s.getState().setLocked({ kind: 'outline' }, k, true),
      (s) => s.getState().rotateTangent({ kind: 'outline' }, k, 'both', 0.05),
      (s) => s.getState().stepTangentLength({ kind: 'outline' }, k, 'next', 1.25),
      (s) => s.getState().setContinuous({ kind: 'outline' }, k + 1, false),
      (s) => s.getState().fairControlPoint({ kind: 'bottom' }, 2),
      (s) => s.getState().alignTangentsHorizontal({ kind: 'deck' }, 3),
    ];
    for (const edit of edits) {
      edit(classic);
      edit(store as unknown as ReturnType<typeof createBoardStore>);
    }
    const sec = store.getState().doc!;
    const cls = classic.getState().board!;
    expect(sec.outline.plus).toEqual(splineToChain(cls.outline));
    expect(sec.rocker).toEqual(splineToChain(cls.bottom));
    expect(sec.deck).toEqual(splineToDeckChain(cls.deck));
    expect(store.getState().past.map((h) => h.label)).toEqual(
      classic.getState().past.map((h) => h.label),
    );
  });

  it('keeps a locked point locked through the document', () => {
    const store = opened(goldenDoc('shortboard'));
    const k = 3;
    store.getState().setLocked({ kind: 'outline' }, k, true);
    const knot = store.getState().doc!.outline.plus.knots[k]!;
    expect(knot.lock).toBeDefined();
    store.getState().undo();
    expect(store.getState().doc!.outline.plus.knots[k]!.lock).toBeUndefined();
    store.getState().redo();
    expect(store.getState().board!.outline.knots[k]!.lock).toBeDefined();
  });

  it('moving the nose stretches the stations with the board', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const b = store.getState().board!;
    const last = b.outline.knots.length - 1;
    const nose = b.outline.knots[last]!.end;
    store.getState().moveControlPoint({ kind: 'outline' }, last, vec2(nose.x + 10, 0));
    const next = store.getState().doc!;
    const L0 = doc.outline.plus.knots.at(-1)!.p[0];
    const L1 = next.outline.plus.knots.at(-1)!.p[0];
    expect(L1).toBeCloseTo(L0 + 10, 9);
    next.stations.forEach((s, i) => expect(s.x).toBeCloseTo(doc.stations[i]!.x * (L1 / L0), 9));
    sections(next).forEach((s, i) => expect(s).toBe(sections(doc)[i]));
    // the rocker and deck follow the nose tip (the junction pass), and the document validates
    expect(next.rocker.knots.at(-1)!.p[0]).toBeCloseTo(L1, 9);
    expect(next.deck.knots.at(-1)!.p[0]).toBeCloseTo(L1, 9);
    expect(errorsOf(next)).toEqual([]);
  });

  it('a standard tail keeps its first outline knot at the tail tip (0, 0)', () => {
    const store = opened(goldenDoc('shortboard'));
    store.getState().moveControlPoint({ kind: 'outline' }, 0, vec2(0, 3));
    expect(store.getState().doc!.outline.plus.knots[0]!.p).toEqual([0, 0]);
    expect(errorsOf(store.getState().doc!)).toEqual([]);
    // dragged along the board, past the next point: still at the tip, and still a valid document
    store.getState().moveControlPoint({ kind: 'outline' }, 0, vec2(4, 0));
    expect(store.getState().doc!.outline.plus.knots[0]!.p).toEqual([0, 0]);
    expect(errorsOf(store.getState().doc!).map((e) => e.code)).not.toContain('tail-start');
  });

  it('an outline handle dragged across the stringer stops on it', () => {
    const store = opened(goldenDoc('shortboard'));
    store.getState().moveTangent({ kind: 'outline' }, 2, 'next', vec2(60, -5));
    const knot = store.getState().doc!.outline.plus.knots[2]!;
    expect(knot.out[1]).toBe(0);
    expect(errorsOf(store.getState().doc!).map((e) => e.code)).not.toContain('outline-endpoints');
  });

  it('sections are read-only in step 1', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const slice = store.getState().board!.crossSections[2]!.spline;
    const k = slice.knots[2]!.end;
    store.getState().moveControlPoint({ kind: 'crossSection', index: 2 }, 2, vec2(k.x * 0.9, k.y));
    store.getState().setLocked({ kind: 'crossSection', index: 2 }, 2, true);
    expect(store.getState().addCrossSection(50)).toBe(-1);
    store.getState().deleteCrossSection(2);
    store.getState().setInterpolationType('sLinear');
    expect(store.getState().doc).toBe(doc);
    expect(store.getState().past).toHaveLength(0);
  });

  it('fin edits are written to the document', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    store.getState().setFinSetup('single');
    const next = store.getState().doc!;
    expect((next.fins as { setup: string }).setup).toBe('single');
    expect(next.outline).toBe(doc.outline);
    expect(next.stations).toBe(doc.stations);
    expect(store.getState().board!.fins.setup).toBe('single');
  });

  it('resize scales the lines and the stations, never the sections', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    store.getState().scaleBoard(1.1, 1, 1);
    const next = store.getState().doc!;
    expect(next.outline.plus.knots.at(-1)!.p[0]).toBeCloseTo(
      doc.outline.plus.knots.at(-1)!.p[0] * 1.1,
      9,
    );
    next.stations.forEach((s, i) => expect(s.x).toBeCloseTo(doc.stations[i]!.x * 1.1, 9));
    sections(next).forEach((s, i) => expect(s).toBe(sections(doc)[i]));
  });

  it('random drags of every knot keep the documents valid', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (const name of GOLDEN_NAMES) {
      const store = opened(goldenDoc(name));
      for (let n = 0; n < 150; n++) {
        const b = store.getState().board!;
        const kind = (['outline', 'bottom', 'deck'] as const)[Math.floor(rand() * 3)]!;
        const spline = kind === 'outline' ? b.outline : kind === 'bottom' ? b.bottom : b.deck;
        const i = Math.floor(rand() * spline.knots.length);
        const p = spline.knots[i]!.end;
        const target = { kind };
        store.getState().beginEdit();
        store
          .getState()
          .moveControlPoint(target, i, vec2(p.x + (rand() - 0.5) * 8, p.y + (rand() - 0.5) * 4));
        store.getState().endEdit();
        // A rocker dragged above the deck is the user's to fix ('thickness'); the editors do not stop
        // it, as in classic. Nothing else may break: the junction rules keep the lines functions.
        const codes = errorsOf(store.getState().doc!).map((e) => e.code);
        // a knot dragged past the nose makes the plan not a function, and then the length is moot
        const hard = codes.filter(
          (c) => !SOFT.has(c) && !(c === 'line-domain' && codes.includes('outline-not-function')),
        );
        expect(hard, `${name} step ${n}`).toEqual([]);
      }
    }
  });
});

describe('history', () => {
  it('undo, redo and jumpTo restore documents, labels and the projection', () => {
    const doc = goldenDoc('shortboard');
    const store = opened(doc);
    const s = () => store.getState();
    const move = (kind: 'outline' | 'bottom' | 'deck', dy: number) => {
      const spline =
        kind === 'outline'
          ? s().board!.outline
          : kind === 'bottom'
            ? s().board!.bottom
            : s().board!.deck;
      const i = 2;
      const p = spline.knots[i]!.end;
      s().moveControlPoint({ kind }, i, vec2(p.x, p.y + dy));
    };
    move('outline', 0.5);
    const d1 = s().doc!;
    move('bottom', 0.4);
    const d2 = s().doc!;
    move('deck', 0.3);
    const d3 = s().doc!;
    expect(s().past.map((h) => h.label)).toEqual([
      'Move control point',
      'Move control point',
      'Move control point',
    ]);
    s().undo();
    expect(s().doc).toBe(d2);
    expect(s().board).toBe(projectDoc(d2));
    s().undo();
    expect(s().doc).toBe(d1);
    expect(s().canRedo()).toBe(true);
    s().redo();
    expect(s().doc).toBe(d2);
    s().redo();
    expect(s().doc).toBe(d3);
    s().jumpTo(0);
    expect(s().doc).toBe(doc);
    expect(s().past).toHaveLength(0);
    expect(s().future).toHaveLength(3);
    s().redo();
    s().redo();
    s().redo();
    expect(s().doc).toBe(d3);
  });

  it('a drag is one undo step, and a refused drag leaves none', () => {
    const store = opened(goldenDoc('shortboard'));
    const s = () => store.getState();
    const b = s().board!;
    const i = 3;
    const p = b.outline.knots[i]!.end;
    s().beginEdit();
    for (let n = 1; n <= 10; n++)
      s().moveControlPoint({ kind: 'outline' }, i, vec2(p.x + n * 0.1, p.y));
    s().endEdit();
    expect(s().past).toHaveLength(1);
    const before = s().doc;
    s().beginEdit();
    s().moveControlPoint({ kind: 'crossSection', index: 1 }, 1, vec2(1, 1));
    s().endEdit();
    expect(s().past).toHaveLength(1);
    expect(s().doc).toBe(before);
    s().undo();
    expect(s().past).toHaveLength(0);
  });

  it('loading another document clears history and counts as a load', () => {
    const store = opened(goldenDoc('shortboard'));
    const s = () => store.getState();
    s().moveControlPoint({ kind: 'outline' }, 3, vec2(30, 12));
    const count = s().loadCount;
    s().loadDoc(goldenDoc('funboard'));
    expect(s().loadCount).toBe(count + 1);
    expect(s().past).toHaveLength(0);
    expect(s().selection).toBeNull();
  });
});
