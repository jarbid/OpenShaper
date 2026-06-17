import {
  buildFinBladeMesh,
  resolveFins,
  type BezierBoard,
  type BoardMesh,
} from '@openshaper/kernel';
import { useEffect, useMemo, useState } from 'react';
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three';
import { tessellateAsync } from './geometry';

/** On-brand cyan-blue resin (the OpenShaper accent) so the blades read against the hull. */
const FIN_COLOR = '#22D3EE';

/** Kernel mesh → BufferGeometry WITHOUT centering (fins are placed in board coords). */
const rawGeometry = (mesh: BoardMesh): BufferGeometry => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(mesh.normals), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(mesh.indices), 1));
  g.computeBoundingBox();
  return g;
};

/** The bounding-box center of the board mesh = what `geometry.center()` subtracts. */
const boardCenter = (mesh: BoardMesh): [number, number, number] => {
  const p = mesh.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
};

/**
 * Foiled fin blades for the board, positioned on the bottom surface. The board mesh is
 * centered by `geometry.center()`, so the fins (built in board coords) are wrapped in a
 * group translated by the same offset (the board mesh's bbox center, reused from the
 * tessellation cache) to stay aligned with the hull.
 */
export function Fins3D({
  board,
  targetFaceSize,
  color = FIN_COLOR,
}: {
  board: BezierBoard;
  targetFaceSize: number;
  color?: string;
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

  const geometries = useMemo(
    () => resolveFins(board).map((fin) => rawGeometry(buildFinBladeMesh(fin))),
    [board],
  );
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);

  if (!offset || geometries.length === 0) return null;
  return (
    <group position={offset}>
      {geometries.map((g, i) => (
        <mesh key={i} geometry={g} castShadow>
          <meshStandardMaterial color={color} roughness={0.35} metalness={0.0} side={DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
