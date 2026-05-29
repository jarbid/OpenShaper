import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getArea,
  getCenterOfMass,
  getCenterWidth,
  getLength,
  getMaxRocker,
  getMaxThickness,
  getMaxWidth,
  getMaxWidthPos,
  getRockerAtPos,
  getThickness,
  getThicknessAtPos,
  getVolume,
  getWidthAtPos,
} from './board';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');

interface GoldenStation {
  frac: number;
  pos: number;
  width: number;
  rocker: number;
  thickness: number;
}
interface GoldenBoard {
  length: number;
  maxWidth: number;
  maxWidthPos: number;
  centerWidth: number;
  thickness: number;
  maxThickness: number;
  maxRocker: number;
  volume: number;
  area: number;
  centerOfMass: number;
  stations: GoldenStation[];
}
const golden: { boards: Record<string, GoldenBoard> } = JSON.parse(
  readFileSync(resolve(goldenDir, 'golden.json'), 'utf8'),
);

const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

// Tolerances per docs/specs/golden/README.md.
const DIM = 0.05; // cm — geometry must match closely
const AREA_VOL_PCT = 0.01; // 1% — adaptive vs fixed-split integration

const within = (actual: number, expected: number, tol: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
const withinPct = (actual: number, expected: number, pct: number) =>
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(pct);

for (const name of ['shortboard', 'funboard', 'longboard']) {
  describe(`board model vs golden: ${name}`, () => {
    const b = loadBoard(name);
    const g = golden.boards[name]!;

    it('length', () => within(getLength(b), g.length, DIM));
    it('max width', () => within(getMaxWidth(b), g.maxWidth, DIM));
    it('max width pos', () => within(getMaxWidthPos(b), g.maxWidthPos, 0.5));
    it('center width', () => within(getCenterWidth(b), g.centerWidth, DIM));
    it('thickness', () => within(getThickness(b), g.thickness, DIM));
    it('max thickness', () => within(getMaxThickness(b), g.maxThickness, DIM));
    it('max rocker', () => within(getMaxRocker(b), g.maxRocker, DIM));

    it('per-station width/rocker/thickness', () => {
      for (const s of g.stations) {
        within(getWidthAtPos(b, s.pos), s.width, DIM);
        within(getRockerAtPos(b, s.pos), s.rocker, DIM);
        within(getThicknessAtPos(b, s.pos), s.thickness, DIM);
      }
    });

    it('area within 1%', () => withinPct(getArea(b), g.area, AREA_VOL_PCT));
    it('volume within 1%', () => withinPct(getVolume(b), g.volume, AREA_VOL_PCT));
    it('center of mass', () => within(getCenterOfMass(b), g.centerOfMass, 0.5));
  });
}
