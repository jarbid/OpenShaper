// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The three converted goldens through OpenCascade (docs/design/board2.md
 * §13.3 exit criterion 1, step S7): geom's OCCT protocol
 * (`@openshaper/geom/testing/occt`, geom-core.md §15.3) on the built board of
 * `convertClassic`, Path B in mm and cm: B1 one solid, B2 `isValid`, B3 counts
 * equal to `StepStats` (three faces, three edges, two vertices), B4 no
 * tolerance growth beyond twice the declared uncertainty, B5 / B6 every edge
 * and surface equal to ours parameter by parameter, B8 OCCT's mesh volume
 * within its error bound of our `massProperties` volume (a converted board has
 * no closed form: the stadium's suite, `brep.occt.test.ts`, carries the
 * independent volume oracle; mesh deflection 0.03 mm, as there). Run by
 * `pnpm test:occt`, not by `pnpm test`.
 */
import { curvePoint, massProperties } from '@openshaper/geom';
import { MESH_BOUND_MAX_REL, OcctKernel, pathB } from '@openshaper/geom/testing/occt';
import type { OcctSolid } from '@openshaper/geom/testing/occt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringerLines } from '../height-field';
import { planArc } from '../plan';
import { convertClassic } from './convert';
import { classicSample } from './test-support/samples';

let kernel: OcctKernel;
let mark = 0;
beforeAll(async () => {
  kernel = await OcctKernel.init();
  mark = kernel.checkpoint();
});
afterAll(() => {
  kernel.releaseSince(mark);
});

describe('the converted goldens through OCCT', () => {
  for (const name of ['golden/shortboard.brd', 'golden/funboard.brd', 'golden/longboard.brd']) {
    it(
      name,
      () => {
        const r = convertClassic(classicSample(name).load());
        if (!r.ok) throw new Error(JSON.stringify(r.issues));
        const b = r.value.built;
        const m = massProperties(b.brep, b.doc.build.tolerances);
        // A point inside: mid-way between rocker and deck line at mid-length, on the stringer.
        const lines = stringerLines(b);
        const rock = curvePoint(lines.rocker, 0.5);
        const deck = curvePoint(lines.deck, 0.5);
        const arc = planArc(b.plan, true);
        const length = rock.x * 2;
        const solid: OcctSolid = {
          name: `board2-${name}`,
          volume: m.volume.value,
          area: m.area.value,
          curved: m.area.value,
          inside: [rock.x, 0, 0.5 * (rock.z + deck.z)],
          // The deck edge and the tuck are fitted onto the height fields (§5.5).
          fitted: { perimeter: 2 * arc.total, reach: Math.hypot(length, arc.total / 4, 20) },
          extent: Math.hypot(length + 10, arc.total / 4, 20),
          // All three faces are curved here: at the protocol's 0.01 mm OCCT meshes each
          // golden for 2–5 minutes per file unit. 0.03 mm (the stadium's and geom's V5b
          // setting) keeps the bound at 1.3e-3 to 1.6e-3 of the volume, under
          // MESH_BOUND_MAX_REL.
          deflectionMm: 0.03,
        };
        for (const fileUnit of ['mm', 'cm'] as const) {
          const p = pathB(kernel, b.brep, solid, fileUnit);
          expect(p.type).toBe('solid');
          expect(p.valid, 'B2 BRepCheck_Analyzer').toBe(true);
          expect(p.solids, 'B1').toBe(1);
          expect(p.shells).toBe(1);
          expect([p.faces, p.edges, p.vertices], 'B3').toEqual([3, 3, 2]);
          expect([p.stats.faces, p.stats.edges, p.stats.vertices]).toEqual([3, 3, 2]);
          expect(p.unmatchedEdges, 'B5').toEqual([]);
          expect(p.unmatchedFaces, 'B6').toBe(0);
          expect(p.contains).toEqual({ inside: true, outside: false });
          expect(p.grownMm, 'B4').toBeLessThanOrEqual(2 * p.declaredMm);
          expect(p.mesh.volume).toBeGreaterThan(0);
          expect(Math.abs(p.mesh.volume - p.mesh.exact), 'B8').toBeLessThanOrEqual(p.mesh.bound);
          expect(p.mesh.bound / p.mesh.exact).toBeLessThan(MESH_BOUND_MAX_REL);
        }
      },
      // A synchronous test (one WASM kernel): conversion 12 s, massProperties 11–14 s,
      // OCCT's mesh 1–2 min per file unit on the cloud container (S7 as built).
      600_000,
    );
  }
});
