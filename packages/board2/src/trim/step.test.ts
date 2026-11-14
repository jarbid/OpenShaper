// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The STEP solid of a rails board (`trim/step.ts`) on three rails boards converted from the test boards:
 * the swallow (a mirror board with a notch, a vee and a double concave), the asymmetric board (both
 * halves different, channels reaching the rails) and the shortboard golden with a hard edge in the tail
 * (a 0.5 mm tuck that leaves the bottom at 30 degrees). Each solid passes geom's `checkBrep`, has the
 * counts Euler asks of N splits (V = 3N, E = 5N, F = 2N + 2), is within the tolerance of the kernel
 * (the fit's own measure, and independently at the kernel's band edges, apex line and panel mesh
 * vertices), and encloses the volume of a fine kernel mesh within 0.1 %. A mirror board's halves are
 * exact mirrors; the file is reproducible; a budget no fit can meet is a `StepFitError`. The fish, the
 * plain shortboard and the analytic board run in `step.occt.test.ts` (slower).
 */
import { checkBrep } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { STEP_RAILS_EDGE_GAP, STEP_TOLERANCE } from '../params';
import { StepFitError } from '../step';
import { boardSet } from '../test-support/board-set';
import { asymmetricBoard, swallowBoard } from '../testing';
import type { BuiltRails } from './native';
import { meshRails } from './native';
import { railsSolid, railsStep } from './step';
import type { RailsSolid } from './step';
import {
  builtRails,
  hardTail,
  independentDeviation,
  railsBoardOf,
} from './test-support/rails-step';

/** The kernel mesh the volume is held to: STL quality at this face size (cm). */
const FINE_FACE = 0.25;
/** Volume against that mesh, as a fraction. */
const VOLUME_TOL = 1e-3;

const BOARDS: readonly { readonly name: string; readonly make: () => BuiltRails }[] = [
  { name: 'swallow', make: () => builtRails(railsBoardOf(swallowBoard())) },
  { name: 'asymmetric (channels)', make: () => builtRails(railsBoardOf(asymmetricBoard())) },
  {
    name: 'shortboard, hard edge in the tail',
    make: () =>
      builtRails(
        hardTail(railsBoardOf(boardSet().find((b) => b.name === 'shortboard')!.doc), 60, 30),
      ),
  },
];

const solved = new Map<string, { built: BuiltRails; solid: RailsSolid }>();
const solve = (name: string): { built: BuiltRails; solid: RailsSolid } => {
  let r = solved.get(name);
  if (r === undefined) {
    const built = BOARDS.find((b) => b.name === name)!.make();
    r = { built, solid: railsSolid(built) };
    solved.set(name, r);
  }
  return r;
};

describe('the STEP solid of a rails board', () => {
  for (const { name } of BOARDS) {
    it(`${name}: one valid closed solid within the tolerance of the kernel`, () => {
      const { built, solid } = solve(name);
      const r = solid.report;
      expect(r.withinTolerance).toBe(true);
      expect(r.deviation).toBeLessThanOrEqual(STEP_TOLERANCE);
      expect(r.edgeGap).toBeLessThanOrEqual(STEP_RAILS_EDGE_GAP);
      const check = checkBrep(solid.brep);
      expect(check.issues).toEqual([]);
      expect(check.ok).toBe(true);
      // two panels, and per split a deck blend and a tuck; Euler-Poincaré with genus 0
      const N = r.splits;
      expect(check.euler).toMatchObject({ V: 3 * N, E: 5 * N, F: 2 * N + 2, G: 0, holds: true });
      expect(r.faces).toBe(2 * N + 2);
      // independently of the fit's measure
      const ind = independentDeviation(built, solid, 3);
      expect(ind.rows).toBeLessThanOrEqual(STEP_TOLERANCE);
      expect(ind.panels).toBeLessThanOrEqual(STEP_TOLERANCE);
      // the enclosed volume, against a fine kernel mesh
      const mesh = meshRails(built, { maxEdge: FINE_FACE }).volume;
      expect(Math.abs(check.signedVolume / mesh - 1)).toBeLessThan(VOLUME_TOL);
    }, 60_000);
  }

  it('a mirror board: the minus half is the plus half mirrored, exactly', () => {
    const { solid } = solve('swallow');
    const faces = solid.brep.faces;
    // strip faces come in pairs (deck blend, tuck) in loop order; the minus half runs back to the nose
    const strips = (faces.length - 2) / 2;
    const half = strips / 2;
    for (let k = 0; k < half; k++) {
      for (const side of [0, 1]) {
        const plus = faces[2 * k + side]!.surface.cw;
        const minus = faces[2 * (strips - 1 - k) + side]!.surface.cw;
        expect(minus.length).toBe(plus.length);
        for (let i = 0; i < plus.length; i += 4) {
          expect(minus[i]).toBe(plus[i]);
          expect(minus[i + 1]).toBe(0 - plus[i + 1]!);
          expect(minus[i + 2]).toBe(plus[i + 2]);
        }
      }
    }
    // each panel is its own mirror
    for (const s of [solid.deck, solid.bottom]) {
      const nv = s.v.count;
      for (let i = 0; i < s.u.count; i++) {
        for (let j = 0; j < nv; j++) {
          const a = (i * nv + j) * 4;
          const b = (i * nv + nv - 1 - j) * 4;
          expect(s.cw[b + 1]).toBe(0 - s.cw[a + 1]!);
          expect(s.cw[b + 2]).toBe(s.cw[a + 2]);
        }
      }
    }
  }, 60_000);

  it('writes a reproducible Part 21 file in the unit asked for', () => {
    const { built } = solve('swallow');
    const opts = { name: 'swallow', unit: 'cm', timestamp: '2026-01-01T00:00:00' } as const;
    const a = railsStep(built, opts);
    const b = railsStep(built, opts);
    expect(a.text).toBe(b.text);
    expect(a.text.startsWith('ISO-10303-21;')).toBe(true);
    expect(a.text).toContain('.CENTI.');
    expect(a.text).toContain('MANIFOLD_SOLID_BREP');
    expect(a.stats.faces).toBe(a.report.faces);
  }, 60_000);

  it('a budget no fit can meet fails with a StepFitError', () => {
    const { built } = solve('swallow');
    expect(() => railsStep(built, { maxControls: 100 })).toThrowError(StepFitError);
    try {
      railsStep(built, { maxControls: 100 });
    } catch (e) {
      expect((e as StepFitError).kind).toBe('budget');
    }
  }, 60_000);
});
