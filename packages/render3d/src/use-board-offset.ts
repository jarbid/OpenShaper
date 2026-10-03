import type { BezierBoard } from '@openshaper/kernel';
import { useEffect, useState } from 'react';
import { boardCenter, tessellateAsync } from './geometry';

/** Where board-coordinate geometry goes, and which board that placement is for. */
export interface BoardPlacement {
  /** The negated bounding-box centre of the hull mesh: what `meshToGeometry` subtracts. */
  offset: [number, number, number];
  /**
   * The board the hull on screen was meshed from. While a newer board is still
   * tessellating in the worker this lags the live one, and overlays built from it
   * (fins, guides) stay with the hull instead of running ahead of it.
   */
  board: BezierBoard;
}

/**
 * The translation that puts board-coordinate geometry (fins, guide lines) on the
 * centred hull, and the board it belongs to. Read from the same (shared, cached)
 * tessellation as the hull, so it never disagrees with it. Null until the first
 * mesh arrives; on a failed or superseded tessellation the previous one stays.
 */
export function useBoardOffset(board: BezierBoard, targetFaceSize: number): BoardPlacement | null {
  const [placement, setPlacement] = useState<BoardPlacement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    tessellateAsync(board, targetFaceSize, abort.signal)
      .then((mesh) => {
        if (cancelled) return;
        const c = boardCenter(mesh);
        setPlacement({ offset: [-c[0], -c[1], -c[2]], board });
      })
      .catch(() => {
        /* keep the previous placement on failure */
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [board, targetFaceSize]);

  return placement;
}
