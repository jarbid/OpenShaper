import {
  board,
  closestPointOnSpline,
  coeffsOf,
  crossSection,
  curveFromPoints,
  curveLength,
  getInterpolatedCrossSection,
  knot,
  maxX,
  scaleSpline,
  splineFromKnots,
  splitCurve,
  valueAt,
  vec2,
  type BezierBoard,
  type CrossSection,
  type InterpolationType,
  type Knot,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';

/**
 * Pure editing helpers. The kernel is immutable, so every edit returns a NEW
 * spline / board; the store swaps the reference. No mutation, fully testable.
 */

/** Identifies which spline on the board an edit targets. */
export type SplineTarget =
  | { kind: 'outline' }
  | { kind: 'deck' }
  | { kind: 'bottom' }
  | { kind: 'crossSection'; index: number };

export const getTargetSpline = (b: BezierBoard, t: SplineTarget): Spline => {
  switch (t.kind) {
    case 'outline':
      return b.outline;
    case 'deck':
      return b.deck;
    case 'bottom':
      return b.bottom;
    case 'crossSection':
      return b.crossSections[t.index]!.spline;
  }
};

/** Return a new board with the target spline replaced. */
export const withSpline = (b: BezierBoard, t: SplineTarget, spline: Spline): BezierBoard => {
  switch (t.kind) {
    case 'outline':
      return board(spline, b.bottom, b.deck, b.crossSections, b.interpolationType);
    case 'deck':
      return board(b.outline, b.bottom, spline, b.crossSections, b.interpolationType);
    case 'bottom':
      return board(b.outline, spline, b.deck, b.crossSections, b.interpolationType);
    case 'crossSection': {
      const cs = b.crossSections.map((c, i) =>
        i === t.index ? { position: c.position, spline } : c,
      );
      return board(b.outline, b.bottom, b.deck, cs, b.interpolationType);
    }
  }
};

const replaceKnot = (s: Spline, index: number, k: Knot): Spline =>
  splineFromKnots(s.knots.map((kk, i) => (i === index ? k : kk)));

/**
 * Move a knot's endpoint to `end`, translating its two tangent handles by the
 * same delta (legacy `BezierKnot.setControlPointLocation` — the whole knot moves).
 */
export const moveKnotEnd = (s: Spline, index: number, end: Vec2): Spline => {
  const k = s.knots[index]!;
  const dx = end.x - k.end.x;
  const dy = end.y - k.end.y;
  return replaceKnot(
    s,
    index,
    knot(
      end,
      vec2(k.tangentToPrev.x + dx, k.tangentToPrev.y + dy),
      vec2(k.tangentToNext.x + dx, k.tangentToNext.y + dy),
      k.continuous,
      k.other,
    ),
  );
};

/**
 * Move one tangent handle to `pos`. If the knot is continuous, the opposite
 * handle is kept collinear through the endpoint, preserving its own length
 * (smooth-curve editing).
 */
export const moveKnotTangent = (
  s: Spline,
  index: number,
  which: 'prev' | 'next',
  pos: Vec2,
): Spline => {
  const k = s.knots[index]!;
  let prev = which === 'prev' ? pos : k.tangentToPrev;
  let next = which === 'next' ? pos : k.tangentToNext;

  if (k.continuous) {
    const movedToEnd = vec2(k.end.x - pos.x, k.end.y - pos.y); // from moved handle to end
    const len = Math.hypot(movedToEnd.x, movedToEnd.y);
    const opp = which === 'prev' ? k.tangentToNext : k.tangentToPrev;
    const oppLen = Math.hypot(opp.x - k.end.x, opp.y - k.end.y);
    if (len > 1e-9) {
      const ux = movedToEnd.x / len;
      const uy = movedToEnd.y / len;
      const mirrored = vec2(k.end.x + ux * oppLen, k.end.y + uy * oppLen);
      if (which === 'prev') next = mirrored;
      else prev = mirrored;
    }
  }
  return replaceKnot(s, index, knot(k.end, prev, next, k.continuous, k.other));
};

/** Toggle a knot between continuous (smooth) and corner. Legacy BezierKnot.setContinous. */
export const setKnotContinuous = (s: Spline, index: number, continuous: boolean): Spline => {
  const k = s.knots[index]!;
  return replaceKnot(s, index, knot(k.end, k.tangentToPrev, k.tangentToNext, continuous, k.other));
};

/**
 * Insert a control point on the spline nearest to `p`, splitting the segment it
 * lands on (legacy BrdAddControlPointCommand). The de Casteljau split leaves the
 * curve shape unchanged. Returns the new spline plus the inserted knot's index,
 * or null if the spline has no segments to split.
 */
export const insertKnotAt = (s: Spline, p: Vec2): { spline: Spline; index: number } | null => {
  const hit = closestPointOnSpline(s, p);
  if (!hit) return null;
  const split = splitCurve(s.curves[hit.index]!, hit.t);
  const start = s.knots[hit.index]!;
  const end = s.knots[hit.index + 1]!;
  const insertIndex = hit.index + 1;

  // start keeps its end + prev handle; only its toNext handle is pulled in.
  const newStart = knot(
    start.end,
    start.tangentToPrev,
    split.startTangentToNext,
    start.continuous,
    start.other,
  );
  // the new knot sits on the curve; its tangents are collinear, so it is smooth.
  const mid = knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false);
  // end keeps its end + next handle; only its toPrev handle is pulled in.
  const newEnd = knot(
    end.end,
    split.endTangentToPrev,
    end.tangentToNext,
    end.continuous,
    end.other,
  );

  const knots = [
    ...s.knots.slice(0, hit.index),
    newStart,
    mid,
    newEnd,
    ...s.knots.slice(hit.index + 2),
  ];
  return { spline: splineFromKnots(knots), index: insertIndex };
};

// --- two-way coupling: cross-section centerline/width drives the curves ---

/** A knot already on the curve this close (cm) to a station is retargeted, not duplicated. */
const VALUE_X_TOL = 0.5;
/** Minimum centerline/width change (cm) that propagates back to a curve. */
const PROPAGATE_EPS = 1e-4;

/**
 * Return a copy of `s` whose value at world-x `x` equals `targetY`, exactly. A
 * Bézier knot's endpoint lies on the curve, so we either retarget an interior knot
 * already near `x` (within {@link VALUE_X_TOL}) or insert one on the curve at `x`
 * (shape-preserving split) and set its height. The new/edited knot keeps continuous
 * tangents → the curve stays faired by default; the caller can later corner it for a
 * hard step. Endpoints (tips) are never moved.
 */
export const setSplineValueAt = (s: Spline, x: number, targetY: number): Spline => {
  for (let i = 1; i < s.knots.length - 1; i++) {
    if (Math.abs(s.knots[i]!.end.x - x) <= VALUE_X_TOL) {
      return moveKnotEnd(s, i, vec2(x, targetY));
    }
  }
  const ins = insertKnotAt(s, vec2(x, valueAt(s, x)));
  if (!ins) return s;
  return moveKnotEnd(ins.spline, ins.index, vec2(x, targetY));
};

/**
 * Two-way link: propagate an interior cross-section's centerline/width edit onto the
 * rocker/deck/outline at that station. Compares the just-edited section (`next`)
 * against `prev`: a change in its bottom-center y drives the bottom rocker, its
 * deck-center y drives the deck, and its half-width (maxX) drives the outline — each
 * at the section's longitudinal position. Foil/rail shape changes that don't move the
 * centerline endpoints or the widest point propagate nothing. Returns `next`
 * unchanged when nothing crosses {@link PROPAGATE_EPS}.
 */
export const propagateCrossSectionToCurves = (
  prev: BezierBoard,
  next: BezierBoard,
  index: number,
): BezierBoard => {
  if (index <= 0 || index >= next.crossSections.length - 1) return next;
  const prevCs = prev.crossSections[index];
  const nextCs = next.crossSections[index];
  if (!prevCs || !nextCs) return next;
  const pk = prevCs.spline.knots;
  const nk = nextCs.spline.knots;
  if (pk.length === 0 || pk.length !== nk.length) return next;

  const x = nextCs.position;
  const bottomDelta = nk[0]!.end.y - pk[0]!.end.y;
  const deckDelta = nk[nk.length - 1]!.end.y - pk[pk.length - 1]!.end.y;
  const widthHalfDelta = maxX(nextCs.spline) - maxX(prevCs.spline);

  let { bottom, deck, outline } = next;
  if (Math.abs(bottomDelta) > PROPAGATE_EPS)
    bottom = setSplineValueAt(bottom, x, valueAt(bottom, x) + bottomDelta);
  if (Math.abs(deckDelta) > PROPAGATE_EPS)
    deck = setSplineValueAt(deck, x, valueAt(deck, x) + deckDelta);
  if (Math.abs(widthHalfDelta) > PROPAGATE_EPS)
    outline = setSplineValueAt(outline, x, valueAt(outline, x) + widthHalfDelta);

  if (bottom === next.bottom && deck === next.deck && outline === next.outline) return next;
  return board(outline, bottom, deck, next.crossSections, next.interpolationType);
};

// --- cross-section management (legacy Cross-sections menu) ---

/** Replace the board's cross-section list, kept sorted by longitudinal position. */
export const withCrossSections = (b: BezierBoard, list: readonly CrossSection[]): BezierBoard =>
  board(
    b.outline,
    b.bottom,
    b.deck,
    [...list].sort((a, c) => a.position - c.position),
    b.interpolationType,
  );

/**
 * Insert a shape-preserving cross-section at `position` (legacy
 * BrdAddCrossSectionCommand). The new station is the interpolated surface
 * section at that x — already scaled to the board's width/thickness there — so
 * adding it does not change the board shape; it just gives an editable station.
 * Returns the new board + the inserted section's index, or null if `position` is
 * out of range.
 */
export const insertCrossSection = (
  b: BezierBoard,
  position: number,
): { board: BezierBoard; index: number } | null => {
  const cs = getInterpolatedCrossSection(b, position);
  if (!cs) return null;
  const list = [...b.crossSections, cs].sort((a, c) => a.position - c.position);
  return { board: withCrossSections(b, list), index: list.indexOf(cs) };
};

/**
 * Remove a real (non-dummy) cross-section (legacy removeCrossSection). No-op for
 * the nose/tail dummies or if it would leave no real sections.
 */
export const removeCrossSection = (b: BezierBoard, index: number): BezierBoard => {
  const n = b.crossSections.length;
  if (index < 1 || index > n - 2) return b;
  if (n - 2 <= 1) return b; // keep at least one real section
  return withCrossSections(
    b,
    b.crossSections.filter((_, i) => i !== index),
  );
};

/**
 * Scale the whole board (legacy "Scale Board") by independent factors for length,
 * width, and thickness. Outline = half-width(y) vs length(x); deck/bottom =
 * height(y) vs length(x); cross-sections = height(y) vs width(x), with their
 * longitudinal positions scaled by the length factor. A factor of 1 leaves that
 * axis unchanged.
 */
/** Return the board with a different cross-section interpolation model. */
export const withInterpolationType = (b: BezierBoard, type: InterpolationType): BezierBoard =>
  board(b.outline, b.bottom, b.deck, b.crossSections, type);

export const scaleBoard = (b: BezierBoard, fL: number, fW: number, fT: number): BezierBoard =>
  board(
    scaleSpline(b.outline, fW, fL),
    scaleSpline(b.bottom, fT, fL),
    scaleSpline(b.deck, fT, fL),
    b.crossSections.map((cs) => crossSection(cs.position * fL, scaleSpline(cs.spline, fT, fW))),
    b.interpolationType,
  );

// --- shared curve junctions (hard constraints) ---

const JUNCTION_EPS = 1e-7;
const samePoint = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) < JUNCTION_EPS && Math.abs(a.y - b.y) < JUNCTION_EPS;

/** Copy `src`'s nose (first) + tail (last) endpoints onto `dst`, translating its tangents. */
const joinTips = (src: Spline, dst: Spline): Spline => {
  const sLast = src.knots.length - 1;
  const dLast = dst.knots.length - 1;
  if (sLast < 0 || dLast < 0) return dst;
  let out = dst;
  if (!samePoint(src.knots[0]!.end, out.knots[0]!.end)) {
    out = moveKnotEnd(out, 0, src.knots[0]!.end);
  }
  if (!samePoint(src.knots[sLast]!.end, out.knots[dLast]!.end)) {
    out = moveKnotEnd(out, dLast, src.knots[sLast]!.end);
  }
  return out;
};

/**
 * Re-establish the board's shared curve junctions so an edit can never open a gap
 * (legacy `BezierBoard` keeps these coupled; here they were independent splines):
 *
 *  - each cross-section's center endpoints sit on the stringer (x = 0), so the
 *    mirrored half-section closes;
 *  - the outline's nose endpoint sits on the centerline (y = 0), so the mirrored
 *    plan-shape closes at the tip (the tail is left free — tail width is legitimate);
 *  - the deck and bottom profiles share their nose and tail tips.
 *
 * `changed` (the just-edited curve) wins the deck↔bottom tip join, so dragging one
 * tip pulls the other along instead of snapping back. Defaults to the deck. The pass
 * is idempotent, so it is safe to run after every edit and on load.
 */
export const enforceJunctions = (b: BezierBoard, changed?: SplineTarget): BezierBoard => {
  // Cross-section center endpoints → x = 0 (stringer).
  const crossSections = b.crossSections.map((cs) => {
    const last = cs.spline.knots.length - 1;
    if (last < 0) return cs;
    let s = cs.spline;
    if (s.knots[0]!.end.x !== 0) s = moveKnotEnd(s, 0, vec2(0, s.knots[0]!.end.y));
    if (s.knots[last]!.end.x !== 0) s = moveKnotEnd(s, last, vec2(0, s.knots[last]!.end.y));
    return s === cs.spline ? cs : { position: cs.position, spline: s };
  });

  // Outline nose endpoint → y = 0 (centerline). knots[0] is the nose (smallest x).
  let outline = b.outline;
  if (outline.knots.length > 0 && outline.knots[0]!.end.y !== 0) {
    outline = moveKnotEnd(outline, 0, vec2(outline.knots[0]!.end.x, 0));
  }

  // Deck & bottom share their nose + tail tips; the edited curve wins.
  let deck = b.deck;
  let bottom = b.bottom;
  if (changed?.kind === 'bottom') deck = joinTips(bottom, deck);
  else bottom = joinTips(deck, bottom);

  return board(outline, bottom, deck, crossSections, b.interpolationType);
};

/** Only interior knots can be deleted, and never below a single segment (2 knots). */
export const canDeleteKnot = (s: Spline, index: number): boolean =>
  s.knots.length > 2 && index > 0 && index < s.knots.length - 1;

const DELETE_MAX_ITERATIONS = 1000;
const DELETE_LENGTH_TOLERANCE = 0.1; // cm — legacy convergence threshold

/** Scale a tangent handle's vector about its endpoint (legacy scaleTangentTo*). */
const scaleHandle = (end: Vec2, handle: Vec2, scale: number): Vec2 =>
  vec2(end.x + (handle.x - end.x) * scale, end.y + (handle.y - end.y) * scale);

/**
 * Delete an interior knot, merging its two segments into one (legacy
 * BrdDeleteControlPointCommand, default non-BezierFit path). The neighbours' inner
 * tangents are iteratively scaled so the merged curve's arc length matches the sum
 * of the two original segments — preserving the overall shape as closely as a
 * single cubic can. Returns the spline unchanged if `index` is not deletable.
 */
export const deleteKnot = (s: Spline, index: number): Spline => {
  if (!canDeleteKnot(s, index)) return s;
  const prev = s.knots[index - 1]!;
  const next = s.knots[index + 1]!;
  const targetLen = curveLength(s.coeffs[index - 1]!) + curveLength(s.coeffs[index]!);

  let pTanNext = prev.tangentToNext;
  let nTanPrev = next.tangentToPrev;
  for (let i = 0; i < DELETE_MAX_ITERATIONS; i++) {
    const len = curveLength(coeffsOf(curveFromPoints(prev.end, pTanNext, nTanPrev, next.end)));
    if (Math.abs(len - targetLen) < DELETE_LENGTH_TOLERANCE) break;
    const factor = targetLen / len;
    pTanNext = scaleHandle(prev.end, pTanNext, factor);
    nTanPrev = scaleHandle(next.end, nTanPrev, factor);
  }

  const newPrev = knot(prev.end, prev.tangentToPrev, pTanNext, prev.continuous, prev.other);
  const newNext = knot(next.end, nTanPrev, next.tangentToNext, next.continuous, next.other);
  const knots = [...s.knots.slice(0, index - 1), newPrev, newNext, ...s.knots.slice(index + 2)];
  return splineFromKnots(knots);
};
