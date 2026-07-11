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
  boxSpan,
  developHorizontalRailBand,
  developRailBand,
  getInterpolatedCrossSection,
  getLength,
  getMaxThickness,
  outlineInsetHalfWidthAt,
  pointByTT,
  resolveFins,
  valueAt,
  type BezierBoard,
} from '@openshaper/kernel';
import {
  differenceMulti,
  discFitsInRegion,
  JoinType,
  offsetClosedAll,
  offsetOpenBand,
  sampleCircle,
} from './clipper';
import { dedupe, loop, offsetClosed, sampleCurve, signedArea } from './geom';
import {
  DEFAULT_HWS_PARAMS,
  railOffset,
  type HwsParams,
  type Label,
  type Loop,
  type Part,
  type Pt,
  type TemplateSheet,
  type TemplateWarning,
} from './types';

/** Collects non-fatal build problems; threaded through the part builders. */
type Warn = (w: TemplateWarning) => void;

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

/** Mid-plane height (deck/bottom average) at x — the plane the block plates lie in. */
const midPlaneY = (board: BezierBoard, x: number): number =>
  (valueAt(board.deck, x) + valueAt(board.bottom, x)) / 2;

/**
 * cos of the mid-plane tilt over [xa, xb]. The nose/tail block plates lie in this
 * tilted plane, so their flat templates are developed by x / cosθ (the legacy
 * BoardCAD tail/nose-piece development).
 */
const midPlaneCos = (board: BezierBoard, xa: number, xb: number): number => {
  const span = Math.abs(xb - xa);
  if (span < 1e-6) return 1;
  return Math.cos(Math.atan2(Math.abs(midPlaneY(board, xb) - midPlaneY(board, xa)), span));
};

// --- stringer ---

const buildStringer = (
  board: BezierBoard,
  p: HwsParams,
  stations: readonly number[],
  warn: Warn,
): Part => {
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
  if (inner.length < stations.length) {
    const n = stations.length - inner.length;
    warn({
      code: 'stringer-slots-trimmed',
      partId: 'stringer',
      message: `${n} rib station(s) sit on the stringer's trimmed ends — no half-lap notch cut there (those ribs will not interlock with the stringer)`,
    });
  }

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

  // Nose/tail block cross-lap: open a mid-height notch at each trimmed end so the
  // block plate (see buildBlock) slides in from the tip and half-laps the spine.
  // The overhanging parallelogram follows the tilted mid-plane; Clipper leaves
  // the notch open at the end face (same pattern as the lightening columns).
  let cut = outline;
  const blockNotch = (which: 'nose' | 'tail'): Pt[] | null => {
    const len = which === 'nose' ? p.noseBlockLength : p.tailBlockLength;
    const lap = len - tip; // overlap between the block plate and the stringer
    if (lap <= 0.3) return null; // buildBlock warns about the missing lap
    const xe = which === 'nose' ? x0 : x1; // stringer end face
    const xi = which === 'nose' ? x0 + lap : x1 - lap; // notch inner end
    const xo = which === 'nose' ? x0 - 1 : x1 + 1; // overhang keeps the notch open
    const mid = (x: number): number => (topY(x) + botY(x)) / 2;
    const cosT = midPlaneCos(board, xi, xe);
    const hh = (p.materialThickness / cosT + p.slotFit) / 2;
    return [
      { x: xo, y: mid(xe) + hh },
      { x: xi, y: mid(xi) + hh },
      { x: xi, y: mid(xi) - hh },
      { x: xo, y: mid(xe) - hh },
    ];
  };
  const notches: Pt[][] = [];
  if (p.includeNoseBlock) {
    const nn = blockNotch('nose');
    if (nn) notches.push(nn);
  }
  if (p.includeTailBlock) {
    const nn = blockNotch('tail');
    if (nn) notches.push(nn);
  }
  if (notches.length > 0) {
    const pieces = differenceMulti(outline, notches).filter(
      (r) => r.length >= 3 && Math.abs(signedArea(r)) > 0.5,
    );
    if (pieces.length === 1) {
      cut = dedupe(pieces[0]!);
    } else {
      warn({
        code: 'block-notch-skipped',
        partId: 'stringer',
        message: 'The block cross-lap notch would split the stringer end — skipped',
      });
    }
  }

  const loops: Loop[] = [loop('cut', true, cut)];
  // Optional lightening (same style as the ribs), inset from the spine + notches.
  // Keep a solid column under each rib-notch half-lap.
  if (p.lightenStringer) {
    const lit = buildLightening(cut, p, inner);
    if (p.lighteningStyle !== 'none' && lit.length === 0) {
      warn({
        code: 'lightening-dropped',
        partId: 'stringer',
        message: 'No stringer lightening fits — the web margin / hole size leaves no room',
      });
    }
    loops.push(...lit);
  }
  // Rocker baseline (mark) for reference.
  loops.push(
    loop('mark', false, [
      { x: x0, y: botY(x0) },
      { x: x1, y: botY(x1) },
    ]),
  );

  // Center-fin boxes land on the spine — mark the box footprint along the bottom edge
  // (room for a reinforcement block). Side fins sit off the stringer, so skip them.
  if (board.fins.setup !== 'none') {
    for (const fin of resolveFins(board)) {
      if (fin.side !== 0) continue;
      const cx = (fin.baseLine.fore.x + fin.baseLine.aft.x) / 2;
      const boxLen = boxSpan(fin.box) || fin.spec.base;
      const a = Math.max(x0, cx - boxLen / 2);
      const b = Math.min(x1, cx + boxLen / 2);
      loops.push(
        loop(
          'mark',
          false,
          [
            { x: a, y: botY(a) },
            { x: b, y: botY(b) },
          ],
          true,
        ),
      );
      labels.push({ text: 'fin box', at: { x: cx, y: botY(cx) - 1.5 }, height: 1 });
    }
  }

  return { id: 'stringer', label: 'Stringer', loops, labels };
};

// --- lightening (shared by ribs & stringer) ---

/**
 * Build the `cutInner` lightening loops for a part given its outer `contour`.
 * Insets the contour by `webMargin` (a rim clear of every cut edge, incl. slots
 * and notches), then applies the chosen style — pocket / truss / circles — set
 * out symmetrically about the part's own centre.
 *
 * `slotXs` are the x-positions of any half-lap checks (the rib's stringer slot,
 * the stringer's rib notches): a solid full-height column is kept around each so
 * the material directly above and below every joint stays uncut. Returns [] for
 * style `none` or when the part is too small to lighten.
 */
const buildLightening = (
  contour: readonly Pt[],
  p: HwsParams,
  slotXs: readonly number[] = [],
): Loop[] => {
  if (p.lighteningStyle === 'none') return [];
  let innerRegions = offsetClosedAll(contour, -p.webMargin).filter(
    (r) => r.length >= 3 && Math.abs(signedArea(r)) > 0.5,
  );
  if (innerRegions.length === 0) return [];

  // Keep a solid column over every half-lap check: subtract a full-height
  // rectangle (slot width + a web each side) around each slot from the regions.
  if (slotXs.length > 0) {
    const slotHalf = (p.materialThickness + p.slotFit) / 2 + p.webMargin;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (const r of innerRegions) {
      const b = boundsOf(r);
      if (b.y0 < yLo) yLo = b.y0;
      if (b.y1 > yHi) yHi = b.y1;
    }
    yLo -= 5;
    yHi += 5;
    const columns = slotXs.map((sx) => [
      { x: sx - slotHalf, y: yLo },
      { x: sx + slotHalf, y: yLo },
      { x: sx + slotHalf, y: yHi },
      { x: sx - slotHalf, y: yHi },
    ]);
    innerRegions = innerRegions
      .flatMap((r) => differenceMulti(r, columns))
      .filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 0.5);
    if (innerRegions.length === 0) return [];
  }

  const out: Loop[] = [];
  if (p.lighteningStyle === 'pocket') {
    for (const region of innerRegions) {
      for (const piece of pocketPieces(region, p)) {
        if (piece.length >= 3 && Math.abs(signedArea(piece)) > 0.25) {
          out.push(loop('cutInner', true, dedupe(piece)));
        }
      }
    }
  } else if (p.lighteningStyle === 'truss') {
    // One web, set out from the part centre and mirror-symmetric, subtracted from
    // every region piece (a slot/notch can split the region into several).
    const bands = buildTrussBands(innerRegions, p);
    for (const region of innerRegions) {
      const pieces = bands.length > 0 ? differenceMulti(region, bands) : [region];
      for (const piece of pieces) {
        // Round the pocket corners so the truss webs meet in fillets, not sharp
        // re-entrant notches that crack ply.
        for (const filleted of filletLoop(piece, p.pocketCornerRadius)) {
          if (filleted.length >= 3 && Math.abs(signedArea(filleted)) > 0.25) {
            out.push(loop('cutInner', true, dedupe(filleted)));
          }
        }
      }
    }
  } else {
    // Circles following the part's mid-axis, sized to the local inset height.
    for (const c of holeCircles(innerRegions, p)) {
      out.push(loop('cutInner', true, c));
    }
  }
  return out;
};

// --- ribs ---

/** Clip a closed polygon to one vertical half-plane (Sutherland–Hodgman step). */
const clipHalfPlaneX = (input: readonly Pt[], inside: (q: Pt) => boolean, planeX: number): Pt[] => {
  const out: Pt[] = [];
  const n = input.length;
  for (let i = 0; i < n; i++) {
    const a = input[i]!;
    const b = input[(i + 1) % n]!;
    const aIn = inside(a);
    const bIn = inside(b);
    const cross = (): Pt => {
      const t = (planeX - a.x) / (b.x - a.x);
      return { x: planeX, y: a.y + t * (b.y - a.y) };
    };
    if (aIn && bIn) out.push(b);
    else if (aIn && !bIn) out.push(cross());
    else if (!aIn && bIn) {
      out.push(cross());
      out.push(b);
    }
  }
  return out;
};

/**
 * Clip a closed polygon to the vertical band |x| ≤ xMax (Sutherland–Hodgman, one
 * half-plane per side). A rib section is x-convex, so each side yields one clean
 * vertical face — the flat the rail-band strips glue against.
 */
const clipToMaxAbsX = (pts: readonly Pt[], xMax: number): Pt[] => {
  const right = clipHalfPlaneX(pts, (q) => q.x <= xMax, xMax);
  return clipHalfPlaneX(right, (q) => q.x >= -xMax, -xMax);
};

/**
 * Insert a locating tab into a rib half-profile's vertical side face at x = yCut
 * (the rail-band inner face). The tab protrudes `prot` (one lamination layer of
 * rail stock) and keys the matching slot/notch in the layer-1 rail template:
 * `vertical` lamination centres it on the face, `horizontal` seats it at the
 * face's bottom (the first layer sits on the bottom skin).
 */
const insertSideTab = (
  half: readonly Pt[],
  yCut: number,
  prot: number,
  lamination: HwsParams['railLamination'],
): Pt[] => {
  const eps = 1e-4;
  for (let i = 0; i + 1 < half.length; i++) {
    const a = half[i]!;
    const b = half[i + 1]!;
    if (Math.abs(a.x - yCut) > eps || Math.abs(b.x - yCut) > eps) continue;
    const yLo = Math.min(a.y, b.y);
    const yHi = Math.max(a.y, b.y);
    const faceH = yHi - yLo;
    if (faceH < 0.6) return [...half];
    const tabH = lamination === 'vertical' ? Math.max(0.8, faceH / 3) : Math.min(prot, faceH / 2);
    const c = lamination === 'vertical' ? (yLo + yHi) / 2 : yLo + tabH / 2;
    const t0 = Math.max(yLo, c - tabH / 2);
    const t1 = Math.min(yHi, c + tabH / 2);
    if (t1 - t0 < 0.2) return [...half];
    const up = b.y > a.y; // face walked bottom→deck?
    const tab: Pt[] = up
      ? [
          { x: yCut, y: t0 },
          { x: yCut + prot, y: t0 },
          { x: yCut + prot, y: t1 },
          { x: yCut, y: t1 },
        ]
      : [
          { x: yCut, y: t1 },
          { x: yCut + prot, y: t1 },
          { x: yCut + prot, y: t0 },
          { x: yCut, y: t0 },
        ];
    return [...half.slice(0, i + 1), ...tab, ...half.slice(i + 1)];
  }
  return [...half];
};

const buildRib = (
  board: BezierBoard,
  p: HwsParams,
  x: number,
  index: number,
  warn: Warn,
): Part | null => {
  const id = `rib-${index}`;
  const skip = (why: string): null => {
    warn({
      code: 'rib-skipped',
      partId: id,
      message: `Rib ${index + 1} @ ${x.toFixed(1)} cm skipped: ${why}`,
    });
    return null;
  };
  const cs = getInterpolatedCrossSection(board, x);
  if (!cs) return skip('no cross-section here');
  const tol = p.sampleTolerance;
  const skin = p.skinThickness;
  const inset = skin;
  const slotW = p.materialThickness + p.slotFit;
  const halfW = slotW / 2;

  // Half-profile: tt 0..1 runs bottom-centre → rail → deck-centre. The spline's
  // end-knot handles can let the curve overshoot the centreline near the deck
  // and bottom; trim those overshoots so x ≥ 0 throughout and the mirror-and-
  // close trick below stays simple.
  const rawHalf = trimHalfToPositiveX(sampleCurve((tt) => pointByTT(cs.spline, tt), 0, 1, tol));
  if (rawHalf.length < 2) return skip('degenerate section profile');

  // Mirror the half-profile across x = 0 to form a closed full-profile polygon,
  // then inset it by `inset` using Clipper — this is robust at the rail apex
  // where an open-polyline offset would fold back on itself. Extract the right
  // half (x ≥ 0) afterwards.
  const mirrored = rawHalf
    .slice(1, -1)
    .map((v) => ({ x: -v.x, y: v.y }))
    .reverse();
  const rawFull = dedupe([...rawHalf, ...mirrored]);
  let insetFull = offsetClosed(rawFull, -inset);
  if (insetFull.length < 4) return skip('the skin inset consumes the whole section');

  // Rail band: cut the rib back to the band's inner face — a vertical flat at
  // |x| = offset-outline half-width — WITHOUT touching its deck/bottom edges
  // (the old uniform `skin + railInset` inset wrongly lowered those too).
  let yCut = 0;
  const bandOffset = railOffset(p);
  if (bandOffset > 0) {
    yCut = outlineInsetHalfWidthAt(board, x, bandOffset);
    const railX = insetFull.reduce((m, q) => Math.max(m, Math.abs(q.x)), 0);
    if (yCut > 0.5 && yCut < railX - 1e-3) {
      insetFull = dedupe(clipToMaxAbsX(insetFull, yCut));
      if (insetFull.length < 4) return skip('the rail-band cut-back consumes the whole rib');
    } else {
      yCut = 0; // degenerate near the tips: leave the rib untrimmed
      warn({
        code: 'rail-cutback-skipped',
        partId: id,
        message: `Rib ${index + 1} @ ${x.toFixed(1)} cm left untrimmed — the rail-band offset leaves no vertical glue face here`,
      });
    }
  }

  let half = extractRightHalf(insetFull);
  if (half.length < 2) return skip('degenerate inset profile');
  if (yCut > 0 && p.railJoint === 'tabSlot') {
    const withTab = insertSideTab(half, yCut, p.railStripThickness, p.railLamination);
    if (withTab.length === half.length) {
      warn({
        code: 'tab-skipped',
        partId: id,
        message: `Rib ${index + 1} @ ${x.toFixed(1)} cm: side face too short for a locating tab — cut it as a butt joint`,
      });
    }
    half = withTab;
  }

  const ybc = half[0]!.y; // bottom-centre (inset)
  const ydc = half[half.length - 1]!.y; // deck-centre (inset)
  const H = ydc - ybc;
  if (H <= 0) return skip('inset profile has no height');
  const ribDepth = (1 - p.halfLapFraction) * H;

  // Right rail from the slot mouth (x ≈ halfW) up to the deck centre.
  let mouth = 1;
  while (mouth < half.length && half[mouth]!.x < halfW) mouth++;
  const rightRail = half.slice(mouth);
  if (rightRail.length === 0) return skip('narrower than the stringer slot');
  const leftRail = rightRail.map((v) => ({ x: -v.x, y: v.y })).reverse();

  // Seat the slot mouth corners ON the bottom profile at x = ±halfW (interpolated)
  // rather than dropping them to the centre-low `ybc`. Using `ybc` left a tiny
  // downward spike at each mouth because the profile at the slot half-width sits
  // slightly above the centre; this seats them flush so the slot walls rise
  // cleanly from the rib's bottom edge.
  const a0 = half[mouth - 1]!;
  const b0 = half[mouth]!;
  const mouthY = a0.x === b0.x ? a0.y : a0.y + ((halfW - a0.x) / (b0.x - a0.x)) * (b0.y - a0.y);
  const slotTopY = ybc + ribDepth;

  // Closed contour with a downward-opening stringer slot at the bottom centre.
  const contour: Pt[] = dedupe([
    { x: halfW, y: mouthY }, // right mouth (on the rail)
    ...rightRail, // up right rail → deck centre
    ...leftRail.slice(1), // down left rail → left mouth area
    { x: -halfW, y: mouthY }, // left mouth (on the rail)
    { x: -halfW, y: slotTopY }, // up into slot
    { x: halfW, y: slotTopY }, // across slot top
  ]);
  // The rib's half-lap slot sits at the centreline; keep it solid full-height.
  const lit = buildLightening(contour, p, [0]);
  if (p.lighteningStyle !== 'none' && lit.length === 0) {
    warn({
      code: 'lightening-dropped',
      partId: id,
      message: `Rib ${index + 1} @ ${x.toFixed(1)} cm: no lightening fits — the web margin / hole size leaves no room`,
    });
  }
  const loops: Loop[] = [loop('cut', true, contour), ...lit];

  return {
    id,
    label: `Rib ${index + 1}`,
    station: x,
    loops,
    labels: [{ text: `${index + 1}`, at: { x: 0, y: ydc + 1 }, height: 1 }],
  };
};

interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const boundsOf = (pts: readonly Pt[]): Bounds => {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, x1, y0, y1 };
};

/**
 * Round the internal corners of a closed loop by a shrink-then-grow (round-join)
 * morphology, so there are no re-entrant sharp corners that crack ply. The radius
 * is clamped to just under half the loop's minor extent so the shrink can't
 * collapse it. Returns the surviving loop(s) (a thin loop may split or vanish).
 */
const filletLoop = (loopPts: readonly Pt[], radius: number): Pt[][] => {
  if (loopPts.length < 3) return [];
  const b = boundsOf(loopPts);
  const minor = Math.min(b.x1 - b.x0, b.y1 - b.y0);
  const r = Math.max(0, Math.min(radius, minor / 2 - 0.05));
  if (r <= 0) return [loopPts as Pt[]];
  const shrunk = offsetClosedAll(loopPts, -r, { joinType: JoinType.Round });
  const grown = shrunk.flatMap((s) => offsetClosedAll(s, r, { joinType: JoinType.Round }));
  return grown.length > 0 ? grown : [loopPts as Pt[]];
};

/**
 * One filleted lightening pocket for the `pocket` style: the inset region with
 * its corners rounded to `pocketCornerRadius`.
 */
const pocketPieces = (region: readonly Pt[], p: HwsParams): Pt[][] =>
  filletLoop(region, p.pocketCornerRadius);

/**
 * Build the truss-web struts for a whole rib, set out from the centreline and
 * mirror-symmetric L/R. Returns solid strut polygons (bands) to be subtracted
 * from each rib region.
 *
 * Setout: struts sit at x = ±a/2, ±3a/2, … so the first strut is half a bay off
 * the centreline (the central bay straddles the stringer symmetrically). The bay
 * pitch `a` is the target `trussSpacing` rounded to divide the rib half-width
 * evenly, so the spacing fits each rib. Each strut spans the full rib height;
 * `trussAngle` rotates it about its centre — 0° = vertical posts. Above 0° the
 * struts lean in ALTERNATING directions (a Warren truss), so the pockets between
 * them are alternating triangles; the two halves mirror about the centreline.
 */
const buildTrussBands = (regions: readonly (readonly Pt[])[], p: HwsParams): Pt[][] => {
  // Combined extent across all region pieces (full width incl. both sides).
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const region of regions) {
    const b = boundsOf(region);
    if (b.x0 < x0) x0 = b.x0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y0 < y0) y0 = b.y0;
    if (b.y1 > y1) y1 = b.y1;
  }
  const cX = (x0 + x1) / 2; // part centre (≈0 for ribs, mid-length for the stringer)
  const halfWidth = (x1 - x0) / 2;
  const Hr = y1 - y0;
  if (halfWidth <= 0 || Hr <= 0) return [];

  const nHalf = Math.max(1, Math.round(halfWidth / Math.max(p.trussSpacing, 0.1)));
  const a = halfWidth / nHalf; // bay pitch, fitted to this part
  const half = Math.max(p.webThickness, 0.05) / 2;
  const over = p.webThickness; // overshoot the chords to cut clean to the rim
  const yBot = y0 - over;
  const yTop = y1 + over;
  const halfH = (yTop - yBot) / 2;
  // Top-vs-bottom horizontal offset from vertical. 0° → 0 (upright posts). Clamp
  // below half a bay so neighbouring struts never cross into a bowtie.
  const lean = Math.min(a * 0.45, halfH * Math.tan((Math.max(0, p.trussAngle) * Math.PI) / 180));

  const bands: Pt[][] = [];
  for (let k = 0; k < nHalf; k++) {
    const px = cX + (k + 0.5) * a; // strut centre, right of the part centre
    // Alternate the lean per strut so the pockets triangulate (Warren). The
    // innermost strut (k = 0) leans its top toward the part centre so the two
    // halves meet in an apex; the mirror strut keeps the figure symmetric.
    const s = k % 2 === 0 ? -1 : 1;
    const right: Pt[] = [
      { x: px - s * lean, y: yBot },
      { x: px + s * lean, y: yTop },
    ];
    const left: Pt[] = right.map((q) => ({ x: 2 * cX - q.x, y: q.y }));
    bands.push(...offsetOpenBand(right, half));
    bands.push(...offsetOpenBand(left, half));
  }
  return bands;
};

/** Vertical extent [yMin, yMax] of a closed loop at x = `cx`, or null if `cx` is outside it. */
const verticalSpan = (region: readonly Pt[], cx: number): { yMin: number; yMax: number } | null => {
  let yMin = Infinity;
  let yMax = -Infinity;
  let count = 0;
  const n = region.length;
  for (let i = 0; i < n; i++) {
    const a = region[i]!;
    const b = region[(i + 1) % n]!;
    const straddles = (a.x <= cx && b.x >= cx) || (a.x >= cx && b.x <= cx);
    if (!straddles) continue;
    if (a.x === b.x) {
      yMin = Math.min(yMin, a.y, b.y);
      yMax = Math.max(yMax, a.y, b.y);
      count += 2;
    } else {
      const y = a.y + ((cx - a.x) / (b.x - a.x)) * (b.y - a.y);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
      count += 1;
    }
  }
  return count >= 2 ? { yMin, yMax } : null;
};

/**
 * A row of lightening holes that follow the part's mid-axis and fill the local
 * height of the inset region. Holes are set out from the part centre at a pitch
 * fitted to its half-width, centred on the midpoint of the region's vertical span
 * at each station, and sized to that span (capped at `holeDiameter`). Holes that
 * can't fit a sensible radius — or that fall in a slot/notch gap — are dropped.
 * Returns the closed hole loops.
 */
const holeCircles = (regions: readonly (readonly Pt[])[], p: HwsParams): Pt[][] => {
  if (regions.length === 0) return [];
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const region of regions) {
    const b = boundsOf(region);
    if (b.x0 < x0) x0 = b.x0;
    if (b.x1 > x1) x1 = b.x1;
  }
  const cX = (x0 + x1) / 2;
  const halfWidth = (x1 - x0) / 2;
  if (halfWidth <= 0) return [];

  const nHalf = Math.max(1, Math.round(halfWidth / Math.max(p.holeSpacing, 0.1)));
  const a = halfWidth / nHalf; // hole pitch, fitted to this part
  const capR = p.holeDiameter / 2;
  const minR = 0.3; // ≥ 3 mm holes only
  const out: Pt[][] = [];
  for (let i = -nHalf; i <= nHalf; i++) {
    const cx = cX + i * a;
    // Pick the region that spans this station (the slot splits it into two).
    let span: { yMin: number; yMax: number } | null = null;
    let host: readonly Pt[] | null = null;
    for (const region of regions) {
      const s = verticalSpan(region, cx);
      if (s && (!span || s.yMax - s.yMin > span.yMax - span.yMin)) {
        span = s;
        host = region;
      }
    }
    if (!span || !host) continue;
    const cy = (span.yMin + span.yMax) / 2;
    const r = Math.min(capR, ((span.yMax - span.yMin) / 2) * 0.95);
    if (r < minR) continue;
    // Final guard: the disc must clear the rim horizontally too (rib taper / slot).
    if (!discFitsInRegion(host, cx, cy, r)) continue;
    out.push(sampleCircle(cx, cy, r, p.sampleTolerance));
  }
  return out;
};

/**
 * Trim a sampled cross-section half-profile so x ≥ 0 throughout. Spline
 * handles at the end knots can let the curve dip past the centreline near the
 * bottom and deck endpoints; we replace any such overshoot with the linearly
 * interpolated crossing of x = 0 and snap the endpoints to x = 0.
 */
const trimHalfToPositiveX = (pts: readonly Pt[]): Pt[] => {
  if (pts.length < 2) return [...pts];
  const out: Pt[] = [];
  const cross = (a: Pt, b: Pt): Pt => {
    const t = a.x / (a.x - b.x); // x(t) = a.x + t*(b.x-a.x) = 0
    return { x: 0, y: a.y + t * (b.y - a.y) };
  };
  let inside = pts[0]!.x >= 0;
  if (inside) out.push({ x: Math.max(0, pts[0]!.x), y: pts[0]!.y });
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const aIn = a.x >= 0;
    const bIn = b.x >= 0;
    if (aIn && bIn) {
      out.push(b);
    } else if (aIn && !bIn) {
      out.push(cross(a, b));
      inside = false;
    } else if (!aIn && bIn) {
      if (!inside) out.push(cross(a, b));
      out.push(b);
      inside = true;
    }
  }
  if (out.length === 0) return out;
  out[0] = { x: 0, y: out[0]!.y };
  out[out.length - 1] = { x: 0, y: out[out.length - 1]!.y };
  return out;
};

// Vertices this close to the centreline (cm) count as seam vertices. Well above
// float/Clipper noise, well below any real profile feature.
const SEAM_EPS = 0.05;

/**
 * Extract the x ≥ 0 half of a closed polygon symmetric about x = 0, returning
 * a polyline that runs bottom-centre → rail → deck-centre, endpoints snapped
 * to x = 0.
 *
 * The polygon is first clipped to the x ≥ 0 half-plane (which manufactures
 * exact seam vertices at x = 0), and the walk is anchored at the CENTRELINE
 * SEAM vertices — the extreme-y vertices at x ≈ 0 — never the global y
 * extremes. On boards whose bottom contour dips below the centreline height
 * toward the rail (most real bottoms), the global min-y vertex sits AT THE
 * RAIL on whichever side float noise picks; anchoring there dropped the whole
 * bottom edge and collapsed ribs into straight-edged "diamonds".
 */
const extractRightHalf = (closed: readonly Pt[]): Pt[] => {
  if (closed.length < 4) return [];
  const ring = dedupe(clipHalfPlaneX(closed, (q) => q.x >= 0, 0));
  // dedupe() is consecutive-only: also weld a duplicated first/last pair.
  if (
    ring.length > 1 &&
    Math.hypot(ring[0]!.x - ring[ring.length - 1]!.x, ring[0]!.y - ring[ring.length - 1]!.y) < 1e-6
  ) {
    // prettier-ignore
    ring.pop();
  }
  const n = ring.length;
  if (n < 3) return [];

  // Seam anchors: lowest / highest vertex on the centreline.
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    if (ring[i]!.x > SEAM_EPS) continue;
    if (lo === -1 || ring[i]!.y < ring[lo]!.y) lo = i;
    if (hi === -1 || ring[i]!.y > ring[hi]!.y) hi = i;
  }
  if (lo === -1 || lo === hi) return [];

  // Walk both directions seam-bottom → seam-top; the rail-side walk (not the
  // short hop along the seam itself) has the larger x-sum.
  const walk = (dir: 1 | -1): Pt[] => {
    const out: Pt[] = [];
    for (let k = 0; k < n; k++) {
      const idx = (lo + dir * k + n) % n;
      out.push(ring[idx]!);
      if (idx === hi) break;
    }
    return out;
  };
  const a = walk(1);
  const b = walk(-1);
  const sumX = (pts: Pt[]): number => pts.reduce((s, p) => s + p.x, 0);
  const half = sumX(a) >= sumX(b) ? a : b;
  if (half.length < 2) return [];
  // Snap centreline endpoints to x = 0 (the symmetric polygon's seam).
  half[0] = { x: 0, y: half[0]!.y };
  half[half.length - 1] = { x: 0, y: half[half.length - 1]!.y };
  return half;
};

// --- fins ---

const sideTag = (s: -1 | 0 | 1): string => (s === 0 ? 'C' : s < 0 ? 'P' : 'S');

/**
 * Non-cutting fin-box marks for the bottom skin, in the plan frame (x = length,
 * y = lateral) that {@link resolveFins} already returns: the toed footprint plus
 * the system box outline (Futures rectangle / FCS plug circles; glass-on draws just
 * the footprint), each labelled by side. These are positions to route the boxes
 * into after the skin is on — `mark`, never cut.
 */
const finSkinMarks = (board: BezierBoard): { loops: Loop[]; labels: Label[] } => {
  const loops: Loop[] = [];
  const labels: Label[] = [];
  for (const fin of resolveFins(board)) {
    loops.push(loop('mark', false, [fin.baseLine.aft, fin.baseLine.fore], true));
    const cx = (fin.baseLine.fore.x + fin.baseLine.aft.x) / 2;
    const cy = (fin.baseLine.fore.y + fin.baseLine.aft.y) / 2;
    const dl = Math.hypot(fin.baseLine.fore.x - fin.baseLine.aft.x, fin.baseLine.fore.y - fin.baseLine.aft.y) || 1; // prettier-ignore
    const ax = (fin.baseLine.fore.x - fin.baseLine.aft.x) / dl;
    const ay = (fin.baseLine.fore.y - fin.baseLine.aft.y) / dl;
    const nx = -ay;
    const ny = ax;
    if (fin.box.kind === 'shapes') {
      for (const fp of fin.box.footprints) {
        const ox = cx + ax * fp.along;
        const oy = cy + ay * fp.along;
        if (fp.shape.kind === 'rect') {
          const hl = fp.shape.length / 2;
          const hw = fp.shape.width / 2;
          const corner = (sa: number, sn: number): Pt => ({
            x: ox + ax * hl * sa + nx * hw * sn,
            y: oy + ay * hl * sa + ny * hw * sn,
          });
          loops.push(
            loop('mark', true, [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)]),
          );
        } else {
          const r = fp.shape.diameter / 2;
          const ring: Pt[] = [];
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            ring.push({ x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r });
          }
          loops.push(loop('mark', true, ring));
        }
      }
    }
    labels.push({ text: `${sideTag(fin.side)} fin`, at: { x: cx, y: cy + 1.5 }, height: 1 });
  }
  return { loops, labels };
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
  // Fin-box positions are routed into the bottom skin — mark them there.
  if (which === 'bottom' && board.fins.setup !== 'none') {
    const fins = finSkinMarks(board);
    loops.push(...fins.loops);
    labels.push(...fins.labels);
  }
  return {
    id: `skin-${which}`,
    label: `${which === 'deck' ? 'Deck' : 'Bottom'} skin`,
    loops,
    labels,
  };
};

// --- rail-band templates ---

/** y of a developed edge at u by linear interpolation (edges are u-ascending). */
const edgeYAt = (edge: readonly Pt[], u: number): number => {
  if (edge.length === 0) return 0;
  if (u <= edge[0]!.x) return edge[0]!.y;
  for (let i = 1; i < edge.length; i++) {
    const a = edge[i - 1]!;
    const b = edge[i]!;
    if (u <= b.x) {
      const t = b.x === a.x ? 0 : (u - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return edge[edge.length - 1]!.y;
};

/**
 * How many lamination layers build the band per side. Vertical strips: exactly
 * the user's layer count (it defines the offset). Horizontal layers stack UP the
 * rail, so their count is an estimate from the tallest rail height.
 */
const railLayerCount = (board: BezierBoard, p: HwsParams): number => {
  if (p.railLamination === 'vertical') return Math.max(1, Math.round(p.railLaminations));
  if (p.railStripThickness <= 0) return 1;
  const railHeight = Math.max(0, getMaxThickness(board) - 2 * p.skinThickness);
  return Math.max(1, Math.ceil(railHeight / p.railStripThickness));
};

interface RailMarks {
  loops: Loop[];
  labels: Label[];
}

/** Dashed rib-station reference lines spanning lower→upper edge, numbered like the ribs. */
const railStationMarks = (
  stationU: readonly number[],
  lower: readonly Pt[],
  upper: readonly Pt[],
): RailMarks => {
  const loops: Loop[] = [];
  const labels: Label[] = [];
  stationU.forEach((u, i) => {
    if (!Number.isFinite(u)) return;
    const yLo = edgeYAt(lower, u);
    const yHi = edgeYAt(upper, u);
    loops.push(
      loop(
        'mark',
        false,
        [
          { x: u, y: yLo },
          { x: u, y: yHi },
        ],
        true,
      ),
    );
    labels.push({ text: `${i + 1}`, at: { x: u, y: yHi + 1 }, height: 1 });
  });
  return { loops, labels };
};

/**
 * VERTICAL-lamination rail template(s): the offset-curve ribbon developed flat by
 * the kernel ({@link developRailBand}). `butt` joint → one part with station
 * reference lines; `tabSlot` → a layer-1 part with slot cut-outs matching the rib
 * tabs, plus a plain part for the remaining layers.
 */
const buildVerticalRailParts = (
  board: BezierBoard,
  p: HwsParams,
  stations: readonly number[],
  warn: Warn,
): Part[] => {
  const dev = developRailBand(board, {
    offset: railOffset(p),
    tailTrim: p.railTailTrim,
    noseTrim: p.railNoseTrim,
    skinThickness: p.skinThickness,
    flatten: p.railFlatten,
    tolerance: p.sampleTolerance,
    stations,
  });
  if (dev.deck.length < 2) {
    warn({
      code: 'rail-band-empty',
      message: 'Rail-band development is empty — the offset / end trims leave no band',
    });
    return [];
  }

  const outline = dedupe([...dev.deck, ...[...dev.bottom].reverse()]);
  const marks = railStationMarks(dev.stationU, dev.bottom, dev.deck);
  const layers = railLayerCount(board, p);
  const slotW = p.materialThickness + p.slotFit;

  const slots: Loop[] = [];
  if (p.railJoint === 'tabSlot') {
    for (const u of dev.stationU) {
      if (!Number.isFinite(u)) continue;
      const yD = edgeYAt(dev.deck, u);
      const yB = edgeYAt(dev.bottom, u);
      const faceH = yD - yB;
      const tabH = Math.max(0.8, faceH / 3) + p.slotFit;
      if (faceH - tabH < 0.6) continue; // keep a web above and below the slot
      const c = (yD + yB) / 2;
      slots.push(
        loop('cutInner', true, [
          { x: u - slotW / 2, y: c - tabH / 2 },
          { x: u + slotW / 2, y: c - tabH / 2 },
          { x: u + slotW / 2, y: c + tabH / 2 },
          { x: u - slotW / 2, y: c + tabH / 2 },
        ]),
      );
    }
  }

  const note = (text: string): Label => ({
    text,
    at: { x: 2, y: edgeYAt(dev.deck, 2) + 2.5 },
    height: 1,
  });
  const base = (
    id: string,
    label: string,
    extra: Loop[],
    noteText: string,
    count: number,
  ): Part => ({
    id,
    label,
    count,
    loops: [loop('cut', true, outline), ...extra, ...marks.loops],
    labels: [note(noteText), ...marks.labels],
  });

  if (p.railJoint === 'tabSlot' && slots.length > 0) {
    const parts = [
      base('rail-band-slotted', 'Rail band — layer 1', slots, 'layer 1 — cut 1 per side (x2)', 2),
    ];
    if (layers > 1) {
      parts.push(
        base('rail-band', 'Rail band — layers 2+', [], `layers 2-${layers} — cut ${layers - 1} per side (x2)`, 2 * (layers - 1)), // prettier-ignore
      );
    }
    return parts;
  }
  return [base('rail-band', 'Rail band', [], `cut ${layers} per side (x2 sides)`, 2 * layers)];
};

/**
 * HORIZONTAL-lamination rail template(s): the plan band between outline and offset
 * curve developed along the bottom rocker ({@link developHorizontalRailBand}).
 * `tabSlot` notches the layer-1 inner edge at each rib station so the rib tabs
 * (seated at the bottom of the rib side face) key the first layer.
 */
const buildHorizontalRailParts = (
  board: BezierBoard,
  p: HwsParams,
  stations: readonly number[],
  warn: Warn,
): Part[] => {
  const dev = developHorizontalRailBand(board, {
    offset: railOffset(p),
    tailTrim: p.railTailTrim,
    noseTrim: p.railNoseTrim,
    tolerance: p.sampleTolerance,
    stations,
  });
  if (dev.outer.length < 2) {
    warn({
      code: 'rail-band-empty',
      message: 'Rail-band development is empty — the offset / end trims leave no band',
    });
    return [];
  }

  const marks = railStationMarks(dev.stationU, dev.inner, dev.outer);
  const layers = railLayerCount(board, p);
  const slotW = p.materialThickness + p.slotFit;

  /** Inner edge with a rib notch cut toward the outer edge at each station. */
  const notchedInner = (): Pt[] => {
    const cuts = dev.stationU
      .filter((u) => Number.isFinite(u))
      .sort((a, b) => a - b)
      .map((u) => {
        const u1 = u - slotW / 2;
        const u2 = u + slotW / 2;
        const yEdge = Math.max(edgeYAt(dev.inner, u1), edgeYAt(dev.inner, u2));
        const band = edgeYAt(dev.outer, u) - yEdge;
        const depth = Math.min(p.railStripThickness, band - 0.3);
        return { u1, u2, top: yEdge + depth, ok: depth > 0.15 };
      })
      .filter((c) => c.ok);
    if (cuts.length === 0) return [...dev.inner];

    const out: Pt[] = [];
    let ci = 0;
    for (const q of dev.inner) {
      while (ci < cuts.length && q.x > cuts[ci]!.u2) ci++;
      const c = cuts[ci];
      if (c && q.x >= c.u1 && q.x <= c.u2) {
        // First point inside the notch span: emit the notch, then skip the rest.
        if (out.length === 0 || out[out.length - 1]!.x < c.u1) {
          out.push({ x: c.u1, y: edgeYAt(dev.inner, c.u1) });
          out.push({ x: c.u1, y: c.top });
          out.push({ x: c.u2, y: c.top });
          out.push({ x: c.u2, y: edgeYAt(dev.inner, c.u2) });
        }
        continue;
      }
      out.push(q);
    }
    return out;
  };

  const partOf = (
    id: string,
    label: string,
    inner: readonly Pt[],
    noteText: string,
    count: number,
  ): Part => ({
    id,
    label,
    count,
    loops: [loop('cut', true, dedupe([...dev.outer, ...[...inner].reverse()])), ...marks.loops],
    labels: [
      { text: noteText, at: { x: 2, y: edgeYAt(dev.outer, 2) + 2.5 }, height: 1 },
      ...marks.labels,
    ],
  });

  // Horizontal layers stack up the rail, so the count is a height-based estimate.
  if (p.railJoint === 'tabSlot') {
    const parts = [
      partOf('rail-band-slotted', 'Rail band — layer 1', notchedInner(), 'layer 1 (bottom) — cut 1 per side (x2)', 2), // prettier-ignore
    ];
    if (layers > 1) {
      parts.push(
        partOf('rail-band', 'Rail band — layers 2+', dev.inner, `~${layers - 1} more per side (x2), stack to the deck`, 2 * (layers - 1)), // prettier-ignore
      );
    }
    return parts;
  }
  return [partOf('rail-band', 'Rail band', dev.inner, `cut ~${layers} per side (x2), stack to the deck`, 2 * layers)]; // prettier-ignore
};

// --- nose/tail blocks ---

/**
 * Nose/tail block template: a flat plate lying in the board's tilted mid-plane,
 * spanning tip → block length. The lateral edge follows the same offset outline
 * the ribs butt against (the rail-band inner face, or the skin inset when no
 * band is configured), developed to true size by the mid-plane tilt (x / cosθ,
 * like the legacy BoardCAD nose/tail pieces). A centreline slot from the aft
 * edge cross-laps the matching stringer end notch; the rail band simply butts
 * against the plate edge (crenellated keying is a later refinement).
 */
const buildBlock = (
  board: BezierBoard,
  p: HwsParams,
  which: 'nose' | 'tail',
  warn: Warn,
): Part | null => {
  const id = `block-${which}`;
  const label = which === 'nose' ? 'Nose block' : 'Tail block';
  const skip = (why: string): null => {
    warn({ code: 'block-skipped', partId: id, message: `${label} skipped: ${why}` });
    return null;
  };
  const L = getLength(board);
  const len = Math.min(which === 'nose' ? p.noseBlockLength : p.tailBlockLength, L / 2 - 1);
  const s0 = 0.5; // keep off the exact tip, where the outline pinches to zero
  if (len <= s0 + 0.5) return skip('block length too short');
  const bx = (s: number): number => (which === 'nose' ? s : L - s); // tip-relative → board x

  const bandOffset = railOffset(p);
  const inset = bandOffset > 0 ? bandOffset : p.skinThickness;
  const cosT = midPlaneCos(board, bx(s0), bx(len));
  const u = (s: number): number => (s - s0) / cosT; // developed coordinate
  const yHalfAt = (s: number): number => Math.max(0, outlineInsetHalfWidthAt(board, bx(s), inset));

  // Step forward past any stations the inset consumed entirely (right at the tip).
  let sStart = s0;
  const step = (len - s0) / 32;
  while (sStart < len && yHalfAt(sStart) < 0.05) sStart += step;
  if (len - sStart < 1) return skip('the outline inset leaves no width here');

  const tol = p.sampleTolerance;
  const top = sampleCurve((s) => ({ x: u(s), y: yHalfAt(s) }), sStart, len, tol);
  const bottom = sampleCurve((s) => ({ x: u(s), y: -yHalfAt(s) }), len, sStart, tol);

  // Centreline slot from the aft edge, spanning the overlap with the stringer.
  const u1 = u(len);
  const yAft = yHalfAt(len);
  const slotW = p.materialThickness + p.slotFit;
  const tip = Math.max(p.endMargin, 1);
  const lap = len - tip;
  let slot: Pt[] = [];
  if (lap <= 0.3) {
    warn({
      code: 'block-lap-skipped',
      partId: id,
      message: `${label} (${len.toFixed(1)} cm) ends before the stringer does (end margin ${tip.toFixed(1)} cm) — no cross-lap cut`,
    });
  } else if (yAft > slotW / 2 + 0.3) {
    const uSlot = u1 - lap / cosT;
    slot = [
      { x: u1, y: slotW / 2 },
      { x: uSlot, y: slotW / 2 },
      { x: uSlot, y: -slotW / 2 },
      { x: u1, y: -slotW / 2 },
    ];
  }

  const contour = dedupe([...top, ...slot, ...bottom]);
  if (contour.length < 4) return skip('degenerate contour');
  const lit = buildLightening(contour, p, []);
  if (p.lighteningStyle !== 'none' && lit.length === 0) {
    warn({
      code: 'lightening-dropped',
      partId: id,
      message: `${label}: no lightening fits — the web margin / hole size leaves no room`,
    });
  }
  return {
    id,
    label,
    loops: [loop('cut', true, contour), ...lit],
    labels: [{ text: label, at: { x: u1 * 0.35, y: 0.8 }, height: 1 }],
  };
};

const buildRailParts = (
  board: BezierBoard,
  p: HwsParams,
  stations: readonly number[],
  warn: Warn,
): Part[] =>
  p.railLamination === 'horizontal'
    ? buildHorizontalRailParts(board, p, stations, warn)
    : buildVerticalRailParts(board, p, stations, warn);

/**
 * Build the HWS internal-frame templates for `board`. Missing params fall back to
 * {@link DEFAULT_HWS_PARAMS}. Coordinates are centimetres; feed the result to
 * `sheetToDxf` / `sheetToSvg` / `sheetToPdf`.
 *
 * The geometry is always **true size** — tool-diameter (kerf) offsets are the
 * operator's job in CAM/CNC programming.
 */
export const buildHwsTemplates = (
  board: BezierBoard,
  paramsIn: Partial<HwsParams> = {},
): TemplateSheet => {
  const p: HwsParams = { ...DEFAULT_HWS_PARAMS, ...paramsIn };
  const stations = ribStations(board, p);
  const warnings: TemplateWarning[] = [];
  const warn: Warn = (w) => warnings.push(w);

  const parts: Part[] = [];
  if (p.includeStringer) parts.push(buildStringer(board, p, stations, warn));
  if (p.includeRibs) {
    stations.forEach((x, i) => {
      const rib = buildRib(board, p, x, i, warn);
      if (rib) parts.push(rib);
    });
  }
  if (p.includeDeckSkin) parts.push(buildSkin(board, p, stations, 'deck'));
  if (p.includeBottomSkin) parts.push(buildSkin(board, p, stations, 'bottom'));
  if (p.includeRailTemplate && railOffset(p) > 0) {
    parts.push(...buildRailParts(board, p, stations, warn));
  }
  if (p.includeNoseBlock) {
    const b = buildBlock(board, p, 'nose', warn);
    if (b) parts.push(b);
  }
  if (p.includeTailBlock) {
    const b = buildBlock(board, p, 'tail', warn);
    if (b) parts.push(b);
  }

  return {
    parts,
    units: 'cm',
    ...(warnings.length > 0 ? { warnings } : {}),
    meta: { title: 'Hollow Wood Frame', generator: 'OpenShaper' },
  };
};
