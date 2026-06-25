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
