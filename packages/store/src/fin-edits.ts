// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure edits on a fin design, for the fin store (docs/design/fin-designer.md, step 9).
 * Spline operations are the board's (edits.ts); this module knows which curve of a fin
 * is which, what each curve's ends are pinned to, and the fin-wide edits (cant,
 * thickness, depth, foil presets, hand).
 */
import {
  FIN_MAX_CANT,
  FIN_MAX_TOE,
  FIN_PANEL_MAX_ANGLE,
  FIN_PANEL_THICKNESS,
  FIN_MIN_SLICE_CANT,
  twistAt,
  FIN_MIN_THICKNESS,
  FIN_MIN_THICKNESS_LIMITS,
  finMinThickness,
  FIN_SLICE_MIN_GAP,
  FIN_THICKNESS_PATH_LIMITS,
  placeOnBase,
  smoothFoilAt,
  smoothRowSize,
  smoothSectionRow,
  moveFoilThickest,
  sectionThickest,
  tipFoilOf,
  tipApexFraction,
  tipLineOf,
  defaultCanard,
  finHasToe,
  splitFoil,
  defaultKeel,
  defaultSingleFin,
  defaultTwinFin,
  defaultFinDesign,
  futuresKind,
  flatFace,
  knot,
  nacaSection,
  parseNaca4,
  splineFromKnots,
  sub,
  validateFinDesign,
  value,
  vec2,
  withHandles,
  type FinDesign,
  type FinHand,
  type FinIssueCode,
  type FinPosition,
  type FinSection,
  type FinCantLine,
  type FinTwist,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { moveKnotEnd, setKnotContinuous, withoutEmptySpans } from './edits';

/** The editable curves of a fin. */
export type FinCurve = 'outline' | 'outside' | 'inside' | 'taper';

/**
 * Which foil the section curves (`outside`, `inside`) mean: 0 the root foil (foil sweep
 * start), {@link TIP_FOIL} the tip foil (foil sweep end), k the k-th horizontal slice
 * ({@link FinDesign.slices}, 1-based here so the root needs no special case).
 */
export type FinFoilIndex = number;

/** The tip foil's index: where the foil sweep ends (FinDesign.tipSection). */
export const TIP_FOIL = -1;

/** The foil `foil` names, or null if there is no such slice. */
export const getFoil = (d: FinDesign, foil: FinFoilIndex = 0): FinSection | null =>
  foil === 0 ? d.section : foil === TIP_FOIL ? tipFoilOf(d) : (d.slices[foil - 1]?.section ?? null);

/**
 * The design without empty spans in any curve ({@link withoutEmptySpans}): points
 * stacked on one another, as a slip of the add-point button left them. The shapes are
 * unchanged. The same design if it has none.
 */
export const withoutStackedPoints = (d: FinDesign): FinDesign => {
  const sec = (s: FinSection): FinSection => {
    const outside = withoutEmptySpans(s.outside);
    const inside = s.inside && withoutEmptySpans(s.inside);
    return outside === s.outside && inside === s.inside ? s : { outside, inside };
  };
  const outline = withoutEmptySpans(d.outline);
  const taper = withoutEmptySpans(d.taper);
  const section = sec(d.section);
  const tipSection = d.tipSection && sec(d.tipSection);
  const slices = d.slices.map((sl) => {
    const s = sec(sl.section);
    return s === sl.section ? sl : { ...sl, section: s };
  });
  const same =
    outline === d.outline &&
    taper === d.taper &&
    section === d.section &&
    tipSection === d.tipSection &&
    slices.every((sl, i) => sl === d.slices[i]);
  return same
    ? d
    : { ...d, outline, taper, section, slices, ...(tipSection ? { tipSection } : {}) };
};

/**
 * The real chord and thickness a foil is drawn for: the length of its row of the smooth
 * blade (the tip foil's is the tip line, turned level in the foil view) and how thick that
 * row is at its thickest.
 */
export const foilSize = (
  d: FinDesign,
  foil: FinFoilIndex,
): { chord: number; thickness: number } => {
  const tipRow = smoothSectionRow(d, 1);
  const sl = foil >= 1 ? d.slices[foil - 1] : undefined;
  return smoothRowSize(d, foil === TIP_FOIL ? tipRow : sl ? sl.height * tipRow : 0);
};

/**
 * How much taller than its stored shape the foil really is, to draw it true to scale
 * (owner request): its thickness over its chord (foilSize), against the shape's own
 * thickness in chords. Only a foil's shape counts, so it may be stored at any thickness;
 * {@link withFoilsNearTrueScale} keeps it within four times either way.
 */
export const foilTrueScale = (d: FinDesign, foil: FinFoilIndex): number => {
  const sec = getFoil(d, foil);
  const { chord, thickness } = foilSize(d, foil);
  const shape = sec ? sectionThickest(sec).thickness : 0;
  if (!(chord > 0) || !(shape > 0) || !(thickness > 0)) return 1;
  return thickness / chord / shape;
};

/** Beyond this either way, a foil is stored at its true thickness instead. */
const FOIL_SCALE_LIMIT = 4;

/** `sec` taller by `k`: the same shape, as the blade reads it. */
const scaledFoil = (sec: FinSection, k: number): FinSection => {
  const tall = (s: Spline) =>
    splineFromKnots(
      s.knots.map((kn) => {
        const f = (p: Vec2) => vec2(p.x, p.y * k);
        return knot(f(kn.end), f(kn.tangentToPrev), f(kn.tangentToNext), kn.continuous, kn.other);
      }),
    );
  return { outside: tall(sec.outside), inside: sec.inside && tall(sec.inside) };
};

/**
 * The design with every foil stored far from its true thickness (more than four times
 * either way) stored at it instead. The blade is unchanged: only a foil's shape counts.
 * The same design if none is. Owner testing: with the foil view's true-scale stretch
 * read afresh at every step of a drag, drags ran a tip foil down to a millionth of its
 * thickness, the view zoomed far out, and points moved that weren't dragged.
 */
export const withFoilsNearTrueScale = (d: FinDesign): FinDesign => {
  const foils = [0, ...(d.tipSection ? [TIP_FOIL] : []), ...d.slices.map((_, i) => i + 1)];
  let out = d;
  for (const f of foils) {
    const k = foilTrueScale(d, f);
    if (k <= FOIL_SCALE_LIMIT && k >= 1 / FOIL_SCALE_LIMIT) continue;
    out = withFoil(out, f, scaledFoil(getFoil(d, f)!, k));
  }
  return out;
};

/** The design with foil `foil` replaced. */
export const withFoil = (d: FinDesign, foil: FinFoilIndex, sec: FinSection): FinDesign =>
  foil === 0
    ? { ...d, section: sec }
    : foil === TIP_FOIL
      ? { ...d, tipSection: sec }
      : { ...d, slices: d.slices.map((sl, i) => (i === foil - 1 ? { ...sl, section: sec } : sl)) };

export const getFinCurve = (d: FinDesign, c: FinCurve, foil: FinFoilIndex = 0): Spline | null => {
  switch (c) {
    case 'outline':
      return d.outline;
    case 'outside':
      return getFoil(d, foil)?.outside ?? null;
    case 'inside':
      return getFoil(d, foil)?.inside ?? null;
    case 'taper':
      return d.taper;
  }
};

/**
 * `face` with its leading- and trailing-edge points where `to`'s are, their handles
 * carried with them: the two faces of a foil meet at its edges. `face` itself if they
 * already do.
 */
const withEdgesOf = (face: Spline, to: Spline): Spline => {
  let s = face;
  for (const [i, j] of [
    [0, 0],
    [face.knots.length - 1, to.knots.length - 1],
  ] as const) {
    const e = to.knots[j]!.end;
    if (s.knots[i]!.end.y !== e.y) s = moveKnotEnd(s, i, vec2(s.knots[i]!.end.x, e.y));
  }
  return s;
};

/** `face` with its edges back on the chord line: for a foil made symmetric or flat inside. */
const edgesOnChord = (face: Spline): Spline =>
  withEdgesOf(
    face,
    splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), false),
      knot(vec2(1, 0), vec2(1, 0), vec2(1, 0), false),
    ]),
  );

/**
 * Whether the edges of foil `foil` may leave the chord line (constrainKnot): a foil with
 * its own inside face, whose faces then move their edges together. A symmetric foil's
 * stay on the line (owner's choice): its inside face mirrors the outside.
 */
export const edgesFree = (d: FinDesign, foil: FinFoilIndex = 0): boolean =>
  !!getFoil(d, foil)?.inside;

export const withFinCurve = (
  d: FinDesign,
  c: FinCurve,
  s: Spline,
  foil: FinFoilIndex = 0,
): FinDesign => {
  const sec = getFoil(d, foil);
  switch (c) {
    case 'outline':
      return { ...d, outline: s };
    // A face's edges move the other face's with them: the foil stays closed there.
    case 'outside':
      return sec
        ? withFoil(d, foil, { outside: s, inside: sec.inside && withEdgesOf(sec.inside, s) })
        : d;
    case 'inside':
      return sec ? withFoil(d, foil, { outside: withEdgesOf(sec.outside, s), inside: s }) : d;
    case 'taper':
      return { ...d, taper: s };
  }
};

/**
 * `d` with an imported profile, placed on its tab as a fin starts there. Any moved tip line
 * was on the old outline, so it goes back to the default.
 */
export const importedOutline = (d: FinDesign, outline: Spline): FinDesign => {
  const { tipLine: _old, ...rest } = d;
  void _old;
  // placeOnBase leaves a fin already on the tab alone: come at it from another.
  const other = d.base === 'futures-side' ? 'futures-centre' : 'futures-side';
  return placeOnBase({ ...rest, outline, base: other }, d.base);
};

/**
 * `d` with its profile scaled by `k` about `about` (the tab frame, cm), evenly in both
 * directions: every point and handle moves `k` times its distance from `about`. With
 * `about` on the tab top (y = 0) the base stays on it. Only the profile changes: the
 * thickness, the foils (by chord) and every height kept as a fraction scale with it or
 * don't need to.
 */
export const scaledOutline = (d: FinDesign, k: number, about: Vec2): FinDesign => {
  if (k === 1) return d;
  const f = (p: Vec2) => vec2(about.x + (p.x - about.x) * k, about.y + (p.y - about.y) * k);
  const outline = splineFromKnots(
    d.outline.knots.map((kn) =>
      knot(f(kn.end), f(kn.tangentToPrev), f(kn.tangentToNext), kn.continuous, kn.other),
    ),
  );
  return { ...d, outline };
};

/**
 * A new control section at `height` (the fraction of the way to the tip line), starting
 * as the foil on its row (kernel smoothFoilAt), so the blade doesn't change until it is edited
 * (owner's rules). Its height is clamped into the room between its neighbours
 * ({@link FIN_SLICE_MIN_GAP}); null if there is none. Returns the design and the new
 * slice's foil index.
 */
export const addSlice = (
  d: FinDesign,
  height: number,
): { design: FinDesign; foil: FinFoilIndex } | null => {
  const at = d.slices.findIndex((sl) => sl.height > height); // insert before this
  const pos = at === -1 ? d.slices.length : at;
  const lo = (pos === 0 ? 0 : d.slices[pos - 1]!.height) + FIN_SLICE_MIN_GAP;
  const hi = (pos === d.slices.length ? 1 : d.slices[pos]!.height) - FIN_SLICE_MIN_GAP;
  if (hi < lo) return null;
  const h = Math.min(hi, Math.max(lo, height));
  const section = smoothFoilAt(d, h);
  const slices = [...d.slices.slice(0, pos), { height: h, section }, ...d.slices.slice(pos)];
  return { design: { ...d, slices }, foil: pos + 1 };
};

const withCantLines = (d: FinDesign, lines: readonly FinCantLine[]): FinDesign => {
  const { cantLines: _old, ...rest } = d;
  void _old;
  return lines.length ? { ...rest, cantLines: lines } : rest;
};

/**
 * A new cant line at `height` (fraction of the depth), starting at the cant and toe the
 * blade has there. Clamped into the room between its neighbours; null if there is none.
 * Returns the design and the line's number (1-based).
 */
export const addCantLine = (
  d: FinDesign,
  height: number,
): { design: FinDesign; line: number } | null => {
  const lines = d.cantLines ?? [];
  const at = lines.findIndex((l) => l.height > height);
  const pos = at === -1 ? lines.length : at;
  const lo = (pos === 0 ? 0 : lines[pos - 1]!.height) + FIN_SLICE_MIN_GAP;
  const hi = (pos === lines.length ? 1 : lines[pos]!.height) - FIN_SLICE_MIN_GAP;
  if (hi < lo) return null;
  const h = Math.min(hi, Math.max(lo, height));
  const added = { height: h, ...twistAt(d, h) };
  return {
    design: withCantLines(d, [...lines.slice(0, pos), added, ...lines.slice(pos)]),
    line: pos + 1,
  };
};

/** Cant line `line` (1-based) with new cant or toe, clamped to their ranges. */
export const setCantLine = (d: FinDesign, line: number, change: Partial<FinTwist>): FinDesign => {
  const lines = d.cantLines ?? [];
  if (!lines[line - 1]) return d;
  return withCantLines(
    d,
    lines.map((l, i) => {
      if (i !== line - 1) return l;
      const next = { ...l, ...change };
      return {
        height: l.height,
        cant: Math.min(FIN_MAX_CANT, Math.max(FIN_MIN_SLICE_CANT, next.cant)),
        toe: Math.round(Math.min(FIN_MAX_TOE, Math.max(-FIN_MAX_TOE, next.toe)) * 1e6) / 1e6,
      };
    }),
  );
};

/** The design without cant line `line` (1-based). */
export const removeCantLine = (d: FinDesign, line: number): FinDesign =>
  d.cantLines?.[line - 1]
    ? withCantLines(
        d,
        d.cantLines.filter((_, i) => i !== line - 1),
      )
    : d;

/**
 * Cant line `line` moved to `height`, its cant and toe with it; it stops short of the line
 * either side, the base and the top. Returns the design unchanged if it can't move.
 */
export const moveCantLine = (d: FinDesign, line: number, height: number): FinDesign => {
  const lines = d.cantLines ?? [];
  if (!lines[line - 1]) return d;
  const lo = (line > 1 ? lines[line - 2]!.height : 0) + FIN_SLICE_MIN_GAP;
  const hi = (line < lines.length ? lines[line]!.height : 1) - FIN_SLICE_MIN_GAP;
  const h = Math.min(hi, Math.max(lo, height));
  return withCantLines(
    d,
    lines.map((l, i) => (i === line - 1 ? { ...l, height: h } : l)),
  );
};

/** The design without slice `foil` (1-based); unchanged for the root or no such slice. */
export const removeSlice = (d: FinDesign, foil: FinFoilIndex): FinDesign =>
  foil < 1 || foil > d.slices.length
    ? d
    : { ...d, slices: d.slices.filter((_, i) => i !== foil - 1) };

/**
 * Slice `foil` moved to `height`. It may pass the other slices (owner feedback: a new
 * slice couldn't be dragged past an old one), but keeps {@link FIN_SLICE_MIN_GAP} from
 * them and from the root and tip: dragged up to a neighbour it waits just short of it,
 * and hops to the far side once the drag is past the neighbour. Slices are kept in
 * order up the blade, so its index may change: returns the design and its new index.
 *
 * A section is a foil drawn for its row, and takes it along unchanged.
 */
export const moveSlice = (
  d: FinDesign,
  foil: FinFoilIndex,
  height: number,
): { design: FinDesign; foil: FinFoilIndex } => {
  const i = foil - 1;
  const sl = d.slices[i];
  if (!sl) return { design: d, foil };
  const others = d.slices.filter((_, j) => j !== i);
  const gap = FIN_SLICE_MIN_GAP;
  const eps = 1e-12;
  const fits = (h: number) =>
    h >= gap - eps &&
    h <= 1 - gap + eps &&
    others.every((o) => Math.abs(h - o.height) >= gap - eps);
  // The nearest place that fits: the height itself, or just clear of a slice, root or tip.
  const candidates = [
    height,
    gap,
    1 - gap,
    ...others.flatMap((o) => [o.height - gap, o.height + gap]),
  ];
  let h = sl.height;
  let best = Infinity;
  for (const c of candidates) {
    if (fits(c) && Math.abs(c - height) < best) {
      best = Math.abs(c - height);
      h = c;
    }
  }
  if (h === sl.height) return { design: d, foil };
  const moved = { ...sl, height: h };
  const at = others.findIndex((o) => o.height > h);
  const pos = at === -1 ? others.length : at;
  const slices = [...others.slice(0, pos), moved, ...others.slice(pos)];
  return { design: { ...d, slices }, foil: pos + 1 };
};

/**
 * Where a knot of `curve` may go when dragged toward `p`:
 * - the outline's two ends slide along the base (y = 0);
 * - a section face's ends are the leading and trailing edges: they move only across the
 *   chord, and only with `edges` free ({@link edgesFree}), else fixed at (0, 0), (1, 0);
 * - the taper's ends keep their heights (0 at the root, 1 at the tip).
 */
export const constrainKnot = (
  s: Spline,
  c: FinCurve,
  index: number,
  p: Vec2,
  edges = false,
): Vec2 => {
  const end = index === 0 || index === s.knots.length - 1;
  if (!end) return p;
  const at = s.knots[index]!.end;
  if (c === 'outline') return vec2(p.x, 0);
  if (c === 'taper' || edges) return vec2(at.x, p.y);
  return at; // a symmetric foil's edges: on the chord line
};

/** Rule codes `next` breaks that `prev` did not (`prev` may be its issue codes). */
export const newIssues = (
  prev: FinDesign | ReadonlySet<FinIssueCode>,
  next: FinDesign,
): FinIssueCode[] => {
  const had = prev instanceof Set ? prev : issueCodes(prev as FinDesign);
  return validateFinDesign(next)
    .map((i) => i.code)
    .filter((c) => !had.has(c));
};

const issueCodes = (d: FinDesign): ReadonlySet<FinIssueCode> =>
  new Set(validateFinDesign(d).map((i) => i.code));

/**
 * The furthest edit along a move that breaks no new rule. `at(t)` builds the design
 * moved a fraction t of the way (t = 1 is the whole move). Returns the full move if it
 * is fine; otherwise bisects for the last fine fraction, so a dragged point stops at the
 * boundary rather than refusing to move. Null if no part of the move is allowed.
 */
export const clampEdit = (
  current: FinDesign,
  at: (t: number) => FinDesign,
  steps = 12,
): FinDesign | null => {
  const had = issueCodes(current); // once, not per probe
  const ok = (d: FinDesign) => newIssues(had, d).length === 0;
  const full = at(1);
  if (ok(full)) return full;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (ok(at(mid))) lo = mid;
    else hi = mid;
  }
  return lo > 0 ? at(lo) : null;
};

/** Cant clamped to what the position allows: 0 for a centre fin, else 0 to the max. */
export const setCant = (d: FinDesign, deg: number): FinDesign => {
  // A centre fin has none; on an FCS single tab the plug carries it.
  const fixed = d.position === 'centre' || !futuresKind(d.base);
  const cant = fixed ? 0 : Math.min(FIN_MAX_CANT, Math.max(0, deg));
  return cant === d.cant ? d : { ...d, cant };
};

/** Toe correction (deg, + toe in), clamped to ±FIN_MAX_TOE. */
export const setToe = (d: FinDesign, deg: number): FinDesign => {
  // A centre or US box fin has none.
  const toe = finHasToe(d) ? Math.min(FIN_MAX_TOE, Math.max(-FIN_MAX_TOE, deg)) : 0;
  // Snap away float noise from repeated quarter-degree steps.
  const snapped = Math.round(toe * 1e6) / 1e6;
  return snapped === d.toe ? d : { ...d, toe: snapped };
};

/**
 * Scale the taper so the root is `cm` thick, keeping its shape: every point's
 * thickness scales by the same factor, then nothing goes under the minimum.
 */
export const setRootThickness = (d: FinDesign, cm: number): FinDesign => {
  const root = d.taper.knots[0]!.end.y;
  if (!(cm > 0) || root <= 0 || cm === root) return d;
  const f = cm / root;
  const min = finMinThickness(d);
  const m = (p: Vec2) => vec2(p.x, Math.max(min, p.y * f));
  return {
    ...d,
    taper: splineFromKnots(
      d.taper.knots.map((k) =>
        knot(m(k.end), m(k.tangentToPrev), m(k.tangentToNext), k.continuous, k.other, k.lock),
      ),
    ),
  };
};

/**
 * Stretch the outline vertically so its highest point is `cm` above the tab, keeping
 * the base (and so the root chord) where it is. Sweep changes with it, as it would if
 * the shaper drew a taller fin over the same base.
 */
export const setDepth = (d: FinDesign, cm: number, currentDepth: number): FinDesign => {
  if (!(cm > 0) || !(currentDepth > 0) || cm === currentDepth) return d;
  const f = cm / currentDepth;
  const m = (p: Vec2) => vec2(p.x, p.y * f);
  return {
    ...d,
    outline: splineFromKnots(
      d.outline.knots.map((k) =>
        knot(m(k.end), m(k.tangentToPrev), m(k.tangentToNext), k.continuous, k.other, k.lock),
      ),
    ),
  };
};

/**
 * Replace the section with a NACA 4-digit preset. A centre fin takes only symmetric
 * (00XX) foils: null for anything else, or for a code that isn't one.
 */
export const applyNaca = (d: FinDesign, code: string, foil: FinFoilIndex = 0): FinDesign | null => {
  let n;
  try {
    n = parseNaca4(code);
  } catch {
    return null;
  }
  if (d.position === 'centre' && n.camber > 0) return null;
  return getFoil(d, foil) ? withFoil(d, foil, nacaSection(n)) : null;
};

/** Make a foil's inside face flat (side fins) or mirror the outside (any fin). */
export const setInsideFace = (
  d: FinDesign,
  kind: 'flat' | 'symmetric',
  foil: FinFoilIndex = 0,
): FinDesign | null => {
  if (kind === 'flat' && d.position === 'centre') return null;
  const sec = getFoil(d, foil);
  // Edges off the chord line come back to it: flat or mirrored, the faces meet there.
  return sec
    ? withFoil(d, foil, {
        outside: edgesOnChord(sec.outside),
        inside: kind === 'flat' ? flatFace() : null,
      })
    : null;
};

/**
 * Split a foil between its faces, `outside` (a share, 0 to 1) above the chord line and
 * the rest below, as a leading-edge radius on each face and straight lines to the
 * trailing edge (split-foil.ts). The radii are true to the fin where this foil is: its
 * thickness over its chord at the root, or at its slice's height. Not for centre fins,
 * which stay symmetric.
 */
export const setFoilSplit = (
  d: FinDesign,
  outside: number,
  foil: FinFoilIndex = 0,
): FinDesign | null => {
  if (d.position === 'centre' || !getFoil(d, foil)) return null;
  const { chord, thickness } = foilSize(d, foil);
  if (!(chord > 0)) return null;
  return withFoil(d, foil, splitFoil(outside, thickness / chord));
};

/** Which side a side or quad-rear fin is for; the design is otherwise unchanged. */
export const setHand = (d: FinDesign, hand: FinHand): FinDesign =>
  d.position === 'centre' || d.hand === hand ? d : { ...d, hand };

/** What a new fin can start as: a position's default fin, or one of the owner's. */
export type FinStart = FinPosition | 'canard' | 'single' | 'twin' | 'keel';

/** A fresh starting fin (the designer's New fin menu). */
export const newFin = (start: FinStart, hand: FinHand = 'left'): FinDesign =>
  start === 'canard'
    ? defaultCanard(hand)
    : start === 'single'
      ? defaultSingleFin()
      : start === 'twin'
        ? defaultTwinFin(hand)
        : start === 'keel'
          ? defaultKeel(hand)
          : defaultFinDesign(start, hand);

/**
 * Where the toolbar's add-point button puts a new point: halfway along the span after
 * knot `index` (the span before it, for the last knot). Null for an index off the curve.
 */
export const spanMidpoint = (s: Spline, index: number): Vec2 | null => {
  const spans = s.knots.length - 1;
  if (spans < 1 || index < 0 || index > spans) return null;
  return value(s.coeffs[Math.min(index, spans - 1)]!, 0.5);
};

/**
 * Knot `index` made smooth with its handles lined up, each keeping its length: they
 * turn to the average of their two directions. Flagging a corner smooth without this
 * would leave its kink in place until the next drag.
 */
export const smoothKnot = (s: Spline, index: number): Spline => {
  const k = s.knots[index];
  if (!k) return s;
  // A locked handle's direction is fixed; setKnotContinuous mirrors the lock instead.
  if (k.lock) return setKnotContinuous(s, index, true);
  const prev = sub(k.tangentToPrev, k.end);
  const next = sub(k.tangentToNext, k.end);
  const lp = Math.hypot(prev.x, prev.y);
  const ln = Math.hypot(next.x, next.y);
  let dir: Vec2;
  if (lp > 0 && ln > 0) dir = vec2(next.x / ln - prev.x / lp, next.y / ln - prev.y / lp);
  else if (ln > 0) dir = next;
  else if (lp > 0) dir = vec2(-prev.x, -prev.y);
  else return setKnotContinuous(s, index, true);
  const ld = Math.hypot(dir.x, dir.y);
  // Handles pointing the same way: nothing sensible to average.
  if (ld < 1e-12) return setKnotContinuous(s, index, true);
  const u = vec2(dir.x / ld, dir.y / ld);
  const aligned = withHandles(
    k,
    vec2(k.end.x - u.x * lp, k.end.y - u.y * lp),
    vec2(k.end.x + u.x * ln, k.end.y + u.y * ln),
  );
  const knots = s.knots.slice();
  knots[index] = aligned;
  return setKnotContinuous(splineFromKnots(knots), index, true);
};

/**
 * The panel the fin is cut from: `thickness` (cm, clamped to FIN_PANEL_THICKNESS), keeping
 * the angle it's turned to; null clears it.
 */
/**
 * The thinnest the blade may get, `cm` (owner request: set in the thickness view),
 * within FIN_MIN_THICKNESS_LIMITS, to a hundredth of a millimetre. The taper follows: a
 * tip that sat on the old minimum moves to the new one, handles and all, and nothing is
 * left under it.
 */
export const setMinThickness = (d: FinDesign, cm: number): FinDesign => {
  if (!Number.isFinite(cm)) return d;
  const { min, max } = FIN_MIN_THICKNESS_LIMITS;
  const to = Math.round(Math.min(max, Math.max(min, cm)) * 1e3) / 1e3;
  const was = finMinThickness(d);
  if (to === was) return d;
  const last = d.taper.knots.length - 1;
  const onMin = Math.abs(d.taper.knots[last]!.end.y - was) < 1e-9;
  let taper = onMin ? moveKnotEnd(d.taper, last, vec2(1, to)) : d.taper;
  const up = (p: Vec2) => (p.y < to ? vec2(p.x, to) : p);
  if (taper.knots.some((k) => k.end.y < to || k.tangentToPrev.y < to || k.tangentToNext.y < to)) {
    taper = splineFromKnots(
      taper.knots.map((k) =>
        knot(up(k.end), up(k.tangentToPrev), up(k.tangentToNext), k.continuous, k.other, k.lock),
      ),
    );
  }
  const { minThickness: _old, ...rest } = d;
  void _old;
  return { ...rest, taper, ...(to === FIN_MIN_THICKNESS ? {} : { minThickness: to }) };
};

export const setPanelThickness = (d: FinDesign, thickness: number | null): FinDesign => {
  if (thickness === null) {
    if (!d.panel) return d;
    const { panel: _old, ...rest } = d;
    void _old;
    return rest;
  }
  const { min, max } = FIN_PANEL_THICKNESS;
  const t = Math.min(max, Math.max(min, thickness));
  return t === d.panel?.thickness
    ? d
    : { ...d, panel: { thickness: t, angle: d.panel?.angle ?? 0 } };
};

/** `deg` within ±FIN_PANEL_MAX_ANGLE, to a hundredth of a degree. */
const panelDeg = (deg: number): number =>
  Math.round(Math.min(FIN_PANEL_MAX_ANGLE, Math.max(-FIN_PANEL_MAX_ANGLE, deg)) * 100) / 100;

/** The fin turned `deg` in its panel, within ±FIN_PANEL_MAX_ANGLE; unchanged with no panel. */
export const setPanelAngle = (d: FinDesign, deg: number): FinDesign => {
  if (!d.panel || !Number.isFinite(deg)) return d;
  const a = panelDeg(deg);
  return a === d.panel.angle ? d : { ...d, panel: { ...d.panel, angle: a } };
};

/**
 * The panel tilted `deg` about its length, within ±FIN_PANEL_MAX_ANGLE; unchanged with
 * no panel. No tilt is stored as none.
 */
export const setPanelTilt = (d: FinDesign, deg: number): FinDesign => {
  if (!d.panel || !Number.isFinite(deg)) return d;
  const t = panelDeg(deg);
  if (t === (d.panel.tilt ?? 0)) return d;
  const { tilt: _old, ...panel } = d.panel;
  void _old;
  return { ...d, panel: t ? { ...panel, tilt: t } : panel };
};

/**
 * How far either end of the tip line keeps from the tip's furthest point, and from the
 * roots (fraction of the outline's length): the sweep needs room between them.
 */
const TIP_LINE_GAP = 0.01;
const TIP_LINE_FROM_ROOT = 0.15;

/**
 * The tip line with one end (`start`, on the leading edge's side, or `end`, on the
 * trailing edge's) moved to `fraction` of the outline's length. Each end stays on its
 * own side of the tip and clear of the roots.
 */
export const setTipLineEnd = (
  d: FinDesign,
  which: 'start' | 'end',
  fraction: number,
): FinDesign => {
  if (!Number.isFinite(fraction)) return d;
  const now = tipLineOf(d);
  const apex = tipApexFraction(d.outline);
  const f =
    which === 'start'
      ? Math.min(apex - TIP_LINE_GAP, Math.max(TIP_LINE_FROM_ROOT, fraction))
      : Math.min(1 - TIP_LINE_FROM_ROOT, Math.max(apex + TIP_LINE_GAP, fraction));
  if (Math.abs(f - now[which]) < 1e-9) return d;
  return { ...d, tipLine: { ...now, [which]: f } };
};

/** The tip line back to where the designer puts it (swept-loft.ts, defaultTipLine). */
export const resetTipLine = (d: FinDesign): FinDesign => {
  if (!d.tipLine) return d;
  const { tipLine: _old, ...rest } = d;
  void _old;
  return rest;
};

/**
 * Foil `foil` reshaped so it is thickest at `fraction` of its chord (kernel
 * moveFoilThickest). The base and tip foils' thickest points are the thickness path's
 * ends, so this moves the path too.
 */
export const setFoilThickest = (d: FinDesign, foil: FinFoilIndex, fraction: number): FinDesign => {
  const sec = getFoil(d, foil);
  if (!sec || !Number.isFinite(fraction)) return d;
  const { min, max } = FIN_THICKNESS_PATH_LIMITS;
  const to = Math.min(max, Math.max(min, fraction));
  if (Math.abs(sectionThickest(sec).at - to) < 5e-4) return d;
  return withFoil(d, foil, moveFoilThickest(sec, to));
};

/**
 * Point `index` of the thickness path moved to `fraction` of its section: its ends
 * (0 the base, 2 the tip line) are the base and tip foils' thickest points, so those
 * foils are reshaped; the middle (1) is set on its own, within FIN_THICKNESS_PATH_LIMITS.
 */
export const setThicknessPath = (d: FinDesign, index: 0 | 1 | 2, fraction: number): FinDesign => {
  if (!Number.isFinite(fraction)) return d;
  if (index !== 1) return setFoilThickest(d, index === 0 ? 0 : TIP_FOIL, fraction);
  const { min, max } = FIN_THICKNESS_PATH_LIMITS;
  const f = Math.round(Math.min(max, Math.max(min, fraction)) * 1e4) / 1e4;
  return d.thicknessMid === f ? d : { ...d, thicknessMid: f };
};

/** The thickness path's middle back to halfway between its ends. */
export const resetThicknessPath = (d: FinDesign): FinDesign => {
  if (d.thicknessMid === undefined) return d;
  const { thicknessMid: _old, ...rest } = d;
  void _old;
  return rest;
};
