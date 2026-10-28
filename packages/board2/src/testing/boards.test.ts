// SPDX-License-Identifier: GPL-3.0-or-later
/** The test boards themselves: a knot marked smooth really is G1. */
import { describe, expect, it } from 'vitest';
import type { BoardDoc, Chain } from '../types';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from './boards';

/** Angle (rad) between the handles of every interior knot marked smooth, with where it is. */
function smoothKinks(c: Chain, what: string): { what: string; knot: number; angle: number }[] {
  const out: { what: string; knot: number; angle: number }[] = [];
  c.knots.forEach((k, i) => {
    if (i === 0 || i === c.knots.length - 1 || !k.smooth) return;
    const a = [k.p[0] - k.in[0], k.p[1] - k.in[1]];
    const b = [k.out[0] - k.p[0], k.out[1] - k.p[1]];
    if (Math.hypot(a[0]!, a[1]!) === 0 || Math.hypot(b[0]!, b[1]!) === 0) return;
    const angle = Math.abs(
      Math.atan2(a[0]! * b[1]! - a[1]! * b[0]!, a[0]! * b[0]! + a[1]! * b[1]!),
    );
    out.push({ what, knot: i, angle });
  });
  return out;
}

function allChains(d: BoardDoc): [string, Chain][] {
  const list: [string, Chain][] = [
    ['outline plus', d.outline.plus],
    ['rocker', d.rocker],
    ['deck', d.deck],
  ];
  if (d.outline.minus !== undefined) list.push(['outline minus', d.outline.minus]);
  for (const s of d.stations) {
    list.push([`section ${s.id} plus`, s.plus.chain]);
    if (s.minus !== undefined) list.push([`section ${s.id} minus`, s.minus.chain]);
  }
  return list;
}

describe('the test boards', () => {
  it.each([
    ['swallow', swallowBoard],
    ['fish', fishBoard],
    ['asymmetric', asymmetricBoard],
    ['analytic', analyticBoard],
  ] as const)('%s: every knot marked smooth has collinear handles (G1)', (_n, make) => {
    for (const [what, c] of allChains(make())) {
      for (const k of smoothKinks(c, what)) {
        expect(k.angle, `${k.what} knot ${k.knot}`).toBeLessThan(1e-9);
      }
    }
  });
});
