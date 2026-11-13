// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails projection: lines as the section store makes them, station curves in the engine's own
 * frame (half width with a notch filled in, thickness), closed sections from slices or stand-ins,
 * the index conversions, and the sharing of unchanged pieces between documents.
 */
import type { RailsBoard } from '@openshaper/board2';
import { convertSections, halfWidthRails } from '@openshaper/board2';
import { asymmetricBoard, fishBoard, swallowBoard } from '@openshaper/board2/testing';
import { describe, expect, it } from 'vitest';
import { goldenDoc } from '../sections/test-support/docs';
import { chainToSpline, deckToSpline } from '../sections/project';
import { halfWidthFn, thicknessAt } from './measure';
import {
  curveToSpline,
  polylineSpline,
  projectRails,
  splineToCurve,
  standInSection,
} from './project';
import { railsBoards } from './test-support/boards';
import { sliceOfStation, stationOfSlice } from './types';

/** The engine's own reading of each station (the converter's report), per side. */
const reports = [
  ['mirror', () => goldenDoc('shortboard')],
  ['asymmetric', asymmetricBoard],
  ['swallow', swallowBoard],
  ['fish', fishBoard],
] as const;

describe.each(reports)('the projection of the %s board', (_name, make) => {
  const r = convertSections(make());
  if (!r.ok) throw new Error('conversion failed');
  const doc = r.value.board;
  const p = projectRails(doc);

  it('reads every station in the engine frame: half width and thickness within 1e-9 cm', () => {
    for (const st of r.value.report.stations) {
      const i = doc.stations.findIndex((s) => s.id === st.id);
      const half = st.side === 'minus' ? p.minus! : p;
      const e = half.stationCurves[i]!;
      expect(Math.abs(e.w - st.halfWidth)).toBeLessThan(1e-9);
      expect(Math.abs(e.T - st.thickness)).toBeLessThan(1e-9);
      const w = halfWidthRails(doc, st.side === 'minus' ? 'minus' : undefined)(st.x);
      expect(Math.abs(e.w - w)).toBeLessThan(1e-9);
    }
  });

  it('scales each station curve by that half width and thickness', () => {
    doc.stations.forEach((st, i) => {
      for (const side of doc.outline.minus ? (['plus', 'minus'] as const) : (['plus'] as const)) {
        const e = (side === 'minus' ? p.minus! : p).stationCurves[i]!;
        const curves = side === 'minus' ? st.minus! : st.plus;
        for (const [spline, chain] of [
          [e.bottom, curves.bottom],
          [e.deck, curves.deck],
        ] as const) {
          chain.knots.forEach((k, j) => {
            const s = spline.knots[j]!;
            expect(Math.abs(s.end.x - k.p[0] * e.w)).toBeLessThan(1e-9);
            expect(Math.abs(s.end.y - k.p[1] * e.T)).toBeLessThan(1e-9);
            expect(Math.abs(s.tangentToNext.x - k.out[0] * e.w)).toBeLessThan(1e-9);
            expect(Math.abs(s.tangentToPrev.y - k.in[1] * e.T)).toBeLessThan(1e-9);
          });
        }
      }
    });
  });

  it('has the lines of the section projection, and classic end slices around the stations', () => {
    expect(p.outline).toBe(chainToSpline(doc.outline.plus));
    expect(p.bottom).toBe(chainToSpline(doc.rocker));
    expect(p.deck).toBe(deckToSpline(doc.deck, doc.rocker, doc.outline.plus.knots.at(-1)!.p[0]));
    expect(p.crossSections).toHaveLength(doc.stations.length + 2);
    doc.stations.forEach((st, i) => {
      expect(p.crossSections[sliceOfStation(i)]!.position).toBe(st.x);
    });
    expect(p.crossSections[0]!.spline.knots).toHaveLength(1);
    expect(p.crossSections.at(-1)!.spline.knots).toHaveLength(1);
    expect(p.minus !== undefined).toBe(doc.outline.minus !== undefined);
  });
});

describe('index conversions', () => {
  it('map slices to stations and back, with the end slices to null', () => {
    expect(stationOfSlice(0, 4)).toBeNull();
    expect(stationOfSlice(5, 4)).toBeNull();
    expect(stationOfSlice(1.5, 4)).toBeNull();
    for (let i = 0; i < 4; i++) expect(stationOfSlice(sliceOfStation(i), 4)).toBe(i);
  });
});

describe('the store-side half width', () => {
  it.each(railsBoards)('agrees with the engine along the whole %s board', (_n, make) => {
    const doc = make();
    const L = doc.outline.plus.knots.at(-1)!.p[0];
    for (const side of [undefined, 'minus'] as const) {
      const ours = halfWidthFn(doc.outline, side);
      const theirs = halfWidthRails(doc, side);
      for (let i = 0; i <= 200; i++) {
        const x = (L * i) / 200;
        expect(Math.abs(ours(x) - theirs(x))).toBeLessThan(1e-9);
      }
    }
  });

  it('gives the thickness as deck over rocker', () => {
    const doc = railsBoards[0]![1]();
    const x = doc.stations[1]!.x;
    expect(thicknessAt(doc.rocker, doc.deck, x)).toBeCloseTo(
      projectRails(doc).stationCurves[1]!.T,
      12,
    );
  });
});

describe('closed sections', () => {
  const doc = railsBoards[0]![1]();
  const p = projectRails(doc);

  it('stand in for a missing slice: bottom, a wall at the half width, deck back to the stringer', () => {
    const e = p.stationCurves[1]!;
    const s = standInSection(e);
    expect(p.crossSections[2]!.spline).toBe(s);
    const k = s.knots;
    expect(k[0]!.end).toEqual(e.bottom.knots[0]!.end);
    expect(k.at(-1)!.end).toEqual(e.deck.knots[0]!.end);
    const bEnd = e.bottom.knots.at(-1)!.end;
    const dEnd = e.deck.knots.at(-1)!.end;
    const nb = e.bottom.knots.length;
    expect(k[nb - 1]!.end).toEqual(bEnd);
    expect(k[nb]!.end).toEqual(dEnd);
    expect(bEnd.x).toBe(e.w);
    expect(dEnd.x).toBe(e.w);
    expect(k).toHaveLength(nb + e.deck.knots.length);
  });

  it('draw a slice as straight segments, for the station it is keyed to only', () => {
    const id = doc.stations[2]!.id;
    const flat = [0, 0, 5, 0.2, 8, 3, 0, 6];
    const q = projectRails(doc, { [id]: { plus: flat } });
    const s = q.crossSections[sliceOfStation(2)]!.spline;
    expect(s).toBe(polylineSpline(flat));
    expect(s.knots.map((k) => [k.end.x, k.end.y])).toEqual([
      [0, 0],
      [5, 0.2],
      [8, 3],
      [0, 6],
    ]);
    expect(s.knots[1]!.tangentToNext.x).toBeCloseTo(5 + 3 / 3, 12);
    expect(s.knots.every((k) => !k.continuous)).toBe(true);
    // every other station still stands in, and the station curves are the same objects
    expect(q.crossSections[1]!.spline).toBe(p.crossSections[1]!.spline);
    expect(q.stationCurves).toBe(p.stationCurves);
    expect(polylineSpline([1, 1])).toBeNull();
  });
});

describe('memoising and sharing', () => {
  const doc = railsBoards[0]![1]();

  it('is one board per document and slices', () => {
    expect(projectRails(doc)).toBe(projectRails(doc, null));
  });

  it('shares every unchanged piece with the projection of an edited document', () => {
    const st = doc.stations[1]!;
    const edited: RailsBoard = {
      ...doc,
      stations: doc.stations.map((s) =>
        s === st ? { ...s, plus: { ...s.plus, deck: { knots: [...s.plus.deck.knots] } } } : s,
      ),
    };
    const a = projectRails(doc);
    const b = projectRails(edited);
    expect(b.outline).toBe(a.outline);
    expect(b.bottom).toBe(a.bottom);
    expect(b.deck).toBe(a.deck);
    expect(b.stationCurves[0]).toBe(a.stationCurves[0]);
    expect(b.stationCurves[1]!.bottom).toBe(a.stationCurves[1]!.bottom);
    expect(b.stationCurves[1]!.deck).not.toBe(a.stationCurves[1]!.deck);
    expect(b.crossSections[1]!.spline).toBe(a.crossSections[1]!.spline);
  });

  it('turns a curve to cm and back exactly', () => {
    const e = projectRails(doc).stationCurves[2]!;
    const chain = doc.stations[2]!.plus.bottom;
    const back = splineToCurve(curveToSpline(chain, e.w, e.T), e.w, e.T);
    back.knots.forEach((k, i) => {
      const o = chain.knots[i]!;
      expect(k.p[0]).toBeCloseTo(o.p[0], 12);
      expect(k.p[1]).toBeCloseTo(o.p[1], 12);
      expect(k.smooth).toBe(o.smooth);
    });
    expect(back.knots[0]!.p).toEqual([0, 0]);
    expect(back.knots.at(-1)!.p[0]).toBe(1);
  });
});
