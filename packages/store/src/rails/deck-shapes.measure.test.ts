// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the decks of the boards the project ships and makes measure, and what the shapes of
 * `deck-shapes.ts` cost: printed, not asserted, and the numbers behind that module's constants.
 *
 * A study, run on demand and not by the package's suite:
 *
 *   TRIM_STUDY=1 pnpm --filter @openshaper/store exec vitest run src/rails/deck-shapes.measure.test.ts --reporter=verbose
 */
import type { RailsBoard } from '@openshaper/board2';
import { buildRails, probeRails } from '@openshaper/board2';
import { distanceToPolyline } from '@openshaper/board2/testing';
import { describe, expect, it } from 'vitest';
import { WALL_SLOPE_MAX, applyDeckShape, bandAt, deckShapeOf, domedSpline } from './deck-shapes';
import { addStation } from './edits';
import { insertStation } from './station-insert';
import { splineToCurve, stationSplines } from './project';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';

const study = describe.skipIf(process.env.TRIM_STUDY !== '1');

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0
    ? NaN
    : s.length % 2
      ? s[(s.length - 1) / 2]!
      : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

study('the crowns of the decks of every board', () => {
  it('the crown at the band edge and the fall at the wall, station by station', () => {
    const shares: number[] = [];
    const midShares: number[] = [];
    const wallShares: number[] = [];
    const midWallShares: number[] = [];
    const rows: string[] = [];
    for (const [name, make] of everyBoard) {
      const doc = make();
      const entries = stationSplines(doc, 'plus');
      doc.stations.forEach((st, i) => {
        const e = entries[i]!;
        if (!(e.w > 0 && e.T > 0)) return;
        const band = bandAt(doc, 'plus', st.x);
        const read = deckShapeOf(e, band)!;
        const wall = e.T - e.deck.knots[e.deck.knots.length - 1]!.end.y;
        const share = read.crown / e.T;
        shares.push(share);
        wallShares.push(wall / e.T);
        if (e.T > 0.6 * Math.max(...entries.map((q) => q.T))) {
          midShares.push(share);
          midWallShares.push(wall / e.T);
        }
        rows.push(
          `${name} ${st.id}@${st.x.toFixed(0)}: w ${e.w.toFixed(1)} T ${e.T.toFixed(2)} band ${band.toFixed(2)} | ${read.shape} crown ${read.crown.toFixed(2)} (${(share * 100).toFixed(0)}% of T) | wall fall ${wall.toFixed(2)} (${((wall / e.T) * 100).toFixed(0)}%)`,
        );
      });
    }
    console.log(
      `${rows.join('\n')}\ncrown share of the thickness: median ${median(shares).toFixed(3)} over ${shares.length} stations (${Math.min(...shares).toFixed(2)} to ${Math.max(...shares).toFixed(2)}); the thick stations: median ${median(midShares).toFixed(3)} (${Math.min(...midShares).toFixed(2)} to ${Math.max(...midShares).toFixed(2)})\nfall at the wall over the thickness: median ${median(wallShares).toFixed(3)} over ${wallShares.length} stations (${Math.min(...wallShares).toFixed(2)} to ${Math.max(...wallShares).toFixed(2)}); the thick stations: median ${median(midWallShares).toFixed(3)} (${Math.min(...midWallShares).toFixed(2)} to ${Math.max(...midWallShares).toFixed(2)})`,
    );
    expect(shares.length).toBeGreaterThan(30);
  });
});

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

/** The worst move (mm) of the built surface when a station is added midway between each pair of neighbours. */
function insertCost(doc: RailsBoard, add: typeof addStation): { worst: number; where: string } {
  const before = built(doc);
  const sides: (0 | 1)[] = doc.outline.minus ? [0, 1] : [0];
  let worst = 0;
  let where = '';
  for (let i = 0; i + 1 < doc.stations.length; i++) {
    const a = doc.stations[i]!;
    const b = doc.stations[i + 1]!;
    const added = add(doc, (a.x + b.x) / 2);
    if (added === null) continue;
    const after = built(added.doc);
    for (let j = 1; j <= PLACES; j++) {
      const x = a.x + ((b.x - a.x) * j) / (PLACES + 1);
      for (const side of sides) {
        const g = gap(probeRails(before, side, x, SAMPLES), probeRails(after, side, x, SAMPLES));
        if (g > worst) {
          worst = g;
          where = `${a.id}..${b.id}`;
        }
      }
    }
  }
  return { worst: worst * 10, where };
}

study('the surface change of a station added midway, with deck shapes', () => {
  it.each(everyBoard)('on the %s board', { timeout: 120_000 }, (name, make) => {
    const doc = make();
    const mid = Math.floor(doc.stations.length / 2);
    const cases: [string, RailsBoard][] = [
      ['as shipped', doc],
      [
        'every deck Domed (each keeps its crown)',
        applyDeckShape(doc, { shape: 'domed' }, { station: mid, all: true }),
      ],
      [
        'every deck Domed at one crown share',
        applyDeckShape(doc, { shape: 'domed', crown: 1.5 }, { station: mid, all: true }),
      ],
      ['every deck Flat', applyDeckShape(doc, { shape: 'flat' }, { station: mid, all: true })],
      [
        'one Domed deck between drawn ones',
        applyDeckShape(doc, { shape: 'domed' }, { station: mid, all: false }),
      ],
    ];
    const rows = cases.map(([label, d]) => {
      const was = insertCost(d, addStation);
      const now = insertCost(d, insertStation);
      return `${label}: addStation ${was.worst.toFixed(2)} mm (${was.where}), insertStation ${now.worst.toFixed(2)} mm (${now.where})`;
    });
    console.log(`station insert with deck shapes, ${name}\n  ${rows.join('\n  ')}`);
  });
});

/**
 * The board with every station's deck a dome that ends `height` cm above the bottom's end at the wall (held to the
 * steepest slope a dome may have): how thin a rail at the wall the engine builds. Stations with no width or
 * thickness keep their curves.
 */
function wallBoard(doc: RailsBoard, height: number): RailsBoard {
  const sides = (['plus', 'minus'] as const).filter((s) => s === 'plus' || doc.outline.minus);
  const entries = sides.map((s) => stationSplines(doc, s));
  return {
    ...doc,
    stations: doc.stations.map((st, i) => {
      const next = { ...st };
      sides.forEach((s, k) => {
        const e = entries[k]![i]!;
        const curves = s === 'minus' ? st.minus : st.plus;
        if (!(e.w > 0 && e.T > 0) || curves === undefined) return;
        const bottomEnd = e.bottom.knots[e.bottom.knots.length - 1]!.end.y;
        const fall = Math.min(e.T - bottomEnd - height, (e.w * WALL_SLOPE_MAX) / 2);
        if (!(fall > 0)) return;
        next[s] = { ...curves, deck: splineToCurve(domedSpline(e.w, e.T, fall), e.w, e.T) };
      });
      return next;
    }),
  };
}

study('how thin the rail at the wall may be for the engine', () => {
  it.each(everyBoard)('on the %s board', { timeout: 120_000 }, (name, make) => {
    const doc = make();
    const rows = [0.1, 0.01, 0.002, 0].map((h) => {
      const board = wallBoard(doc, h);
      const draft = closedVerdict(board, true);
      const view = closedVerdict(board, false);
      expect(draft.ok && view.ok, `${name} at ${h} cm: ${draft.why} ${view.why}`).toBe(true);
      return `${h} cm: draft ${draft.ok ? 'closed' : draft.why}, view ${view.ok ? 'closed' : view.why}`;
    });
    console.log(`deck end above the bottom's end at the wall, ${name}\n  ${rows.join('\n  ')}`);
  });
});
