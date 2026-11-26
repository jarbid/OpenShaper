// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Contours (`contours.ts`): the words and the numbers, then the edits on every board the project ships
 * and makes. A contour is built at the least, a typical and the greatest depth, at the least, a typical
 * and the greatest extent: the engine builds the board with no issue and its mesh is closed, the dials read
 * back what was set, the bottom stays clear of the deck, applying a value twice changes nothing (the same
 * object) and undo restores the document exactly. The engine sweeps are split by board and kind so that
 * each test builds a handful of boards.
 */
import type { BottomFeature, RailsBoard } from '@openshaper/board2';
import { buildRails } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { FEATURE_MIN_SPAN, addFeature, featureKindOf, featureLimits } from '../sections/features';
import {
  CONTOUR_DEFAULTS,
  CONTOUR_KINDS,
  MAX_CONTOURS,
  addContour,
  canAddContour,
  chordsOf,
  contourAt,
  contourBands,
  contourDepth,
  contourDepthAt,
  contourDepthMax,
  contourDials,
  contourExtent,
  contourKeys,
  contourKindInfo,
  contourProfile,
  contourReliefAt,
  contourRoom,
  contoursOf,
  moveContour,
  setContourDepth,
  setContourExtent,
  setContourKey,
  setContourParams,
  type ContourKind,
} from './contours';
import { halfWidthFn } from './measure';
import { createRailsStore } from './rails-store';
import { railAt } from './zones';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';
import { between, deepFreeze, pick, seeded } from './test-support/zone-kit';

const kinds: readonly ContourKind[] = CONTOUR_KINDS.map((k) => k.kind);
const board = (name: string): RailsBoard => everyBoard.find(([n]) => n === name)![1]();

/** The id of the contour `addContour` just added. */
const lastId = (doc: RailsBoard): string => doc.features[doc.features.length - 1]!.id;
const featureOf = (doc: RailsBoard, id: string): BottomFeature =>
  doc.features.find((f) => f.id === id)!;

/** What a contour dial reads back is what was set, to this much (cm, or a fraction): the edits are scalings and holds. */
const READ_BACK = 1e-9;
/**
 * The depth curve read off its polyline against the engine's exact solve of the same curve, cm: the
 * polyline has 24 points on each segment, and the contours of the project are a few millimetres deep.
 */
const RELIEF_TOLERANCE = 5e-4;

// --- the words -------------------------------------------------------------------------------------

describe('the kinds', () => {
  it('are the four a board takes, each named once, in the order a shaper lists them', () => {
    expect(kinds).toEqual(['single-concave', 'double-concave', 'vee', 'channels']);
    expect(new Set(CONTOUR_KINDS.map((k) => k.name)).size).toBe(4);
    expect(CONTOUR_KINDS.map((k) => k.name)).toEqual([
      'Single concave',
      'Double concave',
      'Vee',
      'Channels',
    ]);
  });

  it('give the face a depth and at most one more dial, and the rest of the parameters go under More', () => {
    for (const k of CONTOUR_KINDS) {
      expect(k.depth.key).toBe('depth');
      expect(k.depth.unit).toBe('length');
      expect(k.note.length).toBeGreaterThan(10);
      expect(k.depth.note.length).toBeGreaterThan(10);
    }
    expect(CONTOUR_KINDS.map((k) => k.second?.key ?? null)).toEqual([
      'width',
      'width',
      null,
      'count',
    ]);
    expect(CONTOUR_KINDS.map((k) => k.more.map((d) => d.key))).toEqual([
      [],
      ['centre'],
      ['stringerRadius'],
      ['width', 'pitch', 'railInset'],
    ]);
  });

  it('say every parameter the store knows, on some kind', () => {
    const named = new Set(
      CONTOUR_KINDS.flatMap((k) => [k.second, ...k.more].flatMap((d) => (d ? [d.key] : []))),
    );
    for (const key of ['stringerRadius', 'width', 'centre', 'count', 'pitch', 'railInset']) {
      expect(named.has(key as never)).toBe(true);
    }
  });
});

describe('the contours of the project', () => {
  it('are the four on the made boards, and the starter templates carry none', () => {
    const found = everyBoard.flatMap(([name, make]) =>
      make().features.map((f) => `${name}:${featureKindOf(f)}`),
    );
    expect(found.sort()).toEqual([
      'asymmetric:channels',
      'fish:single-concave',
      'swallow:double-concave',
      'swallow:vee',
    ]);
  });

  it('are placed as a shaper cuts them, on every board, and a channel is never pinched', () => {
    for (const [name, make] of everyBoard) {
      const doc = make();
      const room = contourRoom(doc);
      const start = doc.outline.plus.knots[0]!.p[0];
      const run = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0] - start;
      const share = (x: number) => (x - start) / run;
      for (const kind of kinds) {
        const next = addContour(doc, kind);
        const f = featureOf(next, lastId(next));
        const { from, to } = contourExtent(f);
        const at = `${name} ${kind}`;
        if (kind === 'single-concave') {
          // through the middle third
          expect(share(from), at).toBeCloseTo(1 / 3, 6);
          expect(share(to), at).toBeCloseTo(2 / 3, 6);
        } else if (kind === 'channels') {
          // in the tail half, no nearer the tip than the board holds them: the defaults of a channel stand
          expect(share(from), at).toBeCloseTo(0.1, 6);
          expect(share(to), at).toBeCloseTo(0.45, 6);
          expect(
            f.kind === 'channels' ? [f.count, f.width, f.pitch, f.railInset] : null,
            at,
          ).toEqual([2, 0.8, 1.2, 3]);
        } else {
          // a vee and a double concave run out of the tail, the vee as far as the middle
          expect(from, at).toBe(room.min);
          expect(share(to), at).toBeCloseTo(kind === 'vee' ? 0.5 : 0.55, 6);
        }
        expect(contourDepth(f), at).toBeCloseTo(
          Math.min(CONTOUR_DEFAULTS[kind].depth, contourDials(next, f.id)!.depth.max),
          9,
        );
      }
    }
  });
});

// --- reading ---------------------------------------------------------------------------------------

describe('reading a board', () => {
  it('lists the contours, numbering the kinds a board has more than one of', () => {
    let doc = board('shortboard');
    expect(contoursOf(doc)).toEqual([]);
    doc = addContour(doc, 'vee');
    expect(contoursOf(doc).map((c) => c.name)).toEqual(['Vee']);
    doc = addContour(addContour(doc, 'vee'), 'channels');
    expect(contoursOf(doc).map((c) => c.name)).toEqual(['Vee 1', 'Vee 2', 'Channels']);
    expect(contoursOf(doc).map((c) => c.id)).toEqual(['vee', 'vee-2', 'channels']);
    const swallow = contoursOf(board('swallow'));
    expect(swallow.map((c) => [c.name, c.enabled])).toEqual([
      ['Vee', true],
      ['Double concave', true],
    ]);
  });

  it('reads each dial with the range the board holds it to, from the store’s own limits', () => {
    for (const name of ['shortboard', 'swallow', 'asymmetric']) {
      for (const kind of kinds) {
        const doc = addContour(board(name), kind);
        const id = lastId(doc);
        const f = featureOf(doc, id);
        const limits = featureLimits(doc, f, chordsOf);
        const dials = contourDials(doc, id)!;
        const all = [dials.depth, dials.second, ...dials.more, dials.from, dials.to].flatMap((d) =>
          d ? [d] : [],
        );
        for (const d of all) {
          const r = limits[d.key]!;
          // the depth is also held by the wall's thickness (`contourDepthMax`); every other range is the store's
          const max = d.key === 'depth' ? Math.min(r.max, contourDepthMax(doc, f)) : r.max;
          expect([d.min, d.max], `${name} ${kind} ${d.key}`).toEqual([r.min, Math.max(r.min, max)]);
          expect(d.value).toBeGreaterThanOrEqual(d.min - READ_BACK);
          expect(d.value).toBeLessThanOrEqual(d.max + READ_BACK);
        }
        expect(dials.info.kind).toBe(kind);
        expect(dials.depth.value).toBeCloseTo(
          Math.min(CONTOUR_DEFAULTS[kind].depth, dials.depth.max),
          9,
        );
      }
    }
    expect(contourDials(board('shortboard'), 'nothing')).toBeNull();
  });

  it('names the keys of the law between the ends, each with the room it has', () => {
    const doc = addContour(board('shortboard'), 'single-concave');
    const keys = contourKeys(doc, lastId(doc));
    expect(keys.map((k) => k.index)).toEqual([1, 2]);
    const f = featureOf(doc, lastId(doc));
    expect(keys[0]!.sMin).toBe(f.depth.keys[0]!.s);
    expect(keys[0]!.sMax).toBe(f.depth.keys[2]!.s);
    // a curve keeps its ends and one key between: a plateau (two between) may lose one, a curve of three may not
    expect(keys.every((k) => k.removable)).toBe(true);
    const bare = {
      ...doc,
      features: doc.features.map((q) => ({
        ...q,
        depth: { keys: [q.depth.keys[0]!, q.depth.keys[1]!, q.depth.keys[3]!] },
      })),
    };
    expect(contourKeys(bare, lastId(bare)).map((k) => k.removable)).toEqual([false]);
    expect(contourKeys(doc, 'nothing')).toEqual([]);
  });
});

// --- extent ----------------------------------------------------------------------------------------

/** The depth curve's inner keys as shares of its span (0 to 1) and their values. */
const shape = (f: BottomFeature): [number, number][] => {
  const { from, to } = contourExtent(f);
  return f.depth.keys.map((k) => [(k.s - from) / (to - from), k.value]);
};

describe('the extent', () => {
  it('moves the end keys and keeps every key between them at the same share of the span', () => {
    for (const name of ['shortboard', 'swallow', 'longboard']) {
      let doc = addContour(board(name), 'single-concave');
      const id = lastId(doc);
      // give the law keys of its own: a shaped curve, not the plateau
      doc = {
        ...doc,
        features: doc.features.map((f) =>
          f.id === id
            ? {
                ...f,
                depth: {
                  keys: [
                    { s: f.depth.keys[0]!.s, value: 0 },
                    {
                      s: f.depth.keys[0]!.s + 0.1 * (f.depth.keys[3]!.s - f.depth.keys[0]!.s),
                      value: 0.1,
                    },
                    {
                      s: f.depth.keys[0]!.s + 0.45 * (f.depth.keys[3]!.s - f.depth.keys[0]!.s),
                      value: 0.35,
                    },
                    {
                      s: f.depth.keys[0]!.s + 0.8 * (f.depth.keys[3]!.s - f.depth.keys[0]!.s),
                      value: 0.2,
                    },
                    f.depth.keys[3]!,
                  ],
                },
              }
            : f,
        ),
      };
      const before = featureOf(doc, id);
      const room = contourRoom(doc);
      const { from, to } = contourExtent(before);
      for (const [a, b] of [
        [from + 3, to],
        [from, to - 7],
        [from - 5, to + 5],
        [from + 10, to - 10],
        [room.min, room.max],
      ] as const) {
        const next = setContourExtent(doc, id, a, b);
        const f = featureOf(next, id);
        const now = contourExtent(f);
        expect(now.from, name).toBeCloseTo(Math.max(a, room.min), 9);
        expect(now.to, name).toBeCloseTo(Math.min(b, room.max), 9);
        const was = shape(before);
        const is = shape(f);
        // the depth may have been held to what the new run allows (a run over the thin tips holds less):
        // the keys keep their share of the peak as well
        const peakWas = Math.max(...was.map((k) => k[1]));
        const peakIs = Math.max(...is.map((k) => k[1]));
        was.forEach(([share, value], i) => {
          expect(is[i]![0], `${name} key ${i} share`).toBeCloseTo(share, 9);
          expect(is[i]![1] / peakIs, `${name} key ${i} value`).toBeCloseTo(value / peakWas, 9);
        });
      }
      // nothing else of the board moves
      const next = setContourExtent(doc, id, from + 3, to);
      expect(next.outline).toBe(doc.outline);
      expect(next.stations).toBe(doc.stations);
      expect(next.rocker).toBe(doc.rocker);
    }
  });

  it('holds an end inside the station range and the least span from the other, never refusing', () => {
    for (const name of ['shortboard', 'swallow', 'fish']) {
      const doc = addContour(board(name), 'vee');
      const id = lastId(doc);
      const room = contourRoom(doc);
      const { from, to } = contourExtent(featureOf(doc, id));
      const tail = contourExtent(featureOf(setContourExtent(doc, id, -1e6), id));
      expect(tail.from).toBe(room.min);
      expect(tail.to).toBe(to);
      const nose = contourExtent(featureOf(setContourExtent(doc, id, undefined, 1e6), id));
      expect(nose.to).toBe(room.max);
      const crossed = contourExtent(featureOf(setContourExtent(doc, id, to + 50, undefined), id));
      expect(crossed.from).toBeCloseTo(to - FEATURE_MIN_SPAN, 9);
      const squeezed = contourExtent(
        featureOf(setContourExtent(doc, id, undefined, from - 50), id),
      );
      expect(squeezed.to).toBeCloseTo(from + FEATURE_MIN_SPAN, 9);
      // a pair is held as a pair: the start first, then the end at least the span after it
      const pair = contourExtent(featureOf(setContourExtent(doc, id, 1e6, 1e6 + 1), id));
      expect(pair.to).toBe(room.max);
      expect(pair.from).toBeCloseTo(room.max - FEATURE_MIN_SPAN, 9);
      for (const v of [Number.NaN, Infinity, -Infinity]) {
        expect(setContourExtent(doc, id, v, v)).toBe(doc);
      }
    }
  });

  it('starts no nearer the tail than the notch bottom, so the pins behind it stay flat', () => {
    for (const name of ['swallow', 'fish', 'fish-shortboard', 'swallow-shortboard']) {
      const doc = board(name);
      const notch = doc.outline.plus.knots[0]!.p[0];
      expect(notch).toBeGreaterThan(0);
      for (const kind of kinds) {
        const added = addContour(doc, kind, { from: -100 });
        const f = featureOf(added, lastId(added));
        expect(contourExtent(f).from).toBeGreaterThan(notch);
        expect(contourExtent(f).from).toBe(contourRoom(added).min);
        const moved = moveContour(added, lastId(added), -100);
        expect(contourExtent(featureOf(moved, lastId(added))).from).toBe(contourRoom(added).min);
        // no x behind the notch bottom has any relief
        expect(contourDepthAt(f, notch)).toBe(0);
        expect(contourDepthAt(f, notch / 2)).toBe(0);
      }
    }
  });

  it('slides a contour with its length kept, and stops where an end meets the range', () => {
    const doc = addContour(board('shortboard'), 'double-concave');
    const id = lastId(doc);
    const { from, to } = contourExtent(featureOf(doc, id));
    const room = contourRoom(doc);
    const moved = contourExtent(featureOf(moveContour(doc, id, from + 10), id));
    expect(moved.from).toBeCloseTo(from + 10, 9);
    expect(moved.to - moved.from).toBeCloseTo(to - from, 9);
    const nose = contourExtent(featureOf(moveContour(doc, id, 1e6), id));
    expect(nose.to).toBeCloseTo(room.max, 9);
    expect(nose.to - nose.from).toBeCloseTo(to - from, 9);
    const tail = contourExtent(featureOf(moveContour(doc, id, -1e6), id));
    expect(tail.from).toBe(room.min);
    expect(tail.to - tail.from).toBeCloseTo(to - from, 9);
    expect(moveContour(doc, id, from)).toBe(doc);
    expect(moveContour(doc, id, Number.NaN)).toBe(doc);
  });
});

// --- adding ----------------------------------------------------------------------------------------

describe('adding a contour', () => {
  it('puts a new one at the kind’s own run and depth, on', () => {
    for (const name of ['shortboard', 'swallow', 'asymmetric']) {
      const doc = board(name);
      const start = doc.outline.plus.knots[0]!.p[0];
      const run = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0] - start;
      for (const kind of kinds) {
        const next = addContour(doc, kind);
        const f = featureOf(next, lastId(next));
        const d = CONTOUR_DEFAULTS[kind];
        expect(f.enabled).toBe(true);
        expect(featureKindOf(f)).toBe(kind);
        expect(contourExtent(f).from).toBeCloseTo(
          Math.max(contourRoom(doc).min, start + d.from * run),
          9,
        );
        expect(contourExtent(f).to).toBeCloseTo(start + d.to * run, 9);
        expect(contourDepth(f)).toBeCloseTo(
          Math.min(d.depth, contourDials(next, f.id)!.depth.max),
          9,
        );
        expect(next.features.slice(0, -1)).toEqual(doc.features);
      }
    }
  });

  it('holds what it is asked for at the nearest the board can have it, and never refuses', () => {
    const doc = board('swallow');
    const room = contourRoom(doc);
    const asked = [
      { from: -50, to: 1e6, depth: 1e6 },
      { from: 1e6, to: 1e6 },
      { to: -1e6 },
      { from: room.max, depth: -3 },
      { depth: Number.NaN, from: Number.NaN },
      { from: 100, to: 101 },
    ];
    for (const kind of kinds) {
      for (const options of asked) {
        const next = addContour(doc, kind, options);
        expect(next, `${kind} ${JSON.stringify(options)}`).not.toBe(doc);
        const f = featureOf(next, lastId(next));
        const { from, to } = contourExtent(f);
        expect(from).toBeGreaterThanOrEqual(room.min);
        expect(to).toBeLessThanOrEqual(room.max);
        expect(to - from).toBeGreaterThanOrEqual(FEATURE_MIN_SPAN - READ_BACK);
        const dials = contourDials(next, f.id)!;
        expect(contourDepth(f)).toBeLessThanOrEqual(dials.depth.max + READ_BACK);
        expect(contourDepth(f)).toBeGreaterThanOrEqual(0);
      }
      // the engine builds the two hardest asks: everything at once, and the whole range past the nose
      for (const options of [asked[0]!, asked[1]!]) {
        const next = addContour(doc, kind, options);
        const verdict = closedVerdict(next, true);
        expect(verdict.ok, `${kind} ${JSON.stringify(options)}: ${verdict.why}`).toBe(true);
      }
    }
  });

  it('keeps the end that was given where there is room, the other giving way', () => {
    const doc = board('shortboard');
    const toTail = addContour(doc, 'vee', { to: 20 });
    expect(contourExtent(featureOf(toTail, lastId(toTail))).to).toBeCloseTo(20, 9);
    const fromNose = addContour(doc, 'vee', { from: 170 });
    expect(contourExtent(featureOf(fromNose, lastId(fromNose))).from).toBeCloseTo(170, 9);
  });

  it('stops at the engine’s own limit: that many build and one more is refused', () => {
    let doc = board('shortboard');
    for (let i = 0; i < MAX_CONTOURS; i++) {
      expect(canAddContour(doc)).toBe(true);
      doc = addContour(doc, pick(seeded(i + 1), kinds));
    }
    expect(doc.features.length).toBe(MAX_CONTOURS);
    expect(canAddContour(doc)).toBe(false);
    expect(addContour(doc, 'vee')).toBe(doc);
    expect(new Set(doc.features.map((f) => f.id)).size).toBe(MAX_CONTOURS);
    expect(buildRails(doc).ok).toBe(true);
    // the same board with one more, added past the editor's own rule, is the engine's to refuse
    const over = addFeature(doc, 'vee', chordsOf);
    expect(over.features.length).toBe(MAX_CONTOURS + 1);
    expect(buildRails(over).ok).toBe(false);
  });
});

// --- the relief ------------------------------------------------------------------------------------

describe('the relief a contour makes', () => {
  it('is the engine’s own, at every plan point of every kind on every board', () => {
    for (const name of ['mirror', 'swallow', 'asymmetric', 'fish']) {
      for (const kind of kinds) {
        const doc = addContour(board(name), kind);
        const f = featureOf(doc, lastId(doc));
        const built = buildRails(doc);
        if (!built.ok) throw new Error(`${name} ${kind}: ${built.issues.map((i) => i.code)}`);
        const { from, to } = contourExtent(f);
        const out = new Float64Array(3);
        let worst = 0;
        // the engine's relief is the sum of the board's contours
        const sum = (x: number, y: number, w: number): number =>
          doc.features.reduce((t, g) => t + (g.enabled ? contourReliefAt(g, x, y, w) : 0), 0);
        for (const side of ['plus', 'minus'] as const) {
          const w = halfWidthFn(doc.outline, side === 'minus' ? 'minus' : undefined);
          for (let i = 1; i < 24; i++) {
            const x = from + ((to - from) * i) / 24;
            for (let j = 0; j <= 10; j++) {
              const y = ((side === 'plus' ? 1 : -1) * (w(x) * j)) / 10;
              built.value.panels.relief!(x, y, out);
              worst = Math.max(worst, Math.abs(sum(x, y, w(x)) - out[0]!));
            }
          }
        }
        expect(worst, `${name} ${kind}`).toBeLessThanOrEqual(RELIEF_TOLERANCE);
      }
    }
  });

  it('has no depth outside its run and the least at its ends', () => {
    const doc = addContour(board('shortboard'), 'single-concave');
    const f = featureOf(doc, lastId(doc));
    const { from, to } = contourExtent(f);
    expect(contourDepthAt(f, from)).toBe(0);
    expect(contourDepthAt(f, to)).toBe(0);
    expect(contourDepthAt(f, from - 1)).toBe(0);
    expect(contourDepthAt(f, to + 1)).toBe(0);
    expect(contourDepthAt(f, (from + to) / 2)).toBeCloseTo(contourDepth(f), 6);
  });

  it('says where across the bottom each kind acts', () => {
    const doc = addContour(
      addContour(
        addContour(addContour(board('shortboard'), 'vee'), 'single-concave'),
        'double-concave',
      ),
      'channels',
    );
    const by = Object.fromEntries(doc.features.map((f) => [featureKindOf(f), f]));
    const w = 20;
    expect(contourBands(by['vee']!, w)).toEqual([{ from: 0, to: w }]);
    const single = by['single-concave']!;
    expect(single.kind === 'concave' && contourBands(single, w)).toEqual([
      { from: 0, to: 0.7 * w },
    ]);
    const double = contourBands(by['double-concave']!, w);
    expect(double).toHaveLength(1);
    expect(double[0]!.from).toBeCloseTo(0.1 * w, 9);
    expect(double[0]!.to).toBeCloseTo(0.7 * w, 9);
    const channels = contourBands(by['channels']!, w);
    expect(channels).toHaveLength(2);
    // measured in from the outline: the outer channel's near edge is the rail inset
    expect(channels[0]!.to).toBeCloseTo(w - 3, 9);
    expect(channels[0]!.from).toBeCloseTo(w - 3 - 0.8, 9);
    expect(channels[1]!.to).toBeCloseTo(w - 3 - 1.2, 9);
    // the profile is zero where no band is
    for (const f of doc.features) {
      const bands = contourBands(f, w);
      const inside = (y: number) => bands.some((b) => y >= b.from - 1e-9 && y <= b.to + 1e-9);
      for (let i = 0; i <= 100; i++) {
        const y = (w * i) / 100;
        if (!inside(y)) expect(contourProfile(f, y / w, w)).toBeCloseTo(0, 12);
      }
    }
  });

  it('is found under a tap: the narrowest contour that holds the point', () => {
    let doc = board('shortboard');
    doc = addContour(doc, 'vee'); // the whole bottom, out of the tail to the middle
    doc = addContour(doc, 'single-concave'); // the middle third
    const vee = doc.features[0]!.id;
    const concave = doc.features[1]!.id;
    const room = contourRoom(doc);
    const x = room.min + 0.4 * (room.max - room.min); // inside both runs
    const w = halfWidthFn(doc.outline)(x);
    expect(contourAt(doc, x, 0)).toBe(concave);
    expect(contourAt(doc, x, -0.2 * w, 'plus')).toBe(concave);
    expect(contourAt(doc, x, 0.95 * w)).toBe(vee);
    expect(contourAt(doc, room.min + 0.1 * (room.max - room.min), 0)).toBe(vee); // only the vee runs there
    expect(contourAt(doc, room.max - 1, 0)).toBeNull();
    expect(contourAt(doc, x, 3 * w)).toBeNull();
    const off = { ...doc, features: doc.features.map((f) => ({ ...f, enabled: false })) };
    expect(contourAt(off, x, 0)).toBeNull();
  });

  it('is found on the side the tap is on, on a board whose sides differ', () => {
    let doc = board('asymmetric');
    doc = addContour(doc, 'single-concave');
    const id = lastId(doc);
    const room = contourRoom(doc);
    const x = room.min + 0.5 * (room.max - room.min);
    const plus = halfWidthFn(doc.outline)(x);
    const minus = halfWidthFn(doc.outline, 'minus')(x);
    expect(plus).not.toBeCloseTo(minus, 3);
    // 0.6 of each side's own half width is inside a concave that reaches 0.7 of the way out on each side
    expect(contourAt(doc, x, 0.6 * plus, 'plus')).toBe(id);
    expect(contourAt(doc, x, -0.6 * minus, 'minus')).toBe(id);
    // 0.9 of the wider side's half width is outside it on either side's reading
    const wide = Math.max(plus, minus);
    expect(contourAt(doc, x, 0.9 * wide, 'plus')).toBeNull();
    expect(contourAt(doc, x, 0.9 * wide, 'minus')).toBeNull();
  });
});

// --- the engine ------------------------------------------------------------------------------------

/**
 * The corners of a contour on a board: its depth at the least, the kind's own and the greatest the board holds,
 * its extent at the least (the least span out of the tail, where a notched board is narrowest), the kind's own
 * and the greatest (the whole station range). The depth range depends on the extent, so each extent is set and
 * the depth is read after it.
 */
function corner(
  doc: RailsBoard,
  kind: ContourKind,
  depth: 'least' | 'typical' | 'greatest',
  extent: 'least' | 'typical' | 'greatest',
): { doc: RailsBoard; id: string } {
  const added = addContour(doc, kind);
  const id = lastId(added);
  const room = contourRoom(added);
  const run =
    extent === 'least'
      ? ([room.min, room.min + FEATURE_MIN_SPAN] as const)
      : extent === 'greatest'
        ? ([room.min, room.max] as const)
        : ([undefined, undefined] as const);
  const placed = extent === 'typical' ? added : setContourExtent(added, id, run[0], run[1]);
  const range = contourDials(placed, id)!.depth;
  const value = depth === 'least' ? range.min : depth === 'greatest' ? range.max : undefined;
  return { doc: value === undefined ? placed : setContourDepth(placed, id, value), id };
}

type Level = 'least' | 'typical' | 'greatest';
const LEVELS: readonly Level[] = ['least', 'typical', 'greatest'];

/**
 * How much of the board's thickness is left under a contour: the least, over its run and across the bottom out
 * to where the tuck starts on each side (past that the mesh fades the relief out along the rail), of the deck
 * panel less the bottom panel and the relief, over the deck panel less the bottom panel. The engine's own
 * panels are the oracle. Where the board has no thickness to speak of (under 0.5 mm) there is nothing to leave.
 */
function thicknessLeft(doc: RailsBoard, id: string): number {
  const built = buildRails(doc);
  if (!built.ok) throw new Error(built.issues.map((i) => i.code).join(','));
  const { panels } = built.value;
  const { from, to } = contourExtent(featureOf(doc, id));
  const out = new Float64Array(3);
  let least = Infinity;
  for (const sign of doc.outline.minus === undefined ? [1] : [1, -1]) {
    const w = halfWidthFn(doc.outline, sign < 0 ? 'minus' : undefined);
    const keys = sign < 0 ? (doc.rails.minus ?? doc.rails.plus) : doc.rails.plus;
    for (let i = 1; i < 40; i++) {
      const x = from + ((to - from) * i) / 40;
      const reach = Math.max(0, w(x) - railAt(keys, x).tuck);
      for (let j = 0; j <= 10; j++) {
        const y = (sign * reach * j) / 10;
        panels.relief!(x, y, out);
        const base = panels.deck(x, y) - panels.bottom(x, y);
        if (base > 0.05) least = Math.min(least, (base - out[0]!) / base);
      }
    }
  }
  return least;
}

/** What is left of the thickness at the greatest depth, at the least: more than this share of it. */
const THICKNESS_KEPT = 0.4;

/** What a corner must satisfy; the same for every board and kind. */
function expectCorner(
  name: string,
  doc: RailsBoard,
  kind: ContourKind,
  depth: Level,
  extent: Level,
  draft = true,
): void {
  const label = `${name} ${kind} depth ${depth} extent ${extent}`;
  const { doc: next, id } = corner(doc, kind, depth, extent);
  const verdict = closedVerdict(next, draft);
  expect(verdict.ok, `${label}: ${verdict.why}`).toBe(true);
  const f = featureOf(next, id);
  const dials = contourDials(next, id)!;
  // the dials read back what was set, held to the range
  expect(dials.depth.value, label).toBeCloseTo(contourDepth(f), 9);
  expect(contourDepth(f), label).toBeLessThanOrEqual(dials.depth.max + READ_BACK);
  const room = contourRoom(next);
  expect(contourExtent(f).from, label).toBeGreaterThanOrEqual(room.min);
  expect(contourExtent(f).to, label).toBeLessThanOrEqual(room.max);
  if (depth === 'greatest') expect(contourDepth(f), label).toBeCloseTo(dials.depth.max, 9);
  if (depth === 'least') expect(contourDepth(f), label).toBe(0);
  if (extent === 'greatest') {
    expect(contourExtent(f).from, label).toBe(room.min);
    expect(contourExtent(f).to, label).toBe(room.max);
  }
  if (extent === 'least')
    expect(contourExtent(f).to - contourExtent(f).from, label).toBeCloseTo(FEATURE_MIN_SPAN, 9);
  // the tail is at x = 0 and nothing but the features changed
  expect(Math.min(...next.outline.plus.knots.map((k) => k.p[0])), label).toBe(0);
  expect(next.outline).toBe(doc.outline);
  expect(next.stations).toBe(doc.stations);
  // the bottom stays clear of the deck, at the notch's bottom and the tips as much as anywhere
  if (depth === 'greatest') expect(thicknessLeft(next, id), label).toBeGreaterThan(THICKNESS_KEPT);
}

const GRID_BOARDS = ['swallow', 'asymmetric'];

describe('on the notched and the asymmetric board: every depth at every extent', () => {
  for (const name of GRID_BOARDS) {
    for (const kind of kinds) {
      it(`${name}: ${kind}`, () => {
        const doc = board(name);
        for (const depth of LEVELS) {
          for (const extent of LEVELS) expectCorner(name, doc, kind, depth, extent);
        }
      });
    }
  }
});

describe('on the other boards: the typical contour and the greatest', () => {
  const others = everyBoard.map(([n]) => n).filter((n) => !GRID_BOARDS.includes(n));
  for (const name of others) {
    for (const kind of kinds) {
      it(`${name}: ${kind}`, () => {
        const doc = board(name);
        expectCorner(name, doc, kind, 'typical', 'typical');
        expectCorner(name, doc, kind, 'greatest', 'greatest');
        // the shortest run at the greatest depth, out of the tail: on a notched board it is the notch's bottom,
        // where the wall is thinnest. (A contour of no depth raises nothing, so the board is the board it was:
        // the least depth runs on the two grid boards and not on these.)
        if (doc.outline.plus.knots[0]!.p[0] > 0) expectCorner(name, doc, kind, 'greatest', 'least');
      });
    }
  }
});

describe('at view quality', () => {
  for (const name of ['swallow']) {
    it(`${name}: the contours at their greatest depth and extent`, () => {
      const doc = board(name);
      for (const kind of kinds) expectCorner(name, doc, kind, 'greatest', 'greatest', false);
    });
  }
});

// --- the dials, the wall and the law ------------------------------------------------------------------

describe('the dials read back what was set', () => {
  it('the second dial and those under More: inside the range as set, beyond it as the bound', () => {
    for (const name of ['shortboard', 'swallow']) {
      for (const kind of kinds) {
        const doc = addContour(board(name), kind);
        const id = lastId(doc);
        const info = contourKindInfo(kind);
        const find = (d: RailsBoard, key: string) => {
          const dials = contourDials(d, id)!;
          return [dials.second, ...dials.more].find((x) => x?.key === key)!;
        };
        for (const dial of [info.second, ...info.more]) {
          if (!dial) continue;
          const now = find(doc, dial.key);
          const mid = now.min + (now.max - now.min) / 2;
          const interior = dial.unit === 'count' ? Math.round(mid) : mid;
          const at = `${name} ${kind} ${dial.key}`;
          const set = setContourParams(doc, id, { [dial.key]: interior });
          expect(find(set, dial.key).value, at).toBeCloseTo(interior, 9);
          // a channel's width, spacing and inset give way to one another, so they read inside the range;
          // every other dial reads the bound itself
          const gives = kind === 'channels' && dial.key !== 'count';
          for (const [asked, bound] of [
            [now.max + 1e3, now.max],
            [now.min - 1e3, now.min],
          ] as const) {
            const held = find(setContourParams(doc, id, { [dial.key]: asked }), dial.key).value;
            if (gives) {
              const after = find(setContourParams(doc, id, { [dial.key]: asked }), dial.key);
              expect(held, `${at} beyond`).toBeGreaterThanOrEqual(after.min - READ_BACK);
              expect(held, `${at} beyond`).toBeLessThanOrEqual(after.max + READ_BACK);
            } else {
              expect(held, `${at} beyond`).toBeCloseTo(bound, 9);
            }
          }
        }
        // the ends read back too, and the depth reads what it was set to
        const d = contourDials(doc, id)!;
        const mid = (d.from.min + d.from.max) / 2;
        expect(contourDials(setContourExtent(doc, id, mid), id)!.from.value).toBeCloseTo(mid, 9);
        const depth = (d.depth.min + d.depth.max) / 2;
        expect(contourDials(setContourDepth(doc, id, depth), id)!.depth.value).toBeCloseTo(
          depth,
          9,
        );
      }
    }
  });
});

describe('how deep the board lets a contour be', () => {
  it('is never more than the stringer’s rule, and a run over a thin wall holds less than the same run elsewhere', () => {
    const middle = addContour(board('shortboard'), 'single-concave');
    const f = featureOf(middle, lastId(middle));
    expect(contourDepthMax(middle, f)).toBeLessThanOrEqual(
      featureLimits(middle, f, chordsOf).depth!.max,
    );
    expect(contourDepthMax(middle, f)).toBeGreaterThan(0.3);
    for (const name of ['fish', 'swallow']) {
      const doc = board(name);
      const room = contourRoom(doc);
      const mid = (room.min + room.max) / 2;
      const at = (from: number) => {
        const next = addContour(doc, 'vee', { from, to: from + FEATURE_MIN_SPAN });
        return contourDepthMax(next, featureOf(next, lastId(next)));
      };
      expect(at(room.min), name).toBeLessThan(at(mid));
      expect(at(room.min), name).toBeGreaterThan(0);
    }
  });

  it('keeps a channel cut into the rail clear of the deck at the notch’s bottom', () => {
    for (const name of ['fish', 'swallow', 'fish-shortboard']) {
      let doc = board(name);
      const room = contourRoom(doc);
      doc = addContour(doc, 'channels', { from: room.min, to: room.min + 20 });
      const id = lastId(doc);
      doc = setContourParams(doc, id, { railInset: 0 });
      doc = setContourDepth(doc, id, 1e6);
      expect(thicknessLeft(doc, id), name).toBeGreaterThan(THICKNESS_KEPT);
    }
  });

  it('holds the keys of the law to it, and a key set twice is set once', () => {
    const doc = addContour(board('shortboard'), 'double-concave');
    const id = lastId(doc);
    const max = contourDials(doc, id)!.depth.max;
    const keys = contourKeys(doc, id);
    const high = setContourKey(doc, id, 1, { value: 1e6 });
    expect(contourDepth(featureOf(high, id))).toBeLessThanOrEqual(max + READ_BACK);
    expect(setContourKey(high, id, 1, { value: 1e6 })).toBe(high);
    const moved = setContourKey(doc, id, 1, { s: (keys[0]!.sMin + keys[0]!.sMax) / 2 });
    expect(contourKeys(moved, id)[0]!.s).toBeCloseTo((keys[0]!.sMin + keys[0]!.sMax) / 2, 9);
    expect(contourKeys(moved, id)[0]!.s).toBeGreaterThan(keys[0]!.sMin);
    expect(setContourKey(doc, 'nothing', 1, { value: 0.1 })).toBe(doc);
    // the ends are the extent: a key of the law is never one of them
    expect(contourKeys(doc, id).map((k) => k.index)).toEqual([1, 2]);
  });
});

// --- the store -------------------------------------------------------------------------------------

describe('the store’s contour actions', () => {
  const store = (name: string) => {
    const s = createRailsStore();
    s.getState().loadDoc(board(name));
    return s;
  };

  it('add, set and remove, each one undo step, and undo restores the document exactly', () => {
    const s = store('swallow');
    const original = s.getState().doc!;
    const id = s.getState().addContour('channels')!;
    expect(id).toBe('channels');
    expect(s.getState().past.at(-1)!.label).toBe('Add Channels');
    s.getState().setContourDepth(id, 0.2);
    s.getState().setContourExtent(id, 70, 150);
    s.getState().moveContour(id, 60);
    s.getState().setContourParams(id, { count: 3 });
    s.getState().setFeatureEnabled(id, false);
    expect(s.getState().past.length).toBe(6);
    expect(s.getState().past.map((p) => p.label)).toEqual([
      'Add Channels',
      'Set depth of channels',
      'Set extent of channels',
      'Move channels',
      'Set channels',
      'Disable channels',
    ]);
    s.getState().removeFeature(id);
    for (let i = 0; i < 7; i++) s.getState().undo();
    expect(s.getState().doc).toBe(original);
    for (let i = 0; i < 7; i++) s.getState().redo();
    expect(s.getState().doc!.features.some((f) => f.id === id)).toBe(false);
    s.getState().undo();
    expect(s.getState().doc!.features.some((f) => f.id === id)).toBe(true);
  });

  it('change nothing when the same value is set twice', () => {
    const s = store('shortboard');
    const id = s.getState().addContour('double-concave')!;
    const steps = (): number => s.getState().past.length;
    s.getState().setContourDepth(id, 0.25);
    const doc = s.getState().doc;
    const n = steps();
    s.getState().setContourDepth(id, 0.25);
    s.getState().setContourExtent(id, contourExtent(featureOf(doc!, id)).from, undefined);
    s.getState().moveContour(id, contourExtent(featureOf(doc!, id)).from);
    s.getState().setContourParams(id, { width: (featureOf(doc!, id) as { width: number }).width });
    expect(s.getState().doc).toBe(doc);
    expect(steps()).toBe(n);
    expect(s.getState().addContour('vee', { from: 1 })).not.toBeNull();
    expect(steps()).toBe(n + 1);
  });

  it('are pure functions: the same value twice is the same object', () => {
    for (const name of ['shortboard', 'swallow', 'fish']) {
      for (const kind of kinds) {
        const doc = deepFreeze(addContour(board(name), kind));
        const id = lastId(doc);
        const once = setContourDepth(doc, id, 0.11);
        expect(setContourDepth(once, id, 0.11)).toBe(once);
        const ext = setContourExtent(doc, id, 30, 90);
        expect(setContourExtent(ext, id, 30, 90)).toBe(ext);
        expect(setContourExtent(doc, id, undefined, undefined)).toBe(doc);
        expect(moveContour(ext, id, contourExtent(featureOf(ext, id)).from)).toBe(ext);
        expect(setContourParams(doc, id, {})).toBe(doc);
        const dials = contourDials(doc, id)!;
        if (dials.second) {
          const same = setContourParams(doc, id, { [dials.second.key]: dials.second.value });
          expect(same).toBe(doc);
        }
      }
    }
  });

  it('bring channels back when a run that went to a narrow place returns, inside one drag', () => {
    const s = store('swallow');
    const id = s.getState().addContour('channels')!;
    const origin = s.getState().doc!;
    const reach = (d: RailsBoard): number => {
      const f = featureOf(d, id);
      return f.kind === 'channels' ? f.railInset + f.width + (f.count - 1) * f.pitch : 0;
    };
    const { from, to } = contourExtent(featureOf(origin, id));
    s.getState().beginEdit();
    // out to the nose, where the board is narrowest
    s.getState().setContourExtent(id, contourRoom(origin).max - 3, contourRoom(origin).max);
    expect(reach(s.getState().doc!)).toBeLessThan(reach(origin));
    s.getState().setContourExtent(id, from, to);
    s.getState().endEdit();
    expect(s.getState().doc).toBe(origin);
  });

  it('are a function of the pointer inside a drag: a depth taken to nothing and back keeps the law', () => {
    const s = store('shortboard');
    const id = s.getState().addContour('single-concave')!;
    // a curve that is not a plateau
    const doc = s.getState().doc!;
    const shaped: RailsBoard = {
      ...doc,
      features: doc.features.map((f) =>
        f.id === id
          ? {
              ...f,
              depth: {
                keys: [
                  { s: f.depth.keys[0]!.s, value: 0 },
                  { s: f.depth.keys[1]!.s, value: 0.1 },
                  { s: f.depth.keys[2]!.s, value: 0.3 },
                  f.depth.keys[3]!,
                ],
              },
            }
          : f,
      ),
    };
    s.getState().commitDoc(shaped, 'Shape the law');
    const before = s.getState().past.length;
    s.getState().beginEdit();
    s.getState().setContourDepth(id, 0);
    expect(contourDepth(featureOf(s.getState().doc!, id))).toBe(0);
    s.getState().setContourDepth(id, 0.15);
    s.getState().endEdit();
    const f = featureOf(s.getState().doc!, id);
    const was = shaped.features.find((q) => q.id === id)!.depth.keys.map((k) => k.value / 0.3);
    f.depth.keys.forEach((k, i) => expect(k.value / 0.15).toBeCloseTo(was[i]!, 12));
    expect(s.getState().past.length).toBe(before + 1);
    s.getState().undo();
    expect(s.getState().doc).toBe(shaped);
  });
});

// --- a seeded sweep ---------------------------------------------------------------------------------

describe('a long random run of contour edits', () => {
  it('keeps every rule of a feature on every board, and the engine builds what is left', () => {
    for (const [seed, name] of [
      [11, 'swallow'],
      [12, 'asymmetric'],
      [13, 'shortboard'],
    ] as const) {
      const rng = seeded(seed);
      let doc = board(name);
      const room0 = contourRoom(doc);
      for (let step = 0; step < 90; step++) {
        const roll = rng();
        const ids = doc.features.map((f) => f.id);
        const id = ids.length > 0 ? pick(rng, ids) : 'none';
        const big = () => pick(rng, [-1e9, -10, 0, 0.1, 1, 25, 1e9, Number.NaN]);
        if (roll < 0.12 && canAddContour(doc)) {
          doc = addContour(
            doc,
            pick(rng, kinds),
            rng() < 0.5
              ? {}
              : { from: between(rng, -20, 220), to: between(rng, -20, 260), depth: big() },
          );
        } else if (roll < 0.2) {
          doc = { ...doc, features: doc.features.filter((f) => f.id !== id) };
        } else if (roll < 0.4) {
          doc = setContourDepth(doc, id, rng() < 0.5 ? between(rng, 0, 2) : big());
        } else if (roll < 0.6) {
          doc = setContourExtent(
            doc,
            id,
            rng() < 0.7 ? between(rng, -10, 250) : undefined,
            rng() < 0.7 ? between(rng, -10, 280) : undefined,
          );
        } else if (roll < 0.7) {
          doc = moveContour(doc, id, between(rng, -50, 250));
        } else {
          doc = setContourParams(doc, id, {
            width: rng() < 0.5 ? between(rng, 0, 1.2) : big(),
            centre: rng() < 0.5 ? between(rng, 0, 1) : big(),
            count: pick(rng, [0, 1, 2, 3, 4, 9, 2.5]),
            pitch: between(rng, 0, 12),
            railInset: between(rng, 0, 25),
            stringerRadius: between(rng, 0, 1.3),
          });
        }
        const room = contourRoom(doc);
        expect(room).toEqual(room0);
        for (const f of doc.features) {
          const keys = f.depth.keys;
          expect(keys[0]!.value, `${name} step ${step}`).toBe(0);
          expect(keys[keys.length - 1]!.value).toBe(0);
          for (let i = 1; i < keys.length; i++) expect(keys[i]!.s).toBeGreaterThan(keys[i - 1]!.s);
          expect(keys[0]!.s).toBeGreaterThanOrEqual(room.min);
          expect(keys[keys.length - 1]!.s).toBeLessThanOrEqual(room.max);
          expect(keys[keys.length - 1]!.s - keys[0]!.s).toBeGreaterThanOrEqual(
            FEATURE_MIN_SPAN - READ_BACK,
          );
          const limits = featureLimits(doc, f, chordsOf);
          expect(contourDepth(f)).toBeLessThanOrEqual(limits.depth!.max + READ_BACK);
          for (const k of keys) expect(Number.isFinite(k.s) && Number.isFinite(k.value)).toBe(true);
        }
        expect(new Set(doc.features.map((f) => f.id)).size).toBe(doc.features.length);
        if (step % 30 === 29) {
          const verdict = closedVerdict(doc, true);
          expect(verdict.ok, `${name} step ${step}: ${verdict.why}`).toBe(true);
        }
      }
    }
  });
});

describe('the words', () => {
  it('name each kind through its info', () => {
    for (const kind of kinds) expect(contourKindInfo(kind).kind).toBe(kind);
  });
});
