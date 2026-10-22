// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S6 and S7 exit (docs/design/board2.md §14): the synthetic `.s3dx` sample files in
 * name order, first four (both knife-tip files among them). All of them have
 * pointed tips and polygonal sections. Every one also passes `validateBoard`.
 * See `test-support/exit.ts` for the checks.
 */
import { describe, expect, it } from 'vitest';
import { expectExit, expectS7Exit, runExit } from './test-support/exit';
import { CLASSIC_SAMPLES } from './test-support/samples';

const files = CLASSIC_SAMPLES.filter((s) => s.name.endsWith('.s3dx')).slice(0, 4);

describe('S6 and S7 exit: synthetic sample files (a)', () => {
  it('covers four files', () => expect(files).toHaveLength(4));
  for (const s of files) {
    it(
      s.name,
      () => {
        const run = runExit(s);
        expectExit(s.name, run);
        expectS7Exit(s.name, run, s.load());
        expect(run.measures.validateErrors).toEqual([]);
      },
      180_000,
    );
  }
});
