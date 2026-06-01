/**
 * Fin setups. The legacy stored a flat `double[]` (side-fin front/back x,y, center
 * front/back, depths, splay) — we model it cleanly instead: a named setup that
 * auto-places fins at conventional distances *from the tail*, the way a shaper
 * marks a board. Only the setup name is persisted (in the board metadata); the fin
 * positions are derived, scaled to the board's tail.
 */

import { getLength, getWidthAtPos, type BezierBoard } from '@openshaper/kernel';

export type FinSetup = 'none' | 'single' | 'twin' | 'thruster' | 'quad' | '2+1';

export const FIN_SETUPS: FinSetup[] = ['none', 'single', 'twin', 'thruster', 'quad', '2+1'];

export const FIN_SETUP_LABELS: Record<FinSetup, string> = {
  none: 'No fins',
  single: 'Single',
  twin: 'Twin',
  thruster: 'Thruster',
  quad: 'Quad',
  '2+1': '2 + 1',
};

/** A fin in board coordinates: x from the nose, lateral offset from the stringer, base length. */
export interface FinMarker {
  x: number;
  offset: number;
  base: number;
}

/**
 * Fins for a setup, placed by conventional distance from the tail (cm). Fin
 * placement is fairly absolute, not strongly length-scaled, matching how boards
 * are marked. The tail end is detected from the geometry — the nose tapers to a
 * sharper point, so the *wider* end is the tail — making placement correct
 * regardless of which x-end a loaded board calls the nose.
 */
export function finsFor(setup: FinSetup, board: BezierBoard): FinMarker[] {
  const length = getLength(board);
  const tailAtZero = getWidthAtPos(board, 5) >= getWidthAtPos(board, length - 5);
  const tail = (d: number): number => (tailAtZero ? d : length - d);
  switch (setup) {
    case 'single':
      return [{ x: tail(30), offset: 0, base: 13 }];
    case 'twin':
      return [
        { x: tail(30), offset: -12, base: 11 },
        { x: tail(30), offset: 12, base: 11 },
      ];
    case 'thruster':
      return [
        { x: tail(30), offset: -11, base: 11 },
        { x: tail(30), offset: 11, base: 11 },
        { x: tail(9), offset: 0, base: 11 },
      ];
    case 'quad':
      return [
        { x: tail(32), offset: -13, base: 10 },
        { x: tail(32), offset: 13, base: 10 },
        { x: tail(18), offset: -9, base: 9 },
        { x: tail(18), offset: 9, base: 9 },
      ];
    case '2+1':
      return [
        { x: tail(32), offset: -13, base: 9 },
        { x: tail(32), offset: 13, base: 9 },
        { x: tail(14), offset: 0, base: 16 },
      ];
    default:
      return [];
  }
}
