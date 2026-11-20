// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A study, kept out of the default run: how far each starter template can be scaled before the board it
 * makes stops being a good one. It builds and meshes many boards, so it takes minutes:
 *
 *   BOARD_TYPES_STUDY=1 BOARD_TYPES_STUDY_OUT=/some/file.txt \
 *     pnpm --filter @openshaper/web exec vitest run src/board-types.measure.test.ts
 *
 * Part one: for each template it scales one dimension at a time and then all three together, from 0.5 to 1.7 times the
 * drawn size, and records what the engine says (does it build, any issue, is the mesh closed, is the volume
 * what the scale predicts) and how thin the board is at its tips. Part two builds the eight corners of each
 * kind's box (the least and the greatest of the three ranges) and records the litres. The ranges in
 * `board-types.ts` are chosen from shaping norms and checked against this.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { buildRails, meshRails } from '@openshaper/board2';
import { thicknessAt } from '@openshaper/store/rails';
import { describe, it } from 'vitest';
import { BOARD_TYPES, DIMENSIONS, type BoardSize } from './board-types';
import { measureRails, sizeRailsBoard } from './board-sizing';
import { NURBS_TEMPLATES } from './templates';
import { openEdges } from './test/mesh-closed';
import { templateRails } from './test/template-rails';

const study = describe.skipIf(!process.env.BOARD_TYPES_STUDY);
const OUT = process.env.BOARD_TYPES_STUDY_OUT;
const say = (line: string) => {
  if (OUT) appendFileSync(OUT, `${line}\n`);
};

const FACTORS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7];

interface Row {
  readonly label: string;
  readonly size: BoardSize;
}

study('how far a template can be scaled', () => {
  if (OUT) writeFileSync(OUT, '');
  it.each(NURBS_TEMPLATES.map((t) => t.name))(
    '%s',
    async (name) => {
      const base = await templateRails(name);
      const drawn = measureRails(base);
      const v0 = (() => {
        const b = buildRails(base);
        if (!b.ok) throw new Error('drawn board does not build');
        return meshRails(b.value).volume;
      })();
      const rows: Row[] = [];
      for (const f of FACTORS) {
        rows.push({ label: `L x${f}`, size: { ...drawn, length: drawn.length * f } });
        rows.push({ label: `W x${f}`, size: { ...drawn, width: drawn.width * f } });
        rows.push({ label: `T x${f}`, size: { ...drawn, thickness: drawn.thickness * f } });
        rows.push({
          label: `all x${f}`,
          size: {
            length: drawn.length * f,
            width: drawn.width * f,
            thickness: drawn.thickness * f,
          },
        });
      }
      say(
        `## ${name}: drawn ${drawn.length.toFixed(2)} x ${drawn.width.toFixed(2)} x ${drawn.thickness.toFixed(3)} cm, ${(v0 / 1000).toFixed(2)} L`,
      );
      for (const r of rows) {
        const t0 = performance.now();
        const sized = sizeRailsBoard(base, r.size);
        const m = measureRails(sized);
        const knots = sized.outline.plus.knots;
        const tipThin = Math.min(
          thicknessAt(sized.rocker, sized.deck, 0),
          thicknessAt(sized.rocker, sized.deck, knots[knots.length - 1]!.p[0]),
        );
        const built = buildRails(sized);
        let verdict: string;
        if (!built.ok) {
          verdict = `REFUSED ${built.issues.map((i) => i.code).join(',')}`;
        } else {
          const mesh = meshRails(built.value);
          const open = openEdges(mesh.positions, mesh.indices);
          const fL = r.size.length / drawn.length;
          const fW = r.size.width / drawn.width;
          const fT = r.size.thickness / drawn.thickness;
          const affine = v0 * fL * fW * fT;
          const fill = mesh.volume / (r.size.length * r.size.width * r.size.thickness);
          verdict = `issues=${built.issues.length} open=${open}${mesh.coarsened ? ' COARSE' : ''} V=${(mesh.volume / 1000).toFixed(2)}L V/affine=${(mesh.volume / affine).toFixed(3)} fill=${fill.toFixed(3)}`;
        }
        say(
          `${r.label.padEnd(9)} ${(r.size.length / 2.54 / 12).toFixed(2)}ft x ${(r.size.width / 2.54).toFixed(2)}in x ${(r.size.thickness / 2.54).toFixed(3)}in  measured ${m.length.toFixed(2)}/${m.width.toFixed(2)}/${m.thickness.toFixed(3)}  tip ${(tipThin * 10).toFixed(2)}mm  ${verdict}  ${(performance.now() - t0).toFixed(0)}ms`,
        );
      }
    },
    600_000,
  );
});

study('the eight corners of each kind', () => {
  it.each(BOARD_TYPES.map((t) => t.name))(
    '%s',
    async (name) => {
      const type = BOARD_TYPES.find((t) => t.name === name)!;
      const base = await templateRails(name);
      const drawn = measureRails(base);
      const built0 = buildRails(base);
      if (!built0.ok) throw new Error('drawn board does not build');
      const v0 = meshRails(built0.value).volume;
      say(`## corners of ${name}`);
      let least = Infinity;
      let greatest = -Infinity;
      for (let mask = 0; mask < 8; mask++) {
        const size = Object.fromEntries(
          DIMENSIONS.map((d, i) => [
            d,
            mask & (1 << i) ? type.ranges[d].greatest : type.ranges[d].least,
          ]),
        ) as unknown as BoardSize;
        const sized = sizeRailsBoard(base, size);
        const built = buildRails(sized);
        if (!built.ok) {
          say(`corner ${mask.toString(2).padStart(3, '0')} REFUSED`);
          continue;
        }
        const mesh = meshRails(built.value);
        const open = openEdges(mesh.positions, mesh.indices);
        const affine =
          v0 *
          (size.length / drawn.length) *
          (size.width / drawn.width) *
          (size.thickness / drawn.thickness);
        least = Math.min(least, mesh.volume);
        greatest = Math.max(greatest, mesh.volume);
        say(
          `corner ${mask.toString(2).padStart(3, '0')} ${(size.length / 2.54 / 12).toFixed(2)}ft x ${(size.width / 2.54).toFixed(2)}in x ${(size.thickness / 2.54).toFixed(3)}in  issues=${built.issues.length} open=${open}${mesh.coarsened ? ' COARSE' : ''} V=${(mesh.volume / 1000).toFixed(2)}L V/affine=${(mesh.volume / affine).toFixed(3)} fill=${(mesh.volume / (size.length * size.width * size.thickness)).toFixed(3)}`,
        );
      }
      say(`litres at the corners: ${(least / 1000).toFixed(1)} to ${(greatest / 1000).toFixed(1)}`);
    },
    600_000,
  );
});
