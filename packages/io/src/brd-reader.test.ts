import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getLength,
  getMaxWidth,
  getThickness,
  getVolume,
} from '@board-studio/kernel';
import { parseBrd } from './brd-reader';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(HERE, '../../../docs/specs/golden');

const readBrd = (name: string): string =>
  readFileSync(resolve(GOLDEN_DIR, `${name}.brd`), 'utf8');

interface GoldenBoard {
  length: number;
  maxWidth: number;
  thickness: number;
  volume: number;
}
const golden = JSON.parse(readFileSync(resolve(GOLDEN_DIR, 'golden.json'), 'utf8')) as {
  boards: Record<string, GoldenBoard>;
};

const BOARDS = ['shortboard', 'funboard', 'longboard'] as const;

describe('parseBrd — golden fixtures', () => {
  for (const name of BOARDS) {
    describe(name, () => {
      const parsed = parseBrd(readBrd(name));
      const g = golden.boards[name]!;

      it('parses metadata (version + name)', () => {
        expect(parsed.metadata.version).toBe('V4.4');
        expect(parsed.metadata.name).toBe('BoardCAD');
      });

      it('volume within 1% of golden', () => {
        const v = getVolume(parsed.board);
        expect(Math.abs(v - g.volume) / g.volume).toBeLessThan(0.01);
      });

      it('length within 0.05cm of golden', () => {
        expect(Math.abs(getLength(parsed.board) - g.length)).toBeLessThan(0.05);
      });

      it('maxWidth within 0.05cm of golden', () => {
        expect(Math.abs(getMaxWidth(parsed.board) - g.maxWidth)).toBeLessThan(0.05);
      });

      it('thickness within 0.05cm of golden', () => {
        expect(Math.abs(getThickness(parsed.board) - g.thickness)).toBeLessThan(0.05);
      });
    });
  }

  it('parses outline control-point coordinates exactly (shortboard)', () => {
    const { board } = parseBrd(readBrd('shortboard'));
    const knots = board.outline.knots;
    // First knot: (cp [0.0,0.0, 0.0,0.0, 0.0,3.05804454721486] ...)
    expect(knots[0]!.end.x).toBe(0.0);
    expect(knots[0]!.end.y).toBe(0.0);
    expect(knots[0]!.tangentToNext.y).toBe(3.05804454721486);
    // Third knot end: (cp [90.13362308681752,23.49499750470692, ...])
    expect(knots[2]!.end.x).toBe(90.13362308681752);
    expect(knots[2]!.end.y).toBe(23.49499750470692);
    // Last knot end x = board length.
    expect(knots[knots.length - 1]!.end.x).toBe(187.96);
  });

  it('shortboard parses without throwing and warns about the truncated p35 group', () => {
    const parsed = parseBrd(readBrd('shortboard'));
    expect(parsed.board.crossSections.length).toBeGreaterThanOrEqual(3);
    expect(parsed.warnings.some((w) => /missing its closing|truncated/i.test(w))).toBe(true);
  });

  it('funboard and longboard parse with no warnings', () => {
    expect(parseBrd(readBrd('funboard')).warnings).toEqual([]);
    expect(parseBrd(readBrd('longboard')).warnings).toEqual([]);
  });
});

describe('parseBrd — error handling', () => {
  it('throws on input with no outline', () => {
    expect(() => parseBrd('p08 : Empty\n')).toThrow();
  });

  it('throws on a malformed (cp ...) record', () => {
    const bad = 'p32 : (\n(cp [1.0,2.0] true false)\n)\n';
    expect(() => parseBrd(bad)).toThrow();
  });
});
