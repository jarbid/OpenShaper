// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the tails of the boards the project ships and makes measure, and where the engine's limits for a tail
 * are: printed, not asserted, and the numbers behind the constants of `tail-shapes.ts`.
 *
 * A study, run on demand and not by the package's suite:
 *
 *   TRIM_STUDY=1 pnpm --filter @openshaper/store exec vitest run src/rails/tail-shapes.measure.test.ts --reporter=verbose
 */
import type { Chain, RailsBoard } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { cornerKnots } from './edits';
import {
  TAIL_SHAPES,
  TAIL_WIDTH_SHARE,
  applyTailShape,
  railKnotIndex,
  tailCorners,
  tailShapeAt,
  type TailCorner,
  type TailShapeId,
} from './tail-shapes';
import { arcAt, builtArcs } from './test-support/built-arcs';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');
const f = (n: number): string => (+n.toFixed(2)).toString();
const pair = (p: readonly number[]): string => `(${f(p[0]!)}, ${f(p[1]!)})`;
const widestOf = (c: Chain): number => Math.max(...c.knots.map((k) => k.p[1]));

study('the tails of every board', () => {
  it('the knots of the tail, where it meets the rail, the corners and what each reads as', () => {
    const rows: string[] = [];
    for (const [name, make] of everyBoard) {
      const doc = make();
      const side = doc.outline.plus;
      const r = railKnotIndex(side);
      const read = tailShapeAt(doc);
      rows.push(
        `== ${name}: ${doc.symmetry}, length ${f(side.knots.at(-1)!.p[0])}, widest half ${f(widestOf(side))}; reads ${read.shape}${read.width === null ? '' : ` (width ${f(read.width)}, ${f((100 * read.width) / (2 * widestOf(side)))}% of the board's)`}; the rail knot is knot ${r} at ${pair(side.knots[r]!.p)}`,
        `   corners: nose ${doc.corners.nose}, tail ${doc.corners.tail}, plus ${JSON.stringify(doc.corners.plus)}${doc.corners.minus ? `, minus ${JSON.stringify(doc.corners.minus)}` : ''}; corner knots at ${JSON.stringify(cornerKnots(side))}`,
      );
      side.knots
        .slice(0, r + 1)
        .forEach((k, i) =>
          rows.push(
            `   knot ${i}${i === r ? ' (rail)' : ''}: p ${pair(k.p)} in ${pair(k.in)} out ${pair(k.out)} ${k.smooth ? 'smooth' : 'corner'}`,
          ),
        );
    }
    console.log(rows.join('\n'));
    expect(rows.length).toBeGreaterThan(30);
  });
});

/** The shapes' widths scanned across and beyond their ranges: where the engine builds a closed board with no issue. */
study('the widths the engine builds', () => {
  it("builds each shape at shares of the board's width, on every board", () => {
    const shares = [0.04, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    const table = TAIL_WIDTH_SHARE as Record<TailShapeId, [number, number]>;
    const kept = { ...table };
    const rows: string[] = [];
    try {
      for (const shape of TAIL_SHAPES) {
        // open the range so the scan is not held to it
        table[shape] = [0, 10];
        for (const [name, make] of everyBoard) {
          const doc = make();
          const board = 2 * widestOf(doc.outline.plus);
          const ok: string[] = [];
          for (const share of shares) {
            const next = applyTailShape(doc, { shape, width: share * board });
            const read = tailShapeAt(next);
            const verdict = closedVerdict(next, true);
            ok.push(
              `${share}:${verdict.ok ? (read.shape === shape ? 'ok' : 'reads ' + read.shape) : verdict.why}`,
            );
          }
          rows.push(`${shape.padEnd(8)} ${name.padEnd(18)} ${ok.join(' ')}`);
        }
      }
    } finally {
      for (const shape of TAIL_SHAPES) table[shape] = kept[shape];
    }
    console.log(rows.join('\n'));
  }, 280000);
});

function withRadius(doc: RailsBoard, c: TailCorner, r: number): RailsBoard {
  if (c.side === 'tail') return { ...doc, corners: { ...doc.corners, tail: r } };
  const radii = c.side === 'minus' ? (doc.corners.minus ?? doc.corners.plus) : doc.corners.plus;
  const next = radii.map((q, i) => (i === c.index ? r : q));
  return c.side === 'minus'
    ? { ...doc, corners: { ...doc.corners, minus: next } }
    : { ...doc, corners: { ...doc.corners, plus: next } };
}

study('the radii the engine builds', () => {
  it('builds each corner at radii up to where it retries a smaller one', () => {
    const rows: string[] = [];
    for (const name of ['mirror', 'swallow-shortboard', 'funboard', 'asymmetric']) {
      const board = everyBoard.find(([n]) => n === name)![1]();
      for (const shape of TAIL_SHAPES) {
        const doc = applyTailShape(board, { shape });
        for (const c of tailCorners(doc)) {
          let okUpTo = 0;
          let firstBad = '-';
          for (let r = 0.5; r < 60; r *= 1.15) {
            const arcs = builtArcs(withRadius(doc, c, r));
            const hit =
              arcs && arcAt(arcs, c.point[0], c.side === 'minus' ? -c.point[1] : c.point[1]);
            const ratio = hit && hit.distance < 3 * r + 0.5 ? hit.arc.radius / r : null;
            if (ratio !== null && ratio > 0.97 && ratio < 1.03) okUpTo = r;
            else {
              firstBad = `${f(r)} gave ${ratio === null ? 'none' : `x${f(ratio)}`}`;
              break;
            }
          }
          rows.push(
            `${name.padEnd(18)} ${shape.padEnd(8)} ${c.label.padEnd(20)} turn ${f((c.turn * 180) / Math.PI).padStart(6)} deg: held to ${f(c.range.min)}..${f(c.range.max)}; built as asked up to ${f(okUpTo)} (first not: ${firstBad})`,
          );
        }
      }
    }
    // the smallest radius that is built at all
    const squash = applyTailShape(everyBoard[0]![1](), { shape: 'squash' });
    const corner = tailCorners(squash)[0]!;
    const floor = [0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.07, 0.1].map((r) => {
      const hit = arcAt(
        builtArcs(withRadius(squash, corner, r))!,
        corner.point[0],
        corner.point[1],
      );
      return `${r}: ${hit && hit.distance < 0.6 ? `an arc of ${hit.arc.points.length / 2} samples` : 'no arc'}`;
    });
    console.log(`${rows.join('\n')}\nthe least radius that is built: ${floor.join('; ')}`);
  }, 280000);
});
