// SPDX-License-Identifier: GPL-3.0-or-later
import type { BezierBoard } from '@openshaper/kernel';
import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import { useBoardOffset } from './use-board-offset';
import { activeGuideKey, guideLines } from './guide-lines';

/** Amber centreline, red stations, brand cyan for the station being edited. */
const STRINGER_COLOR = '#F59E0B';
const SECTION_COLOR = '#EF4444';
const ACTIVE_COLOR = '#22D3EE';

/**
 * A depth bias, not a geometric one: the guides sit exactly on the surface, and
 * this pushes them toward the camera in the depth buffer only, so they win the
 * z-fight without being displaced off the hull.
 */
const OFFSET = {
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
} as const;

/**
 * Reference lines drawn on the hull: the stringer plane's silhouette, and a ring
 * at every real cross-section with the active one highlighted.
 *
 * `meshToGeometry` centres the board mesh by its bounding box, so — exactly like
 * `Fins3D` — these are built in board coordinates and wrapped in a group carrying
 * the same offset.
 */
export function Guides3D({
  board,
  targetFaceSize,
  showStringer,
  showSections,
  activeSectionX,
}: {
  board: BezierBoard;
  targetFaceSize: number;
  showStringer: boolean;
  showSections: boolean;
  activeSectionX: number | null;
}) {
  // Lines come from the board the hull on screen was meshed from, so they move with
  // it rather than ahead of it (and are not re-lofted on every drag move).
  const placed = useBoardOffset(board, targetFaceSize);
  const placedBoard = placed?.board ?? null;

  // The kernel swaps `board` on every edit, so adding or deleting a
  // cross-section invalidates this automatically. The active station only picks
  // which ring is highlighted, so it is not a dependency of the lines themselves.
  const lines = useMemo(
    () => (placedBoard ? guideLines(placedBoard, targetFaceSize, null) : null),
    [placedBoard, targetFaceSize],
  );
  const activeKey = useMemo(
    () => (lines ? activeGuideKey(lines.sections, activeSectionX) : null),
    [lines, activeSectionX],
  );

  if (!placed || !lines || (!showStringer && !showSections)) return null;

  return (
    <group position={placed.offset}>
      {showStringer &&
        lines.stringer?.paths.map((points, i) => (
          <Line key={i} points={points} color={STRINGER_COLOR} lineWidth={2} {...OFFSET} />
        ))}
      {showSections &&
        lines.sections.map((s) => {
          const active = s.key === activeKey;
          return s.paths.map((points, i) => (
            <Line
              key={`${s.key}:${i}`}
              points={points}
              color={active ? ACTIVE_COLOR : SECTION_COLOR}
              lineWidth={active ? 2.5 : 1.5}
              {...OFFSET}
            />
          ));
        })}
    </group>
  );
}
