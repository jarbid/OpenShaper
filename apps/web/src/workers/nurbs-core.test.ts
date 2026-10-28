// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The worker's compute is not yet wired to the section-based model (M1 step 3): every
 * job is refused with an ordinary error the viewer shows. Step 3 replaces this with
 * the real convert / mesh tests.
 */
import { describe, expect, it } from 'vitest';
import { convertAndMesh, NOT_WIRED, remesh } from './nurbs-core';

describe('nurbs-core (not yet wired)', () => {
  it('refuses a conversion and a re-mesh with an error outcome, never throwing', () => {
    const board = {} as Parameters<typeof convertAndMesh>[1];
    expect(convertAndMesh(1, board, 0.9)).toEqual({ ok: false, error: NOT_WIRED, issues: [] });
    expect(remesh(1, '{}', board, 0.9)).toEqual({ ok: false, error: NOT_WIRED, issues: [] });
  });
});
