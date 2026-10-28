// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The direct classic converter (docs/design/m1-model.md §4, step 2 acceptance in §6):
 *
 * - every classic sample file converts or is refused with a reason, and none throws;
 * - the outline, rocker and deck are copied exactly, the slices are normalised and keep their
 *   identity when the slice is unchanged;
 * - on the golden boards the converted surface matches the classic one within 0.05 cm at the
 *   stations and on the lines; between the stations it differs by design, and how much is measured
 *   here (and recorded in docs/specs/divergences.md);
 * - the crease test: the normal-angle jump across a station is at least 100 times smaller than the
 *   classic loft's;
 * - swallow and fish outlines become a notched tail; what the model cannot hold is refused.
 */
import {
  board,
  crossSection,
  getDeckAtPos,
  getLength,
  getRockerAtPos,
  loftRing,
  ringHalf,
  sampleOutline,
  scaleSpline,
  splineFromKnots,
  knotFromArray,
} from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { boardDocToJson, reviveBoardDoc } from '../doc';
import { deriveLadders, meshBoard } from '../mesh';
import { buildBoard, createEvaluator } from '../surface';
import type { BuiltBoard } from '../surface';
import { GOLDENS, SAMPLES, classicNotched } from '../test-support/classic-samples';
import { nurbsRing, normalJump, polylineHausdorff, topology } from '../test-support/mesh-checks';
import type { V3 } from '../test-support/mesh-checks';
import { fishBoard, swallowBoard } from '../testing';
import { convertClassic } from './index';

/** The pinned outcome of each sample file: converted, or refused with this first issue code. */
const OUTCOME: Readonly<Record<string, string>> = {
  'shortboard.brd': 'ok',
  'funboard.brd': 'ok',
  'longboard.brd': 'ok',
  'sample-board.brd': 'ok',
  'self-authored-shortboard.brd': 'ok',
  'synthetic-clean-6x22x2-75.s3dx': 'thickness',
  'synthetic-degenerate-section.s3dx': 'ok',
  'synthetic-fallback-outline-5x10.s3dx': 'thickness',
  'synthetic-rocker-absolute-deck.s3dx': 'convert-slice',
  'synthetic-rocker-thickness-deck.s3dx': 'convert-slice',
  'synthetic-stringer-fold-a.s3dx': 'ok',
  'synthetic-stringer-fold-b.s3dx': 'ok',
};

function ok(b: BezierBoard) {
  const r = convertClassic(b);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  return r.value;
}

function built(b: BezierBoard): BuiltBoard {
  const r = buildBoard(ok(b).doc, { check: false });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

describe('the sample files', () => {
  it('each converts or is refused with a reason; none throws', () => {
    const seen = new Set<string>();
    for (const sample of SAMPLES) {
      const base = sample.name.replace(/^.*\//, '');
      const r = convertClassic(sample.load());
      if (r.ok) {
        // a converted board builds and meshes closed
        const b = buildBoard(r.value.doc, { check: false });
        expect(b.ok, sample.name).toBe(true);
        if (b.ok) {
          const m = meshBoard(b.value);
          expect(topology(m.indices, m.vertexCount).badEdges, sample.name).toBe(0);
          expect(m.volume, sample.name).toBeGreaterThan(0);
        }
        // and its document round-trips through JSON exactly
        const text = boardDocToJson(r.value.doc);
        const back = reviveBoardDoc(JSON.parse(text) as unknown);
        expect(back.ok, sample.name).toBe(true);
        if (back.ok) expect(boardDocToJson(back.value)).toBe(text);
        expect(OUTCOME[base], sample.name).toBe('ok');
      } else {
        const first = r.issues.find((i) => i.severity === 'error')!;
        expect(first.message.length).toBeGreaterThan(10);
        expect(OUTCOME[base], `${sample.name}: ${first.code}`).toBe(first.code);
      }
      seen.add(base);
    }
    // the three copies of each golden board are the same board
    expect([...seen].sort()).toEqual(
      [...new Set(SAMPLES.map((s) => s.name.replace(/^.*\//, '')))].sort(),
    );
  });
});

describe.each(GOLDENS)('$name', (sample) => {
  const classic = sample.load();
  const conv = ok(classic);
  const doc = conv.doc;

  it('copies the outline, rocker and deck as chains and normalises each slice', () => {
    expect(doc.symmetry).toBe('mirror');
    expect(doc.tail).toEqual({ kind: 'standard' });
    expect(doc.outline.plus.knots).toHaveLength(classic.outline.knots.length);
    classic.outline.knots.forEach((k, i) => {
      const c = doc.outline.plus.knots[i]!;
      expect(c.p).toEqual([k.end.x, k.end.y]);
      if (i > 0) expect(c.in[1]).toBe(k.tangentToPrev.y);
    });
    expect(doc.rocker.knots.map((k) => k.p)).toEqual(
      classic.bottom.knots.map((k) => [k.end.x, k.end.y]),
    );
    // the classic deck has a vertical wall at each end that the section model does not store
    expect(conv.report.deckWalls).toEqual([true, true]);
    expect(doc.deck.knots).toHaveLength(classic.deck.knots.length - 2);
    expect(doc.stations.map((s) => s.x)).toEqual(
      classic.crossSections.slice(1, -1).map((c) => c.position),
    );
    for (const s of doc.stations) {
      const k = s.plus.chain.knots;
      expect(k[0]!.p).toEqual([0, 0]);
      expect(k[k.length - 1]!.p).toEqual([0, 1]);
      expect(k[s.plus.apex]!.p[0]).toBe(1);
    }
    expect(conv.report.lineAdjust).toBeLessThan(0.01);
    expect(conv.report.sectionAdjust).toBeLessThan(0.01);
  });

  it('keeps the identity of an unchanged slice and nothing else of it', () => {
    const again = ok(classic);
    again.doc.stations.forEach((s, i) => expect(s.plus).toBe(doc.stations[i]!.plus));
    // an edit that replaces one slice: only that section is new
    const slices = classic.crossSections;
    const edited = crossSection(slices[2]!.position, scaleSpline(slices[2]!.spline, 1.03, 1.0));
    const changed = board(
      classic.outline,
      classic.bottom,
      classic.deck,
      slices.map((c, i) => (i === 2 ? edited : c)),
      classic.interpolationType,
      classic.fins,
    );
    const next = ok(changed).doc;
    next.stations.forEach((s, i) => {
      if (i === 1) expect(s.plus).not.toBe(doc.stations[i]!.plus);
      else expect(s.plus).toBe(doc.stations[i]!.plus);
    });
    // an outline edit leaves every section alone
    const moved = board(
      splineFromKnots(
        classic.outline.knots.map((k, i) =>
          i === 1
            ? knotFromArray(
                [
                  k.end.x,
                  k.end.y + 0.3,
                  k.tangentToPrev.x,
                  k.tangentToPrev.y + 0.3,
                  k.tangentToNext.x,
                  k.tangentToNext.y + 0.3,
                ],
                k.continuous,
                k.other,
              )
            : k,
        ),
      ),
      classic.bottom,
      classic.deck,
      slices,
      classic.interpolationType,
      classic.fins,
    );
    ok(moved).doc.stations.forEach((s, i) => expect(s.plus).toBe(doc.stations[i]!.plus));
  });

  describe('against the classic surface', () => {
    const b = built(classic);
    const ev = createEvaluator(b);
    const L = getLength(classic);
    const o = new Float64Array(18);

    /** The closed ring of the converted surface at x: the plus half, then the minus half back. */
    const ring = (x: number, n: number): V3[] => {
      const plus = nurbsRing(ev, x, n);
      const minus = plus.slice(1, -1).map((p): V3 => [p[0], -p[1], p[2]]);
      return [...plus, ...minus.reverse()];
    };
    const classicRing = (x: number): V3[] =>
      loftRing(classic, x, 400)!.map((v): V3 => [v.x, v.y, v.z]);
    const deviation = (x: number): number => {
      const c = classicRing(x);
      const n = ring(x, 200);
      return Math.max(polylineHausdorff(c, n, true), polylineHausdorff(n, c, true));
    };

    it('matches within 0.05 cm at every station', () => {
      for (const s of classic.crossSections.slice(1, -1)) {
        expect(deviation(s.position), `station ${s.position}`).toBeLessThan(0.05);
      }
    });

    it('matches within 0.05 cm on the outline, rocker and deck lines', () => {
      const outline = sampleOutline(classic.outline, 3000).map((p): V3 => [p.x, p.y, 0]);
      // (the vertical end wall of a blunt nose is a planar cap of the surface, not part of the apex line)
      const noWall = outline.filter((p) => p[0] < L - 1e-6);
      const apex: V3[] = [];
      let worstRocker = 0;
      let worstDeck = 0;
      for (let i = 0; i <= 3000; i++) {
        // cosine spacing: the plan is nearly vertical at the tips
        const x = (L * (1 - Math.cos((Math.PI * i) / 3000))) / 2;
        ev.at(0, x, 0.5, 0, o);
        apex.push([o[0]!, o[1]!, 0]);
        // the ends are the wall of the classic deck (its value there is the first segment's)
        if (x < 0.5 || x > L - 0.5) continue;
        ev.at(0, x, 0, 0, o);
        worstRocker = Math.max(worstRocker, Math.abs(o[2]! - getRockerAtPos(classic, x)));
        ev.at(0, x, 1, 0, o);
        worstDeck = Math.max(worstDeck, Math.abs(o[2]! - getDeckAtPos(classic, x)));
      }
      expect(polylineHausdorff(apex, outline, false)).toBeLessThan(0.05);
      expect(polylineHausdorff(noWall, apex, false)).toBeLessThan(0.05);
      expect(worstRocker).toBeLessThan(0.05);
      expect(worstDeck).toBeLessThan(0.05);
    });

    it('differs from the classic loft between the stations, by design and by a few millimetres', () => {
      const stations = classic.crossSections.slice(1, -1).map((s) => s.position);
      const edges = [0, ...stations, L];
      let worst = 0;
      let worstAt = 0;
      for (let x = 2; x < L - 2; x += 2) {
        const d = deviation(x);
        if (d > worst) {
          worst = d;
          worstAt = x;
        }
      }
      // The classic blends linearly between neighbouring stations; the converted surface is a
      // cubic spline through them (C2, no station creases). Measured on the goldens: 3 to 5 mm
      // (docs/specs/divergences.md). Pinned with room; a jump past 8 mm is a regression.
      expect(
        worst,
        `worst ${worst} cm at x = ${worstAt} (stations ${edges.join(', ')})`,
      ).toBeLessThan(0.8);
      expect(worst).toBeGreaterThan(0.05);
    }, 60_000);

    it("has no crease at the stations: the normal jump is at least 100x smaller than the loft's", () => {
      const half = ringHalf(192);
      const classicHalf = (x: number): V3[] =>
        loftRing(classic, x, 192)!
          .slice(0, half)
          .map((v): V3 => [v.x, v.y, v.z]);
      const delta = 1e-5;
      for (const s of classic.crossSections.slice(1, -1)) {
        const x = s.position;
        const jc = normalJump(classicHalf(x - delta), classicHalf(x), classicHalf(x + delta));
        const jn = normalJump(
          nurbsRing(ev, x - delta, half - 1),
          nurbsRing(ev, x, half - 1),
          nurbsRing(ev, x + delta, half - 1),
        );
        expect(jc, `classic jump at ${x}`).toBeGreaterThan(1e-3);
        expect(jn * 100, `station ${x}: nurbs ${jn} classic ${jc}`).toBeLessThan(jc);
      }
    });
  });
});

describe('swallow and fish tails', () => {
  const base = GOLDENS[0]!.load();
  it.each([
    ['swallow', swallowBoard],
    ['fish', fishBoard],
  ] as const)(
    'a classic %s becomes a notched board that builds, meshes closed and keeps its rail',
    (_n, make) => {
      const classic = classicNotched(base, make());
      const conv = ok(classic);
      expect(conv.doc.tail.kind).toBe('notched');
      expect(conv.report.zone).toBeGreaterThan(0);
      expect(conv.doc.stations.length).toBe(classic.crossSections.length - 2);
      for (let i = 1; i < conv.doc.stations.length; i++) {
        expect(conv.doc.stations[i]!.x).toBeGreaterThan(conv.doc.stations[i - 1]!.x);
      }
      const b = built(classic);
      const mesh = meshBoard(b);
      expect(topology(mesh.indices, mesh.vertexCount).badEdges).toBe(0);
      expect(mesh.volume).toBeGreaterThan(0);
      // the apex line is the classic outline, notch wall and tips included
      const ev = createEvaluator(b);
      const o = new Float64Array(18);
      const outline = sampleOutline(classic.outline, 3000).map((p): V3 => [p.x, p.y, 0]);
      const apex: V3[] = [];
      for (let i = 0; i <= 3000; i++) {
        const f = (1 - Math.cos((Math.PI * i) / 3000)) / 2;
        ev.at(0, b.xiMin + (b.xiMax - b.xiMin) * f, 0.5, 0, o);
        apex.push([o[0]!, o[1]!, 0]);
      }
      expect(polylineHausdorff(apex, outline, false)).toBeLessThan(0.05);
      expect(polylineHausdorff(outline, apex, false)).toBeLessThan(0.05);
      expect(deriveLadders(b).xi.length).toBeGreaterThan(30);
    },
  );
});

describe('refusals', () => {
  const base = GOLDENS[0]!.load();
  const code = (b: BezierBoard): string | undefined => {
    const r = convertClassic(b);
    return r.ok ? undefined : r.issues.find((i) => i.severity === 'error')?.code;
  };

  it('refuses a board without slices, a blunt tail and a slice without thickness', () => {
    expect(code(board(base.outline, base.bottom, base.deck, [base.crossSections[0]!]))).toBe(
      'too-few-sections',
    );
    const blunt = splineFromKnots([
      knotFromArray([0, 2, 0, 2, 0, 4], false, false),
      ...base.outline.knots.slice(1),
    ]);
    expect(code(board(blunt, base.bottom, base.deck, base.crossSections))).toBe(
      'outline-endpoints',
    );
    const flat = crossSection(
      30,
      splineFromKnots(
        base.crossSections[2]!.spline.knots.map((k) =>
          knotFromArray([k.end.x, 0, k.tangentToPrev.x, 0, k.tangentToNext.x, 0], true, false),
        ),
      ),
    );
    expect(
      code(
        board(base.outline, base.bottom, base.deck, [
          base.crossSections[0]!,
          flat,
          base.crossSections[5]!,
        ]),
      ),
    ).toBe('convert-slice');
  });

  it('never throws on a malformed board', () => {
    const one = splineFromKnots([base.outline.knots[0]!]);
    expect(convertClassic(board(one, base.bottom, base.deck, base.crossSections)).ok).toBe(false);
    expect(
      convertClassic(board(base.outline, splineFromKnots([]), base.deck, base.crossSections)).ok,
    ).toBe(false);
  });
});
