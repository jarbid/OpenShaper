// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Hollow-Wood-Surfboard (HWS) internal-frame template builder.
 *
 * Produces a {@link TemplateSheet} of flat parts that assemble into a 3D frame:
 *   - one **stringer** (longitudinal spine) with rib slots cut into its top edge;
 *   - N **ribs** (transverse frames) with a stringer slot cut into the bottom edge;
 *   - optional **deck/bottom skin** planshape outlines with registration marks.
 *
 * The stringer's top slots and the ribs' bottom slots are complementary half-laps:
 * their depths sum to the local internal frame height, so the parts interlock
 * (egg-crate). The frame is inset from the board surface by the skin thickness so
 * the bent skins finish flush. Pure geometry in centimetres; no I/O.
 */
import {
  getInterpolatedCrossSection,
  getLength,
  pointByTT,
  valueAt,
  type BezierBoard,
} from '@openshaper/kernel';
import { dedupe, loop, offsetClosed, offsetOpen, sampleCurve, signedArea } from './geom';
import {
  DEFAULT_HWS_PARAMS,
  type HwsParams,
  type Label,
  type Loop,
  type Part,
  type Pt,
  type TemplateSheet,
} from './types';

/** Choose rib longitudinal positions per the rib mode, respecting the end margins. */
const ribStations = (board: BezierBoard, p: HwsParams): number[] => {
  const L = getLength(board);
  const lo = p.endMargin;
  const hi = L - p.endMargin;
  if (hi <= lo) return [L / 2];

  const evenStations = (n: number): number[] => {
    if (n <= 1) return [(lo + hi) / 2];
    return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  };

  if (p.ribMode === 'crossSections') {
    const xs = board.crossSections
      .slice(1, -1) // drop the nose/tail dummy sections
      .map((cs) => cs.position)
      .filter((x) => x >= lo && x <= hi);
    return xs.length > 0 ? xs : evenStations(p.ribCount);
  }
  if (p.ribMode === 'spacing') {
    const out: number[] = [];
    const c = L / 2;
    const step = Math.max(1, p.ribSpacing);
    for (let x = c; x >= lo; x -= step) out.unshift(x);
    for (let x = c + step; x <= hi; x += step) out.push(x);
    return out;
  }
  return evenStations(p.ribCount);
};

/** Internal frame height at x: board thickness there minus both skins. */
const internalHeight = (board: BezierBoard, x: number, skin: number): number =>
  valueAt(board.deck, x) - valueAt(board.bottom, x) - 2 * skin;

// --- stringer ---

const buildStringer = (board: BezierBoard, p: HwsParams, stations: readonly number[]): Part => {
  const L = getLength(board);
  const tip = Math.max(p.endMargin, 1);
  const x0 = tip;
  const x1 = L - tip;
  const skin = p.skinThickness;
  const tol = p.sampleTolerance;
  const slotW = p.materialThickness + p.slotFit;
  const halfW = slotW / 2;

  const topY = (x: number): number => valueAt(board.deck, x) - skin;
  const botY = (x: number): number => valueAt(board.bottom, x) + skin;

  // Only slot stations that sit clear of the trimmed ends.
  const inner = stations.filter((x) => x > x0 + slotW && x < x1 - slotW);

  // Top edge nose→tail, dipping into a half-lap notch at each rib station.
  const top: Pt[] = [];
  let cursor = x0;
  const labels: Label[] = [];
  for (const xi of inner) {
    top.push(...sampleCurve((t) => ({ x: t, y: topY(t) }), cursor, xi - halfW, tol));
    const slotBottom = topY(xi) - p.halfLapFraction * internalHeight(board, xi, skin);
    top.push({ x: xi - halfW, y: slotBottom });
    top.push({ x: xi + halfW, y: slotBottom });
    top.push({ x: xi + halfW, y: topY(xi + halfW) });
    cursor = xi + halfW;
    labels.push({ text: xi.toFixed(0), at: { x: xi, y: topY(xi) + 1 }, height: 1 });
  }
  top.push(...sampleCurve((t) => ({ x: t, y: topY(t) }), cursor, x1, tol));

  // Bottom edge tail→nose (no notches).
  const bottom = sampleCurve((t) => ({ x: t, y: botY(t) }), x1, x0, tol);

  const outline = dedupe([...top, ...bottom]);
  const loops: Loop[] = [loop('cut', true, outline)];
  // Rocker baseline (mark) for reference.
  loops.push(
    loop('mark', false, [
      { x: x0, y: botY(x0) },
      { x: x1, y: botY(x1) },
    ]),
  );

  return { id: 'stringer', label: 'Stringer', loops, labels };
};

// --- ribs ---

const buildRib = (board: BezierBoard, p: HwsParams, x: number, index: number): Part | null => {
  const cs = getInterpolatedCrossSection(board, x);
  if (!cs) return null;
  const tol = p.sampleTolerance;
  const skin = p.skinThickness;
  const inset = skin + p.railInset;
  const slotW = p.materialThickness + p.slotFit;
  const halfW = slotW / 2;

  // Half profile: tt 0..1 runs bottom-centre → rail → deck-centre (x ≥ 0).
  const rawHalf = sampleCurve((tt) => pointByTT(cs.spline, tt), 0, 1, tol);

  // Inset inward (left-hand normal points to the board interior); pin the two
  // centre endpoints back to x = 0 since the true inset there is purely vertical.
  const half = offsetOpen(rawHalf, inset);
  if (half.length < 2) return null;
  half[0] = { x: 0, y: half[0]!.y };
  half[half.length - 1] = { x: 0, y: half[half.length - 1]!.y };

  const ybc = half[0]!.y; // bottom-centre (inset)
  const ydc = half[half.length - 1]!.y; // deck-centre (inset)
  const H = ydc - ybc;
  const ribDepth = (1 - p.halfLapFraction) * H;

  // Right rail from the slot mouth (x ≈ halfW) up to the deck centre.
  let mouth = 1;
  while (mouth < half.length && half[mouth]!.x < halfW) mouth++;
  const rightRail = half.slice(mouth);
  if (rightRail.length === 0) return null;
  const leftRail = rightRail.map((v) => ({ x: -v.x, y: v.y })).reverse();

  // Closed contour with a downward-opening stringer slot at the bottom centre.
  const contour: Pt[] = [
    { x: halfW, y: ybc }, // right mouth
    ...rightRail, // up right rail → deck centre
    ...leftRail.slice(1), // down left rail → left mouth area
    { x: -halfW, y: ybc }, // left mouth
    { x: -halfW, y: ybc + ribDepth }, // up into slot
    { x: halfW, y: ybc + ribDepth }, // across slot top
  ];
  const loops: Loop[] = [loop('cut', true, dedupe(contour))];

  // Optional lightening hole above the slot.
  if (p.lighteningHoles && H > 2 * p.webMargin) {
    const ring = dedupe([
      ...half,
      ...half
        .map((v) => ({ x: -v.x, y: v.y }))
        .reverse()
        .slice(1),
    ]);
    const cutY = ybc + ribDepth + p.webMargin;
    const holeRaw = offsetClosed(ring, -p.webMargin).map((v) =>
      v.y < cutY ? { x: v.x, y: cutY } : v,
    );
    const hole = dedupe(holeRaw);
    if (hole.length >= 3 && Math.abs(signedArea(hole)) > 1) {
      loops.push(loop('cutInner', true, hole));
    }
  }

  return {
    id: `rib-${index}`,
    label: `Rib ${index + 1} @ ${x.toFixed(0)}cm`,
    loops,
    labels: [{ text: `${index + 1}`, at: { x: 0, y: ydc + 1 }, height: 1 }],
  };
};

// --- skins ---

const buildSkin = (
  board: BezierBoard,
  p: HwsParams,
  stations: readonly number[],
  which: 'deck' | 'bottom',
): Part => {
  const L = getLength(board);
  const tol = p.sampleTolerance;
  const half = (x: number): number => valueAt(board.outline, x);
  const x0 = 0.5;
  const x1 = L - 0.5;

  const topRail = sampleCurve((t) => ({ x: t, y: half(t) }), x0, x1, tol);
  const botRail = sampleCurve((t) => ({ x: t, y: -half(t) }), x1, x0, tol);
  let outline = dedupe([...topRail, ...botRail]);
  if (p.skinOverhang > 0) outline = offsetClosed(outline, p.skinOverhang);

  const loops: Loop[] = [loop('cut', true, outline)];
  loops.push(
    loop('mark', false, [
      { x: x0, y: 0 },
      { x: x1, y: 0 },
    ]),
  ); // stringer centreline
  const labels: Label[] = [];
  for (const xi of stations) {
    const h = half(xi);
    loops.push(
      loop(
        'mark',
        false,
        [
          { x: xi, y: -h },
          { x: xi, y: h },
        ],
        true,
      ),
    );
    labels.push({ text: xi.toFixed(0), at: { x: xi, y: h + 1 }, height: 1 });
  }
  return {
    id: `skin-${which}`,
    label: `${which === 'deck' ? 'Deck' : 'Bottom'} skin`,
    loops,
    labels,
  };
};

// --- kerf compensation ---

const kerfComp = (part: Part, kerf: number): Part => {
  const d = kerf / 2;
  return {
    ...part,
    loops: part.loops.map((l) => {
      if (!l.closed) return l;
      if (l.kind === 'cut') return { ...l, pts: offsetClosed(l.pts, d) };
      if (l.kind === 'cutInner') return { ...l, pts: offsetClosed(l.pts, -d) };
      return l;
    }),
  };
};

/**
 * Build the HWS internal-frame templates for `board`. Missing params fall back to
 * {@link DEFAULT_HWS_PARAMS}. Coordinates are centimetres; feed the result to
 * `sheetToDxf` / `sheetToSvg` / `sheetToPdf`.
 */
export const buildHwsTemplates = (
  board: BezierBoard,
  paramsIn: Partial<HwsParams> = {},
): TemplateSheet => {
  const p: HwsParams = { ...DEFAULT_HWS_PARAMS, ...paramsIn };
  const stations = ribStations(board, p);

  const parts: Part[] = [];
  if (p.includeStringer) parts.push(buildStringer(board, p, stations));
  if (p.includeRibs) {
    stations.forEach((x, i) => {
      const rib = buildRib(board, p, x, i);
      if (rib) parts.push(rib);
    });
  }
  if (p.includeDeckSkin) parts.push(buildSkin(board, p, stations, 'deck'));
  if (p.includeBottomSkin) parts.push(buildSkin(board, p, stations, 'bottom'));

  const finalized = p.kerf > 0 ? parts.map((part) => kerfComp(part, p.kerf)) : parts;
  return {
    parts: finalized,
    units: 'cm',
    meta: { title: 'Hollow Wood Frame', generator: 'OpenShaper' },
  };
};
