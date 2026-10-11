import type { BezierBoard } from '@openshaper/kernel';
import type { BoardSpecs } from '@openshaper/store';

/**
 * Message protocol between the app and the specs worker (see
 * docs/design/specs-worker.md). The board is plain immutable data, so it
 * crosses the boundary by structured clone — no transferables needed.
 */

/** One distribution sample: board-length x and cross-sectional area at that station. */
export interface DistributionSample {
  x: number;
  value: number;
}

/**
 * One sample of the rail apex height: board-length x and the board height (z) of that
 * station's widest point, on the +y rail.
 */
export interface ApexSample {
  x: number;
  z: number;
}

/** main → worker: compute the derived specs for this board. */
export interface SpecsRequest {
  /** Monotonically increasing; the response echoes it so stale results can be dropped. */
  id: number;
  board: BezierBoard;
  /**
   * When true the worker also computes the cross-sectional-area distribution
   * (step 4 of the specs-worker migration). Defaults to false.
   */
  wantDistribution?: boolean;
  /**
   * Number of equal-spaced intervals to sample along the board length.
   * Produces (distributionIntervals + 1) samples. Defaults to 40.
   */
  distributionIntervals?: number;
  /**
   * When true the worker also traces the rail apex height (the rocker view's apex
   * overlay). Defaults to false.
   */
  wantApex?: boolean;
}

/** worker → main. */
export type SpecsResponse =
  | {
      id: number;
      ok: true;
      specs: BoardSpecs;
      /** Present only when the request included wantDistribution: true. */
      distribution?: DistributionSample[];
      /** Present only when the request included wantApex: true (empty if none could be traced). */
      apex?: ApexSample[];
    }
  | { id: number; ok: false; error: string };
