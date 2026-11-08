// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generality and the editing frame (`docs/design/tail-model.md`):
 *
 * - a **wing** (a corner knot in the outline, where the rail steps in) and a **bat tail**
 *   (a shallow notch plus two wings) on today's model, with no new machinery: validate,
 *   build, mesh and export;
 * - the **chord tilt at each station** of a notched board, which is what "a station inside
 *   the zone edits in a different frame" amounts to numerically.
 *
 *   TAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/tailproto/generality.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import { compileChain } from '../chain';
import { frameAt, makeFrame } from '../frame';
import { hasErrors } from '../issues';
import { meshBoard } from '../mesh';
import { boardSolid } from '../step';
import { buildBoard } from '../surface';
import { fishBoard, swallowBoard } from '../testing';
import { validateBoard } from '../validate';
import type { BoardDoc, Chain, ChainKnot } from '../types';
import { boardSet } from '../test-support/board-set';
import { foldAt } from './fold';
import { smoothMapFactory } from './maps';
import { MIN_CHORD_ANGLE } from '../params';

const corner = (p: [number, number], inn: [number, number], out: [number, number]): ChainKnot => ({
  p,
  in: inn,
  out,
  smooth: false,
});

/** A wing: a corner knot where the rail steps in, inserted into an outline before `beforeX`. */
function withWing(outline: Chain, at: number, step: number, y: number): Chain {
  const knots = [...outline.knots];
  const i = knots.findIndex((k) => k.p[0] > at);
  const wing = corner([at, y], [at - 4, y + step], [at + 1, y - step * 0.15]);
  knots.splice(i, 0, wing);
  return { knots };
}

/** A squash tail with two wings, no notch: the wing needs nothing but a corner knot. */
function wingBoard(): BoardDoc {
  const base = swallowBoard();
  const plus: Chain = {
    knots: [
      { p: [0, 0], in: [0, 0], out: [0, 6.5], smooth: false },
      corner([0, 10.5], [0, 8.4], [2.2, 13.2]),
      corner([18, 17.4], [9, 15.6], [19.5, 17.9]),
      corner([19.5, 19.4], [19.5, 18.6], [26, 20.1]),
      { p: [95, 23.6], in: [70, 23.8], out: [120, 23.4], smooth: true },
      { p: [155, 17.5], in: [140, 21.5], out: [165, 13.5], smooth: true },
      { p: [185, 0], in: [185, 8], out: [185, 0], smooth: false },
    ],
  };
  return {
    ...base,
    meta: { ...base.meta, name: 'winger' },
    tail: { kind: 'standard' },
    outline: { plus },
    stations: [{ ...base.stations[0]!, x: 0 }, ...base.stations.filter((st) => st.x >= 24)],
  };
}

/** The swallow's outline with a shallow notch and two wings: a bat tail. */
function batTail(zone: number, auto: boolean): BoardDoc {
  const base = swallowBoard();
  const plus: Chain = {
    knots: [
      { p: [5, 0], in: [5, 0], out: [3.2, 1.6], smooth: false },
      { p: [0, 10.5], in: [0.8, 9.2], out: [2.2, 13.2], smooth: false },
      corner([18, 17.4], [9, 15.6], [19.5, 17.9]),
      corner([19.5, 19.4], [19.5, 18.6], [26, 20.1]),
      { p: [95, 23.6], in: [70, 23.8], out: [120, 23.4], smooth: true },
      { p: [155, 17.5], in: [140, 21.5], out: [165, 13.5], smooth: true },
      { p: [185, 0], in: [185, 8], out: [185, 0], smooth: false },
    ],
  };
  return {
    ...base,
    meta: { ...base.meta, name: 'bat tail' },
    tail: auto ? { kind: 'notched', zone, auto: true } : { kind: 'notched', zone },
    outline: { plus },
    stations: base.stations.filter((s) => s.x >= 5),
  };
}

function report(name: string, doc: BoardDoc, step: boolean, smooth = false): string {
  const v = validateBoard(doc);
  if (hasErrors(v) && !smooth)
    return `${name} | REFUSED: ${v.map((i) => `${i.code}: ${i.message}`).join('; ')}`;
  const r = buildBoard(
    doc,
    smooth ? { check: false, chordMap: smoothMapFactory(MIN_CHORD_ANGLE) } : {},
  );
  if (!r.ok) return `${name} | BUILD FAILED: ${r.issues.map((i) => i.message).join('; ')}`;
  const built = r.value;
  const t0 = performance.now();
  const mesh = meshBoard(built);
  const ms = performance.now() - t0;
  const warn = r.issues.map((i) => i.code).join(',') || 'none';
  let stepPart = '';
  if (step) {
    const solid = boardSolid(built);
    const f = foldAt(built, solid, 0, 0.001, 0.999);
    stepPart = ` | STEP dev ${(10 * solid.report.deviation).toFixed(2)} mm, fold ${f.worst.toFixed(3)} deg, ${solid.report.tail}/${solid.report.nose}`;
  }
  return `${name} | built, tail ${built.doc.tail.kind}${built.doc.tail.kind === 'notched' ? ` zone ${built.doc.tail.zone.toFixed(1)}` : ''} | fit ${built.report.stationFitError.toFixed(4)} cm | verts ${mesh.positions.length / 3} | mesh ${ms.toFixed(0)} ms | warnings ${warn}${stepPart}`;
}

// Study runs only on demand: TAIL_STUDY=1 keeps it out of the package's suite.
const study = describe.skipIf(process.env.TAIL_STUDY !== '1');

study('tail model: generality and the editing frame', () => {
  it('a wing and a bat tail need no new machinery', () => {
    const rows = [
      report('winger (squash tail + two wings, no notch)', wingBoard(), true),
      report('swallow + wing at x = 60', { ...swallowBoard(), outline: { plus: withWing(swallowBoard().outline.plus, 60, 1.2, 21.6) } }, false), // prettier-ignore
      ...[0, 10, 15, 20, 30].map((z) =>
        report(
          `bat tail (notch depth 5, zone ${z === 0 ? 'auto' : z})`,
          batTail(z || 10, z === 0),
          true,
        ),
      ),
      ...[10, 20, 30].map((z) =>
        report(`bat tail [D] (notch depth 5, lambda >= ${z})`, batTail(z, false), true, true),
      ),
    ];
    for (const r of rows) console.log(r);
    console.log('\n[J] generality\n' + rows.join('\n'));
    expect(rows.every((r) => r.includes('built'))).toBe(true);
  }, 900_000);

  it('the chord tilt at each station', () => {
    const rows: string[] = [];
    for (const { name, doc } of [
      { name: 'swallow', doc: swallowBoard() },
      { name: 'fish', doc: fishBoard() },
      { name: 'shortboard', doc: boardSet().find((b) => b.name === 'shortboard')!.doc },
    ]) {
      const chain = compileChain(doc.outline.plus);
      const f = makeFrame(chain, doc.tail);
      const p = new Float64Array(6);
      const zone = doc.tail.kind === 'notched' ? doc.tail.zone : 0;
      const d = doc.tail.kind === 'notched' ? chain.c[0]! : 0;
      const tilts = doc.stations.map((st) => {
        frameAt(f, st.x, p);
        const dx = p[0]! - st.x;
        const dy = p[1]!;
        const t =
          (Math.abs(Math.atan2(dx, Math.max(Math.abs(dy), Number.EPSILON))) * 180) / Math.PI;
        const inZone = st.x < d + zone;
        return `${st.x.toFixed(0)}${inZone ? '*' : ''}:${t.toFixed(0)}`;
      });
      rows.push(
        `${name} | zone [${d.toFixed(1)}, ${(d + zone).toFixed(1)}] | station x:tilt deg (* = in the fan) ${tilts.join(' ')}`,
      );
      console.log(rows[rows.length - 1]);
    }
    console.log('\n[K] chord tilt at the stations\n' + rows.join('\n'));
    expect(rows.length).toBe(3);
  });
});
