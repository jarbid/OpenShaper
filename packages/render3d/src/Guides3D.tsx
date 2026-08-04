// SPDX-License-Identifier: GPL-3.0-or-later
import type { BezierBoard } from '@openshaper/kernel';
import { Line } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import { boardCenter, tessellateAsync } from './geometry';
import { guideLines } from './guide-lines';

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
  const [offset, setOffset] = useState<[number, number, number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    tessellateAsync(board, targetFaceSize)
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
    };
  }, [board, targetFaceSize]);

  // The kernel swaps `board` on every edit, so adding or deleting a
  // cross-section invalidates this automatically.
  const lines = useMemo(
    () => guideLines(board, targetFaceSize, activeSectionX),
    [board, targetFaceSize, activeSectionX],
  );

  if (!offset || (!showStringer && !showSections)) return null;

  return (
    <group position={offset}>
      {showStringer && lines.stringer && (
        <Line points={lines.stringer.points} color={STRINGER_COLOR} lineWidth={2} {...OFFSET} />
      )}
      {showSections &&
        lines.sections.map((s) => {
          const active = s.key === lines.activeKey;
          return (
            <Line
              key={s.key}
              points={s.points}
              color={active ? ACTIVE_COLOR : SECTION_COLOR}
              lineWidth={active ? 2.5 : 1.5}
              {...OFFSET}
            />
          );
        })}
    </group>
  );
}
