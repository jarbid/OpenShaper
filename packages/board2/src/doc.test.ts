// SPDX-License-Identifier: GPL-3.0-or-later
/* eslint-disable @typescript-eslint/no-explicit-any -- the tests edit plain JSON documents */
/** The document boundary: exact JSON round trip, shape errors, isolation. */
import { describe, expect, it } from 'vitest';
import { boardDocToJson, reviveBoardDoc } from './doc';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from './testing';
import type { BoardDoc } from './types';

const BOARDS: [string, () => BoardDoc][] = [
  ['analytic', analyticBoard],
  ['swallow', swallowBoard],
  ['fish', fishBoard],
  ['asymmetric', asymmetricBoard],
];

const revive = (v: unknown): BoardDoc => {
  const r = reviveBoardDoc(v);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

describe('canonical JSON', () => {
  it.each(BOARDS)('round-trips the %s board exactly', (_name, make) => {
    const doc = make();
    const text = boardDocToJson(doc);
    const back = revive(JSON.parse(text));
    expect(back).toEqual(doc);
    expect(boardDocToJson(back)).toBe(text);
    // and once more from the revived text
    expect(boardDocToJson(revive(JSON.parse(boardDocToJson(back))))).toBe(text);
  });

  it('is independent of the key order of the input', () => {
    const doc = swallowBoard();
    const shuffled = JSON.parse(
      JSON.stringify(doc, (_k, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    );
    expect(boardDocToJson(revive(shuffled))).toBe(boardDocToJson(doc));
  });

  it('carries optional fields: meta details and opaque fins', () => {
    const doc: BoardDoc = {
      ...asymmetricBoard(),
      meta: { name: 'n', author: 'a', comment: 'c', source: 's' },
      fins: { systems: ['fcs2', { count: 3, toe: -0.5 }], on: true, none: null },
    };
    const text = boardDocToJson(doc);
    expect(boardDocToJson(revive(JSON.parse(text)))).toBe(text);
    expect(revive(JSON.parse(text)).fins).toEqual(doc.fins);
  });

  it('reads -0 as 0 and keeps full double precision', () => {
    const doc = mutated(analyticBoard(), (d) => {
      d.stations[0].x = Math.PI * 16;
      d.rocker.knots[0].p[1] = -0;
    });
    const back = revive(JSON.parse(boardDocToJson(doc)));
    expect(back.stations[0]!.x).toBe(Math.PI * 16);
    expect(Object.is(back.rocker.knots[0]!.p[1], 0)).toBe(true);
  });

  it('writes the document with a header and no derived data', () => {
    const text = boardDocToJson(analyticBoard());
    expect(
      text.startsWith('{\n  "format": "openshaper",\n  "version": 3,\n  "model": "sections",'),
    ).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });
});

const mutated = (doc: BoardDoc, edit: (d: any) => void): BoardDoc => {
  const d = JSON.parse(JSON.stringify(doc));
  edit(d);
  return d;
};

describe('reviveBoardDoc', () => {
  const bad = (v: unknown) => {
    const r = reviveBoardDoc(v);
    expect(r.ok).toBe(false);
    return r.issues;
  };

  it('returns a frozen deep copy that shares nothing with its input', () => {
    const input = JSON.parse(boardDocToJson(swallowBoard()));
    const doc = revive(input);
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.outline.plus.knots[0]!.p)).toBe(true);
    input.outline.plus.knots[0].p[0] = 99;
    expect(doc.outline.plus.knots[0]!.p[0]).toBe(11);
  });

  it('reports shape problems as doc-malformed with a path', () => {
    const base = JSON.parse(boardDocToJson(swallowBoard()));
    const cases: [string, (d: any) => void, string][] = [
      ['a missing field', (d) => delete d.rocker, 'document.rocker'],
      ['an unknown field', (d) => (d.extra = 1), 'document.extra'],
      ['a non-number', (d) => (d.stations[1].x = '5'), 'stations[1].x'],
      ['a non-finite number', (d) => (d.stations[1].x = Infinity), 'stations[1].x'],
      ['a short pair', (d) => (d.outline.plus.knots[0].p = [1]), 'outline.plus.knots[0].p'],
      ['a bad enum', (d) => (d.symmetry = 'left'), 'symmetry'],
      ['a missing zone', (d) => delete d.tail.zone, 'tail.zone'],
      ['a bad feature kind', (d) => (d.features[0].kind = 'fin'), 'features[0].kind'],
      ['a non-integer apex', (d) => (d.stations[0].plus.apex = 1.5), 'stations[0].plus.apex'],
    ];
    for (const [what, edit, path] of cases) {
      const d = JSON.parse(JSON.stringify(base));
      edit(d);
      const issues = bad(d);
      expect(
        issues.every((i) => i.code === 'doc-malformed') &&
          issues.some((i) => i.message.includes(path)),
        what,
      ).toBe(true);
    }
  });

  it('tells a wrong version or model from a malformed document', () => {
    const base = JSON.parse(boardDocToJson(analyticBoard()));
    expect(bad({ ...base, version: 2 })[0]!.code).toBe('doc-version');
    expect(bad({ ...base, model: 'rails' })[0]!.code).toBe('doc-version');
    expect(bad({ ...base, format: 'other' })[0]!.code).toBe('doc-malformed');
    expect(bad(null)[0]!.code).toBe('doc-malformed');
    expect(bad([])[0]!.code).toBe('doc-malformed');
  });

  it('leaves the judgement of the board to the validator', () => {
    // a mirror board with a minus outline is well shaped; validateBoard refuses it
    const d = mutated(swallowBoard(), (x) => (x.outline.minus = x.outline.plus));
    expect(reviveBoardDoc(JSON.parse(JSON.stringify(d))).ok).toBe(true);
  });
});
