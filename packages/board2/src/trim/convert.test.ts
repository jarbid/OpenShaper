// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `convertSections` on the made boards: the stations come out as they went in, each curve is the
 * stored section's own chain to the panel's end and a straight line on to the wall, a rail key
 * stands at every usable station and none at a tip, and the converted station lofts back to the
 * stored section, with the rail the kernel builds from its key standing off it by the fit's gap.
 */
import { describe, expect, it } from 'vitest';
import { chainEval, chainParamAtX, chainXRange, compileChain, funcEval } from '../chain';
import { TRIM } from '../params';
import type { BoardDoc, Chain, ChainKnot } from '../types';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import { convertCache, convertSections, outlineCos, physicalHalf, sectionHalves } from './convert';
import type { ConvertCache, ConvertReport } from './convert';
import type { RailsBoard } from './board';
import { buildLoft, loftAt } from './loft';
import { filledOutline, halfWidthOf } from './outline';
import { recipeGap, sectionRail } from './station';

const BOARDS: { readonly [name: string]: () => BoardDoc } = {
  analytic: analyticBoard,
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
};

/** Grid cells across u of the test's lofts: 0.05 cm or finer on these boards. */
const LOFT_SAMPLES = 600;
/** Lofted height against the stored section, and recipeGap against the fit's gap, cm. */
const HEIGHT_TOL = 0.002;
const GAP_TOL = 0.002;
/** Points along u at which a station's lofted height is checked, inboard of the panel's end. */
const CHECKS = 300;
/** Grid cells kept clear of the panel's end, where the loft's cubic across u spans the cut. */
const CLEAR_CELLS = 2;

function converted(doc: BoardDoc): { board: RailsBoard; report: ConvertReport } {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

const sides = (doc: BoardDoc): ('plus' | 'minus')[] =>
  doc.symmetry === 'asymmetric' ? ['plus', 'minus'] : ['plus'];

const thickness = (doc: BoardDoc, x: number): number => {
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  funcEval(compileChain(doc.rocker), x, r, 0);
  funcEval(compileChain(doc.deck), x, d, 0);
  return d[0]! - r[0]!;
};

/** v of a half chain (stringer to apex) at u. */
function vAt(half: Chain, u: number): number {
  const ch = compileChain(half);
  const out = new Float64Array(2);
  chainEval(ch, chainParamAtX(ch, u, 0, ch.segments), 0, out, 0);
  return out[1]!;
}

const worst = { height: 0, gap: 0 };

describe('convertSections', () => {
  for (const [name, make] of Object.entries(BOARDS)) {
    describe(name, () => {
      const doc = make();
      const { board, report } = converted(doc);

      it('keeps the stations, ids and x, and the document parts carried over', () => {
        expect(board.model).toBe('rails');
        expect(board.stations.map((s) => [s.id, s.x])).toEqual(
          doc.stations.map((s) => [s.id, s.x]),
        );
        expect(board.outline).toBe(doc.outline);
        expect(board.rocker).toBe(doc.rocker);
        expect(board.deck).toBe(doc.deck);
        expect(board.features).toBe(doc.features);
        expect(board.symmetry).toBe(doc.symmetry);
        const asym = doc.symmetry === 'asymmetric';
        expect(board.rails.minus !== undefined).toBe(asym);
        expect(board.stations.every((s) => (s.minus !== undefined) === asym)).toBe(true);
        expect(board.corners.minus !== undefined).toBe(doc.outline.minus !== undefined);
      });

      for (const side of sides(doc)) {
        const wOf = halfWidthOf(doc.outline, side === 'minus' ? 'minus' : undefined);
        const rows = report.stations.filter((s) => s.side === side);
        const keys = board.rails[side]!;

        it(`${side}: one rail key at each usable station, none at a tip`, () => {
          expect(rows.length).toBe(doc.stations.length);
          const usable = doc.stations.filter(
            (st) => thickness(doc, st.x) >= 0.6 && wOf(st.x) >= 2.5,
          );
          expect(rows.filter((r) => !r.tip).map((r) => r.x)).toEqual(usable.map((s) => s.x));
          expect(keys.map((k) => k.x)).toEqual(usable.map((s) => s.x));
          expect(report.tips.filter((t) => t.side === side).map((t) => t.x)).toEqual(
            rows.filter((r) => r.tip).map((r) => r.x),
          );
        });

        it(`${side}: each curve is the stored section to the panel's end, then straight to the wall`, () => {
          doc.stations.forEach((st, i) => {
            const halves = sectionHalves(side === 'minus' ? st.minus! : st.plus);
            const curves = board.stations[i]![side]!;
            const row = rows[i]!;
            for (const part of ['bottom', 'deck'] as const) {
              const curve = curves[part];
              const stored = halves[part];
              const ks = curve.knots;
              const n = ks.length;
              // ends at u = 0 and u = 1 exactly; u never decreases
              expect(ks[0]!.p[0]).toBe(0);
              expect(ks[n - 1]!.p[0]).toBe(1);
              const ch = compileChain(curve);
              const pt = new Float64Array(2);
              let last = -Infinity;
              for (let j = 0; j <= 200 * ch.segments; j++) {
                chainEval(ch, j / 200, 0, pt, 0);
                expect(pt[0]!).toBeGreaterThanOrEqual(last);
                last = pt[0]!;
              }
              // the designer's knots up to the split, bit for bit
              const split = n - 2;
              const same = (a: ChainKnot, b: ChainKnot) => {
                expect(a.p).toEqual(b.p);
                expect(a.in).toEqual(b.in);
              };
              for (let k = 0; k < split; k++) {
                same(ks[k]!, stored.knots[k]!);
                if (k < split - 1) expect(ks[k]!.out).toEqual(stored.knots[k]!.out);
              }
              // the knot before the split keeps its handle's direction (shortened by de Casteljau)
              if (split > 0 && ks[split]!.p[0] !== stored.knots[split]?.p[0]) {
                const a = stored.knots[split - 1]!;
                const o = ks[split - 1]!.out;
                const cross =
                  (o[0] - a.p[0]) * (a.out[1] - a.p[1]) - (o[1] - a.p[1]) * (a.out[0] - a.p[0]);
                expect(Math.abs(cross)).toBeLessThan(1e-12);
              }
              // the split point is on the stored section, at the reported share
              const sp = ks[split]!.p;
              expect(sp[0]).toBeCloseTo(part === 'bottom' ? row.bottom.share : row.deck.share, 12);
              expect(Math.abs(sp[1] - vAt(stored, sp[0]))).toBeLessThan(1e-9);
              // the last segment is straight, at the reported slope
              const end = ks[n - 1]!.p;
              const h1 = ks[split]!.out;
              const h2 = ks[n - 1]!.in;
              for (const h of [h1, h2]) {
                const c = (h[0] - sp[0]) * (end[1] - sp[1]) - (h[1] - sp[1]) * (end[0] - sp[0]);
                expect(Math.abs(c)).toBeLessThan(1e-12);
              }
              const slope = part === 'bottom' ? row.bottom.slope : row.deck.slope;
              if (end[0] > sp[0]) {
                expect((end[1] - sp[1]) / (end[0] - sp[0])).toBeCloseTo(slope, 9);
              }
            }
          });
        });

        it(`${side}: the slope of a usable station's straight end is the fit's panel slope`, () => {
          const lo = 0;
          const filled = filledOutline(doc.outline);
          const oc = side === 'minus' ? (filled.minus ?? filled.plus) : filled.plus;
          const hi = oc.knots[oc.knots.length - 1]!.p[0];
          doc.stations.forEach((st, i) => {
            const row = rows[i]!;
            if (row.tip) return;
            const halves = sectionHalves(side === 'minus' ? st.minus! : st.plus);
            const w = wOf(st.x);
            const t = thickness(doc, st.x);
            expect(row.halfWidth).toBe(w);
            const cos = outlineCos(wOf, lo, hi, st.x);
            const rail = sectionRail(
              physicalHalf(compileChain(halves.bottom), w, t),
              physicalHalf(compileChain(halves.deck), w, t),
              cos,
            );
            expect(row.bottom.slope).toBeCloseTo((rail.bottom.panel.slope * w) / t, 12);
            expect(row.deck.slope).toBeCloseTo((rail.deck.panel.slope * w) / t, 12);
            expect(row.bottom.share).toBeCloseTo(rail.bottom.panel.y / w, 12);
            expect(keys.find((k) => k.x === st.x)!.rail).toEqual(rail.recipe);
          });
        });

        it(`${side}: the converted station lofts back to the stored section`, () => {
          const bottom = buildLoft(
            board.stations.map((s) => ({ x: s.x, curve: s[side]!.bottom })),
            LOFT_SAMPLES,
          );
          const top = buildLoft(
            board.stations.map((s) => ({ x: s.x, curve: s[side]!.deck })),
            LOFT_SAMPLES,
          );
          const out = new Float64Array(3);
          doc.stations.forEach((st, i) => {
            const halves = sectionHalves(side === 'minus' ? st.minus! : st.plus);
            const t = thickness(doc, st.x);
            const row = rows[i]!;
            for (const [part, loft] of [
              ['bottom', bottom],
              ['deck', top],
            ] as const) {
              const upTo = row[part].share - CLEAR_CELLS / LOFT_SAMPLES;
              for (let j = 0; j <= CHECKS; j++) {
                const u = (upTo * j) / CHECKS;
                loftAt(loft, st.x, u, out);
                const d = Math.abs(out[0]! - vAt(halves[part], u)) * t;
                worst.height = Math.max(worst.height, d);
                expect(d).toBeLessThan(HEIGHT_TOL);
              }
            }
          });
        });

        it(`${side}: the rail the kernel builds from a key stands off the section by the fit's gap`, () => {
          const filled = filledOutline(doc.outline);
          const oc = side === 'minus' ? (filled.minus ?? filled.plus) : filled.plus;
          const hi = oc.knots[oc.knots.length - 1]!.p[0];
          doc.stations.forEach((st, i) => {
            const row = rows[i]!;
            if (row.tip) return;
            const halves = sectionHalves(side === 'minus' ? st.minus! : st.plus);
            const w = row.halfWidth;
            const t = row.thickness;
            const key = keys.find((k) => k.x === st.x)!;
            const gap = recipeGap(
              physicalHalf(compileChain(halves.bottom), w, t),
              physicalHalf(compileChain(halves.deck), w, t),
              key.rail,
              outlineCos(wOf, 0, hi, st.x),
            );
            const fit = Math.max(row.bottom.fit!.gap, row.deck.fit!.gap);
            worst.gap = Math.max(worst.gap, Math.abs(gap - fit));
            expect(Math.abs(gap - fit)).toBeLessThan(GAP_TOL);
          });
        });
      }
    });
  }

  it('flags a half that is not a function of u inboard of its cut, and no half of a clean board', () => {
    for (const make of Object.values(BOARDS)) {
      expect(converted(make()).report.foldedHalves).toBe(0);
    }
    const doc = analyticBoard();
    const st = doc.stations[0]!;
    const k = st.plus.chain.knots;
    // a vertical first segment: the half rises 0.04 of the thickness at the stringer, then goes on
    const knots: ChainKnot[] = [
      { ...k[0]!, out: [0, 0.02] },
      { p: [0, 0.04], in: [0, 0.03], out: [0.3, 0.04], smooth: false },
      ...k.slice(1),
    ];
    const folded = {
      ...doc,
      stations: [{ ...st, plus: { chain: { knots }, apex: st.plus.apex + 1 } }],
    };
    const { report } = converted(folded);
    const row = report.stations[0]!;
    expect(row.bottom.folds).toBe(true);
    expect(row.deck.folds).toBe(false);
    expect(report.foldedHalves).toBe(1);
  });

  it('reads a notched board with its notch filled, and keeps the notch in the outline', () => {
    const doc = swallowBoard();
    const { board, report } = converted(doc);
    expect(board.outline).toBe(doc.outline);
    expect(board.outline.plus.knots[0]!.p[0]).toBeGreaterThan(0);
    expect(board.corners.tail).toBeLessThan(board.corners.nose);
    const filled = halfWidthOf(doc.outline);
    for (const row of report.stations) expect(row.halfWidth).toBe(filled(row.x));
    // the station on the notch's bottom is read across the filled notch, not at a zero width
    const first = report.stations[0]!;
    expect(first.x).toBe(doc.outline.plus.knots[0]!.p[0]);
    expect(first.halfWidth).toBeGreaterThan(2.5);
  });

  it('refuses a document with no stations, and one that is not a sections board', () => {
    const none = convertSections({ ...swallowBoard(), stations: [] });
    expect(none.ok).toBe(false);
    expect(none.issues[0]!.code).toBe('too-few-sections');
    const rails = convertSections({ ...swallowBoard(), model: 'rails' } as unknown as BoardDoc);
    expect(rails.ok).toBe(false);
    expect(rails.issues[0]!.code).toBe('doc-malformed');
  });

  it('refuses a side with no station that can carry a rail', () => {
    const doc = swallowBoard();
    const thin = convertSections({ ...doc, deck: doc.rocker });
    expect(thin.ok).toBe(false);
    expect(thin.issues[0]!.code).toBe('too-few-sections');
  });

  it('states the worst figures', () => {
    // read by the reviewer from the file below; the bounds are the tests above
    expect(worst.height).toBeLessThan(HEIGHT_TOL);
    expect(worst.gap).toBeLessThan(GAP_TOL);
  });
});

describe.each(Object.keys(BOARDS))('convertSections with a cache: %s', (name) => {
  const doc = BOARDS[name]!();
  const sides = doc.symmetry === 'asymmetric' ? 2 : 1;
  const all = sides * doc.stations.length;
  const plain = (d: BoardDoc) => converted(d);
  const cached = (d: BoardDoc, cache: ConvertCache) => {
    const r = convertSections(d, { cache });
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
    return r.value;
  };

  it('gives the result it gives without one, and refits nothing the second time', () => {
    const cache = convertCache();
    expect(cached(structuredClone(doc), cache)).toEqual(plain(doc));
    expect(cache.fits).toBe(all);
    expect(cached(structuredClone(doc), cache)).toEqual(plain(doc));
    expect(cache.fits).toBe(all);
    expect(cache.reused).toBe(all);
  });

  it("refits one station side when one station's section changes", () => {
    const cache = convertCache();
    cached(doc, cache);
    const i = doc.stations.length >> 1;
    const st = doc.stations[i]!;
    const knots = st.plus.chain.knots.map((k, j) =>
      j === 1 ? { ...k, p: [k.p[0], k.p[1] + 0.01] as const } : k,
    );
    const edited: BoardDoc = {
      ...doc,
      stations: doc.stations.map((s, j) =>
        j === i ? { ...s, plus: { ...s.plus, chain: { knots } } } : s,
      ),
    };
    expect(cached(structuredClone(edited), cache)).toEqual(plain(edited));
    expect(cache.fits).toBe(all + 1);
    expect(cache.reused).toBe(all - 1);
  });

  it('refits the station sides whose half width or outline angle changed when the outline does', () => {
    const cache = convertCache();
    cached(doc, cache);
    const knots = doc.outline.plus.knots.map((k, j) =>
      j === 1 ? { ...k, p: [k.p[0], k.p[1] + 0.2] as const } : k,
    );
    const edited: BoardDoc = { ...doc, outline: { ...doc.outline, plus: { knots } } };
    // which station sides read a different half width or angle: plus only, the minus side has its own chain or mirrors plus
    const reads = (d: BoardDoc, side: 'plus' | 'minus') => {
      const w = halfWidthOf(d.outline, side === 'minus' ? 'minus' : undefined);
      const f = filledOutline(d.outline);
      const ch = side === 'minus' ? (f.minus ?? f.plus) : f.plus;
      const [lo, hi] = chainXRange(compileChain(ch));
      return d.stations.map((s) => [w(s.x), outlineCos(w, lo, hi, s.x)]);
    };
    let changed = 0;
    for (const side of sides === 2 ? (['plus', 'minus'] as const) : (['plus'] as const)) {
      const a = reads(doc, side);
      const b = reads(edited, side);
      a.forEach((v, j) => {
        if (v[0] !== b[j]![0] || v[1] !== b[j]![1]) changed++;
      });
    }
    expect(changed).toBeGreaterThan(0);
    expect(cached(structuredClone(edited), cache)).toEqual(plain(edited));
    expect(cache.fits).toBe(all + changed);
  });

  it('stays bounded', () => {
    const cache = convertCache();
    for (let k = 0; k < 30; k++) {
      const deck = {
        knots: doc.deck.knots.map((kn) => ({ ...kn, p: [kn.p[0], kn.p[1] + 0.01 * k] as const })),
      };
      cached({ ...doc, deck }, cache);
    }
    expect(cache.entries.length).toBeLessThanOrEqual(all + TRIM.convertCacheSpare);
  });
});
