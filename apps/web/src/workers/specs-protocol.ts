import type { BezierBoard } from '@openshaper/kernel';
import type { BoardSpecs } from '@openshaper/store';

/**
 * Message protocol between the app and the specs worker (see
 * docs/design/specs-worker.md). The board is plain immutable data, so it
 * crosses the boundary by structured clone — no transferables needed.
 */

/** main → worker: compute the derived specs for this board. */
export interface SpecsRequest {
  /** Monotonically increasing; the response echoes it so stale results can be dropped. */
  id: number;
  board: BezierBoard;
}

/** worker → main. */
export type SpecsResponse =
  | { id: number; ok: true; specs: BoardSpecs }
  | { id: number; ok: false; error: string };
