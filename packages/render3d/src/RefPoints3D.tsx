// SPDX-License-Identifier: GPL-3.0-or-later
import { refPoint3D, refPointWithin, type BezierBoard, type RefPoints } from '@openshaper/kernel';
import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import { useBoardOffset } from './use-board-offset';

// The 2D crosshair colours, so a point reads the same in every view.
const COLOR = '#FACC15';
const SELECTED = '#F97316';
const OK = '#22C55E';
const OFF = '#EF4444';

/** Half the arm of a 3D crosshair, in cm: big enough to find, small enough not to hide the rail. */
const ARM = 1.2;

/** Draw over the hull's depth so a mark on the surface is never half-buried in it. */
const ON_TOP = { depthTest: false, transparent: true } as const;

type Point = [number, number, number];

export interface RefPointMark {
  id: string;
  color: string;
  /** Three two-point segments, one along each axis, in board cm. */
  arms: Point[][];
  width: number;
}

/** The crosshairs to draw for `points` on `board`; points with no place on the hull are skipped. */
export const refPointMarks = (
  board: BezierBoard,
  points: RefPoints,
  selectedId: string | null,
  tolerance?: number,
): RefPointMark[] =>
  points.flatMap((p) => {
    const at = refPoint3D(board, p);
    if (!at) return [];
    const verdict = tolerance === undefined ? null : refPointWithin(board, p, tolerance);
    const color = p.id === selectedId ? SELECTED : verdict === null ? COLOR : verdict ? OK : OFF;
    const arms: Point[][] = [
      [
        [at.x - ARM, at.y, at.z],
        [at.x + ARM, at.y, at.z],
      ],
      [
        [at.x, at.y - ARM, at.z],
        [at.x, at.y + ARM, at.z],
      ],
      [
        [at.x, at.y, at.z - ARM],
        [at.x, at.y, at.z + ARM],
      ],
    ];
    return [{ id: p.id, color, arms, width: p.id === selectedId ? 3 : 2 }];
  });

/**
 * Reference points as small three-axis crosshairs on the hull, coloured as in 2D
 * (green within tolerance, red beyond, yellow with nothing to compare, orange when
 * selected).
 *
 * Built from the board the hull on screen was meshed from and wrapped in the same
 * offset as `Fins3D` and `Guides3D`, so the marks stay with the hull while a newer
 * board is still tessellating.
 */
export function RefPoints3D({
  board,
  targetFaceSize,
  points,
  selectedId,
  tolerance,
}: {
  board: BezierBoard;
  targetFaceSize: number;
  points: RefPoints;
  selectedId: string | null;
  /** Gap (cm) to judge points against; omitted, they are all drawn in the plain colour. */
  tolerance?: number;
}) {
  const placed = useBoardOffset(board, targetFaceSize);
  const placedBoard = placed?.board ?? null;

  const marks = useMemo(
    () => (placedBoard ? refPointMarks(placedBoard, points, selectedId, tolerance) : []),
    [placedBoard, points, selectedId, tolerance],
  );

  if (!placed || marks.length === 0) return null;

  return (
    <group position={placed.offset}>
      {marks.map((m) =>
        m.arms.map((arm, i) => (
          <Line key={`${m.id}:${i}`} points={arm} color={m.color} lineWidth={m.width} {...ON_TOP} />
        )),
      )}
    </group>
  );
}
