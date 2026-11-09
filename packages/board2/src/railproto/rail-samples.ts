// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Boards the rail-law study measures (`docs/design/rail-laws-test.md`). Scratch module:
 * the engine never imports it.
 *
 * The eight Shape3D boards of `Sample board imports/carlos/` are third-party and
 * gitignored; {@link carlosBoards} returns an empty list when the folder is absent, so a
 * run in a fresh clone skips them instead of failing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseS3dx } from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';
import { convertClassic } from '../classic';
import { createChordFn, probeSection } from '../probe';
import { compileChain, funcEval } from '../chain';
import { buildBoard, createEvaluator } from '../surface';
import { asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import { GOLDENS } from '../test-support/classic-samples';
import { fromPolyline, realSection } from './rail-geom';
import type { RealSection } from './rail-geom';
import { MIN_CHORD, MIN_THICKNESS, SECTION_SAMPLES } from './rail-params';
import type { BoardDoc } from '../types';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CARLOS = resolve(repo, 'Sample board imports/carlos');

export interface StudyBoard {
  readonly name: string;
  readonly doc: BoardDoc;
  readonly group: 'carlos' | 'golden' | 'synthetic';
}

/** The eight Shape3D sample boards, or `[]` when the gitignored folder is absent. */
export function carlosBoards(): StudyBoard[] {
  if (!existsSync(CARLOS)) return [];
  const out: StudyBoard[] = [];
  for (const f of readdirSync(CARLOS).sort()) {
    if (!/\.s3dx$/i.test(f)) continue;
    const classic: BezierBoard = parseS3dx(readFileSync(resolve(CARLOS, f), 'utf8')).board;
    const conv = convertClassic(classic);
    if (!conv.ok) continue;
    out.push({ name: f.replace(/\.s3dx$/i, ''), doc: conv.value.doc, group: 'carlos' });
  }
  return out;
}

/** The three golden boards, converted. */
export function goldenBoards(): StudyBoard[] {
  const out: StudyBoard[] = [];
  for (const s of GOLDENS) {
    const conv = convertClassic(s.load());
    if (!conv.ok) continue;
    out.push({
      name: s.name.replace(/^.*\//, '').replace(/\.brd$/, ''),
      doc: conv.value.doc,
      group: 'golden',
    });
  }
  return out;
}

/** The package's own hand-built test boards. */
export function syntheticBoards(): StudyBoard[] {
  return [
    { name: 'swallow', doc: swallowBoard(), group: 'synthetic' as const },
    { name: 'fish', doc: fishBoard(), group: 'synthetic' as const },
    { name: 'asymmetric', doc: asymmetricBoard(), group: 'synthetic' as const },
  ];
}

export const allBoards = (): StudyBoard[] => [
  ...carlosBoards(),
  ...goldenBoards(),
  ...syntheticBoards(),
];

export interface BoardSections {
  readonly name: string;
  readonly group: StudyBoard['group'];
  readonly length: number;
  readonly sections: readonly RealSection[];
  /** Stations left out, with why. */
  readonly skipped: readonly string[];
}

/**
 * Every usable station of a board as a real-coordinate section. A station is dropped when
 * the board is too thin or too narrow there to have a rail at all (the tips are a lens).
 */
export function boardSections(b: StudyBoard): BoardSections {
  const built = buildBoard(b.doc, { check: false });
  if (!built.ok) throw new Error(`${b.name}: ${built.issues.map((i) => i.message).join('; ')}`);
  const chordOf = createChordFn(b.doc);
  const rocker = compileChain(b.doc.rocker);
  const deck = compileChain(b.doc.deck);
  const r = new Float64Array(2);
  const d = new Float64Array(2);
  const sections: RealSection[] = [];
  const skipped: string[] = [];
  for (const st of b.doc.stations) {
    const chord = chordOf(st.x);
    funcEval(rocker, st.x, r, 0);
    funcEval(deck, st.x, d, 0);
    const thickness = d[0]! - r[0]!;
    if (thickness < MIN_THICKNESS || chord < MIN_CHORD) {
      skipped.push(`x=${st.x.toFixed(1)} (T=${thickness.toFixed(2)}, W=${chord.toFixed(2)})`);
      continue;
    }
    sections.push(realSection(st.plus, st.x, chord, thickness));
  }
  return {
    name: b.name,
    group: b.group,
    length: built.value.xiMax,
    sections,
    skipped,
  };
}

/**
 * The as-built section at `count` evenly spaced stations between the first and last usable
 * stored station: the engine's own rail, sampled densely enough to ask whether a parameter
 * varies smoothly along a board. The stored stations alone are 3 to 6 per board, which any
 * 5-degree-of-freedom law curve fits exactly, so the question would be vacuous on them.
 *
 * The caveat, stated once here and again in the design note: between stations this is
 * board2's own C2 blend of the stored sections, not independent designer data, so it is
 * smoother than reality. It bounds law smoothness from the optimistic side.
 */
export function denseSections(b: StudyBoard, count: number): BoardSections {
  const built = buildBoard(b.doc, { check: false });
  if (!built.ok) throw new Error(`${b.name}: ${built.issues.map((i) => i.message).join('; ')}`);
  const ev = createEvaluator(built.value);
  const chordOf = createChordFn(b.doc);
  const rocker = compileChain(b.doc.rocker);
  const deck = compileChain(b.doc.deck);
  const r = new Float64Array(2);
  const d = new Float64Array(2);
  const usable = boardSections(b).sections;
  if (usable.length < 2) return { ...boardSections(b), sections: [] };
  const x0 = usable[0]!.x;
  const x1 = usable[usable.length - 1]!.x;
  const sections: RealSection[] = [];
  const skipped: string[] = [];
  // 2 n + 1 samples puts the apex (the section's t = 1/2) on the middle sample exactly.
  const n = SECTION_SAMPLES;
  for (let k = 0; k < count; k++) {
    const x = x0 + ((x1 - x0) * k) / (count - 1);
    const chord = chordOf(x);
    funcEval(rocker, x, r, 0);
    funcEval(deck, x, d, 0);
    const thickness = d[0]! - r[0]!;
    if (thickness < MIN_THICKNESS || chord < MIN_CHORD) {
      skipped.push(`x=${x.toFixed(1)}`);
      continue;
    }
    const pts = Float64Array.from(probeSection(built.value, ev, 0, x, 2 * n + 1));
    sections.push(fromPolyline(pts, n, x, chord, thickness));
  }
  return { name: b.name, group: b.group, length: built.value.xiMax, sections, skipped };
}
