// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Option B of the tail-model study (`docs/design/tail-model.md`): chords perpendicular to the
 * outline in plan, on the three goldens (standard tails, where the rule applies everywhere).
 * Measures the migration cost — how far a converted classic board moves from the classic loft,
 * the project's own measure (`m1-model.md` §13: today 1.02 / 0.70 / 1.07 mm) — whether the
 * chords cross, and the live-mesh cost.
 *
 *   TAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/tailproto/normal.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import { chainEval, compileChain } from '../chain';
import { meshBoard } from '../mesh';
import { buildBoard } from '../surface';
import type { BuiltBoard } from '../surface';
import { boardSet, planeSections, sectionDeviation } from '../test-support/board-set';
import type { BoardDoc } from '../types';
import { normalMapFactory } from './maps';
import { PROTO_ANGLE_SAMPLES } from './proto-params';

const build = (doc: BoardDoc, normal: boolean): BuiltBoard => {
  const r = buildBoard(doc, { check: false, chordMap: normal ? normalMapFactory : undefined });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

const SET = boardSet().filter((b) => b.classic !== undefined && b.doc.tail.kind === 'standard');

// Study runs only on demand: TAIL_STUDY=1 keeps it out of the package's suite.
const study = describe.skipIf(process.env.TAIL_STUDY !== '1');

study('tail model: perpendicular chords', () => {
  it('chords cross, or they do not', () => {
    const rows: string[] = [];
    for (const { name, doc } of SET) {
      const chain = compileChain(doc.outline.plus);
      const o = new Float64Array(6);
      let worstFoot = Infinity;
      let at = 0;
      let maxTilt = 0;
      for (let i = 0; i <= PROTO_ANGLE_SAMPLES; i++) {
        const s = (chain.segments * i) / PROTO_ANGLE_SAMPLES;
        chainEval(chain, s, 2, o, 0);
        const xs = o[2]! === 0 ? Number.EPSILON : o[2]!;
        const dfoot =
          xs + (o[3]! * o[3]!) / xs + (o[1]! * (o[5]! * xs - o[3]! * o[4]!)) / (xs * xs);
        if (dfoot < worstFoot) {
          worstFoot = dfoot;
          at = o[0]!;
        }
        const foot = o[0]! + (o[1]! * o[3]!) / xs;
        maxTilt = Math.max(
          maxTilt,
          (Math.abs(Math.atan2(o[0]! - foot, Math.max(o[1]!, Number.EPSILON))) * 180) / Math.PI,
        );
      }
      rows.push(
        `${name} | min d(foot)/ds ${worstFoot.toFixed(2)} at x=${at.toFixed(1)} ${worstFoot > 0 ? '(monotone)' : '(CHORDS CROSS)'} | max chord tilt from the x-plane ${maxTilt.toFixed(0)} deg`,
      );
      console.log(rows[rows.length - 1]);
    }
    console.log('\n[H] option B: chord geometry\n' + rows.join('\n'));
    expect(rows.length).toBe(SET.length);
  });

  it('distance from the classic loft, and the live mesh', () => {
    const rows: string[] = [];
    for (const { name, doc, classic } of SET) {
      const L = doc.rocker.knots[doc.rocker.knots.length - 1]!.p[0];
      const xs: number[] = [];
      for (let x = 10; x <= L - 10; x += 10) xs.push(x);
      const out: string[] = [];
      for (const normal of [false, true]) {
        const built = build(doc, normal);
        const cut = planeSections(built, xs);
        let max = 0;
        let sum = 0;
        let n = 0;
        xs.forEach((x, k) => {
          const d = sectionDeviation(classic!, cut.segments[k]!, x);
          if (Number.isFinite(d)) {
            max = Math.max(max, d);
            sum += d;
            n++;
          }
        });
        const t0 = performance.now();
        const mesh = meshBoard(built);
        const ms = performance.now() - t0;
        out.push(
          `${normal ? '[B]' : '[today]'} loft max ${(10 * max).toFixed(2)} mm mean ${((10 * sum) / Math.max(n, 1)).toFixed(2)} mm | verts ${mesh.positions.length / 3} | mesh ${ms.toFixed(0)} ms`,
        );
      }
      rows.push(`${name} | ${out.join(' || ')}`);
      console.log(rows[rows.length - 1]);
    }
    console.log('\n[I] option B: distance from the classic loft\n' + rows.join('\n'));
    expect(rows.length).toBe(SET.length);
  }, 1_800_000);
});
