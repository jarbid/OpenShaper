// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * First look at the data behind the rail-law study: which boards load, how many stations
 * each has, and what one real section looks like. Run on demand:
 *
 *   RAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/railproto/probe.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import { allBoards, boardSections, denseSections } from './test-support/rail-samples';
import { deviation, turnIndex } from './rail-geom';

const study = describe.skipIf(process.env.RAIL_STUDY !== '1');

study('rail study data', () => {
  it('loads every board and reports its stations', () => {
    const boards = allBoards();
    console.log(`boards: ${boards.length}`);
    for (const b of boards) {
      const bs = boardSections(b);
      console.log(
        `${bs.group.padEnd(9)} ${bs.name.padEnd(46)} L=${bs.length.toFixed(0).padStart(4)}cm ` +
          `stations=${String(bs.sections.length).padStart(3)} skipped=${bs.skipped.length}`,
      );
    }
    expect(boards.length).toBeGreaterThan(0);
  });

  it('shows one real section and its turn profile', () => {
    const b = allBoards().find((x) => x.group === 'golden' && x.name === 'shortboard')!;
    const bs = boardSections(b);
    const s = bs.sections[Math.floor(bs.sections.length / 2)]!;
    console.log(
      `shortboard x=${s.x.toFixed(1)} chord=${s.chord.toFixed(2)} T=${s.thickness.toFixed(2)} ` +
        `apexZ=${s.pts[2 * s.apex + 1]!.toFixed(3)} arc=${s.arc[s.count - 1]!.toFixed(2)}`,
    );
    for (const deg of [30, 50, 60, 70, 80, 85]) {
      const fb = turnIndex(s, 'bottom', deg);
      const fd = turnIndex(s, 'deck', deg);
      const insetOf = (f: number): string =>
        f < 0 ? '  n/a' : (s.chord - s.pts[2 * Math.round(f)]!).toFixed(2).padStart(5);
      console.log(
        `  turn ${String(deg).padStart(2)}deg  bottom inset ${insetOf(fb)} cm   deck inset ${insetOf(fd)} cm`,
      );
    }
    // the stored section's bottom half turns monotonically into the apex
    const phi = Array.from({ length: s.apex + 1 }, (_, i) => s.phi[i]!);
    console.log(
      `  phi bottom centre=${phi[0]!.toFixed(1)} apex=${phi[phi.length - 1]!.toFixed(1)}`,
    );
    console.log(`  phi deck centre=${s.phi[s.count - 1]!.toFixed(1)}`);
    expect(s.count).toBeGreaterThan(100);
  });
});

study('the dense as-built set', () => {
  it('puts the apex on the middle sample and tracks the stored sections', () => {
    for (const b of allBoards()
      .filter((x) => x.group !== 'synthetic')
      .slice(0, 5)) {
      const dense = denseSections(b, 21);
      let apexSlip = 0;
      for (const s of dense.sections) {
        let widest = 0;
        for (let i = 0; i < s.count; i++) if (s.pts[2 * i]! > s.pts[2 * widest]!) widest = i;
        apexSlip = Math.max(apexSlip, Math.abs(s.pts[2 * widest]! - s.pts[2 * s.apex]!));
      }
      const stored = boardSections(b).sections;
      let worst = 0;
      for (const st of stored) {
        const near = dense.sections.reduce((a, c) =>
          Math.abs(c.x - st.x) < Math.abs(a.x - st.x) ? c : a,
        );
        if (Math.abs(near.x - st.x) > 0.5) continue;
        const d = deviation(st, 0, st.count - 1, near.pts);
        worst = Math.max(worst, d.max);
      }
      console.log(
        `${b.name.padEnd(46)} dense=${String(dense.sections.length).padStart(2)} ` +
          `apex-vs-widest=${(apexSlip * 10).toFixed(3)}mm  stored-vs-asbuilt=${(worst * 10).toFixed(2)}mm`,
      );
    }
    expect(true).toBe(true);
  });
});
