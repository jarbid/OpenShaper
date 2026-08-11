// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Do the ring's points go where the shape needs them?
 *
 * Spreading a ring's points evenly by arc length is fair but not smart. A rail
 * apex can have a radius of a few millimetres while the bottom is dead flat, and
 * an even ring spends the same number of points on each — so the tightest part
 * of the section, the part a shaper is actually judging, is the worst resolved.
 * At the default viewport quality that measured 2.5 mm of chord error on an
 * `80-20-hard` rail: visible as a flat spot.
 *
 * `ringFractions` biases the points toward curvature. This file is what stops
 * that bias from being a free lunch — it has to buy real accuracy at the rail
 * without either wrecking the spacing elsewhere or disturbing the two properties
 * the loft depends on:
 *
 *   - the ladder must be IDENTICAL at every station, or the correspondence that
 *     makes point-blending work is gone and the pinch comes back;
 *   - it must not move the surface, only re-place samples on it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arcLengthTable, pointAtArcFraction } from './bezier-spline';
import { getInterpolatedCrossSection, getLength, type BezierBoard } from './board';
import { crossSection, scaleCrossSection } from './cross-section';
import { CURVATURE_BIAS, ringFractions } from './loft';
import { applyRailProfile, RAIL_PRESETS } from './rail-profile';
import { parseBrdGeometry } from './test-support/brd-geometry';
import type { Vec2 } from './vec2';

const here = dirname(fileURLToPath(import.meta.url));

/** Sample board with a hard rail at one station and a soft one at the next. */
const railBoard = (): { board: BezierBoard; hard: number } => {
  const base = parseBrdGeometry(
    readFileSync(resolve(here, '../../../docs/specs/golden/shortboard.brd'), 'utf8'),
  );
  const pos = getLength(base) * 0.45;
  const cs = getInterpolatedCrossSection(base, pos);
  if (!cs) throw new Error('no section');
  const list = [...base.crossSections];
  let i = list.findIndex((c) => c.position > pos);
  if (i < 0) i = list.length - 1;
  list.splice(i, 0, crossSection(pos, cs.spline));
  const params = (id: string) => RAIL_PRESETS.find((p) => p.id === id)!.params;
  list[i] = applyRailProfile(list[i]!, params('80-20-hard'));
  list[i + 1] = applyRailProfile(list[i + 1]!, params('50-50-soft'));
  return { board: { ...base, crossSections: list }, hard: i };
};

const distToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/**
 * Worst distance from the true profile to the ring's chords — the error a viewer
 * actually sees as faceting, and what a CAD tessellator's sag tolerance bounds.
 */
const chordError = (board: BezierBoard, index: number, points: number): number => {
  const table = arcLengthTable(scaleCrossSection(board.crossSections[index]!, 6, 45).spline);
  const fs = ringFractions(board, points);
  let worst = 0;
  for (let i = 0; i < fs.length - 1; i++) {
    const a = pointAtArcFraction(table, fs[i]!);
    const b = pointAtArcFraction(table, fs[i + 1]!);
    for (let s = 1; s < 40; s++) {
      const p = pointAtArcFraction(table, fs[i]! + (fs[i + 1]! - fs[i]!) * (s / 40));
      worst = Math.max(worst, distToSegment(p, a, b));
    }
  }
  return worst;
};

/** Points per rail at the default `ringSteps` of 48. */
const HALF = 24;

describe('ring points follow curvature', () => {
  it('resolves a hard rail several times better than even spacing would', () => {
    // Even spacing measures 0.2531 cm here; the ladder measures 0.0645. The bound
    // is set at a third of the even-spacing figure, so it fails if the bias is
    // switched off or reduced to a token amount, without pinning the exact value
    // — which is quantisation-sensitive (see CURVATURE_BIAS).
    const { board, hard } = railBoard();
    expect(chordError(board, hard, HALF)).toBeLessThan(0.253 / 3);
  });

  it('does not stretch any one span past what shading can carry', () => {
    // The cost of the bias is uneven spacing. Bounded so the flat bottom cannot
    // be reduced to a handful of very long facets: at β=0.5 the longest gap is
    // 3.37 cm, at β=2 it is 6.36 cm.
    const { board, hard } = railBoard();
    const table = arcLengthTable(scaleCrossSection(board.crossSections[hard]!, 6, 45).spline);
    const fs = ringFractions(board, HALF);
    let longest = 0;
    for (let i = 0; i < fs.length - 1; i++) {
      const a = pointAtArcFraction(table, fs[i]!);
      const b = pointAtArcFraction(table, fs[i + 1]!);
      longest = Math.max(longest, Math.hypot(b.x - a.x, b.y - a.y));
    }
    expect(longest).toBeLessThan(4.5);
  });

  it('is one ladder for the whole board, not one per station', () => {
    // The load-bearing property. Point blending only works because the same
    // fraction means the same place at both ends of an interval; a per-station
    // ladder would reintroduce exactly the correspondence bug this replaced.
    const { board } = railBoard();
    const a = ringFractions(board, HALF);
    const b = ringFractions(board, HALF);
    expect(a).toBe(b); // memoised per board, so identity is the strongest check
    expect(a[0]).toBe(0);
    expect(a[a.length - 1]).toBe(1);
  });

  it('is strictly increasing, so the ring never doubles back', () => {
    const { board } = railBoard();
    for (const n of [4, 12, HALF, 100, 201]) {
      const fs = ringFractions(board, n);
      expect(fs).toHaveLength(n);
      for (let i = 1; i < fs.length; i++) expect(fs[i]!).toBeGreaterThan(fs[i - 1]!);
    }
  });

  it('leaves the flat bottom accurate even though it gives points away', () => {
    // Taking points off a straight run costs nothing geometrically, which is the
    // whole reason this trade is available. Even spacing measures 0.0011 cm on
    // the bottom third of the profile and the ladder 0.0024 — both far below the
    // rail's error either way.
    const { board, hard } = railBoard();
    const table = arcLengthTable(scaleCrossSection(board.crossSections[hard]!, 6, 45).spline);
    const fs = ringFractions(board, HALF);
    let worst = 0;
    for (let i = 0; i < fs.length - 1; i++) {
      if (fs[i + 1]! >= 0.3) continue;
      const a = pointAtArcFraction(table, fs[i]!);
      const b = pointAtArcFraction(table, fs[i + 1]!);
      for (let s = 1; s < 40; s++) {
        const p = pointAtArcFraction(table, fs[i]! + (fs[i + 1]! - fs[i]!) * (s / 40));
        worst = Math.max(worst, distToSegment(p, a, b));
      }
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('keeps improving as the ring gets denser', () => {
    // Sanity on the whole scheme: the bias redistributes a fixed budget, it must
    // not cap what a bigger budget can buy.
    const { board, hard } = railBoard();
    expect(chordError(board, hard, 96)).toBeLessThan(chordError(board, hard, HALF));
  });

  it('is declared at the value the measurements chose', () => {
    expect(CURVATURE_BIAS).toBe(0.5);
  });
});
