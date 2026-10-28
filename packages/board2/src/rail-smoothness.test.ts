// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail smoothness between the stations (docs/design/m1-model.md "As built (rail smoothness)").
 *
 * The default shortboard's rails showed edges and bulges the classic surface does not have. Two things
 * caused them: a complete cubic spline through the five far-apart stations rang across the board (the
 * tuck 0.6 cm off, the apex height 5 mm low, the section normal turning back by 39 degrees), and the
 * section fit, which checked positions only, let a tip station's rail corner ring (12 to 30 degrees) and a
 * tight tuck swing its normal by 17. Station creases and edit continuity were tested; nothing looked at the
 * rails between the stations. This does, on every board of the review set, with measurements that read the
 * built surface:
 *
 * 1. **The normal turns one way through the rail.** In every section x = ξ between the stations, the
 *    outward normal of the physical section, walking from the apex down to the bottom and up to the deck
 *    while it is within 80 degrees of horizontal, never turns back by more than {@link REVERSAL_MAX}.
 *    (The classic loft's is at most 0.6 degrees; the old blend reached 39 to 46.)
 * 2. **Close to the classic loft.** On the converted classic boards the section is within
 *    {@link DISTANCE_MAX_MM} of the classic loft's at every x (outside a notch zone), and within
 *    {@link DISTANCE_MEAN_MM} on average. (Old blend: 4.7, 1.9 and 5.0 mm on the goldens, 2 mm mean.)
 * 3. **Every station is fitted on position and on direction.** The section fit checks the position (0.5 mm)
 *    and the tangent direction of the fitted section against the stored one's (4 degrees), and the build
 *    warns (`section-fit`, `section-normal`) when a rung of the ladder could not meet them.
 * 4. **No ringing of the rail landmarks.** The apex height and the two 45 degree points (the tuck on the
 *    bottom half, the deck edge) of the blended section between two stations stay within the range of the
 *    two stations' values plus {@link LANDMARK_MARGIN} (normalised units).
 */
import { describe, expect, it } from 'vitest';
import { boardSet, buildOrThrow, ringDeviation } from './test-support/board-set';
import { SECTION_FIT_TOL, SECTION_NORMAL_TOL } from './params';
import { buildBoard } from './surface';
import { LANDMARK_KEYS, landmarksAt, railReversal } from './test-support/rail-metrics';

/** Largest reversal of the rail's normal angle (rad): 3 degrees. */
const REVERSAL_MAX = (3 * Math.PI) / 180;
/** Largest distance of the section from the classic loft's (mm), on the goldens, and its mean. */
const DISTANCE_MAX_MM = 2;
const DISTANCE_MEAN_MM = 0.8;
/** How far a rail landmark may leave the range of the two stations' values (normalised u or v). */
const LANDMARK_MARGIN = 0.03;
/** Spacing (cm) of the sections the reversal and the distance are measured at. */
const STEP_REVERSAL = 1;
const STEP_DISTANCE = 4;
/** Samples inside each station interval for the landmarks. */
const LANDMARK_SAMPLES = 12;
/** A section this far (cm) behind the end of a notch zone, or from a tip, is measured. */
const ZONE_MARGIN = 12;
const TIP_MARGIN = 2;

describe.each(boardSet().map((b) => [b.name, b] as const))('%s', (_name, nb) => {
  const built = buildOrThrow(nb.doc);
  const zone = built.doc.tail.kind === 'notched' ? built.doc.tail.zone : 0;
  const sides: (0 | 1)[] = built.doc.symmetry === 'mirror' ? [0] : [0, 1];
  const xs = Array.from(built.sides[0].blend.xs);

  it('the rail normal turns one way between the stations', () => {
    let worst = 0;
    let at = 0;
    for (let x = Math.max(1, zone + 1); x <= built.xiMax - 1; x += STEP_REVERSAL) {
      for (const side of sides) {
        const r = railReversal(built, x, side);
        if (r > worst) {
          worst = r;
          at = x;
        }
      }
    }
    expect(
      (worst * 180) / Math.PI,
      `largest reversal ${((worst * 180) / Math.PI).toFixed(2)} degrees at x = ${at.toFixed(1)}`,
    ).toBeLessThanOrEqual((REVERSAL_MAX * 180) / Math.PI);
  });

  it('every station is within the position and tangent-direction limits, with no warnings', () => {
    const r = buildBoard(nb.doc, { check: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(r.value.report.stationFitError).toBeLessThanOrEqual(SECTION_FIT_TOL);
    expect(r.value.report.stationNormalError).toBeLessThanOrEqual(SECTION_NORMAL_TOL);
  });

  it('the rail landmarks stay within the range of the stations on both sides', () => {
    for (const side of sides) {
      const blend = built.sides[side].blend;
      for (let i = 0; i + 1 < xs.length; i++) {
        const a = landmarksAt(blend, xs[i]!);
        const b = landmarksAt(blend, xs[i + 1]!);
        for (let k = 1; k < LANDMARK_SAMPLES; k++) {
          const x = xs[i]! + ((xs[i + 1]! - xs[i]!) * k) / LANDMARK_SAMPLES;
          const l = landmarksAt(blend, x);
          for (const key of LANDMARK_KEYS) {
            const lo = Math.min(a[key], b[key]) - LANDMARK_MARGIN;
            const hi = Math.max(a[key], b[key]) + LANDMARK_MARGIN;
            expect(
              l[key],
              `${key} at x = ${x.toFixed(1)} between ${xs[i]!.toFixed(1)} and ${xs[i + 1]!.toFixed(1)}`,
            ).toBeGreaterThanOrEqual(lo);
            expect(l[key], `${key} at x = ${x.toFixed(1)}`).toBeLessThanOrEqual(hi);
          }
        }
      }
    }
  });

  if (nb.classic !== undefined) {
    it('the section stays close to the classic loft between the stations', () => {
      const from = Math.max(TIP_MARGIN, zone === 0 ? 0 : zone + ZONE_MARGIN);
      let max = 0;
      let sum = 0;
      let n = 0;
      let at = 0;
      for (let x = from; x <= built.xiMax - TIP_MARGIN; x += STEP_DISTANCE) {
        const d = ringDeviation(nb.classic!, built, x) * 10;
        if (!Number.isFinite(d)) continue;
        sum += d;
        n++;
        if (d > max) {
          max = d;
          at = x;
        }
      }
      expect(n).toBeGreaterThan(20);
      expect(
        max,
        `largest distance ${max.toFixed(2)} mm at x = ${at.toFixed(1)}`,
      ).toBeLessThanOrEqual(DISTANCE_MAX_MM);
      expect(sum / n, 'mean distance (mm)').toBeLessThanOrEqual(DISTANCE_MEAN_MM);
    });
  }
});
