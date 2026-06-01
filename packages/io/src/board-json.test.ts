import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLength, getMaxWidth, getVolume } from '@openshaper/kernel';
import { parseBrd } from './brd-reader';
import { BoardJsonError, readBoardJson, writeBoardJson } from './board-json';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const loadBrd = (name: string) => parseBrd(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8')).board;

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
});
