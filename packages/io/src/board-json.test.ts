import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  defaultFinConfig,
  getLength,
  getMaxWidth,
  getVolume,
  hasTailCutout,
  knot,
  splineFromKnots,
  vec2,
  type KnotLock,
  type Spline,
} from '@openshaper/kernel';
import { parseBrd } from './brd-reader';
import { BoardJsonError, readBoardJson, writeBoardJson } from './board-json';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const loadBrd = (name: string) =>
  parseBrd(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8')).board;

describe('board-json round-trip', () => {
  for (const name of ['shortboard', 'funboard', 'longboard']) {
    it(`${name}: write -> read preserves geometry`, () => {
      const original = loadBrd(name);
      const json = writeBoardJson(original, { name });
      const { board: restored, metadata } = readBoardJson(json);

      expect(metadata).toEqual({ name });
      expect(getLength(restored)).toBeCloseTo(getLength(original), 9);
      expect(getMaxWidth(restored)).toBeCloseTo(getMaxWidth(original), 9);
      expect(getVolume(restored)).toBeCloseTo(getVolume(original), 6);
      // control points preserved exactly
      expect(restored.outline.knots).toEqual(original.outline.knots);
      expect(restored.crossSections.length).toBe(original.crossSections.length);
    });
  }

  it('rejects non-Board-Studio JSON', () => {
    expect(() => readBoardJson('{"hello":1}')).toThrow(BoardJsonError);
    expect(() => readBoardJson('not json')).toThrow(BoardJsonError);
  });

  it('preserves a concave tail (swallow) outline through save/load', () => {
    // The outline folds back at the tail (non-monotonic in x). No schema change is
    // needed — it serializes as plain knots — so the notch must survive verbatim.
    const t = (ax: number, ay: number, bx: number, by: number): [number, number] => [
      ax + (bx - ax) / 3,
      ay + (by - ay) / 3,
    ];
    const swallow = splineFromKnots([
      knot(vec2(12, 0), vec2(12, 0), vec2(...t(12, 0, 0, 6))),
      knot(vec2(0, 6), vec2(...t(0, 6, 12, 0)), vec2(...t(0, 6, 50, 15))),
      knot(vec2(50, 15), vec2(...t(50, 15, 0, 6)), vec2(...t(50, 15, 100, 0))),
      knot(vec2(100, 0), vec2(...t(100, 0, 50, 15)), vec2(100, 0)),
    ]);
    const base = loadBrd('shortboard');
    const original = board(
      swallow,
      base.bottom,
      base.deck,
      [
        crossSection(0, base.crossSections[1]!.spline),
        crossSection(50, base.crossSections[1]!.spline),
        crossSection(100, base.crossSections[1]!.spline),
      ],
      base.interpolationType,
    );
    expect(hasTailCutout(original.outline)).toBe(true);
    const { board: restored } = readBoardJson(writeBoardJson(original));
    expect(restored.outline.knots).toEqual(original.outline.knots);
    expect(hasTailCutout(restored.outline)).toBe(true);
  });
});

describe('board-json fins', () => {
  const withFins = () => {
    const b = loadBrd('shortboard');
    const cfg = defaultFinConfig('thruster', 'futures');
    return board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, cfg);
  };

  it('round-trips a fin config exactly', () => {
    const original = withFins();
    const { board: restored } = readBoardJson(writeBoardJson(original));
    expect(restored.fins).toEqual(original.fins);
  });

  it('omits the fins block when there are no fins, and reads back as none', () => {
    const b = loadBrd('shortboard');
    const json = writeBoardJson(b);
    expect(JSON.parse(json).fins).toBeUndefined();
    expect(readBoardJson(json).board.fins.setup).toBe('none');
  });

  it('migrates a legacy metadata.finType setup name to a default config', () => {
    const b = loadBrd('shortboard');
    // Simulate a v1 doc that only carried the legacy finType string in metadata.
    const json = writeBoardJson(b, { finType: 'quad' });
    const { board: restored } = readBoardJson(json);
    expect(restored.fins).toEqual(defaultFinConfig('quad', 'fcs-ii'));
  });
});

describe('board-json structural validation (P6)', () => {
  const valid = () => JSON.parse(writeBoardJson(loadBrd('shortboard'))) as Record<string, unknown>;
  const read = (doc: unknown) => () => readBoardJson(JSON.stringify(doc));

  it('rejects a document that is not an object', () => {
    expect(() => readBoardJson('null')).toThrow(BoardJsonError);
    expect(() => readBoardJson('[1,2]')).toThrow(BoardJsonError);
    expect(() => readBoardJson('"text"')).toThrow(BoardJsonError);
  });

  it('rejects missing curves', () => {
    const doc = valid();
    delete doc.deck;
    expect(read(doc)).toThrow(/deck is missing/);
    const noSections = valid();
    delete noSections.crossSections;
    expect(read(noSections)).toThrow(/crossSections is missing/);
  });

  it('rejects knots with bad coordinates instead of loading NaN geometry', () => {
    const doc = valid();
    (doc.outline as { e: unknown }[])[1]!.e = [null, 'a'];
    expect(read(doc)).toThrow(/outline point 2 has an invalid coordinate/);
  });

  it('rejects a cross-section without a numeric position', () => {
    const doc = valid();
    (doc.crossSections as { position: unknown }[])[2]!.position = 'mid';
    expect(read(doc)).toThrow(/cross-section 3 has no valid position/);
  });

  it('still reads a knot with its optional flags omitted', () => {
    const doc = valid();
    const k = (doc.outline as Record<string, unknown>[])[1]!;
    delete k.c;
    delete k.o;
    expect(read(doc)).not.toThrow();
  });
});

describe('board-json handle-angle locks', () => {
  const R = Math.SQRT1_2;
  /** The shortboard with outline point 1 fully locked and one section point locked on one side. */
  const lockedBoard = () => {
    const b = loadBrd('shortboard');
    const lockAt = (s: Spline, i: number, lock: KnotLock) =>
      splineFromKnots(s.knots.map((k, j) => (j === i ? { ...k, lock } : k)));
    const cs = b.crossSections.map((c, i) =>
      i === 2 ? crossSection(c.position, lockAt(c.spline, 1, { next: vec2(R, R) })) : c,
    );
    return board(
      lockAt(b.outline, 1, { prev: vec2(-1, 0), next: vec2(1, 0) }),
      b.bottom,
      b.deck,
      cs,
      b.interpolationType,
      b.fins,
    );
  };

  it('round-trips locks exactly, one-sided ones included', () => {
    const original = lockedBoard();
    const { board: restored } = readBoardJson(writeBoardJson(original));
    expect(restored.outline.knots).toEqual(original.outline.knots);
    expect(restored.crossSections[2]!.spline.knots[1]!.lock).toEqual({ next: vec2(R, R) });
  });

  it('writes a board without locks exactly as before: no lock field on any point', () => {
    const doc = JSON.parse(writeBoardJson(loadBrd('shortboard'))) as {
      outline: Record<string, unknown>[];
    };
    for (const k of doc.outline) expect(Object.keys(k)).toEqual(['e', 'p', 'n', 'c', 'o']);
    expect(writeBoardJson(loadBrd('shortboard'))).not.toContain('"l"');
  });

  it('reads a point with no lock field as unlocked', () => {
    const { board: restored } = readBoardJson(writeBoardJson(loadBrd('shortboard')));
    for (const k of restored.outline.knots) expect(k).not.toHaveProperty('lock');
  });

  it('normalizes a hand-edited direction and drops a zero one', () => {
    const doc = JSON.parse(writeBoardJson(loadBrd('shortboard'))) as {
      outline: Record<string, unknown>[];
    };
    doc.outline[1]!.l = { p: [-3, 0], n: [0, 0] };
    const k = readBoardJson(JSON.stringify(doc)).board.outline.knots[1]!;
    expect(k.lock).toEqual({ prev: vec2(-1, 0) });

    doc.outline[1]!.l = { n: [0, 0] };
    expect(readBoardJson(JSON.stringify(doc)).board.outline.knots[1]!).not.toHaveProperty('lock');
  });

  it('rejects a malformed lock instead of loading it', () => {
    const doc = JSON.parse(writeBoardJson(loadBrd('shortboard'))) as {
      outline: Record<string, unknown>[];
    };
    doc.outline[1]!.l = { p: ['up', 1] };
    expect(() => readBoardJson(JSON.stringify(doc))).toThrow(
      /outline point 2 has an invalid handle lock/,
    );
    doc.outline[1]!.l = 'locked';
    expect(() => readBoardJson(JSON.stringify(doc))).toThrow(BoardJsonError);
  });
});
