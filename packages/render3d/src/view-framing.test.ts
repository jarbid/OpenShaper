import { describe, expect, it } from 'vitest';
import {
  defaultCameraPosition,
  orthographicZoomFor,
  orthographicZoomForBox,
  projectedExtent,
  upForViewDirection,
} from './view-framing';

describe('orthographicZoomFor', () => {
  it('fits the span across 80% of the viewport width', () => {
    // 1000px across a 200cm board: 80% of 1000px = 800px of board, so 4 px/cm.
    expect(orthographicZoomFor(1000, 200)).toBeCloseTo(4, 10);
    const span = 187.96;
    expect(orthographicZoomFor(1106, span) * span).toBeCloseTo(1106 * 0.8, 6);
  });

  it('scales with the viewport and inversely with the span', () => {
    expect(orthographicZoomFor(2000, 200)).toBeCloseTo(orthographicZoomFor(1000, 200) * 2, 10);
    expect(orthographicZoomFor(1000, 400)).toBeCloseTo(orthographicZoomFor(1000, 200) / 2, 10);
  });

  it('never returns a zoom that would collapse the projection', () => {
    // A zero/negative zoom degenerates the orthographic matrix and the board vanishes.
    for (const [w, span] of [
      [0, 200],
      [1000, Infinity],
      [-100, 200],
      [1000, 1e9],
    ] as const)
      expect(orthographicZoomFor(w, span)).toBeGreaterThan(0);
  });
});

describe('upForViewDirection', () => {
  // Board axes: X tail->nose, Y rail->rail, Z vertical.
  it('keeps the deck upright for profile and isometric views', () => {
    for (const d of [
      { z: 0 }, // dead-on nose / tail / rail
      { z: 0.5 }, // isometric
      { z: -0.7071 }, // 45° from below
      { z: 0.998 }, // steep, but not quite down the axis
    ])
      expect(upForViewDirection(d)).toEqual([0, 0, 1]);
  });

  it('hands "up" to Y when looking along Z, where Z is useless as up', () => {
    expect(upForViewDirection({ z: 1 })).toEqual([0, 1, 0]); // deck view, from above
    expect(upForViewDirection({ z: -1 })).toEqual([0, -1, 0]); // bottom view, from below
  });

  it('puts the nose on the right of the screen from both deck and bottom', () => {
    // screen-right = forward x up, with forward = -direction (the camera looks back
    // toward the board). Both must come out as +X, the nose.
    const cross = (a: number[], b: number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    for (const z of [1, -1]) {
      const forward = [0, 0, -z]; // camera sits at +z*d, looks toward the origin
      const right = cross(forward, upForViewDirection({ z }));
      expect(right[0]).toBeGreaterThan(0); // +X = nose, on the right
      expect(right[1]).toBeCloseTo(0, 10);
      expect(right[2]).toBeCloseTo(0, 10);
    }
  });
});

describe('defaultCameraPosition', () => {
  it('looks across the board from its right rail, a little above, by default', () => {
    expect(defaultCameraPosition(200)).toEqual([0, -200, 90]);
    expect(defaultCameraPosition(200, 'side')).toEqual([0, -200, 90]);
  });

  it('looks from behind the tail, to the right and above, in three quarters', () => {
    const [x, y, z] = defaultCameraPosition(200, 'threeQuarter');
    expect(x).toBeLessThan(0); // behind the tail
    expect(y).toBeLessThan(0); // the right rail's side
    expect(z).toBeGreaterThan(0); // above
    // the deck is seen well off edge-on: more than 30 degrees of elevation
    expect(Math.atan2(z, Math.hypot(x, y))).toBeGreaterThan((30 * Math.PI) / 180);
  });
});

describe('projectedExtent', () => {
  const board = { x: 230, y: 55, z: 20 };

  it('is the board length across and its height up when seen from the side', () => {
    const e = projectedExtent(board, [0, -1, 0]);
    expect(e.horizontal).toBeCloseTo(230, 9);
    expect(e.vertical).toBeCloseTo(20, 9);
  });

  it('is the length across and the width up when seen from above, and from below', () => {
    for (const z of [1, -1]) {
      const e = projectedExtent(board, [0, 0, z]);
      expect(e.horizontal).toBeCloseTo(230, 9);
      expect(e.vertical).toBeCloseTo(55, 9);
    }
  });

  it('is the width across and the height up when seen from the tail', () => {
    const e = projectedExtent(board, [-1, 0, 0]);
    expect(e.horizontal).toBeCloseTo(55, 9);
    expect(e.vertical).toBeCloseTo(20, 9);
  });

  it('matches the silhouette of the eight corners, from any direction', () => {
    const directions: [number, number, number][] = [
      defaultCameraPosition(1, 'threeQuarter'),
      defaultCameraPosition(1, 'side'),
      [1, 1, 1],
      [-0.2, 0.9, -0.4],
      [3, -1, 0.1],
    ];
    for (const from of directions) {
      const length = Math.hypot(...from);
      const toCamera = from.map((v) => v / length) as [number, number, number];
      const forward = toCamera.map((v) => -v);
      const up = upForViewDirection({ z: toCamera[2] });
      const cross = (a: number[], b: number[]) => [
        a[1]! * b[2]! - a[2]! * b[1]!,
        a[2]! * b[0]! - a[0]! * b[2]!,
        a[0]! * b[1]! - a[1]! * b[0]!,
      ];
      const r = cross(forward, up);
      const rl = Math.hypot(...r);
      const right = r.map((v) => v / rl);
      const screenUp = cross(right, forward);
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      const spread = (axis: number[]) => {
        const along: number[] = [];
        for (const sx of [-0.5, 0.5])
          for (const sy of [-0.5, 0.5])
            for (const sz of [-0.5, 0.5])
              along.push(dot([sx * board.x, sy * board.y, sz * board.z], axis));
        return Math.max(...along) - Math.min(...along);
      };
      const e = projectedExtent(board, from);
      expect(e.horizontal).toBeCloseTo(spread(right), 9);
      expect(e.vertical).toBeCloseTo(spread(screenUp), 9);
    }
  });

  it('does not depend on how far away the camera sits', () => {
    const near = projectedExtent(board, [-0.55, -0.8, 0.7]);
    const far = projectedExtent(board, [-55, -80, 70]);
    expect(far.horizontal).toBeCloseTo(near.horizontal, 9);
    expect(far.vertical).toBeCloseTo(near.vertical, 9);
  });
});

describe('orthographicZoomForBox', () => {
  const board = { x: 230, y: 55, z: 20 };

  it('is the width fit when the view is tall enough, so a side view frames as it always has', () => {
    const viewport = { width: 1000, height: 600 };
    const side = projectedExtent(board, defaultCameraPosition(1, 'side'));
    // The side view's pose is a little above the rail, so the box reaches slightly higher than 20;
    // the width still decides, and it decides exactly as the span rule does.
    expect(orthographicZoomForBox(viewport, side)).toBeCloseTo(
      orthographicZoomFor(viewport.width, side.horizontal),
      9,
    );
  });

  it('is limited by the height when the view is wide and short and the board is seen obliquely', () => {
    const viewport = { width: 1250, height: 480 };
    const oblique = projectedExtent(board, defaultCameraPosition(1, 'threeQuarter'));
    const byWidth = orthographicZoomFor(viewport.width, oblique.horizontal);
    const zoom = orthographicZoomForBox(viewport, oblique);
    expect(zoom).toBeLessThan(byWidth);
    // the board's silhouette fills 80% of the height, and fits in the width
    expect(oblique.vertical * zoom).toBeCloseTo(viewport.height * 0.8, 9);
    expect(oblique.horizontal * zoom).toBeLessThanOrEqual(viewport.width * 0.8 + 1e-9);
  });

  it('keeps the silhouette inside the view, with room around it, for any view and any shape of pane', () => {
    for (const viewport of [
      { width: 1250, height: 480 },
      { width: 480, height: 1250 },
      { width: 800, height: 800 },
      { width: 3000, height: 200 },
    ])
      for (const from of [
        defaultCameraPosition(1, 'threeQuarter'),
        [0, 0, 1],
        [-1, 0, 0],
        [1, 1, 1],
      ] as [number, number, number][]) {
        const extent = projectedExtent(board, from);
        const zoom = orthographicZoomForBox(viewport, extent);
        expect(extent.horizontal * zoom).toBeLessThanOrEqual(viewport.width * 0.8 + 1e-9);
        expect(extent.vertical * zoom).toBeLessThanOrEqual(viewport.height * 0.8 + 1e-9);
        // one of the two is exactly filled: nothing is left on the table
        const filled = Math.max(
          (extent.horizontal * zoom) / (viewport.width * 0.8),
          (extent.vertical * zoom) / (viewport.height * 0.8),
        );
        expect(filled).toBeCloseTo(1, 9);
      }
  });

  it('never returns a zoom that would collapse or blow up the projection', () => {
    for (const [width, height, horizontal, vertical] of [
      [0, 0, 100, 100],
      [1000, 500, 0, 0],
      [1000, 500, Infinity, Infinity],
      [-10, 500, 100, 100],
      [1000, 500, 1e12, 1e12],
    ] as const) {
      const zoom = orthographicZoomForBox({ width, height }, { horizontal, vertical });
      expect(Number.isFinite(zoom)).toBe(true);
      expect(zoom).toBeGreaterThan(0);
    }
  });
});
