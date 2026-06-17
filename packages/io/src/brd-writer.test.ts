import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLength, getMaxWidth, getThickness, getVolume } from '@openshaper/kernel';
import { parseBrd } from './brd-reader';
import { writeBrd } from './brd-writer';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const loadBrd = (name: string) =>
  parseBrd(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8')).board;

const BOARDS = ['shortboard', 'funboard', 'longboard'] as const;

describe('writeBrd — round-trip through parseBrd', () => {
  for (const name of BOARDS) {
    it(`${name}: write -> read preserves geometry`, () => {
      const original = loadBrd(name);
      const restored = parseBrd(writeBrd(original)).board;

      expect(getLength(restored)).toBeCloseTo(getLength(original), 9);
      expect(getMaxWidth(restored)).toBeCloseTo(getMaxWidth(original), 9);
      expect(getThickness(restored)).toBeCloseTo(getThickness(original), 9);
      expect(getVolume(restored)).toBeCloseTo(getVolume(original), 6);

      // Control points preserved exactly through serialization.
      expect(restored.outline.knots).toEqual(original.outline.knots);
      expect(restored.bottom.knots).toEqual(original.bottom.knots);
      expect(restored.deck.knots).toEqual(original.deck.knots);
      expect(restored.crossSections.length).toBe(original.crossSections.length);
      for (let i = 0; i < original.crossSections.length; i++) {
        expect(restored.crossSections[i]!.position).toBeCloseTo(
          original.crossSections[i]!.position,
          9,
        );
        expect(restored.crossSections[i]!.spline.knots).toEqual(
          original.crossSections[i]!.spline.knots,
        );
      }
    });
  }
});

describe('writeBrd — output format', () => {
  const text = writeBrd(loadBrd('shortboard'), {
    model: 'Test Model',
    designer: 'Jane',
    comments: 'line one\nline two',
  });

  it('emits the legacy geometry line shapes', () => {
    expect(text).toContain('p32 : (\n');
    expect(text).toContain('p33 : (\n');
    expect(text).toContain('p34 : (\n');
    expect(text).toContain('p35 : (\n');
    expect(text).toMatch(/\(p36 [\d.-]+\n/);
    expect(text).toMatch(/\(cp \[[\d.,-]+\] (true|false) (true|false)\)/);
  });

  it('writes identity metadata and escapes newlines in strings', () => {
    expect(text).toContain('p54 : Test Model\n');
    expect(text).toContain('p45 : Jane\n');
    expect(text).toContain('p49 : line one\\nline two\n');
  });

  it('round-trips identity metadata back through the reader', () => {
    const meta = parseBrd(text).metadata;
    expect(meta.model).toBe('Test Model');
    expect(meta.designer).toBe('Jane');
    expect(meta.comments).toBe('line one\\nline two');
  });
});
