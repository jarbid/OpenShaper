import {
  board,
  closestPointOnSpline,
  coeffsOf,
  crossSection,
  curveFromPoints,
  curveLength,
  defaultFinConfig,
  getInterpolatedCrossSection,
  getLength,
  getWidthAtPos,
  knot,
  mirrorFinIndex,
  maxX,
  scaleSpline,
  splineFromKnots,
  splitCurve,
  valueAt,
  vec2,
  type BezierBoard,
  type CrossSection,
  type FinConfig,
  type FinSetup,
  type FinSpec,
  type FinSystem,
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
  const tailAtZero = getWidthAtPos(b, 5) >= getWidthAtPos(b, length - 5);
  const tailX = tailAtZero ? 0 : length;
  const cx = clamp(point.x, 0.1, length - 0.1);
  const trailingFromTail = Math.max(0, Math.abs(cx - tailX) - spec.base / 2);
  const patch: Partial<FinSpec> =
    spec.side === 0
      ? { trailingFromTail }
      : {
          trailingFromTail,
          insetFromRail: Math.max(0, valueAt(b.outline, cx) - Math.abs(point.y)),
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
const clampMonotonicX = (s: Spline): Spline => {
  const n = s.knots.length;
  let out = s;
  for (let i = 0; i < n; i++) {
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
        knot(
          k.end,
          vec2(prevX, k.tangentToPrev.y),
          vec2(nextX, k.tangentToNext.y),
          k.continuous,
          k.other,
        ),
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
  return replaceKnot(s, index, knot(k.end, prev, next, k.continuous, k.other));
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

  // Outline: tail station pinned to x = 0, nose tip pinned to the centerline y = 0
  // (JC-1). The nose is knots[last] (largest x = length); it tapers to a point on the
  // stringer, so its half-width is 0. Its x is the length reference, so it is not itself
  // x-locked. The tail's y is left free — square / fish tails carry legitimate tail-block
  // width. (Legacy JC-1 locks BOTH tips fully via mask; we keep the tail width editable
  // and re-snap stations only — see docs/specs/divergences.md.)
  let outline = b.outline;
  const noseIdx = outline.knots.length - 1;
  if (noseIdx > 0) {
    if (outline.knots[0]!.end.x !== 0)
      outline = moveKnotEnd(outline, 0, vec2(0, outline.knots[0]!.end.y));
    if (outline.knots[noseIdx]!.end.y !== 0)
      outline = moveKnotEnd(outline, noseIdx, vec2(outline.knots[noseIdx]!.end.x, 0));
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

  // JC-6: outline / deck / bottom stay single-valued in x (run after every endpoint move,
  // since moveKnotEnd translates the handles too). JC-7: the outline tips' inward handles
  // can only depart the centreline outward (+y) so the planshape can't invert at the tips.
  outline = clampMonotonicX(outline);
  deck = clampMonotonicX(deck);
  bottom = clampMonotonicX(bottom);
  if (noseIdx > 0) {
    outline = clampHandleFloor(outline, 0, 'next', 'y');
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
 */
export const alignTangentsHorizontal = (s: Spline, index: number): Spline => {
  const k = s.knots[index]!;
  const { end } = k;
  const prevLen = Math.hypot(k.tangentToPrev.x - end.x, k.tangentToPrev.y - end.y);
  const nextLen = Math.hypot(k.tangentToNext.x - end.x, k.tangentToNext.y - end.y);
  // Preserve the horizontal direction (sign) of each handle relative to the endpoint.
  // Legacy uses strict > 0 for prevSign, >= 0 for nextSign (matches BrdEditCommand).
  const prevSign = k.tangentToPrev.x - end.x > 0 ? 1 : -1;
  const nextSign = k.tangentToNext.x - end.x >= 0 ? 1 : -1;

  let prev = vec2(end.x + prevLen * prevSign, end.y);
  let next = vec2(end.x + nextLen * nextSign, end.y);

  if (k.continuous) {
    // Both handles must be collinear on the horizontal axis through the endpoint.
    // The prev handle drives the mirror: next is opposite direction, preserving next length.
    next = vec2(end.x - nextLen * prevSign, end.y);
  }

  return replaceKnot(s, index, knot(end, prev, next, k.continuous, k.other));
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
 */
export const alignTangentsVertical = (s: Spline, index: number): Spline => {
  const k = s.knots[index]!;
  const { end } = k;
  const prevLen = Math.hypot(k.tangentToPrev.x - end.x, k.tangentToPrev.y - end.y);
  const nextLen = Math.hypot(k.tangentToNext.x - end.x, k.tangentToNext.y - end.y);
  // Preserve the vertical direction (sign) of each handle relative to the endpoint.
  // Legacy uses strict > 0 for prevSign, >= 0 for nextSign (matches BrdEditCommand).
  const prevSign = k.tangentToPrev.y - end.y > 0 ? 1 : -1;
  const nextSign = k.tangentToNext.y - end.y >= 0 ? 1 : -1;

  // Legacy applies two independent if-blocks for which==0 (both run).
  // Block 1 aligns prev (and mirrors next via prevSign if continuous).
  // Block 2 aligns next (and mirrors prev via nextSign if continuous), overwriting block 1.
  // With continuous=true the second block always wins, so nextSign drives the mirror.
  let prev: Vec2;
  let next: Vec2;

  if (k.continuous) {
    // Second block wins: next keeps its sign, prev is mirrored from nextSign.
    next = vec2(end.x, end.y + nextLen * nextSign);
    prev = vec2(end.x, end.y - prevLen * nextSign);
  } else {
    prev = vec2(end.x, end.y + prevLen * prevSign);
    next = vec2(end.x, end.y + nextLen * nextSign);
  }

  return replaceKnot(s, index, knot(end, prev, next, k.continuous, k.other));
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
