import type { BezierBoard } from '@openshaper/kernel';
import { useEffect, useState } from 'react';
import { boardCenter, tessellateAsync } from './geometry';

/**
 * The translation that puts board-coordinate geometry (fins, guide lines) on the
 * centred hull: the negated bounding-box centre of the board's mesh, which is what
 * `meshToGeometry` subtracts. Read from the same (shared, cached) tessellation as
 * the hull, so it never disagrees with it. Null until the first mesh arrives; on a
 * failed or superseded tessellation the previous offset stays.
 */
export function useBoardOffset(
  board: BezierBoard,
  targetFaceSize: number,
): [number, number, number] | null {
  const [offset, setOffset] = useState<[number, number, number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    tessellateAsync(board, targetFaceSize, abort.signal)
      .then((mesh) => {
        if (cancelled) return;
        const c = boardCenter(mesh);
        setOffset([-c[0], -c[1], -c[2]]);
      })
      .catch(() => {
        /* keep the previous offset on failure */
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [board, targetFaceSize]);

  return offset;
}
