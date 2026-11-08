import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RefPoint } from '@openshaper/kernel';
import { parseBrd } from './brd-reader';
import { brdUnwritableRefPoints, writeBrd } from './brd-writer';
import { readBoardJson, writeBoardJson } from './board-json';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const shortboardText = readFileSync(resolve(goldenDir, 'shortboard.brd'), 'utf8');
const shortboard = parseBrd(shortboardText);

/** One of each kind, at stations the shortboard has (92.71) and has not (50). */
const mixed: RefPoint[] = [
  { id: 'r1', plane: 'outline', x: 30.48, y: 19.05, label: 'tail 12in' },
  { id: 'r2', plane: 'rocker', curve: 'bottom', x: 0, y: 6.44 },
  { id: 'r3', plane: 'rocker', curve: 'deck', x: 93.9, y: 5.96 },
  { id: 'r4', plane: 'section', station: 92.71, x: 20, y: -0.2 },
  { id: 'r5', plane: 'section', station: 50, x: 15, y: 1 },
];

describe('.brd guide points (legacy gps blocks)', () => {
  it('imports the golden shortboard guide points as section points at their station', () => {
    expect(shortboard.referencePoints).toEqual([
      {
        id: 'r1',
        plane: 'section',
        station: 92.71,
        x: 20.49624252319336,
        y: -0.21735146641731262,
      },
      {
        id: 'r2',
        plane: 'section',
        station: 92.71,
        x: 12.932412147521973,
        y: -0.13041087985038757,
      },
    ]);
  });

  it('writes them back in the legacy text, byte for byte', () => {
    const out = writeBrd(shortboard.board, undefined, shortboard.referencePoints);
    const block = [
      'gps : (',
      '(gp [20.49624252319336,-0.21735146641731262])',
      '(gp [12.932412147521973,-0.13041087985038757])',
      ')',
      ')',
      '(p36 157.48',
    ].join('\n');
    expect(shortboardText).toContain(block);
    expect(out).toContain(block);
  });

  it('round-trips every curve kind; a section point with no section is left out', () => {
    const out = writeBrd(shortboard.board, undefined, mixed);
    const reread = parseBrd(out);
    expect(reread.referencePoints?.map(({ id: _, label: __, ...p }) => p)).toEqual(
      mixed.slice(0, 4).map(({ id: _, label: __, ...p }) => p),
    );
    expect(brdUnwritableRefPoints(shortboard.board, mixed)).toEqual([mixed[4]]);
    expect(reread.warnings.filter((w) => w.message.includes('guide'))).toEqual([]);
  });

  it('writes no gps blocks when there are no points, exactly as before', () => {
    expect(writeBrd(shortboard.board)).not.toContain('gps');
    expect(writeBrd(shortboard.board, undefined, [])).toBe(writeBrd(shortboard.board));
  });

  it('skips a malformed guide point with a warning and keeps the rest', () => {
    const damaged = shortboardText.replace(
      '(gp [12.932412147521973,-0.13041087985038757])',
      '(gp [12.9,oops])',
    );
    const parsed = parseBrd(damaged);
    expect(parsed.referencePoints).toHaveLength(1);
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({ severity: 'dropped', message: expect.stringContaining('guide') }),
    );
  });
});

describe('.board.json reference points', () => {
  it('round-trips exactly, including labels, ids and side', () => {
    const points: RefPoint[] = [
      ...mixed,
      { id: 'r9', plane: 'outline', x: 0, y: 1, side: 'minus' },
    ];
    const read = readBoardJson(writeBoardJson(shortboard.board, { model: 'x' }, points));
    expect(read.referencePoints).toEqual(points);
    expect(read.metadata).toEqual({ model: 'x' });
    expect(read.warnings).toBeUndefined();
  });

  it('is byte-stable across a second save', () => {
    const first = writeBoardJson(shortboard.board, undefined, mixed);
    const read = readBoardJson(first);
    expect(writeBoardJson(read.board, read.metadata, read.referencePoints)).toBe(first);
  });

  it('writes nothing new for a board without points', () => {
    const before = writeBoardJson(shortboard.board, { model: 'x' });
    expect(writeBoardJson(shortboard.board, { model: 'x' }, [])).toBe(before);
    expect(before).not.toContain('referencePoints');
    expect(readBoardJson(before)).toEqual({
      board: readBoardJson(before).board,
      metadata: { model: 'x' },
    });
  });

  it('drops damaged points with a warning instead of rejecting the board', () => {
    const doc = JSON.parse(writeBoardJson(shortboard.board, undefined, mixed));
    doc.referencePoints[1] = { plane: 'rocker', x: 1, y: 2 }; // no curve
    doc.referencePoints.push('junk');
    const read = readBoardJson(JSON.stringify(doc));
    expect(read.referencePoints?.map((p) => p.id)).toEqual(['r1', 'r3', 'r4', 'r5']);
    expect(read.warnings).toEqual([
      { severity: 'dropped', message: '2 damaged reference points were skipped' },
    ]);
  });

  it('ignores a referencePoints field that is not a list, with a warning', () => {
    const doc = JSON.parse(writeBoardJson(shortboard.board));
    doc.referencePoints = { outline: [] };
    const read = readBoardJson(JSON.stringify(doc));
    expect(read.referencePoints).toBeUndefined();
    expect(read.warnings).toHaveLength(1);
  });
});
