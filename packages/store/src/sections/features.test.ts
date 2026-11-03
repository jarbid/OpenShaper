// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom-feature edits (docs/design/m2-editor.md §2, step 4): a feature edit refits nothing (every Section
 * is the same object and a warm build is under a millisecond), one undo step per edit or drag, a swallow or
 * fish made from each golden validates with each feature kind (in either order of adding and changing the
 * tail), and random parameters within their ranges never make the validator refuse the board.
 */
import { buildBoard, createChordFn, validateBoard, type BoardDoc } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_KINDS,
  addFeature as addFeatureTo,
  addFeatureKey,
  createSectionStore,
  depthPolyline,
  featureKindOf,
  featureLimits as featureLimitsOf,
  removeFeature,
  removeFeatureKey,
  setFeatureDepth,
  setFeatureEnabled as setFeatureEnabledOn,
  setFeatureKey as setFeatureKeyOn,
  setFeatureParams as setFeatureParamsOn,
  setNotchDepth as setNotchDepthTo,
  setSymmetry,
  setTail as setTailTo,
  type FeatureKind,
  type NotchChords,
} from './index';
import { GOLDEN_NAMES, goldenDoc, testDocs } from './test-support/docs';

const errors = (doc: BoardDoc) => validateBoard(doc).filter((i) => i.severity === 'error');
const chords: NotchChords = (doc, side) => createChordFn(doc, side);
// the app injects board2's chord before it opens a notched board; the edits take it as an argument
const addFeature = (d: BoardDoc, k: FeatureKind) => addFeatureTo(d, k, chords);
const featureLimits = (d: BoardDoc, f: BoardDoc['features'][number]) =>
  featureLimitsOf(d, f, chords);
const setFeatureEnabled = (d: BoardDoc, id: string, on: boolean) =>
  setFeatureEnabledOn(d, id, on, chords);
const setFeatureKey = (d: BoardDoc, id: string, i: number, p: { s?: number; value?: number }) =>
  setFeatureKeyOn(d, id, i, p, chords);
const setFeatureParams = (d: BoardDoc, id: string, p: Parameters<typeof setFeatureParamsOn>[2]) =>
  setFeatureParamsOn(d, id, p, chords);
const setNotchDepth = (d: BoardDoc, x: number) => setNotchDepthTo(d, x, chords);
const setTail = (d: BoardDoc, t: Parameters<typeof setTailTo>[1], depth?: number) =>
  setTailTo(d, t, depth, chords);
const bare = (doc: BoardDoc): BoardDoc => ({ ...doc, features: [] });
const lcg = (seed: number) => () =>
  (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

const boards: readonly [string, () => BoardDoc][] = [
  ...GOLDEN_NAMES.map((n): [string, () => BoardDoc] => [n, () => goldenDoc(n)]),
  ...testDocs.slice(3).map(([n, f]): [string, () => BoardDoc] => [n, () => bare(f())]),
];

describe('feature edits', () => {
  it.each(FEATURE_KINDS)('%s: add, set, toggle and remove leave every other part alone', (kind) => {
    const doc = goldenDoc('shortboard');
    const added = addFeature(doc, kind);
    const f = added.features.at(-1)!;
    expect(featureKindOf(f)).toBe(kind);
    expect(f.id).toBe(kind);
    expect(errors(added)).toEqual([]);
    const edits = [
      added,
      setFeatureDepth(added, f.id, 0.2),
      setFeatureEnabled(added, f.id, false),
      setFeatureKey(added, f.id, 0, { s: f.depth.keys[0]!.s + 3 }),
      addFeatureKey(added, f.id),
      removeFeature(added, f.id),
    ];
    for (const d of edits) {
      expect(d.stations).toBe(doc.stations);
      expect(d.outline).toBe(doc.outline);
      expect(d.rocker).toBe(doc.rocker);
      expect(d.deck).toBe(doc.deck);
      expect(errors(d)).toEqual([]);
    }
    expect(removeFeature(added, f.id).features).toEqual([]);
    // a second one of the kind gets a fresh id
    expect(addFeature(added, kind).features.at(-1)!.id).toBe(`${kind}-2`);
    // no change is no new document
    expect(setFeatureDepth(edits[1]!, f.id, 0.2)).toBe(edits[1]);
    expect(setFeatureEnabled(added, f.id, true)).toBe(added);
    expect(removeFeature(doc, 'nothing')).toBe(doc);
  });

  it('the depth keeps its ends at zero; keys move between their neighbours and can be added and removed', () => {
    const doc = addFeature(goldenDoc('funboard'), 'single-concave');
    const f = doc.features[0]!;
    const n = f.depth.keys.length;
    const deeper = setFeatureDepth(doc, f.id, 0.4).features[0]!;
    expect(deeper.depth.keys[0]!.value).toBe(0);
    expect(deeper.depth.keys[n - 1]!.value).toBe(0);
    expect(Math.max(...deeper.depth.keys.map((k) => k.value))).toBeCloseTo(0.4, 12);
    // an inner key cannot pass its neighbour
    const moved = setFeatureKey(doc, f.id, 1, { s: 1e6 }).features[0]!;
    expect(moved.depth.keys[1]!.s).toBeLessThan(moved.depth.keys[2]!.s);
    const plus = addFeatureKey(doc, f.id);
    expect(plus.features[0]!.depth.keys).toHaveLength(n + 1);
    expect(errors(plus)).toEqual([]);
    expect(removeFeatureKey(plus, f.id, 2).features[0]!.depth.keys).toHaveLength(n);
    // the ends and a curve of three keys stay
    expect(removeFeatureKey(doc, f.id, 0)).toBe(doc);
    expect(
      removeFeatureKey(removeFeatureKey(doc, f.id, 1), f.id, 1).features[0]!.depth.keys,
    ).toHaveLength(3);
    const pts = depthPolyline(f.depth);
    expect(pts[0]).toEqual({ x: f.depth.keys[0]!.s, depth: 0 });
    expect(pts.at(-1)!.x).toBeCloseTo(f.depth.keys[n - 1]!.s, 9);
    expect(Math.max(...pts.map((p) => p.depth))).toBeCloseTo(0.3, 9);
  });

  it('a double concave keeps its bumps apart and its channels inside the board', () => {
    const doc = addFeature(addFeature(goldenDoc('shortboard'), 'double-concave'), 'channels');
    const [d, c] = doc.features as [BoardDoc['features'][0], BoardDoc['features'][0]];
    const wide = setFeatureParams(doc, d.id, { width: 0.9 }).features[0]!;
    expect(wide).toMatchObject({ width: 0.5, centre: 0.5 });
    const off = setFeatureParams(doc, d.id, { centre: 0.99 }).features[0]!;
    expect(off).toMatchObject({ centre: 0.7 });
    const huge = setFeatureParams(doc, c.id, { railInset: 99, count: 4, width: 3 });
    expect(errors(huge)).toEqual([]);
  });

  it('a feature edit refits nothing: same Sections, and a warm build is cheap', () => {
    const doc = addFeature(goldenDoc('shortboard'), 'double-concave');
    const first = buildBoard(doc, { check: false });
    expect(first.ok).toBe(true);
    const id = doc.features[0]!.id;
    const times: number[] = [];
    let last = doc;
    for (let i = 0; i < 30; i++) {
      last = setFeatureDepth(doc, id, 0.1 + 0.005 * i);
      const t0 = performance.now();
      const built = buildBoard(last, { check: false });
      times.push(performance.now() - t0);
      expect(built.ok).toBe(true);
    }
    expect(last.stations).toBe(doc.stations);
    times.sort((a, b) => a - b);
    // The median of warm builds: 0.4 to 0.5 ms on a quiet machine (m2-editor.md section 11). The bound is
    // looser than that so a loaded CI machine does not fail it; refitting even one section is ~1.6 ms and a
    // whole board tens, so a refit still cannot hide under it.
    expect(times[15]!).toBeLessThan(3);
  });
});

describe('the store', () => {
  const opened = (doc: BoardDoc) => {
    const store = createSectionStore();
    store.getState().setNotchChords(chords);
    store.getState().loadDoc(doc);
    return store;
  };

  it('each edit is one undo step, a drag is one in all, and undo restores the document', () => {
    const doc = goldenDoc('longboard');
    const store = opened(doc);
    const s = () => store.getState();
    s().addFeature('double-concave');
    expect(s().past.map((p) => p.label)).toEqual(['Add Double concave']);
    const id = s().doc!.features[0]!.id;
    const withFeature = s().doc!;
    s().beginEdit();
    for (let i = 1; i <= 8; i++) s().setFeatureDepth(id, 0.05 * i);
    s().endEdit();
    expect(s().past).toHaveLength(2);
    expect(s().past.at(-1)!.label).toBe('Set depth of double concave');
    expect(s().doc!.stations).toBe(doc.stations);
    s().setFeatureEnabled(id, false);
    s().setFeatureParams(id, { width: 0.2 });
    s().removeFeature(id);
    expect(s().past).toHaveLength(5);
    s().undo();
    s().undo();
    s().undo();
    expect(s().doc!.features[0]!.enabled).toBe(true);
    s().undo();
    expect(s().doc).toBe(withFeature);
  });
});

describe('features follow the tail', () => {
  const tails = ['swallow', 'fish'] as const;

  it.each(
    GOLDEN_NAMES.flatMap((n) => FEATURE_KINDS.flatMap((k) => tails.map((t) => [n, k, t] as const))),
  )('%s with %s: a %s made before or after validates', (name, kind, type) => {
    const std = goldenDoc(name);
    // feature first, then the tail: the keys that lie behind the notch bottom are squeezed in
    const early = setTail(addFeature(std, kind), type);
    expect(errors(early), 'feature first').toEqual([]);
    // tail first, then the feature
    const late = addFeature(setTail(std, type), kind);
    expect(errors(late), 'tail first').toEqual([]);
    expect(buildBoard(late).ok).toBe(true);
    // a deeper notch pushes the keys again; back to standard and to the other kind
    const d = early.outline.plus.knots[0]!.p[0];
    for (const f of [1.5, 2]) {
      const deeper = setNotchDepth(early, d * f);
      if (errors(deeper).some((i) => i.code !== 'notch-chord-angle')) {
        expect(errors(deeper)).toEqual([]);
      }
    }
    expect(errors(setTail(early, type === 'swallow' ? 'fish' : 'swallow'))).toEqual([]);
    expect(errors(setTail(early, 'standard'))).toEqual([]);
  });

  it('a feature that started where the notch bottom now is is squeezed in, sections untouched', () => {
    const doc = goldenDoc('shortboard');
    const f = addFeature(doc, 'vee');
    // start the vee 1 cm from the tail, then cut a deep notch past it
    const early = setFeatureKey(f, 'vee', 0, { s: 1 });
    const made = setTail(early, 'swallow', 18);
    const keys = made.features[0]!.depth.keys;
    expect(keys[0]!.s).toBeGreaterThan(18);
    expect(keys.every((k, i) => i === 0 || k.s > keys[i - 1]!.s)).toBe(true);
    expect(errors(made)).toEqual([]);
    // a tail change that moves nothing keeps the very features array
    expect(setNotchDepth(made, 18)).toBe(made);
  });

  it('the swallow and fish test boards keep their features through a depth change', () => {
    for (const [name, make] of testDocs.slice(3, 5)) {
      const doc = make();
      const deeper = setNotchDepth(doc, doc.outline.plus.knots[0]!.p[0] * 1.2);
      expect(errors(deeper), name).toEqual([]);
    }
  });
});

describe('random parameters within their ranges', () => {
  // the test swallow and fish boards are notched already: their own tail only
  const rows = boards.flatMap(([name, make]) => {
    const own = name === 'swallow' || name === 'fish' || name === 'asymmetric';
    return (own ? ['own'] : ['standard', 'swallow', 'fish']).flatMap((tail) =>
      FEATURE_KINDS.map((k) => [`${name}, ${tail} tail, ${k}`, make, tail, k] as const),
    );
  });

  it.each(rows)('%s: never a validator error', (_title, make, tail, kind: FeatureKind) => {
    const name = _title;
    const rand = lcg(7 + name.length * 31 + kind.length);
    let doc = make();
    if (tail === 'swallow' || tail === 'fish') doc = setTail(doc, tail);
    doc = addFeature(doc, kind);
    const id = doc.features.at(-1)!.id;
    const pick = (lo: number, hi: number) => lo + (hi - lo) * rand();
    for (let i = 0; i < 60; i++) {
      const f = doc.features.find((q) => q.id === id)!;
      const lim = featureLimits(doc, f);
      const names = Object.keys(lim).filter((k) => k !== 'depth' && k !== 'from' && k !== 'to');
      const roll = rand();
      if (roll < 0.35 && names.length > 0) {
        const key = names[Math.floor(rand() * names.length)]!;
        const r = lim[key as keyof typeof lim]!;
        const value = key === 'count' ? Math.round(pick(r.min, r.max)) : pick(r.min, r.max);
        doc = setFeatureParams(doc, id, { [key]: value });
      } else if (roll < 0.55) {
        doc = setFeatureDepth(doc, id, pick(lim.depth!.min, lim.depth!.max));
      } else if (roll < 0.75) {
        doc = setFeatureKey(doc, id, 0, { s: pick(lim.from!.min, lim.from!.max) });
      } else if (roll < 0.9) {
        doc = setFeatureKey(doc, id, f.depth.keys.length - 1, {
          s: pick(lim.to!.min, lim.to!.max),
        });
      } else if (roll < 0.95) {
        doc = addFeatureKey(doc, id);
      } else {
        doc = setFeatureEnabled(setFeatureEnabled(doc, id, false), id, true);
      }
      const bad = errors(doc);
      expect(
        bad.map((b) => b.message),
        `step ${i}`,
      ).toEqual([]);
    }
    expect(buildBoard(doc).ok).toBe(true);
    // an asymmetric board shares the features and the narrower half sets the channels' room
    if (!name.startsWith('asymmetric')) expect(errors(setSymmetry(doc, 'asymmetric'))).toEqual([]);
  });
});
