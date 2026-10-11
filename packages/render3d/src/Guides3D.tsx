// SPDX-License-Identifier: GPL-3.0-or-later
import type { BezierBoard } from '@openshaper/kernel';
import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import { useBoardOffset } from './use-board-offset';
import { activeGuideKey, apexGuideLine, guideLines } from './guide-lines';

/** Amber centreline, red stations, brand cyan for the station being edited. */
const STRINGER_COLOR = '#F59E0B';
const SECTION_COLOR = '#EF4444';
const ACTIVE_COLOR = '#22D3EE';
/**
 * Lime for the rail apex: clear of the three above, of the 2D bottom curve's pink and
 * the fins' violet, and dark enough to read on the default pale hull. The rocker view's
 * apex overlay (`render2d/draw.ts`) uses the same colour, so the two read as one line.
 */
const APEX_COLOR = '#84CC16';

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
 * Reference lines drawn on the hull: the stringer plane's silhouette, a ring at
 * every real cross-section with the active one highlighted, and the rail apex.
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
  showApex,
  activeSectionX,
}: {
  board: BezierBoard;
  targetFaceSize: number;
  showStringer: boolean;
  showSections: boolean;
  showApex: boolean;
  activeSectionX: number | null;
}) {
  // Lines come from the board the hull on screen was meshed from, so they move with
  // it rather than ahead of it (and are not re-lofted on every drag move).
  const placed = useBoardOffset(board, targetFaceSize);
  const placedBoard = placed?.board ?? null;

  // The kernel swaps `board` on every edit, so adding or deleting a
  // cross-section invalidates this automatically. The active station only picks
  // which ring is highlighted, so it is not a dependency of the lines themselves.
  // Each set is built only while it is shown.
  const wantLines = showStringer || showSections;
  const lines = useMemo(
    () => (placedBoard && wantLines ? guideLines(placedBoard, targetFaceSize, null) : null),
    [placedBoard, targetFaceSize, wantLines],
  );
  const apex = useMemo(
    () => (placedBoard && showApex ? apexGuideLine(placedBoard, targetFaceSize) : null),
    [placedBoard, targetFaceSize, showApex],
  );
  const activeKey = useMemo(
    () => (lines ? activeGuideKey(lines.sections, activeSectionX) : null),
    [lines, activeSectionX],
  );

  if (!placed || (!lines && !apex)) return null;

  return (
    <group position={placed.offset}>
      {showStringer &&
        lines?.stringer?.paths.map((points, i) => (
          <Line key={i} points={points} color={STRINGER_COLOR} lineWidth={2} {...OFFSET} />
        ))}
      {showSections &&
        lines?.sections.map((s) => {
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
      {apex?.paths.map((points, i) => (
        <Line key={`apex:${i}`} points={points} color={APEX_COLOR} lineWidth={2} {...OFFSET} />
      ))}
    </group>
  );
}
