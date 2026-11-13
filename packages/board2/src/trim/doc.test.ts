// SPDX-License-Identifier: GPL-3.0-or-later
/* eslint-disable @typescript-eslint/no-explicit-any -- the tests edit plain JSON documents */
/** The rails board's text: exact JSON round trip, key order, shape errors, never throwing. */
import { describe, expect, it } from 'vitest';
import { boardDocToJson, reviveBoardDoc } from '../doc';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import { boardSet } from '../test-support/board-set';
import type { BoardDoc } from '../types';
import type { RailsBoard } from './board';
import { convertSections } from './convert';
import { docModel, railsToJson, reviveRails } from './doc';
import { buildRails, meshRails } from './native';

const toRails = (doc: BoardDoc): RailsBoard => {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
};

const BOARDS: [string, RailsBoard][] = [
  ['analytic', toRails(analyticBoard())],
  ['swallow', toRails(swallowBoard())],
  ['fish', toRails(fishBoard())],
  ['asymmetric', toRails(asymmetricBoard())],
];

const revive = (v: unknown): RailsBoard => {
  const r = reviveRails(v);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

const parsed = (b: RailsBoard): any => JSON.parse(railsToJson(b));
const keys = (o: object): string[] => Object.keys(o);
const asymmetric = BOARDS.find(([n]) => n === 'asymmetric')![1];
const mirror = BOARDS.find(([n]) => n === 'swallow')![1];

describe('canonical JSON', () => {
  it.each(BOARDS)('round-trips the %s board exactly', (_name, board) => {
    const text = railsToJson(board);
    const back = revive(JSON.parse(text));
    expect(back).toEqual(board);
    expect(railsToJson(back)).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.startsWith('{\n  "format": "openshaper",\n')).toBe(true);
  });

  it('round-trips every board of the shared set', () => {
    for (const { name, doc } of boardSet()) {
      const board = toRails(doc);
      const text = railsToJson(board);
      expect(railsToJson(revive(JSON.parse(text))), name).toBe(text);
    }
  });

  it('writes the keys in the fixed order', () => {
    const topKeys = [
      'format',
      'version',
      'model',
      'meta',
      'symmetry',
      'outline',
      'corners',
      'rocker',
      'deck',
      'stations',
      'rails',
      'features',
      'build',
    ];
    const d = parsed(mirror);
    expect(keys(d)).toEqual(topKeys);
    expect(d.format).toBe('openshaper');
    expect(d.version).toBe(1);
    expect(d.model).toBe('rails');
    expect(keys(d.corners)).toEqual(['nose', 'tail', 'plus']);
    expect(keys(d.stations[0])).toEqual(['id', 'x', 'plus']);
    expect(keys(d.stations[0].plus)).toEqual(['bottom', 'deck']);
    expect(keys(d.rails)).toEqual(['plus']);
    expect(keys(d.rails.plus[0])).toEqual(['x', 'rail']);
    expect(keys(d.rails.plus[0].rail)).toEqual([
      'band',
      'hardness',
      'tuck',
      'tuckShape',
      'bottomEdge',
      'deckEdge',
      'apex',
    ]);
    expect(keys(d.build)).toEqual(['tolerance', 'railFade']);

    const a = parsed(asymmetric);
    expect(keys(a.outline)).toEqual(['plus', 'minus']);
    expect(keys(a.corners)).toEqual(['nose', 'tail', 'plus', 'minus']);
    expect(keys(a.stations[0])).toEqual(['id', 'x', 'plus', 'minus']);
    expect(keys(a.rails)).toEqual(['plus', 'minus']);

    const withFins = parsed({ ...mirror, fins: { on: true } });
    expect(keys(withFins)).toEqual([...topKeys.slice(0, 12), 'fins', 'build']);
  });

  it('is independent of the key order of the input', () => {
    const shuffled = JSON.parse(
      JSON.stringify(mirror, (_k, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    );
    shuffled.format = 'openshaper';
    shuffled.version = 1;
    expect(railsToJson(revive(shuffled))).toBe(railsToJson(mirror));
  });

  it('carries optional meta details and opaque fins', () => {
    const board: RailsBoard = {
      ...asymmetric,
      meta: { name: 'n', author: 'a', comment: 'c', source: 's', extra: { n: [1, 2] } },
      fins: { systems: ['fcs2', { count: 3, toe: -0.5 }], on: true, none: null },
    };
    const text = railsToJson(board);
    const back = revive(JSON.parse(text));
    expect(back).toEqual(board);
    expect(railsToJson(back)).toBe(text);
    expect(railsToJson(asymmetric)).not.toContain('"extra"');
    expect(railsToJson(asymmetric)).not.toContain('"fins"');
  });

  it('keeps the minus side of an asymmetric board and writes none for a mirror board', () => {
    const a = revive(parsed(asymmetric));
    expect(a.outline.minus).toEqual(asymmetric.outline.minus);
    expect(a.corners.minus).toEqual(asymmetric.corners.minus);
    expect(a.rails.minus).toEqual(asymmetric.rails.minus);
    expect(a.stations.every((s) => s.minus !== undefined)).toBe(true);
    expect(a.stations.map((s) => s.minus)).toEqual(asymmetric.stations.map((s) => s.minus));
    const text = railsToJson(mirror);
    expect(text).not.toContain('"minus"');
  });

  it('is deep-frozen', () => {
    const b = revive(parsed(asymmetric));
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.corners.plus)).toBe(true);
    expect(Object.isFrozen(b.stations[0]!.plus.bottom.knots[0]!.p)).toBe(true);
    expect(Object.isFrozen(b.rails.plus[0]!.rail)).toBe(true);
    expect(Object.isFrozen(b.outline.minus!.knots)).toBe(true);
  });

  it('shares nothing with its input', () => {
    const input = parsed(mirror);
    const b = revive(input);
    const x = b.stations[0]!.x;
    input.stations[0].x = 99;
    expect(b.stations[0]!.x).toBe(x);
  });

  it('builds and meshes the revived board exactly as the original', () => {
    for (const [name, board] of [BOARDS[0]!, BOARDS[3]!]) {
      const back = revive(parsed(board));
      const a = buildRails(board);
      const b = buildRails(back);
      if (!a.ok || !b.ok) throw new Error(`${name} does not build`);
      const ma = meshRails(a.value);
      const mb = meshRails(b.value);
      expect(mb.volume, name).toBe(ma.volume);
      expect(mb.vertexCount, name).toBe(ma.vertexCount);
      expect(Array.from(mb.positions), name).toEqual(Array.from(ma.positions));
    }
  });
});

describe('reviveRails', () => {
  const issuesOf = (v: unknown) => {
    const r = reviveRails(v);
    expect(r.ok).toBe(false);
    return r.issues;
  };
  const base = parsed(asymmetric);
  const edited = (edit: (d: any) => void): any => {
    const d = JSON.parse(JSON.stringify(base));
    edit(d);
    return d;
  };

  it('reports a missing required key at several depths', () => {
    const cases: [(d: any) => void, string][] = [
      [(d) => delete d.corners, 'document.corners'],
      [(d) => delete d.rails, 'document.rails'],
      [(d) => delete d.corners.nose, 'corners.nose'],
      [(d) => delete d.stations[1].plus.deck, 'stations[1].plus.deck'],
      [(d) => delete d.stations[0].id, 'stations[0].id'],
      [(d) => delete d.rails.plus[0].rail.tuck, 'rails.plus[0].rail.tuck'],
      [(d) => delete d.rails.minus[1].x, 'rails.minus[1].x'],
      [(d) => delete d.rocker.knots[0].smooth, 'rocker.knots[0].smooth'],
      [(d) => delete d.build.railFade, 'build.railFade'],
    ];
    for (const [edit, path] of cases) {
      const issues = issuesOf(edited(edit));
      expect(issues.every((i) => i.code === 'doc-malformed')).toBe(true);
      expect(
        issues.some((i) => i.message.includes(path) && i.message.includes('required')),
        path,
      ).toBe(true);
    }
  });

  it('reports an unknown key at several depths', () => {
    const cases: [(d: any) => void, string][] = [
      [(d) => (d.sections = []), 'document.sections'],
      [(d) => (d.corners.mid = 1), 'corners.mid'],
      [(d) => (d.stations[2].apex = 1), 'stations[2].apex'],
      [(d) => (d.stations[2].minus.bottom.width = 1), 'stations[2].minus.bottom.width'],
      [(d) => (d.rails.plus[0].rail.width = 1), 'rails.plus[0].rail.width'],
      [(d) => (d.rails.plus[0].y = 1), 'rails.plus[0].y'],
      [(d) => (d.outline.minus.knots[1].tension = 1), 'outline.minus.knots[1].tension'],
    ];
    for (const [edit, path] of cases) {
      const issues = issuesOf(edited(edit));
      expect(issues.every((i) => i.code === 'doc-malformed')).toBe(true);
      expect(
        issues.some((i) => i.message.includes(path) && i.message.includes('not a known field')),
        path,
      ).toBe(true);
    }
  });

  it('reports wrong types, non-finite numbers and bad enums with a path', () => {
    const cases: [string, (d: any) => void, string][] = [
      ['a string number', (d) => (d.rails.plus[0].rail.tuck = '1'), 'rails.plus[0].rail.tuck'],
      ['Infinity', (d) => (d.stations[1].x = Infinity), 'stations[1].x'],
      ['NaN', (d) => (d.corners.plus[0] = NaN), 'corners.plus[0]'],
      ['-Infinity in a knot', (d) => (d.deck.knots[1].p[1] = -Infinity), 'deck.knots[1].p[1]'],
      ['a bad symmetry', (d) => (d.symmetry = 'left'), 'symmetry'],
      ['corners.plus not an array', (d) => (d.corners.plus = 3), 'corners.plus'],
      ['a short pair', (d) => (d.rocker.knots[0].p = [1]), 'rocker.knots[0].p'],
      ['a non-boolean smooth', (d) => (d.rocker.knots[0].smooth = 1), 'rocker.knots[0].smooth'],
      ['a bad feature kind', (d) => (d.features[0].kind = 'fin'), 'features[0].kind'],
      [
        'a knot of a station curve',
        (d) => (d.stations[2].plus.bottom.knots[1].p = 'x'),
        'stations[2].plus.bottom.knots[1].p',
      ],
    ];
    for (const [what, edit, path] of cases) {
      const d = edited(edit);
      // the board has features only when it has them; skip if the board has none
      if (what === 'a bad feature kind' && d.features.length === 0) continue;
      const issues = issuesOf(d);
      expect(issues.every((i) => i.code === 'doc-malformed')).toBe(true);
      expect(
        issues.some((i) => i.message.includes(path)),
        what,
      ).toBe(true);
    }
  });

  it('tells a wrong format, version or model apart', () => {
    expect(issuesOf({ ...base, format: 'other' })[0]!.code).toBe('doc-malformed');
    expect(issuesOf({ ...base, format: 'other' })).toHaveLength(1);
    const v = issuesOf({ ...base, version: 3 });
    expect(v).toHaveLength(1);
    expect(v[0]!.code).toBe('doc-version');
    const m = issuesOf({ ...base, model: 'sections' });
    expect(m).toHaveLength(1);
    expect(m[0]!.code).toBe('doc-version');
    const sections = JSON.parse(boardDocToJson(analyticBoard()));
    expect(issuesOf(sections)[0]!.code).toBe('doc-version');
    const r = reviveBoardDoc(base);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('doc-version');
  });

  it('reports every problem of a document, not just the first', () => {
    const d = edited((x) => {
      delete x.corners.nose;
      x.symmetry = 'left';
      x.rails.plus[0].rail.tuck = '1';
      x.stations[0].extra = 1;
      x.build.tolerance = Infinity;
    });
    const msgs = issuesOf(d).map((i) => i.message);
    expect(msgs.length).toBeGreaterThanOrEqual(5);
    for (const path of [
      'corners.nose',
      'symmetry',
      'rails.plus[0].rail.tuck',
      'stations[0].extra',
      'build.tolerance',
    ]) {
      expect(
        msgs.some((m) => m.includes(path)),
        path,
      ).toBe(true);
    }
  });

  it('leaves the judgement of the board to buildRails', () => {
    // a mirror board with a minus outline and unsorted stations is well shaped
    const d = JSON.parse(railsToJson(mirror));
    d.outline.minus = d.outline.plus;
    d.stations.reverse();
    expect(reviveRails(d).ok).toBe(true);
  });

  it('never throws, whatever one node of a valid document is replaced by', () => {
    const doc = parsed(asymmetric);
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, path: (string | number)[]): void => {
      paths.push(path);
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
      else if (v !== null && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    };
    walk(doc, []);
    const replacements: unknown[] = [null, 'x', -1, [], {}, true];
    let tried = 0;
    for (const path of paths) {
      for (const rep of replacements) {
        let copy: any;
        if (path.length === 0) copy = rep;
        else {
          copy = JSON.parse(JSON.stringify(doc));
          let at = copy;
          for (const k of path.slice(0, -1)) at = at[k];
          at[path[path.length - 1]!] = rep;
        }
        expect(() => reviveRails(copy)).not.toThrow();
        tried++;
      }
    }
    expect(tried).toBe(paths.length * replacements.length);
  });

  it('never throws on a value that is not a document', () => {
    const nullProto = Object.create(null);
    for (const v of [
      undefined,
      null,
      42,
      'text',
      [],
      new Date(),
      nullProto,
      () => 1,
      Symbol('s'),
    ]) {
      const r = reviveRails(v);
      expect(r.ok).toBe(false);
      expect(r.issues[0]!.code).toBe('doc-malformed');
    }
  });
});

describe('docModel', () => {
  it('names the reader a parsed document is for', () => {
    expect(docModel(JSON.parse(boardDocToJson(swallowBoard())))).toBe('sections');
    expect(docModel(parsed(mirror))).toBe('rails');
  });

  it('is null for anything else', () => {
    for (const v of [
      null,
      undefined,
      3,
      'openshaper',
      [],
      [{ format: 'openshaper', model: 'rails' }],
      { format: 'other', model: 'rails' },
      { model: 'rails' },
      { format: 'openshaper', model: 'nurbs' },
      { format: 'openshaper' },
    ]) {
      expect(docModel(v)).toBeNull();
    }
  });
});
