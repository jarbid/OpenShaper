// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Writes the fitted-against-real sections the design note's pictures are drawn from
 * (`docs/design/rail-laws-test.md`). The JSON goes to `$RAIL_OUT`; it is scratch output and
 * is not committed. Run on demand:
 *
 *   RAIL_STUDY=1 RAIL_OUT=/tmp/.../cases.json \
 *     pnpm --filter @openshaper/board2 exec vitest run src/railproto/cases.measure.test.ts
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blend, fitSingle, fitStation } from './rail-fit';
import { conicPolyline, lineMeet, sampleAt, turnIndex } from './rail-geom';
import type { RealSection } from './rail-geom';
import { allBoards, boardSections, denseSections } from './rail-samples';
import { DENSE_STATIONS } from './rail-params';

const study = describe.skipIf(process.env.RAIL_STUDY !== '1' || !process.env.RAIL_OUT);

interface Case {
  title: string;
  board: string;
  x: number;
  xOverL: number;
  chord: number;
  thickness: number;
  maxMm: number;
  rmsMm: number;
  params: { turnB: number; rhoB: number; turnD: number; rhoD: number };
  /** Whole section, `[y, z, …]` cm. */
  section: number[];
  /** Model over the rail region, `[y, z, …]` cm. */
  model: number[];
  /** A single conic over the same region, when asked for. */
  single?: number[];
  singleMaxMm?: number;
  apex: [number, number];
  tangents: [number, number][];
  /** Signed residual along the rail region: `[arcFromApex, signedMm]` pairs. */
  residual: number[];
}

/** Model polyline over the whole rail region, bottom tangent point to deck tangent point. */
function modelOf(s: RealSection, f: NonNullable<ReturnType<typeof fitStation>>): number[] {
  const b = blend(s, 'bottom', f.bottom.turn, f.bottom.rho)!;
  const d = blend(s, 'deck', f.deck.turn, f.deck.rho)!;
  return [...conicPolyline(b.conic), ...conicPolyline(d.conic)];
}

const segDist = (
  py: number,
  pz: number,
  qy: number,
  qz: number,
  ry: number,
  rz: number,
): { d: number; y: number; z: number } => {
  const ey = ry - qy;
  const ez = rz - qz;
  const wy = py - qy;
  const wz = pz - qz;
  const ee = ey * ey + ez * ez;
  const f = ee > 0 ? Math.min(1, Math.max(0, (wy * ey + wz * ez) / ee)) : 0;
  return { d: Math.hypot(wy - f * ey, wz - f * ez), y: qy + f * ey, z: qz + f * ez };
};

/**
 * Signed distance of each section sample in the rail region from the model, mm, against the
 * model's **segments** — the same measure `deviation` uses. Positive means the model lies
 * outboard of the section (further from the stringer).
 */
function residualOf(s: RealSection, from: number, to: number, model: number[]): number[] {
  const out: number[] = [];
  const apexArc = s.arc[s.apex]!;
  for (let i = Math.ceil(from); i <= Math.floor(to); i++) {
    const y = s.pts[2 * i]!;
    const z = s.pts[2 * i + 1]!;
    let best = { d: Infinity, y: 0, z: 0 };
    for (let j = 0; 2 * j + 3 < model.length; j++) {
      const c = segDist(y, z, model[2 * j]!, model[2 * j + 1]!, model[2 * j + 2]!, model[2 * j + 3]!);
      if (c.d < best.d) best = c;
    }
    out.push(s.arc[i]! - apexArc, (best.y >= y ? 1 : -1) * best.d * 10);
  }
  return out;
}

function caseOf(
  title: string,
  board: string,
  length: number,
  s: RealSection,
  withSingle: boolean,
): Case | null {
  const f = fitStation(s);
  if (f === null) return null;
  const model = modelOf(s, f);
  const fB = turnIndex(s, 'bottom', f.bottom.turn);
  const fD = turnIndex(s, 'deck', f.deck.turn);
  const c: Case = {
    title,
    board,
    x: s.x,
    xOverL: s.x / length,
    chord: s.chord,
    thickness: s.thickness,
    maxMm: f.max * 10,
    rmsMm: f.rms * 10,
    params: {
      turnB: f.bottom.turn,
      rhoB: f.bottom.rho,
      turnD: f.deck.turn,
      rhoD: f.deck.rho,
    },
    section: Array.from(s.pts),
    model,
    apex: [s.pts[2 * s.apex]!, s.pts[2 * s.apex + 1]!],
    tangents: [sampleAt(s, fB).p as [number, number], sampleAt(s, fD).p as [number, number]],
    residual: residualOf(s, fB, fD, model),
  };
  if (withSingle) {
    const one = fitSingle(s, f.bottom.turn, f.deck.turn);
    const B = sampleAt(s, fB);
    const D = sampleAt(s, fD);
    const m = lineMeet(B.p, B.t, D.p, [-D.t[0], -D.t[1]]);
    if (one !== null && m !== null) {
      c.single = Array.from(conicPolyline({ p0: B.p, p1: m.p, p2: D.p, rho: one.rho }));
      c.singleMaxMm = one.max * 10;
    }
  }
  return c;
}

study('pictures', () => {
  it('writes the good, the worst, a near-tail and a one-conic case', () => {
    const boards = allBoards();
    const cases: Case[] = [];

    // A typical good fit: the shortboard's widest stored station.
    {
      const b = boards.find((x) => x.name === 'shortboard')!;
      const bs = boardSections(b);
      const s = bs.sections.reduce((a, c) => (c.chord > a.chord ? c : a));
      const c = caseOf('A good fit — shortboard at its widest', b.name, bs.length, s, false);
      if (c !== null) cases.push(c);
    }

    // The worst stored station anywhere.
    {
      let worst: { c: Case } | null = null;
      for (const b of boards) {
        const bs = boardSections(b);
        for (const s of bs.sections) {
          const c = caseOf('The worst fit', b.name, bs.length, s, false);
          if (c !== null && (worst === null || c.maxMm > worst.c.maxMm)) worst = { c };
        }
      }
      if (worst !== null) cases.push(worst.c);
    }

    // The worst station in the tail quarter of the dense set, where rails go hard.
    {
      let worst: { c: Case } | null = null;
      for (const b of boards) {
        const bs = denseSections(b, DENSE_STATIONS);
        for (const s of bs.sections) {
          if (s.x / bs.length > 0.2) continue;
          const c = caseOf('Near the tail', b.name, bs.length, s, false);
          if (c !== null && (worst === null || c.maxMm > worst.c.maxMm)) worst = { c };
        }
      }
      if (worst !== null) cases.push(worst.c);
    }

    // One conic against two, on the station where one conic does worst.
    {
      let worst: { c: Case } | null = null;
      for (const b of boards) {
        const bs = boardSections(b);
        for (const s of bs.sections) {
          const c = caseOf('One conic instead of two', b.name, bs.length, s, true);
          if (
            c !== null &&
            c.singleMaxMm !== undefined &&
            (worst === null || c.singleMaxMm > (worst.c.singleMaxMm ?? 0))
          ) {
            worst = { c };
          }
        }
      }
      if (worst !== null) cases.push(worst.c);
    }

    writeFileSync(process.env.RAIL_OUT!, JSON.stringify(cases));
    for (const c of cases) {
      console.log(
        `${c.title}: ${c.board} x=${c.x.toFixed(1)} (x/L=${c.xOverL.toFixed(2)}) ` +
          `max=${c.maxMm.toFixed(2)}mm` +
          (c.singleMaxMm === undefined ? '' : ` single=${c.singleMaxMm.toFixed(2)}mm`),
      );
    }
    expect(cases.length).toBeGreaterThan(2);
  });
});
