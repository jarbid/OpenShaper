import {
  board,
  closestPointOnSpline,
  coeffsOf,
  crossSection,
  curveFromPoints,
  curveLength,
  defaultFinConfig,
  editableCrossSection,
  getLength,
  hasTailCutout,
  knot,
  knotLock,
  mirrorFinIndex,
  maxX,
  scaleSpline,
  splineFromKnots,
  splitCurve,
  valueAt,
  vec2,
  widthBoundsAt,
  withHandles,
  type BezierBoard,
  type CrossSection,
  type FinConfig,
  type FinSetup,
  type FinSpec,
  type FinSystem,
  type InterpolationType,
  type Knot,
  type KnotLock,
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

/** Whether two targets name the same spline (same kind, and same station for sections). */
export const sameTarget = (a: SplineTarget, b: SplineTarget): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'crossSection' || (b.kind === 'crossSection' && b.index === a.index));

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
      return board(spline, b.bottom, b.deck, b.crossSections, b.interpolationType, b.fins);
    case 'deck':
      return board(b.outline, b.bottom, spline, b.crossSections, b.interpolationType, b.fins);
    case 'bottom':
      return board(b.outline, spline, b.deck, b.crossSections, b.interpolationType, b.fins);
    case 'crossSection': {
      const cs = b.crossSections.map((c, i) =>
        i === t.index ? { position: c.position, spline } : c,
      );
      return board(b.outline, b.bottom, b.deck, cs, b.interpolationType, b.fins);
    }
  }
};

// --- handle-angle locks ---

/**
 * `handle` slid onto the ray from `end` along the unit vector `dir`: the length it
 * reaches along that direction, never less than zero. A handle dragged back past its
 * point collapses onto it instead of flipping round. One already on the ray (to
 * rounding) is returned untouched, so re-applying a lock never nudges a point.
 */
const projectOntoLock = (end: Vec2, handle: Vec2, dir: Vec2): Vec2 => {
  const dx = handle.x - end.x;
  const dy = handle.y - end.y;
  const along = dx * dir.x + dy * dir.y;
  if (along >= 0 && Math.abs(dx * dir.y - dy * dir.x) <= 1e-9) return handle;
  const len = Math.max(0, along);
  return vec2(end.x + dir.x * len, end.y + dir.y * len);
};

/**
 * Pull a knot's locked handles back onto their lock directions. A free knot, or one
 * whose handles already obey their lock, is returned as is.
 */
export const constrainToLock = (k: Knot): Knot => {
  const { lock } = k;
  if (!lock) return k;
  const prev = lock.prev ? projectOntoLock(k.end, k.tangentToPrev, lock.prev) : k.tangentToPrev;
  const next = lock.next ? projectOntoLock(k.end, k.tangentToNext, lock.next) : k.tangentToNext;
  return prev === k.tangentToPrev && next === k.tangentToNext ? k : withHandles(k, prev, next);
};

/** The unit vector from `from` toward `to`, or undefined when they coincide. */
const direction = (from: Vec2, to: Vec2): Vec2 | undefined => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? vec2(dx / len, dy / len) : undefined;
};

const reversed = (d: Vec2): Vec2 => vec2(-d.x, -d.y);

/**
 * The directions locking `k` keeps: where its handles point now. A smooth point's
 * handles share one axis, so a collapsed side takes the opposite of the other; a
 * corner's collapsed side has no direction and stays free.
 */
const lockFromHandles = (k: Knot): KnotLock | undefined => {
  let prev = direction(k.end, k.tangentToPrev);
  let next = direction(k.end, k.tangentToNext);
  if (k.continuous) {
    prev ??= next && reversed(next);
    next ??= prev && reversed(prev);
  }
  return knotLock(prev, next);
};

/** Whether a knot has a handle direction to lock — not when both handles are collapsed. */
export const canLockKnot = (k: Knot): boolean => lockFromHandles(k) !== undefined;

const replaceKnot = (s: Spline, index: number, k: Knot): Spline =>
  splineFromKnots(s.knots.map((kk, i) => (i === index ? constrainToLock(k) : kk)));

/**
 * Lock or unlock a knot's handle directions. Locking keeps the directions the handles
 * have now and never moves them, so the curve is unchanged either way. Re-locking a
 * locked knot is a no-op: it must not forget the direction of a collapsed handle.
 */
export const setKnotLock = (s: Spline, index: number, locked: boolean): Spline => {
  const k = s.knots[index];
  if (!k) return s;
  if (!locked) {
    if (!k.lock) return s;
    const { lock: _lock, ...free } = k;
    return replaceKnot(s, index, free);
  }
  if (k.lock) return s;
  const lock = lockFromHandles(k);
  return lock ? replaceKnot(s, index, { ...k, lock }) : s;
};

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
      k.lock,
    ),
  );
};

/**
 * Move one tangent handle to `pos`. If the knot is continuous, the opposite
 * handle is kept collinear through the endpoint, preserving its own length
 * (smooth-curve editing).
 *
 * A locked handle slides along its lock, so `pos` only sets its length. A locked
 * opposite handle is left alone: its direction is fixed, so there is nothing to mirror.
 */
export const moveKnotTangent = (
  s: Spline,
  index: number,
  which: 'prev' | 'next',
  pos: Vec2,
): Spline => {
  const k = s.knots[index]!;
  const ownLock = which === 'prev' ? k.lock?.prev : k.lock?.next;
  const oppositeLock = which === 'prev' ? k.lock?.next : k.lock?.prev;
  const moved = ownLock ? projectOntoLock(k.end, pos, ownLock) : pos;
  let prev = which === 'prev' ? moved : k.tangentToPrev;
  let next = which === 'next' ? moved : k.tangentToNext;

  if (k.continuous && !oppositeLock) {
    const movedToEnd = vec2(k.end.x - moved.x, k.end.y - moved.y); // from moved handle to end
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
  return replaceKnot(s, index, withHandles(k, prev, next));
};

/**
 * Set a handle's length, keeping its direction — its lock's, or where it points now.
 * A collapsed free handle has no direction, so it is left as is.
 */
export const setKnotTangentLength = (
  s: Spline,
  index: number,
  which: 'prev' | 'next',
  length: number,
): Spline => {
  const k = s.knots[index];
  if (!k || !Number.isFinite(length)) return s;
  const handle = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
  const dir = (which === 'prev' ? k.lock?.prev : k.lock?.next) ?? direction(k.end, handle);
  if (!dir) return s;
  const len = Math.max(0, length);
  return moveKnotTangent(s, index, which, vec2(k.end.x + dir.x * len, k.end.y + dir.y * len));
};

/** Adjust the two handles belonging to one segment as a single immutable edit. */
export const moveSegmentTangents = (s: Spline, index: number, first: Vec2, last: Vec2): Spline => {
  if (
    !s.knots[index] ||
    !s.knots[index + 1] ||
    ![first.x, first.y, last.x, last.y].every(Number.isFinite)
  )
    return s;
  const a = s.knots[index]!.tangentToNext;
  const b = s.knots[index + 1]!.tangentToPrev;
  if (a.x === first.x && a.y === first.y && b.x === last.x && b.y === last.y) return s;
  return moveKnotTangent(moveKnotTangent(s, index, 'next', first), index + 1, 'prev', last);
};

/**
 * Toggle a knot between continuous (smooth) and corner. Legacy BezierKnot.setContinous.
 * A locked point made smooth locks both sides along one axis, since its handles now
 * move together.
 */
export const setKnotContinuous = (s: Spline, index: number, continuous: boolean): Spline => {
  const k = s.knots[index]!;
  const lock =
    continuous && k.lock
      ? knotLock(
          k.lock.prev ?? (k.lock.next && reversed(k.lock.next)),
          k.lock.next ?? (k.lock.prev && reversed(k.lock.prev)),
        )
      : k.lock;
  return replaceKnot(
    s,
    index,
    knot(k.end, k.tangentToPrev, k.tangentToNext, continuous, k.other, lock),
  );
};

/**
 * Rebuild one knot's handles from its neighbouring chord, without changing corner/smooth
 * state. A locked handle keeps its direction and only takes the faired length.
 */
export const fairKnot = (s: Spline, index: number): Spline => {
  const k = s.knots[index];
  if (!k) return s;
  const prev = s.knots[index - 1];
  const next = s.knots[index + 1];
  if (!prev && !next) return s;

  // The chord through the neighbouring endpoints is a stable local tangent estimate.
  // One-third of each adjacent chord gives ordinary cubic-Bezier handle lengths and
  // avoids the long handles that commonly create loops or wiggles.
  const from = prev?.end ?? k.end;
  const to = next?.end ?? k.end;
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  let chordLength = Math.hypot(dx, dy);
  if (chordLength <= 1e-9) {
    dx = k.tangentToNext.x - k.end.x;
    dy = k.tangentToNext.y - k.end.y;
    chordLength = Math.hypot(dx, dy);
  }
  if (chordLength <= 1e-9) return s;
  const ux = dx / chordLength;
  const uy = dy / chordLength;
  const prevLength = prev ? Math.hypot(k.end.x - prev.end.x, k.end.y - prev.end.y) / 3 : 0;
  const nextLength = next ? Math.hypot(next.end.x - k.end.x, next.end.y - k.end.y) / 3 : 0;
  const lockPrev = k.lock?.prev;
  const lockNext = k.lock?.next;

  return replaceKnot(
    s,
    index,
    withHandles(
      k,
      lockPrev
        ? vec2(k.end.x + lockPrev.x * prevLength, k.end.y + lockPrev.y * prevLength)
        : vec2(k.end.x - ux * prevLength, k.end.y - uy * prevLength),
      lockNext
        ? vec2(k.end.x + lockNext.x * nextLength, k.end.y + lockNext.y * nextLength)
        : vec2(k.end.x + ux * nextLength, k.end.y + uy * nextLength),
    ),
  );
};

/** Collapse one tangent handle onto its endpoint. */
export const zeroKnotTangent = (s: Spline, index: number, which: 'prev' | 'next'): Spline => {
  const k = s.knots[index];
  if (!k) return s;
  return moveKnotTangent(s, index, which, k.end);
};

/**
 * Give a collapsed tangent a short, useful length directed toward its adjacent knot —
 * or along its lock, when locked. The 20% local-chord length is capped so it remains
 * a small editing affordance on both full-length curves and compact cross-sections.
 */
export const extendKnotTangent = (s: Spline, index: number, which: 'prev' | 'next'): Spline => {
  const k = s.knots[index];
  if (!k) return s;
  const current = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
  if (Math.hypot(current.x - k.end.x, current.y - k.end.y) > 1e-9) return s;
  const locked = which === 'prev' ? k.lock?.prev : k.lock?.next;

  const neighbour = s.knots[index + (which === 'prev' ? -1 : 1)];
  const opposite = which === 'prev' ? k.tangentToNext : k.tangentToPrev;
  let dx: number;
  let dy: number;
  let referenceLength: number;
  if (neighbour) {
    dx = neighbour.end.x - k.end.x;
    dy = neighbour.end.y - k.end.y;
    referenceLength = Math.hypot(dx, dy);
  } else {
    // End knots have no neighbour on one side. Mirror the visible opposite handle;
    // if both are collapsed, fall back to the conventional left/right X direction.
    dx = k.end.x - opposite.x;
    dy = k.end.y - opposite.y;
    referenceLength = Math.hypot(dx, dy);
    if (referenceLength <= 1e-9) {
      dx = which === 'prev' ? -1 : 1;
      dy = 0;
      referenceLength = 5;
    }
  }
  const directionLength = Math.hypot(dx, dy);
  if (!locked && directionLength <= 1e-9) return s;
  const length = Math.max(0.5, Math.min(5, referenceLength * 0.2));
  const ux = locked ? locked.x : dx / directionLength;
  const uy = locked ? locked.y : dy / directionLength;
  return moveKnotTangent(s, index, which, {
    x: k.end.x + ux * length,
    y: k.end.y + uy * length,
  });
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

  // start keeps its end + prev handle; only its toNext handle is pulled in. The split
  // only shortens it, so any lock on the start knot still holds.
  const newStart = withHandles(start, start.tangentToPrev, split.startTangentToNext);
  // the new knot sits on the curve; its tangents are collinear, so it is smooth. It
  // starts free: the user locks the points they choose.
  const mid = knot(split.mid.end, split.mid.tangentToPrev, split.mid.tangentToNext, true, false);
  // end keeps its end + next handle; only its toPrev handle is pulled in.
  const newEnd = withHandles(end, split.endTangentToPrev, end.tangentToNext);

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
  if (pk.length === 0 || nk.length === 0) return next;

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
  return board(outline, bottom, deck, next.crossSections, next.interpolationType, next.fins);
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
    b.fins,
  );

/**
 * Insert a shape-preserving cross-section at `position` (legacy
 * BrdAddCrossSectionCommand). The new station is the surface section at that x —
 * already scaled to the board's width/thickness there — so adding it does not change
 * the board shape; it just gives an editable station. Returns the new board + the
 * inserted section's index, or null if `position` is out of range.
 *
 * "Does not change the board shape" used to be false. The section came off
 * `getInterpolatedCrossSection`, whose control-point blend can sit millimetres from the
 * surface the 3D view and the STL show — up to 4.59 mm on the golden longboard with a
 * different rail at each station — so the user asked for a handle and silently got a
 * different board. `editableCrossSection` keeps that blend wherever it is already right
 * (usually exactly right, at five knots) and fits the lofted surface where it is not.
 * See `section-fit.ts` for why an inserted station cannot simply be the lofted curve.
 */
export const insertCrossSection = (
  b: BezierBoard,
  position: number,
): { board: BezierBoard; index: number } | null => {
  const cs = editableCrossSection(b, position);
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
 * Move a real cross-section along the board while preserving its list index.
 * Stations cannot pass their neighbours: keeping the order stable means a drag
 * never starts editing one section and finishes editing another.
 */
export const moveCrossSectionPosition = (
  b: BezierBoard,
  index: number,
  position: number,
): BezierBoard => {
  const n = b.crossSections.length;
  if (index < 1 || index > n - 2 || !Number.isFinite(position)) return b;
  const current = b.crossSections[index]!;
  const previous = b.crossSections[index - 1]!;
  const next = b.crossSections[index + 1]!;
  const min = previous.position + 1e-3;
  const max = next.position - 1e-3;
  if (min > max) return b;
  const clamped = Math.min(max, Math.max(min, position));
  if (clamped === current.position) return b;
  const sections = b.crossSections.map((section, i) =>
    i === index ? crossSection(clamped, section.spline) : section,
  );
  return board(b.outline, b.bottom, b.deck, sections, b.interpolationType, b.fins);
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
  board(b.outline, b.bottom, b.deck, b.crossSections, type, b.fins);

/**
 * Scale fin placement with the board (legacy `finScaling`): trailing-edge distance
 * from the tail and base scale with length; rail inset and blade depth scale with
 * width / thickness. Angles are unchanged.
 */
const scaleFins = (
  cfg: BezierBoard['fins'],
  fL: number,
  fW: number,
  fT: number,
): BezierBoard['fins'] => ({
  ...cfg,
  fins: cfg.fins.map((f) => ({
    ...f,
    trailingFromTail: f.trailingFromTail * fL,
    base: f.base * fL,
    insetFromRail: f.insetFromRail * fW,
    depth: f.depth * fT,
  })),
});

export const scaleBoard = (b: BezierBoard, fL: number, fW: number, fT: number): BezierBoard =>
  board(
    scaleSpline(b.outline, fW, fL),
    scaleSpline(b.bottom, fT, fL),
    scaleSpline(b.deck, fT, fL),
    b.crossSections.map((cs) => crossSection(cs.position * fL, scaleSpline(cs.spline, fT, fW))),
    b.interpolationType,
    scaleFins(b.fins, fL, fW, fT),
  );

// --- fins -------------------------------------------------------------------

/** Return a new board with a different fin configuration. */
export const withFins = (b: BezierBoard, fins: FinConfig): BezierBoard =>
  board(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, fins);

/** Change the fin setup, re-seeding placement from defaults but keeping the system. */
export const setFinSetup = (b: BezierBoard, setup: FinSetup): BezierBoard =>
  withFins(b, defaultFinConfig(setup, b.fins.system));

/** Change the fin system (FCS/Futures/glass-on), keeping placement. */
export const setFinSystem = (b: BezierBoard, system: FinSystem): BezierBoard =>
  withFins(b, { ...b.fins, system });

/** Toggle whether port/starboard side-fin pairs are kept mirror-symmetric. */
export const setFinSymmetrical = (b: BezierBoard, symmetrical: boolean): BezierBoard =>
  withFins(b, { ...b.fins, symmetrical });

/**
 * Patch a single fin's parametric spec. When the config is symmetrical, the same
 * geometry change (everything but `side`) is mirrored onto the fin's opposite-side
 * partner, so a port/starboard pair stays matched.
 */
export const updateFinSpec = (
  b: BezierBoard,
  index: number,
  patch: Partial<FinSpec>,
): BezierBoard => {
  if (index < 0 || index >= b.fins.fins.length) return b;
  const mirror = b.fins.symmetrical ? mirrorFinIndex(b.fins.fins, index) : null;
  // The partner keeps its own side; only geometry/placement mirrors.
  const { side: _side, ...geomPatch } = patch;
  const fins = b.fins.fins.map((f, i) => {
    if (i === index) return { ...f, ...patch };
    if (i === mirror) return { ...f, ...geomPatch };
    return f;
  });
  return withFins(b, { ...b.fins, fins });
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Re-derive a fin's parametric placement from a dropped plan point (x along length, y
 * lateral) — used for 2D drag. The fin keeps its side; its trailing-edge distance from
 * the tail and (for side fins) its inset from the rail are read back off the point.
 */
export const setFinFromPlanPoint = (b: BezierBoard, index: number, point: Vec2): BezierBoard => {
  const spec = b.fins.fins[index];
  if (!spec) return b;
  const length = getLength(b);
  const cx = clamp(point.x, 0.1, length - 0.1);
  // The tail is always at x=0 (see `resolveFins`), so x is the distance from it.
  const trailingFromTail = Math.max(0, cx - spec.base / 2);
  const patch: Partial<FinSpec> =
    spec.side === 0
      ? { trailingFromTail }
      : {
          trailingFromTail,
          // Outer rail half-width (concave-tail aware) minus the drop point's offset.
          insetFromRail: Math.max(0, widthBoundsAt(b, cx).yOut - Math.abs(point.y)),
        };
  return updateFinSpec(b, index, patch);
};

// --- shared curve junctions (hard constraints) ---

const JUNCTION_EPS = 1e-7;
const samePoint = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) < JUNCTION_EPS && Math.abs(a.y - b.y) < JUNCTION_EPS;

/** Copy `src`'s tail (first) + nose (last) endpoints onto `dst`, translating its tangents. */
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
 * Lock a curve's two endpoints to the board's longitudinal stations — tail tip → x = 0,
 * nose tip → x = length (legacy JC-2/JC-3 endpoint x-mask). Heights (y) are preserved, so
 * tip heights stay editable; only the stations are pinned, so a drag can never pull a tip
 * off the ends of the board. `length` is the outline-derived board length, the single
 * source of truth so all three curves' nose tips coincide.
 */
const lockEndpointsX = (s: Spline, length: number): Spline => {
  const last = s.knots.length - 1;
  if (last < 1) return s;
  let out = s;
  if (out.knots[0]!.end.x !== 0) out = moveKnotEnd(out, 0, vec2(0, out.knots[0]!.end.y));
  if (out.knots[last]!.end.x !== length)
    out = moveKnotEnd(out, last, vec2(length, out.knots[last]!.end.y));
  return out;
};

/**
 * JC-6 monotonic tangent-flow lock for an open profile curve (outline / deck / bottom):
 * every knot's `toPrev` handle x is clamped to ≤ its endpoint x (`LOCK_X_LESS`) and its
 * `toNext` handle x to ≥ its endpoint x (`LOCK_X_MORE`). The handles therefore always point
 * "back" (−x) and "forward" (+x), so the curve stays single-valued in x — a drag can never
 * fold a tangent back on itself. y is untouched. Idempotent and a no-op for handles that
 * already flow the right way (the normal case for a well-formed board curve).
 */
const clampMonotonicX = (s: Spline, exemptUpTo = -1): Spline => {
  const n = s.knots.length;
  let out = s;
  for (let i = 0; i < n; i++) {
    // Knots in the tail-fold region of a concave tail (swallow / fish) are exempt:
    // their handles legitimately point "back" so the notch wall can curve forward
    // toward the centreline. Everything from the tail tip to the nose stays clamped.
    if (i <= exemptUpTo) continue;
    const k = out.knots[i]!;
    // Only the handles that drive a segment matter: an open spline never uses the first
    // knot's toPrev or the last knot's toNext, so leave those dangling handles untouched —
    // this keeps the clamp a true no-op on well-formed boards instead of normalizing inert
    // data, while still preventing every real fold (which is governed by the used handles).
    const prevX = i > 0 ? Math.min(k.tangentToPrev.x, k.end.x) : k.tangentToPrev.x;
    const nextX = i < n - 1 ? Math.max(k.tangentToNext.x, k.end.x) : k.tangentToNext.x;
    if (prevX !== k.tangentToPrev.x || nextX !== k.tangentToNext.x) {
      out = replaceKnot(
        out,
        i,
        withHandles(k, vec2(prevX, k.tangentToPrev.y), vec2(nextX, k.tangentToNext.y)),
      );
    }
  }
  return out;
};

/**
 * Legacy `LOCK_*_MORE` tangent floor: raise one handle's `x` or `y` component so it is ≥ the
 * knot's endpoint component (the handle cannot drop "below" the endpoint on that axis). Used
 * for JC-7 (outline tips, `LOCK_Y_MORE`) and JC-8 (section centre tips, `LOCK_X_MORE`).
 * Returns the same spline reference when already satisfied (no-op).
 */
const clampHandleFloor = (
  s: Spline,
  index: number,
  which: 'prev' | 'next',
  axis: 'x' | 'y',
): Spline => {
  const k = s.knots[index];
  if (!k) return s;
  const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
  const floor = axis === 'x' ? k.end.x : k.end.y;
  if (h[axis] >= floor) return s;
  const nh = axis === 'x' ? vec2(floor, h.y) : vec2(h.x, floor);
  const prev = which === 'prev' ? nh : k.tangentToPrev;
  const next = which === 'next' ? nh : k.tangentToNext;
  return replaceKnot(s, index, withHandles(k, prev, next));
};

/**
 * Re-establish the board's shared curve junctions so an edit can never open a gap
 * (legacy `BezierBoard` keeps these coupled; here they were independent splines):
 *
 *  - each cross-section's center endpoints sit on the stringer (x = 0), so the
 *    mirrored half-section closes (JC-4 x); their inward rail handles stay on the +x
 *    side of the stringer (JC-8);
 *  - the outline's tail station is pinned to x = 0 and the nose tip to the centerline
 *    y = 0 (JC-1); the nose's x defines the board length so it is the length reference,
 *    and the tail's y is left free — square / fish tails carry legitimate width;
 *  - the deck and bottom endpoints are x-locked to the board stations {0, length}
 *    (JC-2 / JC-3), so their tips always sit over the outline's tail and nose;
 *  - the deck and bottom profiles share those tail and nose tips (JC-5);
 *  - outline / deck / bottom stay single-valued in x — tangents can't fold back (JC-6) —
 *    and the outline tips' inward handles can only leave the centreline outward (JC-7);
 *  - every outline point keeps a non-negative half-width (y ≥ 0), so it can't be dragged
 *    across the centre line to the mirrored half (an OpenShaper guard beyond legacy).
 *
 * `changed` (the just-edited curve) wins the deck↔bottom tip join, so dragging one
 * tip pulls the other along instead of snapping back. Defaults to the deck. The pass
 * is idempotent, so it is safe to run after every edit and on load.
 */
export const enforceJunctions = (b: BezierBoard, changed?: SplineTarget): BezierBoard => {
  const length = getLength(b);

  // Cross-section center endpoints → x = 0 (stringer) (JC-4 x); the inward rail handles
  // at those tips must not cross to the mirrored half (JC-8: toNext.x / toPrev.x ≥ 0).
  const crossSections = b.crossSections.map((cs) => {
    const last = cs.spline.knots.length - 1;
    if (last < 0) return cs;
    let s = cs.spline;
    if (s.knots[0]!.end.x !== 0) s = moveKnotEnd(s, 0, vec2(0, s.knots[0]!.end.y));
    if (s.knots[last]!.end.x !== 0) s = moveKnotEnd(s, last, vec2(0, s.knots[last]!.end.y));
    s = clampHandleFloor(s, 0, 'next', 'x');
    s = clampHandleFloor(s, last, 'prev', 'x');
    return s === cs.spline ? cs : { position: cs.position, spline: s };
  });

  // Outline tail/nose pins (JC-1). The rearmost (min-x) outline knot is the tail tip
  // and the length/station reference — pinned to x = 0. For a normal board that is
  // knots[0]; for a concave tail (swallow / fish) it is the interior tip, while knots[0]
  // is the notch bottom on the centreline. The nose (knots[last], largest x = length)
  // tapers to a point, so its half-width y is pinned to 0. The tail's y is left free —
  // square / fish / swallow tails carry legitimate tail-block width. (Legacy JC-1 locks
  // BOTH tips fully via mask; we keep the tail width editable — see docs/specs/divergences.md.)
  const concaveTail = hasTailCutout(b.outline);
  let outline = b.outline;
  const noseIdx = outline.knots.length - 1;
  let tipIdx = 0;
  if (noseIdx > 0) {
    for (let i = 1; i <= noseIdx; i++)
      if (outline.knots[i]!.end.x < outline.knots[tipIdx]!.end.x) tipIdx = i;
    if (outline.knots[tipIdx]!.end.x !== 0)
      outline = moveKnotEnd(outline, tipIdx, vec2(0, outline.knots[tipIdx]!.end.y));
    if (outline.knots[noseIdx]!.end.y !== 0)
      outline = moveKnotEnd(outline, noseIdx, vec2(outline.knots[noseIdx]!.end.x, 0));
    // Concave tail (swallow / fish): knots[0] is the notch bottom — the forward end of
    // the inner wall, the deepest point of the V — which must sit ON the centreline
    // (mirror line, y = 0) so the notch closes there and the two pods merge into solid
    // board. Pin it to y = 0. (tipIdx > 0 confirms the tip is interior, so knots[0] is
    // genuinely the notch bottom and not the tail tip — whose y stays free.)
    if (concaveTail && tipIdx > 0 && outline.knots[0]!.end.y !== 0)
      outline = moveKnotEnd(outline, 0, vec2(outline.knots[0]!.end.x, 0));
    // Half-width floor: an outline point is a half-width (y), mirrored about the stringer
    // (the centre line, y = 0). A point can never cross to the far side, so clamp every
    // endpoint to y ≥ 0. moveKnotEnd carries the handles up with it, so the point stops at
    // the centre line under the cursor instead of inverting the planshape.
    for (let i = 0; i <= noseIdx; i++) {
      const k = outline.knots[i]!;
      if (k.end.y < 0) outline = moveKnotEnd(outline, i, vec2(k.end.x, 0));
    }
  }

  // Deck & bottom endpoints x-locked to the board stations {0, length} (JC-2/JC-3),
  // then they share their tail + nose tips with each other (JC-5); the edited curve wins.
  let deck = lockEndpointsX(b.deck, length);
  let bottom = lockEndpointsX(b.bottom, length);
  if (changed?.kind === 'bottom') deck = joinTips(bottom, deck);
  else bottom = joinTips(deck, bottom);

  // JC-6: the outline stays single-valued in x EXCEPT the concave-tail fold region
  // (knots[0..tip], where the notch wall legitimately curves back); deck / bottom are
  // always single-valued. JC-7: the outline tip + nose inward handles can only depart
  // the centreline outward (+y) so the planshape can't invert at the tips.
  outline = clampMonotonicX(outline, concaveTail ? tipIdx : -1);
  deck = clampMonotonicX(deck);
  bottom = clampMonotonicX(bottom);
  if (noseIdx > 0) {
    outline = clampHandleFloor(outline, tipIdx, 'next', 'y');
    outline = clampHandleFloor(outline, noseIdx, 'prev', 'y');
  }

  return board(outline, bottom, deck, crossSections, b.interpolationType, b.fins);
};

/**
 * Align both tangent handles of a knot so they point along the horizontal (X) axis,
 * preserving each handle's distance from the endpoint.
 *
 * Port of `BrdEditCommand.rotateControlPointToHorizontal` (which==0 path):
 * - The prev handle x-offset direction (sign) is kept; y is set to `end.y`.
 * - The next handle x-offset direction is kept; y is set to `end.y`.
 * - If the knot is continuous, both handles are mirrored through the endpoint so
 *   they remain collinear on the horizontal axis.
 * - If the knot is locked, the lock turns with the handles: aligning a locked point
 *   is how a handle is locked horizontal.
 */
export const alignTangentsHorizontal = (s: Spline, index: number): Spline => {
  const k = s.knots[index]!;
  const { end } = k;
  const prevLen = Math.hypot(k.tangentToPrev.x - end.x, k.tangentToPrev.y - end.y);
  const nextLen = Math.hypot(k.tangentToNext.x - end.x, k.tangentToNext.y - end.y);
  // Preserve the horizontal direction (sign) of each handle relative to the endpoint.
  // Legacy uses strict > 0 for prevSign, >= 0 for nextSign (matches BrdEditCommand).
  const prevSign = k.tangentToPrev.x - end.x > 0 ? 1 : -1;
  let nextSign = k.tangentToNext.x - end.x >= 0 ? 1 : -1;
  // Both handles must be collinear on the horizontal axis through the endpoint.
  // The prev handle drives the mirror: next is opposite direction, preserving next length.
  if (k.continuous) nextSign = -prevSign;

  const prev = vec2(end.x + prevLen * prevSign, end.y);
  const next = vec2(end.x + nextLen * nextSign, end.y);
  const lock = k.lock && { prev: vec2(prevSign, 0), next: vec2(nextSign, 0) };

  return replaceKnot(s, index, knot(end, prev, next, k.continuous, k.other, lock));
};

/**
 * Align both tangent handles of a knot so they point along the vertical (Y) axis,
 * preserving each handle's distance from the endpoint.
 *
 * Port of `BrdEditCommand.rotateControlPointToVertical` (which==0 path):
 * - The prev handle y-offset direction (sign) is kept; x is set to `end.x`.
 * - The next handle y-offset direction is kept; x is set to `end.x`.
 * - If the knot is continuous, both handles are mirrored through the endpoint so
 *   they remain collinear on the vertical axis.
 * - If the knot is locked, the lock turns with the handles: aligning a locked point
 *   is how a handle is locked vertical.
 */
export const alignTangentsVertical = (s: Spline, index: number): Spline => {
  const k = s.knots[index]!;
  const { end } = k;
  const prevLen = Math.hypot(k.tangentToPrev.x - end.x, k.tangentToPrev.y - end.y);
  const nextLen = Math.hypot(k.tangentToNext.x - end.x, k.tangentToNext.y - end.y);
  // Preserve the vertical direction (sign) of each handle relative to the endpoint.
  // Legacy uses strict > 0 for prevSign, >= 0 for nextSign (matches BrdEditCommand).
  let prevSign = k.tangentToPrev.y - end.y > 0 ? 1 : -1;
  const nextSign = k.tangentToNext.y - end.y >= 0 ? 1 : -1;

  // Legacy applies two independent if-blocks for which==0 (both run).
  // Block 1 aligns prev (and mirrors next via prevSign if continuous).
  // Block 2 aligns next (and mirrors prev via nextSign if continuous), overwriting block 1.
  // With continuous=true the second block always wins: next keeps its sign, and prev is
  // mirrored from nextSign.
  if (k.continuous) prevSign = -nextSign;

  const prev = vec2(end.x, end.y + prevLen * prevSign);
  const next = vec2(end.x, end.y + nextLen * nextSign);
  const lock = k.lock && { prev: vec2(0, prevSign), next: vec2(0, nextSign) };

  return replaceKnot(s, index, knot(end, prev, next, k.continuous, k.other, lock));
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

  // Scaling a handle about its point keeps its direction, so the neighbours' locks hold.
  const newPrev = withHandles(prev, prev.tangentToPrev, pTanNext);
  const newNext = withHandles(next, nTanPrev, next.tangentToNext);
  const knots = [...s.knots.slice(0, index - 1), newPrev, newNext, ...s.knots.slice(index + 2)];
  return splineFromKnots(knots);
};
