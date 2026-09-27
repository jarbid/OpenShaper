import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { objectCenteredRotation } from './object-centered-navigation';

describe('objectCenteredRotation', () => {
  const eye = new Vector3(0, -10, 4);
  const up = new Vector3(0, 0, 1);

  it('keeps the board origin fixed while preserving the camera radius', () => {
    const rotated = eye.clone().applyQuaternion(objectCenteredRotation(eye, up, 0.1, 0.1));

    expect(rotated.length()).toBeCloseTo(eye.length());
  });

  it('uses the user-selected direction for an upward pointer drag', () => {
    const rotated = eye.clone().applyQuaternion(objectCenteredRotation(eye, up, 0, 0.05));

    expect(rotated.z).toBeLessThan(eye.z);
  });

  it('does not rotate when the pointer does not move', () => {
    const rotated = eye.clone().applyQuaternion(objectCenteredRotation(eye, up, 0, 0));

    expect(rotated.toArray()).toEqual(eye.toArray());
  });
});
