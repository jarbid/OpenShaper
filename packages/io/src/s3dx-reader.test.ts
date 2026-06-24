/**
 * Tests for the Shape3d `.s3dx` XML reader.
 *
 * GOLDEN ORACLE: unlike `.s3d` (for which no legacy sample exists), the
 * `__fixtures__/*.s3dx` files are REAL Shape3d exports supplied as samples.
 * Parsing them and recovering plausible board dimensions is a true
 * characterization of the port against genuine producer output.
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
} from '@openshaper/kernel';
import { parseS3dx } from './s3d-reader';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = (name: string): string =>
  readFileSync(join(here, '__fixtures__', name), 'latin1');

const INCH = 2.54;

describe('parseS3dx (real Shape3d samples)', () => {
  it('parses a dimensioned sample matching its filename length & thickness (5.10 x _ x 2.6 in)', () => {
    const { board, warnings } = parseS3dx(fixtureText('mlc-5-10x19-8x2-6.s3dx'));
    // 5'10" = 70 in exactly. Length is an exact oracle (= max outline x).
    expect(getLength(board) / INCH).toBeCloseTo(70, 0); // ~177.8 cm
    // 2.6 in thick (~6.6 cm), tolerant to end-cap handling.
    expect(getThickness(board) / INCH).toBeCloseTo(2.6, 0);
    // This export omits <curveDefTop2>, so the outline falls back to the
    // narrower <curveDefTop1> (~18.6" vs the nominal 19.8") — we assert the
    // fallback fired and width is plausible rather than the exact nominal.
    expect(warnings.some((w) => /falling back/.test(w))).toBe(true);
    expect(getMaxWidth(board)).toBeGreaterThan(44);
    expect(getMaxWidth(board)).toBeLessThan(54);
  });

  it.each(['gremilin56.s3dx', 'hyptocrypto.s3dx', 'mlc-5-10x19-8x2-6.s3dx'])(
    'parses %s into a structurally valid board',
    (name) => {
      const { board, warnings } = parseS3dx(fixtureText(name));
      expect(Number.isFinite(getLength(board))).toBe(true);
      expect(getLength(board)).toBeGreaterThan(100); // > ~3'3"
      expect(getMaxWidth(board)).toBeGreaterThan(20);
      expect(getThickness(board)).toBeGreaterThan(2);
      // tail dummy + interior sections + nose dummy
      expect(board.crossSections.length).toBeGreaterThanOrEqual(3);
      expect(Array.isArray(warnings)).toBe(true);
    },
  );
});

describe('parseS3dx protection handling', () => {
  it('rejects a password-protected board with a clear error', () => {
    const base = fixtureText('gremilin56.s3dx');
    // Inject a Protection flag inside <Board>.
    const protectedXml = base.replace('<Board>', '<Board>\n<Protection>1</Protection>');
    expect(() => parseS3dx(protectedXml)).toThrow(/password-protected/i);
  });

  it('ignores a zero Protection flag', () => {
    const base = fixtureText('gremilin56.s3dx');
    const xml = base.replace('<Board>', '<Board>\n<Protection>0</Protection>');
    expect(() => parseS3dx(xml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real-world export robustness (regressions)
// ---------------------------------------------------------------------------

const isNonDecreasing = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

describe('parseS3dx real-world export robustness', () => {
  it('keeps the deck/bottom/outline single-valued in x (hyptocrypto deck folds past the nose)', () => {
    // hyptocrypto's deck runs ~1.6 cm past the board nose while the bottom ends
    // short, so the injected bottom-nose endpoint used to land BEFORE the deck's
    // own nose — a backward x-step that renders the rocker "flipped".
    const { board } = parseS3dx(fixtureText('hyptocrypto.s3dx'));
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

  it('drops degenerate (<3-knot) cross-sections (Go fish Couples_1)', () => {
    const { board, warnings } = parseS3dx(fixtureText('go-fish.s3dx'));
    // Interior sections (excluding the tail/nose dummies at index 0 and last)
    // must all have ≥3 control points.
    const interior = board.crossSections.slice(1, -1);
    for (const cs of interior) {
      expect(cs.spline.knots.length).toBeGreaterThanOrEqual(3);
    }
    expect(warnings.some((w) => /degenerate cross-section/.test(w))).toBe(true);
  });

  it('settles imported sections idempotently (no thickness blow-up on re-edit)', () => {
    // A degenerate section made adjustCrossSectionsToThicknessAndWidth
    // non-idempotent — it exploded a section to ~380 cm on the SECOND pass
    // (every edit re-runs it), so dropping such sections must restore
    // idempotency. Compare section thicknesses after one vs two passes.
    const { board } = parseS3dx(fixtureText('go-fish.s3dx'));
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
