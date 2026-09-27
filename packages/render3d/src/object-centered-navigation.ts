import { Quaternion, Vector3 } from 'three';

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
