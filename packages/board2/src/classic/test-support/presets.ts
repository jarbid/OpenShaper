// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The preset-recovery oracles (docs/design/board2.md §13.2 `convert`, step
 * S7): a classic rail preset applied to every real station of a golden board
 * (the kernel's `applyRailProfile`), converted with the converter's insets at
 * the preset's own band marks (`deckBand`, `bottomBand`: §5.3, the classic
 * `apex` and board2's `apexHeight` are then measured between the same marks),
 * and the apex height read back. Test-only (may import `@openshaper/io` through
 * `samples.ts`).
 *
 * Two checks of different strength (review of S7):
 *
 * - **The preset's own `apex` parameter** at the station nearest the widest
 *   point is the independent oracle: a number the classic editor was given,
 *   never seen by the converter.
 * - **The apex law against the classic loft at every in-range station** is a
 *   consistency check, partly circular: the converter fits the apex law to the
 *   classic's widest points (§9.7 as built, deviation 2), and this reading
 *   takes the same widest points (by dense sampling instead of golden-section
 *   search) between the same band marks. What it verifies independently is the
 *   classic heights at the marks (the oracle reads the loft, the converter its
 *   fitted deck and bottom) and the law's interpolation between its keys; it
 *   cannot catch a wrong choice of the widest point.
 *
 * The classic readings are the loft's own heights, by bisection on the ring
 * fraction of the loft section at the point's x (`loftSection`, `loftPoint`),
 * and its widest point by dense sampling of the ring.
 */
import { createScratch, curveEvalInto } from '@openshaper/geom';
import { applyRailProfile, loftPoint, loftSection, RAIL_PRESETS } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import type { BezierBoard, RailProfileParams } from '@openshaper/kernel';
import { bandContext, effectiveInsets } from '../../band/band';
import { lawEvaluator } from '../../law';
import { paramAtSigma, planFrame } from '../../plan';
import { convertDetailed } from '../convert';
import { DEFAULT_CONVERT_OPTIONS } from '../params';
import { classicSample } from './samples';
import type { DetailedConversion } from '../convert';

/** The board with `p` applied to every real station (the dummy end stations kept). */
export function presetBoard(board: BezierBoard, p: RailProfileParams): BezierBoard {
  const n = board.crossSections.length;
  return {
    ...board,
    crossSections: board.crossSections.map((cs, i) =>
      i === 0 || i === n - 1 ? cs : applyRailProfile(cs, p),
    ),
  };
}

/** A preset board and its conversion with the insets at the preset's band marks. */
export interface PresetRun {
  readonly board: BezierBoard;
  readonly run: DetailedConversion;
}

/** The conversion of `board` with preset `p` applied (module comment). */
export function convertPreset(board: BezierBoard, p: RailProfileParams): PresetRun {
  const preset = presetBoard(board, p);
  const r = convertDetailed(preset, {
    deckInsetFraction: p.deckBand,
    tuckInsetFraction: p.bottomBand,
  });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return { board: preset, run: r.value };
}

/** Ring samples of the dense apex search: a step of a few thousandths of a centimetre on a board's ring. */
const DENSE_RING = 20_000;

type Section = NonNullable<ReturnType<typeof loftSection>>;

function sectionAt(board: BezierBoard, xc: number): Section {
  const s = loftSection(board, xc);
  if (s === null) throw new Error(`no loft section at classic x = ${xc}`);
  return s;
}

/** The ring fraction of the widest point of a section, by dense sampling. */
function widestFraction(s: Section): number {
  let best = 0;
  let bestY = -Infinity;
  for (let k = 0; k <= DENSE_RING; k++) {
    const y = loftPoint(s, k / DENSE_RING).x;
    if (y > bestY) {
      bestY = y;
      best = k / DENSE_RING;
    }
  }
  return best;
}

/**
 * The classic surface's height at plan point (x, |y|) on one side (classic
 * coordinates): bisection on the ring fraction between the stringer and the
 * widest point, where |y| is monotone on the loft's ring.
 */
function classicHeight(board: BezierBoard, xc: number, y: number, side: 'deck' | 'bottom'): number {
  const s = sectionAt(board, xc);
  const fa = widestFraction(s);
  let lo = side === 'bottom' ? 0 : fa;
  let hi = side === 'bottom' ? fa : 1;
  const target = Math.abs(y);
  for (;;) {
    const mid = 0.5 * (lo + hi);
    if (!(mid > lo && mid < hi)) break;
    const ym = loftPoint(s, mid).x;
    // Bottom: y grows with f; deck: y falls with f.
    if (side === 'bottom' ? ym < target : ym > target) lo = mid;
    else hi = mid;
  }
  const p = loftPoint(s, 0.5 * (lo + hi));
  return p.y + s.rocker;
}

/** The classic apex height at a station, read in board2's station plane (module comment). */
export interface ApexReading {
  readonly sigma: number;
  readonly x: number;
  /** The document's apex-height law at σ. */
  readonly law: number;
  /** The classic loft's apex height between the document's own band marks at σ. */
  readonly classic: number;
  /** The plan tangent's angle to the x-axis at σ (radians): 0 where the station plane is an x-plane. */
  readonly tangentAngle: number;
}

/**
 * The apex readings at the converted preset board's real stations whose x
 * lies outside the tip windows (their columns are not fitted, §9.7 as built).
 */
export function apexReadings({ board, run }: PresetRun, tipWindow: number): readonly ApexReading[] {
  const { doc, report } = run.conversion;
  const shift = run.geometry.shift;
  const length = run.geometry.length;
  const ctx = bandContext(doc);
  const apexLaw = lawEvaluator(doc.laws.apexHeight);
  const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
  const q = new Float64Array(2);
  const out: ApexReading[] = [];
  for (const st of report.stationLaws) {
    if (!(st.x > tipWindow && st.x < length - tipWindow)) continue;
    const u = paramAtSigma(ctx.arc, st.sigma);
    curveEvalInto(ctx.plan, u, 0, q, 0, sc);
    const frame = planFrame(ctx.plan, u, true)!;
    const ins = effectiveInsets(ctx, u, st.sigma);
    const ax = q[0]!;
    const ay = q[1]!;
    const n = frame.inward;
    const ex = ax + ins.deckInset * n.x;
    const ey = ay + ins.deckInset * n.y;
    const tx = ax + ins.tuckInset * n.x;
    const ty = ay + ins.tuckInset * n.y;
    const sa = sectionAt(board, ax + shift);
    const pa = loftPoint(sa, widestFraction(sa));
    const za = pa.y + sa.rocker;
    const ze = classicHeight(board, ex + shift, ey, 'deck');
    const zt = classicHeight(board, tx + shift, ty, 'bottom');
    out.push({
      sigma: st.sigma,
      x: st.x,
      law: apexLaw(st.sigma),
      classic: (za - zt) / (ze - zt),
      tangentAngle: Math.abs(Math.atan2(frame.tangent.y, frame.tangent.x)),
    });
  }
  return out;
}

/** The recovered apex must match within this (§13.2: the classic places the apex exactly; the rest is fit error). */
export const APEX_RECOVERY = 0.01;

/**
 * The preset-recovery suite of one golden board (§13.2): every `RAIL_PRESETS`
 * entry applied to every real station and converted; at every station outside
 * the tip windows whose classic reading lies inside `apexHeightRange` (near the
 * nose the station plane cuts the classic rail so obliquely that its apex lies
 * above the deck mark, and the law is clamped to the range), the law is the
 * classic's apex height between the same marks within {@link APEX_RECOVERY};
 * at the station nearest the widest point, where the station plane is an
 * x-plane (tangent within a degree of the x-axis: measured 0.4–0.7°), it is the
 * preset's own `apex` parameter within the same.
 */
export function presetSuite(golden: string, cache: Map<string, PresetRun>): void {
  const base = classicSample(golden).load();
  describe(`preset recovery: ${golden}`, () => {
    for (const p of RAIL_PRESETS) {
      it(
        p.id,
        () => {
          const r = convertPreset(base, p.params);
          cache.set(p.id, r);
          const readings = apexReadings(r, DEFAULT_CONVERT_OPTIONS.tipWindow);
          const [lo, hi] = r.run.conversion.doc.build.apexHeightRange;
          const inRange = readings.filter((x) => x.classic >= lo && x.classic <= hi);
          expect(inRange.length).toBeGreaterThanOrEqual(2);
          // Consistency (partly circular: the law was fitted to these widest points).
          for (const x of inRange) {
            expect(Math.abs(x.law - x.classic), `consistency, σ ${x.sigma}`).toBeLessThanOrEqual(
              APEX_RECOVERY,
            );
          }
          // The independent oracle: the preset's own apex parameter.
          const wide = readings.reduce((a, b) => (b.tangentAngle < a.tangentAngle ? b : a));
          expect(wide.tangentAngle).toBeLessThan(Math.PI / 180);
          expect(
            Math.abs(wide.law - p.params.apex),
            'the preset’s apex parameter at the widest station',
          ).toBeLessThanOrEqual(APEX_RECOVERY);
        },
        PRESET_TIMEOUT,
      );
    }
  });
}

/** One conversion of a golden board takes 10–25 s on the cloud container under the suite's load (S7 as built). */
export const PRESET_TIMEOUT = 240_000;
