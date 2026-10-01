/**
 * Tests for the Shape3d `.s3dx` XML reader.
 *
 * FIXTURES: `__fixtures__/synthetic-*.s3dx` are self-authored files built to
 * exercise the same S3dxReader edge cases real-world Shape3d exports have
 * hit in the past (narrower fallback outline, both deck coordinate
 * representations on a rockered board, a deck curve overshooting the nose,
 * and a degenerate cross-section) — without redistributing anyone else's
 * board design. Each fixture's geometry is chosen so the parsed dimensions land on
 * known values, making this a precise check of the parser rather than a fuzzy
 * characterization against an opaque third-party file.
 *
 * Reference: ../boardcad-le/src/board/readers/S3dxReader.java
 *   - main differences vs S3dReader: curve element names
 *     (curveDefTop2 / curveDefSide0 / curveDefSide4), the <Protection> flag,
 *     and the "Ref. point" → "Ref.point" text fix-up.
 *
 * Internal units: centimetres (Shape3d stores cm; no unit conversion applied).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adjustCrossSectionsToThicknessAndWidth,
  getLength,
  getMaxWidth,
  getThickness,
  getThicknessAtPos,
} from '@openshaper/kernel';
import { parseS3dx } from './s3d-reader';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = (name: string): string =>
  readFileSync(join(here, '__fixtures__', name), 'latin1');

const INCH = 2.54;

describe('parseS3dx (synthetic fixtures)', () => {
  it('parses a dimensioned sample matching its filename length & thickness (5.10 x _ x 2.6 in)', () => {
    const { board, warnings } = parseS3dx(fixtureText('synthetic-fallback-outline-5x10.s3dx'));
    // 5'10" = 70 in exactly. Length is an exact oracle (= max outline x).
    expect(getLength(board) / INCH).toBeCloseTo(70, 0); // 177.8 cm
    // 2.6 in thick (~6.6 cm), tolerant to end-cap handling.
    expect(getThickness(board) / INCH).toBeCloseTo(2.6, 0);
    // This fixture omits <curveDefTop2>, so the outline falls back to the
    // narrower <curveDefTop1> (built deliberately narrower than nominal).
    expect(warnings.some((w) => /falling back/.test(w.message))).toBe(true);
    expect(getMaxWidth(board)).toBeGreaterThan(44);
    expect(getMaxWidth(board)).toBeLessThan(54);
  });

  it('imports a clean export at its exact nominal dims with no warnings (6.0 x 22 x 2.75)', () => {
    // Positive control: a well-formed file (has curveDefTop2, StringerMeasurement=0,
    // no degenerate sections) must hit its nominal dims exactly and warn about nothing.
    const { board, warnings } = parseS3dx(fixtureText('synthetic-clean-6x22x2-75.s3dx'));
    expect(getLength(board) / INCH).toBeCloseTo(72, 0); // 6'0"
    expect(getMaxWidth(board) / INCH).toBeCloseTo(22, 0);
    expect(getThickness(board) / INCH).toBeCloseTo(2.75, 1);
    expect(warnings).toHaveLength(0);
  });

  it.each([
    'synthetic-stringer-fold-b.s3dx',
    'synthetic-stringer-fold-a.s3dx',
    'synthetic-fallback-outline-5x10.s3dx',
  ])('parses %s into a structurally valid board', (name) => {
    const { board, warnings } = parseS3dx(fixtureText(name));
    expect(Number.isFinite(getLength(board))).toBe(true);
    expect(getLength(board)).toBeGreaterThan(100); // > ~3'3"
    expect(getMaxWidth(board)).toBeGreaterThan(20);
    expect(getThickness(board)).toBeGreaterThan(2);
    // tail dummy + interior sections + nose dummy
    expect(board.crossSections.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(warnings)).toBe(true);
  });
});

describe('parseS3dx protection handling', () => {
  it('rejects a password-protected board with a clear error', () => {
    const base = fixtureText('synthetic-stringer-fold-b.s3dx');
    // Inject a Protection flag inside <Board>.
    const protectedXml = base.replace('<Board>', '<Board>\n<Protection>1</Protection>');
    expect(() => parseS3dx(protectedXml)).toThrow(/password-protected/i);
  });

  it('ignores a zero Protection flag', () => {
    const base = fixtureText('synthetic-stringer-fold-b.s3dx');
    const xml = base.replace('<Board>', '<Board>\n<Protection>0</Protection>');
    // Not just "doesn't throw": the flag must have no effect on what is read.
    expect(parseS3dx(xml)).toEqual(parseS3dx(base));
  });
});

// ---------------------------------------------------------------------------
// Real-world export robustness (regressions)
// ---------------------------------------------------------------------------

const isNonDecreasing = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

describe('parseS3dx real-world export robustness', () => {
  it('keeps the deck/bottom/outline single-valued in x (deck folds past the nose)', () => {
    // synthetic-stringer-fold-a's deck runs 1.6 cm past the board nose while
    // the bottom ends exactly at length, so the injected bottom-nose endpoint
    // lands BEFORE the deck's own nose — a backward x-step that renders the
    // rocker "flipped" if left uncorrected.
    const { board } = parseS3dx(fixtureText('synthetic-stringer-fold-a.s3dx'));
    for (const curve of [board.outline, board.bottom, board.deck]) {
      expect(isNonDecreasing(curve.knots.map((k) => k.end.x))).toBe(true);
    }
    const len = getLength(board);
    for (const curve of [board.outline, board.bottom, board.deck]) {
      for (const k of curve.knots) {
        expect(k.end.x).toBeGreaterThanOrEqual(-1e-6);
        expect(k.end.x).toBeLessThanOrEqual(len + 1e-6);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Deck coordinate representation (absolute z vs thickness-above-bottom).
  //
  // Both fixtures below carry <StringerMeasurement>1 and the SAME 8 cm tip
  // rocker, and differ only in how the deck curve is stored. That is the whole
  // point: the flag cannot tell them apart, so the reader must classify them
  // from the geometry. Keying off the flag breaks exactly one of the two, and
  // which one depends on which way the flag is read — so both directions are
  // pinned here.
  //
  // A zero-rocker fixture cannot pin either direction: where bottom(x) = 0 the
  // two representations are the same numbers.
  // -------------------------------------------------------------------------

  it('converts a thickness-above-bottom deck to an absolute deck', () => {
    // Read as absolute this deck sits 7.5 cm BELOW the bottom at the tips —
    // a self-intersecting board, so the curve must hold thickness.
    const { board, warnings } = parseS3dx(fixtureText('synthetic-rocker-thickness-deck.s3dx'));
    const len = getLength(board);

    for (let f = 0; f <= 1.0001; f += 0.02) {
      expect(getThicknessAtPos(board, f * len)).toBeGreaterThan(-0.05);
    }
    expect(getThickness(board)).toBeCloseTo(6.5, 0);
    expect(warnings.some((w) => /thickness above the bottom/i.test(w.message))).toBe(true);
  });

  it('leaves an absolute deck alone even when <StringerMeasurement> is set', () => {
    // Same flag, same rocker, deck already absolute. Converting it would add
    // the 8 cm tip rocker a second time and inflate the board into a slab.
    const { board, warnings } = parseS3dx(fixtureText('synthetic-rocker-absolute-deck.s3dx'));
    const len = getLength(board);

    expect(getThickness(board)).toBeCloseTo(6.5, 0);
    // The double-add would push max thickness to ~14.5 cm.
    let maxThick = 0;
    for (let f = 0; f <= 1.0001; f += 0.02) {
      maxThick = Math.max(maxThick, getThicknessAtPos(board, f * len));
    }
    expect(maxThick).toBeLessThan(7.5);
    // Tips stay thin rather than being lifted clear of the bottom.
    expect(getThicknessAtPos(board, 0)).toBeLessThan(1.5);
    expect(warnings.some((w) => /thickness above the bottom/i.test(w.message))).toBe(false);
  });

  it.each(['synthetic-rocker-thickness-deck.s3dx', 'synthetic-rocker-absolute-deck.s3dx'])(
    'ignores the <StringerMeasurement> flag itself (%s)',
    (name) => {
      // The flag is Shape3d's dimension-measurement setting, not a coordinate
      // declaration: flipping it must not change the parsed board.
      const flagOn = fixtureText(name);
      const flagOff = flagOn.replace(
        '<StringerMeasurement>1</StringerMeasurement>',
        '<StringerMeasurement>0</StringerMeasurement>',
      );
      expect(flagOff).not.toEqual(flagOn); // the replace actually fired
      expect(parseS3dx(flagOn)).toEqual(parseS3dx(flagOff));
    },
  );

  it('leaves an absolute (StringerMeasurement=0) deck unchanged', () => {
    const { board } = parseS3dx(fixtureText('synthetic-degenerate-section.s3dx'));
    const len = getLength(board);
    for (let f = 0; f <= 1.0001; f += 0.05) {
      expect(getThicknessAtPos(board, f * len)).toBeGreaterThan(-0.05);
    }
  });

  it('drops degenerate (<3-knot) cross-sections', () => {
    const { board, warnings } = parseS3dx(fixtureText('synthetic-degenerate-section.s3dx'));
    // Interior sections (excluding the tail/nose dummies at index 0 and last)
    // must all have ≥3 control points.
    const interior = board.crossSections.slice(1, -1);
    for (const cs of interior) {
      expect(cs.spline.knots.length).toBeGreaterThanOrEqual(3);
    }
    expect(
      warnings.some(
        (w) => w.severity === 'dropped' && /too few to form a valid profile/.test(w.message),
      ),
    ).toBe(true);
  });

  it('settles imported sections idempotently (no thickness blow-up on re-edit)', () => {
    // A degenerate section made adjustCrossSectionsToThicknessAndWidth
    // non-idempotent — it exploded a section's thickness on the SECOND pass
    // (every edit re-runs it), so dropping such sections must restore
    // idempotency. Compare section thicknesses after one vs two passes.
    const { board } = parseS3dx(fixtureText('synthetic-degenerate-section.s3dx'));
    const once = adjustCrossSectionsToThicknessAndWidth(board);
    const twice = adjustCrossSectionsToThicknessAndWidth(once);
    const thicknessSpan = (cs: { spline: { knots: readonly { end: { y: number } }[] } }) => {
      const ys = cs.spline.knots.map((k) => k.end.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(twice.crossSections.length).toBe(once.crossSections.length);
    once.crossSections.forEach((cs, i) => {
      expect(thicknessSpan(twice.crossSections[i]!)).toBeCloseTo(thicknessSpan(cs), 5);
    });
  });
});
