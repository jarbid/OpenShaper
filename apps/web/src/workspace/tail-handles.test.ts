// SPDX-License-Identifier: GPL-3.0-or-later
/** Where the Tail step's drawing puts things: the box it frames, a radius handle and how a pointer moves it, the width handles. */
import type { RailsBoard } from '@openshaper/board2';
import {
  TAIL_SHAPES,
  applyTailShape,
  isNotchedShape,
  tailCorners,
  tailShapeOf,
  tailWidthPoint,
} from '@openshaper/store/rails';
import { beforeAll, describe, expect, it } from 'vitest';
import { measureRails, sizeRailsBoard } from '../board-sizing';
import { sampleRailsBoard } from '../test/rails-board';
import {
  COARSE_HANDLES,
  FINE_HANDLES,
  FRAME_NOTCH_DEPTHS,
  HANDLE_MIN_PX,
  PUSH_LIMIT_PX,
  cornerImages,
  distanceAlong,
  draggedRadius,
  handleDistance,
  placeRadiusHandles,
  radiusPerDistance,
  ringDistance,
  squaresOverlap,
  tailFrame,
  widthImages,
  widthSpot,
  type HandleLayout,
  type Spot,
} from './tail-handles';

let sample: RailsBoard;
beforeAll(async () => {
  sample = await sampleRailsBoard();
});

describe('the box the drawing frames', () => {
  it('holds the whole tail of every shape, the same either side of the stringer', () => {
    for (const shape of TAIL_SHAPES) {
      const doc = applyTailShape(sample, { shape });
      const f = tailFrame(doc);
      expect(f.minY, shape).toBeCloseTo(-f.maxY, 12);
      expect(f.minX, shape).toBeLessThan(0);
      for (const c of tailCorners(doc)) {
        expect(c.point[0], `${shape} ${c.label}`).toBeGreaterThanOrEqual(f.minX);
        expect(c.point[0], `${shape} ${c.label}`).toBeLessThanOrEqual(f.maxX);
        expect(c.point[1], `${shape} ${c.label}`).toBeLessThanOrEqual(f.maxY);
      }
      const point = tailWidthPoint(doc);
      expect(point![0]).toBeLessThanOrEqual(f.maxX);
      expect(point![1]).toBeLessThanOrEqual(f.maxY);
    }
  });

  it('zooms on the tail: for a squash it is a fraction of the board’s width, and the rail runs off its edges', () => {
    const doc = applyTailShape(sample, { shape: 'squash' });
    const f = tailFrame(doc);
    const board = measureRails(sample).width;
    expect(f.maxY - f.minY).toBeLessThan(0.7 * board);
    // a round has its width where the zone ends, and the frame holds it
    const round = applyTailShape(sample, { shape: 'round' });
    expect(tailFrame(round).maxY).toBeGreaterThanOrEqual(tailWidthPoint(round)![1]);
  });

  it('is a shape’s alone: it does not follow the width as it is dragged, and is another box for another shape', () => {
    for (const shape of TAIL_SHAPES) {
      const narrow = applyTailShape(sample, { shape, width: undefined });
      const least = tailFrame(narrow);
      for (const width of [0.5, 1, 1.5]) {
        const base = tailShapeOf(narrow).width!;
        const doc = applyTailShape(sample, { shape, width: width * base });
        expect(tailFrame(doc), `${shape} at ${width}`).toEqual(least);
      }
    }
    expect(tailFrame(applyTailShape(sample, { shape: 'round' })).maxY).toBeGreaterThan(
      tailFrame(applyTailShape(sample, { shape: 'squash' })).maxY,
    );
  });

  it('holds the handles of every shape at its typical widths, between the ends of its range', () => {
    for (const shape of TAIL_SHAPES) {
      const doc = applyTailShape(sample, { shape });
      const f = tailFrame(doc);
      for (const image of widthImages(doc))
        expect(image.point[1], shape).toBeLessThanOrEqual(f.maxY);
    }
  });

  it('follows the knots of a tail drawn by hand, which have no range', () => {
    expect(tailShapeOf(sample).shape).toBe('custom');
    const f = tailFrame(sample);
    const wider = sizeRailsBoard(sample, {
      ...measureRails(sample),
      width: 1.5 * measureRails(sample).width,
    });
    expect(tailFrame(wider).maxY).toBeGreaterThan(f.maxY);
  });

  it('shows a deep notch with board beside it', () => {
    const doc = applyTailShape(sample, { shape: 'swallow', notch: 40 });
    expect(tailFrame(doc).maxX).toBeGreaterThanOrEqual(FRAME_NOTCH_DEPTHS * 40 - 1e-9);
  });

  it('is derived from the board: a board twice as long is framed twice as far in', () => {
    const size = measureRails(sample);
    const long = sizeRailsBoard(sample, { ...size, length: 2 * size.length });
    expect(tailFrame(long).maxX / tailFrame(sample).maxX).toBeCloseTo(2, 2);
    const wide = sizeRailsBoard(sample, { ...size, width: 1.5 * size.width });
    expect(tailFrame(wide).maxY / tailFrame(sample).maxY).toBeGreaterThan(1.3);
    expect(tailFrame(wide).maxX).toBeCloseTo(tailFrame(sample).maxX, 6);
  });
});

describe('a radius handle', () => {
  it('stands on the far side of the arc, and moves outward as the radius grows', () => {
    const turn = Math.PI / 2;
    expect(ringDistance(1, turn)).toBeCloseTo(1 + Math.SQRT2, 12);
    expect(ringDistance(2, turn)).toBeCloseTo(2 * (1 + Math.SQRT2), 12);
    expect(ringDistance(1, 0)).toBeCloseTo(2, 12);
    expect(radiusPerDistance(turn)).toBeCloseTo(1 / (1 + Math.SQRT2), 12);
    expect(ringDistance(1, 3.1)).toBeGreaterThan(ringDistance(1, 1));
    expect(Number.isFinite(ringDistance(1, Math.PI))).toBe(true);
  });

  it('never stands nearer its corner than the least on the screen', () => {
    expect(handleDistance(0.6, 0.7, 10)).toBeCloseTo(HANDLE_MIN_PX / 10, 12);
    expect(handleDistance(0.6, 0.7, 1000)).toBeCloseTo(ringDistance(0.6, 0.7), 12);
    expect(handleDistance(8, 0.7, 10)).toBeCloseTo(ringDistance(8, 0.7), 12);
  });

  it('is dragged relative to where it was taken, at the rate of the arc: no jump under the pointer, and back to where it began', () => {
    const turn = 0.9;
    expect(draggedRadius(1.5, 3, 3, turn)).toBe(1.5);
    const out = draggedRadius(1.5, 3, 5, turn);
    expect(out).toBeCloseTo(1.5 + 2 * radiusPerDistance(turn), 12);
    expect(draggedRadius(out, 5, 3, turn)).toBeCloseTo(1.5, 12);
    // a handle placed at the far side and dragged along it grows the radius so that it stays under the pointer
    const r0 = 3;
    const grab = ringDistance(r0, turn);
    const r1 = draggedRadius(r0, grab, ringDistance(5, turn), turn);
    expect(r1).toBeCloseTo(5, 12);
  });

  it('is measured along the corner’s line from the corner', () => {
    const image = { vertex: [2, 3] as const, axis: [0.6, -0.8] as const };
    expect(distanceAlong(image, [2, 3])).toBe(0);
    expect(distanceAlong(image, [2.6, 2.2])).toBeCloseTo(1, 12);
    expect(distanceAlong(image, [1.4, 3.8])).toBeCloseTo(-1, 12);
  });
});

describe('the corners as they stand on the plan', () => {
  it('shows a mirror board’s corner on both sides of the stringer, the one radius moving both, mirrored in its line', () => {
    const doc = applyTailShape(sample, { shape: 'squash' });
    expect(doc.outline.minus).toBeUndefined();
    const images = cornerImages(tailCorners(doc), true);
    expect(images.map((i) => i.sign)).toEqual([1, -1]);
    const [up, down] = images as [(typeof images)[number], (typeof images)[number]];
    expect(down.vertex).toEqual([up.vertex[0], -up.vertex[1]]);
    expect(down.axis).toEqual([up.axis[0], -up.axis[1]]);
    expect(up.corner).toBe(down.corner);
    expect(new Set(images.map((i) => i.key)).size).toBe(2);
  });

  it('shows the notch crotch and the tail point once, on the stringer', () => {
    const swallow = applyTailShape(sample, { shape: 'swallow' });
    const images = cornerImages(tailCorners(swallow), true);
    expect(images.map((i) => [i.corner.role, i.sign])).toEqual([
      ['tip', 1],
      ['tip', -1],
      ['crotch', 1],
    ]);
    expect(images.find((i) => i.corner.role === 'crotch')!.vertex[1]).toBe(0);
    expect(images.find((i) => i.corner.role === 'crotch')!.axis[0]).toBeLessThan(0);
    const pin = applyTailShape(sample, { shape: 'pin' });
    expect(cornerImages(tailCorners(pin), true).map((i) => i.corner.role)).toEqual(['point']);
  });

  it('gives each corner of an asymmetric board its own side', () => {
    const asym = {
      ...sample,
      symmetry: 'asymmetric' as const,
      outline: { plus: sample.outline.plus, minus: sample.outline.plus },
      corners: { ...sample.corners, minus: sample.corners.plus },
      stations: sample.stations.map((s) => ({ ...s, minus: s.plus })),
      rails: { plus: sample.rails.plus, minus: sample.rails.plus },
    };
    const doc = applyTailShape(asym, { shape: 'squash' });
    const images = cornerImages(tailCorners(doc), false);
    expect(images.map((i) => [i.corner.side, i.sign])).toEqual([
      ['plus', 1],
      ['minus', -1],
    ]);
  });
});

describe('the width handles', () => {
  it('stand on both sides of a mirror board’s tail, each at the corner, and are none for a tail drawn by hand', () => {
    expect(tailShapeOf(sample).shape).toBe('custom');
    expect(widthImages(sample)).toEqual([]);
    for (const shape of TAIL_SHAPES) {
      const doc = applyTailShape(sample, { shape });
      const images = widthImages(doc);
      expect(
        images.map((i) => i.sign),
        shape,
      ).toEqual([1, -1]);
      expect(images.every((i) => i.side === undefined && i.shape === shape)).toBe(true);
      expect(images[0]!.point[1] * 2, shape).toBeCloseTo(images[0]!.width, 9);
      expect(images[1]!.point[1], shape).toBeCloseTo(-images[0]!.point[1], 12);
      if (isNotchedShape(shape)) expect(images[0]!.point[0]).toBe(0);
    }
  });
});

describe('the handles of a small tail, under a mouse and under a fingertip', () => {
  /** The plan as the editor fits it to a pane: the frame centred, 24 px about it. */
  const paneOf = (doc: RailsBoard, width: number, height: number) => {
    const f = tailFrame(doc);
    const scale = Math.min((width - 48) / (f.maxX - f.minX), (height - 48) / (f.maxY - f.minY));
    const cx = (f.minX + f.maxX) / 2;
    const cy = (f.minY + f.maxY) / 2;
    return {
      scale,
      toPane: (p: { x: number; y: number }): Spot => ({
        x: width / 2 + (p.x - cx) * scale,
        y: height / 2 - (p.y - cy) * scale,
      }),
    };
  };
  /** Every handle of the tail on a pane: where each stands. */
  const laidOut = (doc: RailsBoard, width: number, height: number, layout: HandleLayout) => {
    const { scale, toPane } = paneOf(doc, width, height);
    const corners = cornerImages(tailCorners(doc), doc.outline.minus === undefined);
    const widths = widthImages(doc).map((i) => widthSpot(i, toPane).at);
    const stands = placeRadiusHandles(corners, toPane, scale, layout, widths, { width, height });
    const radius = corners.map((image) => ({
      image,
      spot: stands.get(image.key)!,
      corner: toPane({ x: image.vertex[0], y: image.vertex[1] }),
    }));
    return {
      scale,
      toPane,
      corners,
      widths,
      radius,
      spots: [...widths, ...radius.map((r) => r.spot)],
    };
  };
  const PANES = [
    [929, 186],
    [929, 320],
    [1000, 560],
  ] as const;
  const LAYOUTS = [
    ['a fingertip', COARSE_HANDLES],
    ['a mouse', FINE_HANDLES],
  ] as const;

  it('puts no two handles on one another where the pane has room, and always leaves each one’s centre clear of the others’ squares', () => {
    for (const [name, layout] of LAYOUTS) {
      for (const shape of TAIL_SHAPES) {
        const doc = applyTailShape(sample, { shape });
        for (const [w, h] of PANES) {
          const { spots } = laidOut(doc, w, h, layout);
          for (let i = 0; i < spots.length; i++) {
            for (let j = i + 1; j < spots.length; j++) {
              const where = `${name}, ${shape}, ${w}x${h}: handles ${i} and ${j}`;
              // each one's centre is clear of the other's square: a press on a handle where it is drawn is its own
              expect(squaresOverlap(spots[i]!, spots[j]!, layout.target / 2), where).toBe(false);
              // and on a pane of 320 px or more, the squares do not overlap at all
              if (h >= 320) {
                expect(squaresOverlap(spots[i]!, spots[j]!, layout.target), where).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  it('keeps a radius handle at least its reach from its own corner, so its square leaves the corner’s point free, and a handle’s square inside the pane', () => {
    for (const [name, layout] of LAYOUTS) {
      for (const shape of TAIL_SHAPES) {
        const doc = applyTailShape(sample, { shape });
        for (const [w, h] of PANES) {
          for (const r of laidOut(doc, w, h, layout).radius) {
            const where = `${name}, ${shape}, ${w}x${h}, ${r.image.key}`;
            const px = Math.hypot(r.spot.x - r.corner.x, r.spot.y - r.corner.y);
            expect(px, where).toBeGreaterThanOrEqual(layout.reach - 1e-6);
            expect(r.spot.x - layout.target / 2, where).toBeGreaterThanOrEqual(-1e-6);
            expect(r.spot.y - layout.target / 2, where).toBeGreaterThanOrEqual(-1e-6);
            expect(r.spot.x + layout.target / 2, where).toBeLessThanOrEqual(w + 1e-6);
            expect(r.spot.y + layout.target / 2, where).toBeLessThanOrEqual(h + 1e-6);
          }
        }
      }
    }
  });

  it('keeps a corner’s handle on its own side of the stringer', () => {
    for (const [name, layout] of LAYOUTS) {
      for (const shape of TAIL_SHAPES) {
        const doc = applyTailShape(sample, { shape });
        for (const [w, h] of PANES) {
          const { toPane, radius } = laidOut(doc, w, h, layout);
          const stringer = toPane({ x: 0, y: 0 }).y;
          for (const r of radius) {
            if (Math.abs(r.corner.y - stringer) < 1e-9) continue;
            expect(
              Math.sign(r.spot.y - stringer),
              `${name}, ${shape}, ${w}x${h}, ${r.image.key}`,
            ).toBe(Math.sign(r.corner.y - stringer));
          }
        }
      }
    }
  });

  it('leaves a handle where its own geometry puts it when nothing is in the way, and moves one only a limited way, in front of its corner, to a place clear of what is', () => {
    const doc = applyTailShape(sample, { shape: 'swallow' });
    const { scale, toPane } = paneOf(doc, 929, 320);
    const pane = { width: 929, height: 320 };
    for (const c of cornerImages(tailCorners(doc), true)) {
      const corner = toPane({ x: c.vertex[0], y: c.vertex[1] });
      const along = toPane({ x: c.vertex[0] + c.axis[0], y: c.vertex[1] + c.axis[1] });
      const unit = Math.hypot(along.x - corner.x, along.y - corner.y);
      const nominal =
        handleDistance(c.corner.radius, c.corner.turn, scale, COARSE_HANDLES.reach) * scale;
      const home = {
        x: corner.x + ((along.x - corner.x) / unit) * nominal,
        y: corner.y + ((along.y - corner.y) / unit) * nominal,
      };
      // alone: at its own place
      const alone = placeRadiusHandles([c], toPane, scale, COARSE_HANDLES, [], pane).get(c.key)!;
      expect(alone.x).toBeCloseTo(home.x, 9);
      expect(alone.y).toBeCloseTo(home.y, 9);
      // with a square standing there: moved, to a place clear of it, no further than the limit, and in front of the corner
      const moved = placeRadiusHandles([c], toPane, scale, COARSE_HANDLES, [home], pane).get(
        c.key,
      )!;
      expect(squaresOverlap(moved, home, COARSE_HANDLES.target), c.key).toBe(false);
      const away = Math.hypot(moved.x - corner.x, moved.y - corner.y);
      expect(away, c.key).toBeGreaterThanOrEqual(nominal - 1e-6);
      expect(away, c.key).toBeLessThanOrEqual(nominal + PUSH_LIMIT_PX + 1e-6);
      const ahead =
        ((moved.x - corner.x) * (along.x - corner.x) +
          (moved.y - corner.y) * (along.y - corner.y)) /
        (unit * away);
      expect(ahead, c.key).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves a handle at its own place when the pane has no place for it', () => {
    const doc = applyTailShape(sample, { shape: 'squash' });
    const { scale, toPane } = paneOf(doc, 929, 186);
    const pane = { width: 929, height: 186 };
    const first = cornerImages(tailCorners(doc), true)[0]!;
    // a wall of handles over the whole pane: no place is clear, not even at the centre
    const wall: Spot[] = [];
    for (let x = 0; x <= 929; x += 8) for (let y = 0; y <= 186; y += 8) wall.push({ x, y });
    const alone = placeRadiusHandles([first], toPane, scale, COARSE_HANDLES, [], pane).get(
      first.key,
    )!;
    const stuck = placeRadiusHandles([first], toPane, scale, COARSE_HANDLES, wall, pane).get(
      first.key,
    )!;
    expect(stuck).toEqual(alone);
  });

  it('stands a width handle outside the board, in line with where the width is measured, a fixed distance from it', () => {
    const doc = applyTailShape(sample, { shape: 'swallow' });
    const { toPane } = paneOf(doc, 929, 320);
    for (const image of widthImages(doc)) {
      const { measured, at } = widthSpot(image, toPane);
      expect(Math.hypot(at.x - measured.x, at.y - measured.y)).toBeCloseTo(22, 9);
      expect(at.x).toBeCloseTo(measured.x, 9);
      // outside the board: above the plus side's tip, below the minus side's, on the pane
      expect(Math.sign(measured.y - at.y)).toBe(image.sign);
    }
  });
});
