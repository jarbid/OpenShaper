// SPDX-License-Identifier: GPL-3.0-or-later
/** The Deck slice's geometry: the fit, the paths, where the crown handle stands and what a pointer means. */
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { bandEdge, domeFall, domedSpline, flatSpline, heightAt } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import {
  SLICE_MARGIN,
  crownAtPointer,
  crownMark,
  deckPaths,
  fitStation,
  flattenSpline,
  grabOf,
} from './deck-slice';
import { toScreen } from './rail-slice';

const BOX = { width: 800, height: 240 };
const W = 22;
const T = 5.5;

describe('the fit', () => {
  it('uses one scale for both axes, so the section has the board’s proportions', () => {
    const f = fitStation([W, W], T, 0, BOX)!;
    const wide = toScreen(f, W, 0, 'right').x - toScreen(f, W, 0, 'left').x;
    const tall = toScreen(f, 0, 0, 'right').y - toScreen(f, 0, T, 'right').y;
    expect(wide / tall).toBeCloseTo((2 * W) / T, 9);
  });

  it('keeps the margins, fitted by the height of a wide box and by the width of a tall one', () => {
    const f = fitStation([W, W], T, 0, { width: 1800, height: 240 })!;
    expect(f.scale).toBeCloseTo((240 - SLICE_MARGIN.top - SLICE_MARGIN.bottom) / T, 9);
    const narrow = fitStation([W, W], T, 0, { width: 200, height: 600 })!;
    expect(narrow.scale).toBeCloseTo((200 - 2 * SLICE_MARGIN.x) / (2 * W), 9);
  });

  it('is the same wherever the deck curve is, so a drag does not move the drawing under the pointer', () => {
    expect(fitStation([W, W], T, 0, BOX)).toEqual(fitStation([W, W], T, 0, BOX));
  });

  it('holds both halves of an asymmetric station, the wider setting the scale', () => {
    const a = fitStation([20, 25], T, 0, { width: 300, height: 600 })!;
    expect(a.scale).toBeCloseTo((300 - 2 * SLICE_MARGIN.x) / 50, 9);
  });

  it('is null with no room or nothing to fit', () => {
    expect(fitStation([W], T, 0, { width: 10, height: 10 })).toBeNull();
    expect(fitStation([], T, 0, BOX)).toBeNull();
    expect(fitStation([0], T, 0, BOX)).toBeNull();
  });
});

describe('the paths', () => {
  const f = fitStation([W, W], T, 0, BOX)!;
  const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const first = (d: string) => nums(d).slice(0, 2);
  const last = (d: string) => nums(d).slice(-2);

  it('draws the deck solid to the band edge and dashed from there to the wall, as one curve', () => {
    const spline = domedSpline(W, T, 3);
    const edge = bandEdge(W, 2);
    const { visible, hidden } = deckPaths(spline, edge, f, 'left');
    const at = toScreen(f, edge, heightAt(spline, edge), 'left');
    // the solid part ends where the dashed one begins, on the crown handle's place
    expect(last(visible)[0]).toBeCloseTo(at.x, 1);
    expect(last(visible)[1]).toBeCloseTo(at.y, 1);
    expect(first(hidden)[0]).toBeCloseTo(at.x, 1);
    expect(first(hidden)[1]).toBeCloseTo(at.y, 1);
    // it starts at the stringer and ends at the wall
    const stringer = toScreen(f, 0, T, 'left');
    expect(first(visible)[0]).toBeCloseTo(stringer.x, 1);
    const wall = toScreen(f, W, heightAt(spline, W), 'left');
    expect(last(hidden)[0]).toBeCloseTo(wall.x, 1);
    expect(last(hidden)[1]).toBeCloseTo(wall.y, 1);
  });

  it('has no dashed part where the deck ends at the band edge', () => {
    expect(deckPaths(flatSpline(W, T), W, f, 'left').hidden).toBe('');
  });

  it('draws the plus side on the left of the stringer and the minus side on the right', () => {
    const left = deckPaths(flatSpline(W, T), bandEdge(W, 2), f, 'left');
    const right = deckPaths(flatSpline(W, T), bandEdge(W, 2), f, 'right');
    expect(last(left.hidden)[0]).toBeLessThan(f.cx);
    expect(last(right.hidden)[0]).toBeGreaterThan(f.cx);
  });

  it('draws a curve with its own corners no sharper than a gentle arc: a point every few pixels', () => {
    const { visible } = deckPaths(domedSpline(W, T, 3), bandEdge(W, 2), f, 'left');
    expect(visible.match(/L/g)!.length).toBeGreaterThan(20);
  });

  it('flattens a curve to its samples, and a polyline to its knots', () => {
    const arc = flattenSpline(domedSpline(W, T, 3));
    expect(arc.length).toBe(2 * 13);
    expect(arc.slice(0, 2)).toEqual([0, T]);
    expect(flattenSpline(domedSpline(W, T, 3), 4)).toHaveLength(2 * 5);
    const poly = splineFromKnots(
      Array.from({ length: 30 }, (_, i) =>
        knot(vec2(i, i * 0.1), vec2(i, i * 0.1), vec2(i, i * 0.1)),
      ),
    );
    expect(flattenSpline(poly)).toHaveLength(60);
  });
});

describe('the crown handle', () => {
  const f = fitStation([W, W], T, 0, BOX)!;

  it('stands on the deck curve at the band edge, with the stringer’s height above it', () => {
    const fall = 3;
    const m = crownMark(f, domedSpline(W, T, fall), W, T, 2, 'left');
    const edge = bandEdge(W, 2);
    expect(m.crown).toBeCloseTo(domeFall(fall, W, edge), 9);
    expect(m.handle.x).toBeCloseTo(toScreen(f, edge, 0, 'left').x, 6);
    expect(m.top.x).toBeCloseTo(m.handle.x, 6);
    expect(m.handle.y - m.top.y).toBeCloseTo(m.crown * f.scale, 6);
  });

  it('stands on the stringer’s height on a flat deck, a crown of nothing', () => {
    const m = crownMark(f, flatSpline(W, T), W, T, 2, 'left');
    expect(m.crown).toBeCloseTo(0, 12);
    expect(m.handle.y).toBeCloseTo(m.top.y, 9);
  });

  it('is the crown a pointer at the handle’s height means, and a grab does not move it', () => {
    const m = crownMark(f, domedSpline(W, T, 3), W, T, 2, 'left');
    expect(crownAtPointer(f, T, m.handle.y)).toBeCloseTo(m.crown, 9);
    // taken 5 px above its centre: the pointer there still means the same crown
    const grab = grabOf(m.handle.y, m.handle.y - 5);
    expect(crownAtPointer(f, T, m.handle.y - 5, grab)).toBeCloseTo(m.crown, 9);
    // 10 px lower is a deeper crown by 10 px of the scale
    expect(crownAtPointer(f, T, m.handle.y + 10) - m.crown).toBeCloseTo(10 / f.scale, 9);
  });
});
