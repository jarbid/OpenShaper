import { board, crossSection, knot, splineFromKnots, vec2 } from '@board-studio/kernel';
import type { BezierBoard, CrossSection, Knot } from '@board-studio/kernel';

/**
 * Build a small, well-formed test board with kernel builders only (no test-support
 * import, which the kernel barrel does not re-export). Geometry is a stubby 100 cm
 * board: outline = half-width vs length, bottom/deck = rocker curves, plus three
 * cross-sections (nose dummy / centre / tail dummy) running bottom-centre→deck-centre.
 */
export const makeTestBoard = (): BezierBoard => {
  const length = 100;
  const halfWidth = 25;
  const deckCenter = 6;

  // Smooth-ish handles: a third of the way to the neighbour, axis-aligned.
  const k = (x: number, y: number, span: number): Knot =>
    knot(vec2(x, y), vec2(x - span, y), vec2(x + span, y));

  // Outline: 0 at nose, halfWidth at mid, 0 at tail (half-width vs length).
  const outline = splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(10, halfWidth * 0.6)),
    knot(vec2(50, halfWidth), vec2(30, halfWidth), vec2(70, halfWidth)),
    knot(vec2(100, 0), vec2(90, halfWidth * 0.6), vec2(100, 0)),
  ]);

  // Bottom rocker: lifted at the ends, lowest in the middle.
  const bottom = splineFromKnots([
    knot(vec2(0, 4), vec2(0, 4), vec2(20, 1.2)),
    knot(vec2(50, 0), vec2(30, 0), vec2(70, 0)),
    knot(vec2(100, 4), vec2(80, 1.2), vec2(100, 4)),
  ]);

  // Deck: bottom + thickness.
  const deck = splineFromKnots([
    knot(vec2(0, 4.5), vec2(0, 4.5), vec2(20, deckCenter)),
    knot(vec2(50, deckCenter), vec2(30, deckCenter), vec2(70, deckCenter)),
    knot(vec2(100, 4.5), vec2(80, deckCenter), vec2(100, 4.5)),
  ]);

  // Cross-section profile: x = distance from centreline (>=0), y = height,
  // running bottom-centre (0,0) -> rail (halfWidth, mid) -> deck-centre (0, thick).
  const profile = (w: number, thick: number) =>
    splineFromKnots([
      k(0, 0, w * 0.2),
      k(w, thick * 0.45, thick * 0.3),
      k(0, thick, w * 0.2),
    ]);

  const sections: CrossSection[] = [
    crossSection(0, profile(halfWidth, deckCenter)), // nose dummy
    crossSection(50, profile(halfWidth, deckCenter)), // centre
    crossSection(length, profile(halfWidth, deckCenter)), // tail dummy
  ];

  return board(outline, bottom, deck, sections, 'controlPoint');
};
