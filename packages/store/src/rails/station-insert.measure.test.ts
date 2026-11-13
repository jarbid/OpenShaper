// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How far the built surface moves when a station is added midway between two stations
 * (`addStation`): measured, not bounded. For each pair of neighbouring stations of each test
 * board, a station is added at their midpoint and the engine's section (`probeRails`, both sides)
 * is compared, before and after, at nine places between the two, as the worst two-sided distance
 * between the two section polylines. The numbers are printed; the test only checks that they are
 * finite and that the board still builds.
 *
 * A study, run on demand and not by the package's suite:
 *
 *   TRIM_STUDY=1 pnpm --filter @openshaper/store exec vitest run src/rails/station-insert.measure.test.ts
 */
import type { RailsBoard } from '@openshaper/board2';
import { buildRails, probeRails } from '@openshaper/board2';
import { distanceToPolyline } from '@openshaper/board2/testing';
import { describe, expect, it } from 'vitest';
import { addStation } from './edits';
import { railsBoards } from './test-support/boards';

const SAMPLES = 160;
const PLACES = 9;

const pairs = (flat: readonly number[]): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
};

/** The worst two-sided distance (cm) between two section polylines. */
function gap(a: readonly number[], b: readonly number[]): number {
  const pa = pairs(a);
  const pb = pairs(b);
  let worst = 0;
  for (const p of pa) worst = Math.max(worst, distanceToPolyline(pb, p));
  for (const p of pb) worst = Math.max(worst, distanceToPolyline(pa, p));
  return worst;
}

function built(doc: RailsBoard) {
  const r = buildRails(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');

study('the surface change of a station added midway between two', () => {
  it.each(railsBoards)('on the %s board', { timeout: 120_000 }, (name, make) => {
    const doc = make();
    const before = built(doc);
    const sides: (0 | 1)[] = doc.outline.minus ? [0, 1] : [0];
    const rows: string[] = [];
    let worst = 0;
    for (let i = 0; i + 1 < doc.stations.length; i++) {
      const a = doc.stations[i]!;
      const b = doc.stations[i + 1]!;
      const added = addStation(doc, (a.x + b.x) / 2);
      if (added === null) continue;
      const after = built(added.doc);
      let pair = 0;
      for (let j = 1; j <= PLACES; j++) {
        const x = a.x + ((b.x - a.x) * j) / (PLACES + 1);
        for (const side of sides) {
          pair = Math.max(
            pair,
            gap(probeRails(before, side, x, SAMPLES), probeRails(after, side, x, SAMPLES)),
          );
        }
      }
      const blended =
        a.plus.bottom.knots.length === b.plus.bottom.knots.length &&
        a.plus.deck.knots.length === b.plus.deck.knots.length;
      rows.push(
        `${a.id}@${a.x.toFixed(1)}..${b.id}@${b.x.toFixed(1)}: ${(pair * 10).toFixed(3)} mm${blended ? '' : ' (nearer copied)'}`,
      );
      worst = Math.max(worst, pair);
      expect(Number.isFinite(pair)).toBe(true);
    }
    console.log(
      `station insert, ${name}: worst ${(worst * 10).toFixed(3)} mm\n  ${rows.join('\n  ')}`,
    );
  });
});
