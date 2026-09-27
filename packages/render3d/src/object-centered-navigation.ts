import { Quaternion, Vector3, type Object3D } from 'three';

const ROTATION_SPEED = Math.PI * 4;

/** Build the free-orbit rotation for a pointer movement normalized to the viewport. */
export function objectCenteredRotation(
  eye: Vector3,
  cameraUp: Vector3,
  horizontal: number,
  vertical: number,
): Quaternion {
  if (eye.lengthSq() === 0) return new Quaternion();

  const up = cameraUp.clone().normalize();
  const sideways = new Vector3().crossVectors(up, eye).normalize();
  const movement = up.multiplyScalar(vertical).addScaledVector(sideways, horizontal);
  const angle = movement.length() * ROTATION_SPEED;
  if (angle === 0) return new Quaternion();

  const axis = new Vector3().crossVectors(movement, eye).normalize();
  return new Quaternion().setFromAxisAngle(axis, angle);
}

/**
 * Turn the camera, its zoom/pan target and its up by `rotation` about the world
 * origin — the board's centre, since its geometry is `center()`-ed. Camera and
 * target move together, so the zoom/pan framing is kept and the board's centre
 * holds its place on screen: the pivot never drifts off the board.
 */
export function rotateViewAboutOrigin(
  camera: Object3D,
  target: Vector3,
  rotation: Quaternion,
): void {
  camera.position.applyQuaternion(rotation);
  target.applyQuaternion(rotation);
  camera.up.applyQuaternion(rotation);
  camera.lookAt(target);
}

/** The pointer fields that decide whether a press starts an orbit. */
export type OrbitPress = Pick<
  PointerEvent,
  'button' | 'isPrimary' | 'shiftKey' | 'ctrlKey' | 'metaKey'
>;

/**
 * Whether a press starts an orbit: a plain left press of the first pointer only.
 * OrbitControls owns the rest — a modified left-drag is its pan, and a second
 * finger turns a touch into its pinch-zoom/pan.
 */
export function startsOrbit(press: OrbitPress): boolean {
  return (
    press.isPrimary && press.button === 0 && !press.shiftKey && !press.ctrlKey && !press.metaKey
  );
}
