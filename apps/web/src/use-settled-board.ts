import type { BezierBoard } from '@openshaper/kernel';
import { useRef, useSyncExternalStore } from 'react';
import { boardStore } from './store';

/**
 * The board as of the last *settled* (non-dragging) moment. Heavy derived values
 * — volume, planshape area, center of mass, cross-section-area distribution — read
 * from this instead of the live board, so the numerical integration runs on edit
 * commit rather than on every pointer-move during a drag. The editors and the 3D
 * view still subscribe to the live board, so dragging stays smooth; the specs
 * snap to the final value on release. When not dragging, this *is* the live board,
 * so steady-state behavior is unchanged.
 */
export function useSettledBoard(): BezierBoard | null {
  const board = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().board);
  const editing = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().editing);
  const ref = useRef(board);
  if (!editing) ref.current = board;
  return ref.current;
}
