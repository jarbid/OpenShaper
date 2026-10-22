// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S6 and S7 exit (docs/design/board2.md §14): the seven `.brd` sample files. The
 * three goldens are converted and measured (`test-support/exit.ts`); the four
 * copies (`apps/web/src/*.brd`, byte-identical to the goldens, and the
 * self-authored shortboard, which parses to a board deep-equal to the golden's)
 * are shown to be the same input, so the pure converter gives them the same
 * result. What S6 hands to S7 is pinned too: `validateBoard` passes on the
 * shortboard and finds only `rail-profile-invalid` near the nose of the funboard
 * and longboard (with S6's constant profile laws the steep nose rocker lifts the
 * bottom's tangent corner above the apex there; S7 fits the laws).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectExit, expectS7Exit, runExit } from './test-support/exit';
import { classicSample } from './test-support/samples';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bytes = (p: string): Buffer => readFileSync(resolve(repo, p));

describe('S6 and S7 exit: .brd sample files', () => {
  for (const name of ['golden/shortboard.brd', 'golden/funboard.brd', 'golden/longboard.brd']) {
    it(
      name,
      () => {
        const run = runExit(classicSample(name));
        expectExit(name, run);
        expectS7Exit(name, run, classicSample(name).load());
        const errors = run.measures.validateErrors;
        if (name === 'golden/shortboard.brd') expect(errors).toEqual([]);
        else {
          expect(errors.length).toBeGreaterThan(0);
          for (const e of errors) {
            expect(e.code).toBe('rail-profile-invalid');
            expect(Math.abs(e.at!.sigma! - 0.5)).toBeLessThan(0.02);
          }
        }
      },
      180_000,
    );
  }

  it('the four copies are the goldens’ input', () => {
    for (const k of ['shortboard', 'funboard', 'longboard']) {
      const copy = k === 'shortboard' ? 'sample-board' : k;
      expect(bytes(`apps/web/src/${copy}.brd`).equals(bytes(`docs/specs/golden/${k}.brd`))).toBe(
        true,
      );
    }
    expect(classicSample('self-authored-shortboard.brd').load()).toEqual(
      classicSample('golden/shortboard.brd').load(),
    );
  });
});
