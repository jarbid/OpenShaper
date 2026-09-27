import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Quaternion, Vector3 } from 'three';
import {
  objectCenteredRotation,
  rotateViewAboutOrigin,
  startsOrbit,
  type OrbitPress,
} from './object-centered-navigation';

describe('objectCenteredRotation', () => {
  const eye = new Vector3(0, -10, 4);
  const up = new Vector3(0, 0, 1);

  it('uses the user-selected direction for an upward pointer drag', () => {
    const rotated = eye.clone().applyQuaternion(objectCenteredRotation(eye, up, 0, 0.05));

    expect(rotated.z).toBeLessThan(eye.z);
  });

  it('swings the camera against a rightward drag, so the board follows the pointer', () => {
    // Screen-right for this camera is +x.
    const rotated = eye.clone().applyQuaternion(objectCenteredRotation(eye, up, 0.05, 0));

    expect(rotated.x).toBeLessThan(0);
  });

  it('does not rotate when the pointer does not move', () => {
    const rotated = eye.clone().applyQuaternion(objectCenteredRotation(eye, up, 0, 0));

    expect(rotated.toArray()).toEqual(eye.toArray());
  });
});

describe('rotateViewAboutOrigin', () => {
  /** A camera zoomed/panned so its target sits well off the board's centre. */
  function pannedView() {
    const camera = new OrthographicCamera(-100, 100, 100, -100, 1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(30, -200, 90);
    const target = new Vector3(40, 10, -5);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return { camera, target };
  }
  const screenPositionOfOrigin = (camera: OrthographicCamera) => {
    camera.updateMatrixWorld();
    return new Vector3().project(camera);
  };
  const drag = (camera: OrthographicCamera, target: Vector3) =>
    objectCenteredRotation(camera.position.clone().sub(target), camera.up, 0.07, -0.04);

  it("keeps the board's centre fixed on screen while orbiting a panned view", () => {
    const { camera, target } = pannedView();
    const before = screenPositionOfOrigin(camera);

    rotateViewAboutOrigin(camera, target, drag(camera, target));

    const after = screenPositionOfOrigin(camera);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('is exercised by a view whose target-pivot would move the centre', () => {
    // Guards the fixture: pivoting on the target (the old trackball) must visibly
    // move the board's centre, or the test above could not tell the two apart.
    const { camera, target } = pannedView();
    const before = screenPositionOfOrigin(camera);
    const rotation = drag(camera, target);

    camera.position.sub(target).applyQuaternion(rotation).add(target);
    camera.up.applyQuaternion(rotation);
    camera.lookAt(target);

    const after = screenPositionOfOrigin(camera);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.05);
  });

  it('keeps the camera-to-target framing', () => {
    const { camera, target } = pannedView();
    const eyeBefore = camera.position.clone().sub(target);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);

    rotateViewAboutOrigin(camera, target, rotation);

    expect(camera.position.clone().sub(target).length()).toBeCloseTo(eyeBefore.length(), 9);
    expect(target.toArray().map((v) => +v.toFixed(9))).toEqual([40, -10, 5]);
  });
});

describe('startsOrbit', () => {
  const plainLeft: OrbitPress = {
    button: 0,
    isPrimary: true,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  };

  it('starts on a plain left press of the first pointer', () => {
    expect(startsOrbit(plainLeft)).toBe(true);
  });

  it.each(['shiftKey', 'ctrlKey', 'metaKey'] as const)(
    'leaves a %s left-drag to OrbitControls as a pan',
    (modifier) => {
      expect(startsOrbit({ ...plainLeft, [modifier]: true })).toBe(false);
    },
  );

  it('leaves a second touch to OrbitControls as a pinch', () => {
    expect(startsOrbit({ ...plainLeft, isPrimary: false })).toBe(false);
  });

  it('leaves right and middle presses to OrbitControls', () => {
    expect(startsOrbit({ ...plainLeft, button: 1 })).toBe(false);
    expect(startsOrbit({ ...plainLeft, button: 2 })).toBe(false);
  });
});
