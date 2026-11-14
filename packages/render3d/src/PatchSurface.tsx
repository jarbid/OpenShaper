// SPDX-License-Identifier: GPL-3.0-or-later
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  DoubleSide,
  Raycaster,
  Triangle,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Mesh,
} from 'three';
import { createPatchMaterial, setPatchUniforms } from './patch-shader';
import { pickPatch, type PatchPick, type PatchSelection, type RailZones } from './patches';
import { createTapTracker } from './tap';

/**
 * The board painted by its patches (`patch-shader.ts`), in board coordinates; the caller places
 * it on the centred hull as it does the other looks. `geometry` carries the `aPatch` attribute.
 *
 * It also answers a tap: a click that is not a drag, on the board, becomes the patch under it
 * through `onPick`, and a tap on nothing is `onPick(null)`. A tap in the `ignoreCorner` square
 * at the bottom right (the view cube's) is not the board's.
 */
export function PatchSurface({
  geometry,
  patch,
  zones,
  selection,
  onPick,
  ignoreCorner,
}: {
  geometry: BufferGeometry;
  /** The per-vertex patch ids `geometry` was built with, for the tap. */
  patch: Uint8Array;
  zones: RailZones;
  selection: PatchSelection | null;
  onPick?: ((pick: PatchPick | null) => void) | undefined;
  ignoreCorner: number;
}) {
  const { camera, gl, invalidate } = useThree();
  const meshRef = useRef<Mesh>(null);
  const built = useMemo(() => {
    const b = createPatchMaterial();
    b.material.side = DoubleSide;
    return b;
  }, []);
  useEffect(() => () => built.material.dispose(), [built]);

  // New zones or a new choice: change the uniforms and ask for a frame (the canvas draws on demand).
  useEffect(() => {
    setPatchUniforms(built.uniforms, zones, selection);
    invalidate();
  }, [built, zones, selection, invalidate]);

  // The tap handler reads the latest of these without re-binding the listeners.
  const latest = useRef({ zones, onPick, patch, ignoreCorner });
  latest.current = { zones, onPick, patch, ignoreCorner };

  useEffect(() => {
    const element = gl.domElement;
    const tracker = createTapTracker();
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const local = new Vector3();
    const corners = [new Vector3(), new Vector3(), new Vector3()];
    const bary = new Vector3();
    const point = (e: PointerEvent) => ({
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      time: e.timeStamp,
      primary: e.isPrimary,
      button: e.button,
      touch: e.pointerType === 'touch',
    });
    const tap = (e: PointerEvent): void => {
      const { zones: z, onPick: report, patch: ids, ignoreCorner: corner } = latest.current;
      const mesh = meshRef.current;
      if (!report || !mesh) return;
      const rect = element.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (px > rect.width - corner && py > rect.height - corner) return;
      ndc.set((px / rect.width) * 2 - 1, -((py / rect.height) * 2 - 1));
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      const index = mesh.geometry.getIndex();
      if (!hit || hit.faceIndex == null || !index) return report(null);
      local.copy(hit.point);
      mesh.worldToLocal(local);
      const position = mesh.geometry.getAttribute('position');
      const [a, b, c] = corners as [Vector3, Vector3, Vector3];
      const triangle = hit.faceIndex;
      a.fromBufferAttribute(position, index.getX(3 * triangle));
      b.fromBufferAttribute(position, index.getX(3 * triangle + 1));
      c.fromBufferAttribute(position, index.getX(3 * triangle + 2));
      Triangle.getBarycoord(local, a, b, c, bary);
      report(
        pickPatch(
          ids,
          index.array,
          { triangle, bary: [bary.x, bary.y, bary.z], x: local.x, y: local.y },
          z,
        ),
      );
    };
    const down = (e: PointerEvent) => tracker.down(point(e));
    const move = (e: PointerEvent) => tracker.move(point(e));
    const up = (e: PointerEvent) => {
      if (tracker.up(point(e))) tap(e);
    };
    const cancel = () => tracker.cancel();
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
    };
  }, [camera, gl]);

  return <mesh ref={meshRef} geometry={geometry} material={built.material} />;
}
