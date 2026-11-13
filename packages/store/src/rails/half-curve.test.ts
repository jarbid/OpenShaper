// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The half-curve rules (`half-curve.ts`): for random drags of every knot and handle of every
 * station curve of several boards, and for random inserts and deletes, the held curve obeys all
 * five rules; an edit inside the rules passes through untouched; an edit the rules take back
 * entirely gives back the curve as it was.
 */
import { vec2, type Spline } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  canDeleteKnot,
  deleteKnot,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  type StationSplines,
} from '../edits';
import { constrainHalfCurve, halfCurveFrame, obeysHalfCurveRules } from './half-curve';
import { projectRails } from './project';
import { railsBoards } from './test-support/boards';

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const curvesOf = (e: StationSplines) =>
  [
    ['bottom', e.bottom],
    ['deck', e.deck],
  ] as const;

describe.each(railsBoards)('the half-curve rules on the %s board', (_name, make) => {
  const doc = make();
  const p = projectRails(doc);
  const halves = p.minus ? [p, p.minus] : [p];

  it('hold every random drag of every knot and handle to all five rules', () => {
    const random = rng(7);
    let edits = 0;
    for (const half of halves) {
      for (const e of half.stationCurves) {
        if (!(e.w > 0 && e.T > 0)) continue;
        for (const [curve, prev] of curvesOf(e)) {
          const frame = halfCurveFrame(e, curve);
          for (let i = 0; i < prev.knots.length; i++) {
            for (let trial = 0; trial < 6; trial++) {
              const k = prev.knots[i]!;
              const d = () => (random() - 0.5) * 2 * (trial < 3 ? 0.3 * e.w : 1.5 * e.w);
              const edits3: Spline[] = [
                moveKnotEnd(prev, i, vec2(k.end.x + d(), k.end.y + d() * 0.2)),
                moveKnotTangent(
                  prev,
                  i,
                  'prev',
                  vec2(k.tangentToPrev.x + d(), k.tangentToPrev.y + d()),
                ),
                moveKnotTangent(
                  prev,
                  i,
                  'next',
                  vec2(k.tangentToNext.x + d(), k.tangentToNext.y + d()),
                ),
              ];
              for (const next of edits3) {
                const held = constrainHalfCurve(prev, next, frame);
                expect(obeysHalfCurveRules(held, frame)).toBe(true);
                edits++;
              }
            }
          }
          // inserts anywhere along the curve, and deletes of every knot that may go
          for (let trial = 0; trial < 4; trial++) {
            const at = vec2(random() * e.w, frame.curve === 'bottom' ? 0 : e.T);
            const ins = insertKnotAt(prev, at);
            if (ins) {
              expect(obeysHalfCurveRules(constrainHalfCurve(prev, ins.spline, frame), frame)).toBe(
                true,
              );
            }
          }
          for (let i = 0; i < prev.knots.length; i++) {
            if (!canDeleteKnot(prev, i)) continue;
            const del = constrainHalfCurve(prev, deleteKnot(prev, i), frame);
            expect(obeysHalfCurveRules(del, frame)).toBe(true);
          }
        }
      }
    }
    expect(edits).toBeGreaterThan(100);
  });

  it('keep the ends: the first and last knot cannot be deleted, a curve keeps two knots', () => {
    const e = p.stationCurves[1]!;
    for (const [, s] of curvesOf(e)) {
      expect(canDeleteKnot(s, 0)).toBe(false);
      expect(canDeleteKnot(s, s.knots.length - 1)).toBe(false);
    }
    const two = { ...e.bottom, knots: [e.bottom.knots[0]!, e.bottom.knots.at(-1)!] };
    expect(canDeleteKnot(two as Spline, 1)).toBe(false);
  });
});

describe('the half-curve rules, one by one', () => {
  const doc = railsBoards[0]![1]();
  const e = projectRails(doc).stationCurves[2]!;
  const bottom = halfCurveFrame(e, 'bottom');
  const deck = halfCurveFrame(e, 'deck');
  const ok = (s: Spline) => obeysHalfCurveRules(s, bottom);

  it('the converted curves obey them already, and an edit inside them passes through', () => {
    expect(ok(e.bottom)).toBe(true);
    expect(obeysHalfCurveRules(e.deck, deck)).toBe(true);
    const k = e.bottom.knots[1]!;
    const next = moveKnotEnd(e.bottom, 1, vec2(k.end.x, k.end.y + 0.05));
    expect(constrainHalfCurve(e.bottom, next, bottom)).toBe(next);
  });

  it('holds the first knot on the stringer: a drag of it alone gives back the curve itself', () => {
    const next = moveKnotEnd(e.bottom, 0, vec2(3, -1));
    expect(constrainHalfCurve(e.bottom, next, bottom)).toBe(e.bottom);
  });

  it('keeps the curve flat at the stringer', () => {
    const k = e.bottom.knots[0]!;
    const next = moveKnotTangent(e.bottom, 0, 'next', vec2(k.tangentToNext.x, 1));
    const held = constrainHalfCurve(e.bottom, next, bottom);
    expect(held.knots[0]!.tangentToNext.y).toBe(0);
  });

  it('holds the last knot on the wall, and the deck end above the bottom end', () => {
    const n = e.deck.knots.length - 1;
    const low = bottom.otherEnd - 5;
    const next = moveKnotEnd(e.deck, n, vec2(e.w + 2, e.bottom.knots.at(-1)!.end.y - 1));
    const held = constrainHalfCurve(e.deck, next, deck);
    expect(held.knots[n]!.end.x).toBe(e.w);
    expect(held.knots[n]!.end.y).toBe(e.bottom.knots.at(-1)!.end.y);
    const nb = e.bottom.knots.length - 1;
    const up = moveKnotEnd(e.bottom, nb, vec2(e.w, bottom.otherEnd + 3));
    expect(constrainHalfCurve(e.bottom, up, bottom).knots[nb]!.end.y).toBe(bottom.otherEnd);
    expect(low).toBeLessThan(bottom.otherEnd);
  });

  it('holds a knot dragged past its neighbour just short of it, with its handles', () => {
    const s = e.bottom;
    expect(s.knots.length).toBeGreaterThan(2);
    const k = s.knots[1]!;
    const right = s.knots[2]!.end.x;
    const next = moveKnotEnd(s, 1, vec2(right + 5, k.end.y));
    const held = constrainHalfCurve(s, next, bottom);
    expect(held.knots[1]!.end.x).toBeLessThan(right);
    expect(held.knots[1]!.end.x).toBeGreaterThan(right - 0.01);
    expect(held.knots[2]!.end).toEqual(s.knots[2]!.end);
    expect(ok(held)).toBe(true);
  });
});
