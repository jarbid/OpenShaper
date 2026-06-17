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
  getInterpolatedCrossSection,
  getLength,
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
  // Optional lightening (same style as the ribs), inset from the spine + notches.
  // Keep a solid column under each rib-notch half-lap.
  if (p.lightenStringer) loops.push(...buildLightening(outline, p, inner));
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

const buildRib = (board: BezierBoard, p: HwsParams, x: number, index: number): Part | null => {
  const cs = getInterpolatedCrossSection(board, x);
  if (!cs) return null;
  const tol = p.sampleTolerance;
  const skin = p.skinThickness;
  const inset = skin + p.railInset;
  const slotW = p.materialThickness + p.slotFit;
  const halfW = slotW / 2;

  // Half-profile: tt 0..1 runs bottom-centre → rail → deck-centre. The spline's
  // end-knot handles can let the curve overshoot the centreline near the deck
  // and bottom; trim those overshoots so x ≥ 0 throughout and the mirror-and-
  // close trick below stays simple.
  const rawHalf = trimHalfToPositiveX(sampleCurve((tt) => pointByTT(cs.spline, tt), 0, 1, tol));
  if (rawHalf.length < 2) return null;

  // Mirror the half-profile across x = 0 to form a closed full-profile polygon,
  // then inset it by `inset` using Clipper — this is robust at the rail apex
  // where an open-polyline offset would fold back on itself. Extract the right
  // half (x ≥ 0) afterwards.
  const mirrored = rawHalf
    .slice(1, -1)
    .map((v) => ({ x: -v.x, y: v.y }))
    .reverse();
  const rawFull = dedupe([...rawHalf, ...mirrored]);
  const insetFull = offsetClosed(rawFull, -inset);
  if (insetFull.length < 4) return null;
  const half = extractRightHalf(insetFull);
  if (half.length < 2) return null;

  const ybc = half[0]!.y; // bottom-centre (inset)
  const ydc = half[half.length - 1]!.y; // deck-centre (inset)
  const H = ydc - ybc;
  if (H <= 0) return null;
  const ribDepth = (1 - p.halfLapFraction) * H;

  // Right rail from the slot mouth (x ≈ halfW) up to the deck centre.
  let mouth = 1;
  while (mouth < half.length && half[mouth]!.x < halfW) mouth++;
  const rightRail = half.slice(mouth);
  if (rightRail.length === 0) return null;
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
  const loops: Loop[] = [loop('cut', true, contour), ...buildLightening(contour, p, [0])];

  return {
    id: `rib-${index}`,
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

/**
 * Extract the x ≥ 0 half of a closed polygon symmetric about x = 0, returning
 * a polyline that runs bottom-centre (min y on x = 0) → rail → deck-centre
 * (max y on x = 0). The endpoints are snapped to x = 0.
 */
const extractRightHalf = (closed: readonly Pt[]): Pt[] => {
  const n = closed.length;
  if (n < 4) return [];
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < n; i++) {
    if (closed[i]!.y < closed[lo]!.y) lo = i;
    if (closed[i]!.y > closed[hi]!.y) hi = i;
  }
  // Walk both directions from lo → hi and keep the one with all x ≥ 0
  // (a closed CCW polygon symmetric about x=0 has one half on each side).
  const walk = (dir: 1 | -1): Pt[] => {
    const out: Pt[] = [];
    for (let k = 0; k < n; k++) {
      const idx = (lo + dir * k + n) % n;
      out.push(closed[idx]!);
      if (idx === hi) break;
    }
    return out;
  };
  const a = walk(1);
  const b = walk(-1);
  const sumX = (pts: Pt[]): number => pts.reduce((s, p) => s + p.x, 0);
  const half = sumX(a) >= sumX(b) ? a : b;
  if (half.length === 0) return half;
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

/**
 * Compensate every cutting loop for a symmetric kerf: the cutter removes
 * `kerf / 2` each side of the drawn line, so outer `cut` contours move outward
 * by half the kerf and `cutInner` holes inward, keeping the finished part true
 * to size. `mark` loops are untouched; holes the kerf consumes entirely vanish.
 */
const applyKerf = (parts: readonly Part[], kerf: number): Part[] =>
  parts.map((part) => ({
    ...part,
    loops: part.loops.flatMap((l): Loop[] => {
      if (!l.closed || l.kind === 'mark') return [l];
      const d = l.kind === 'cut' ? kerf / 2 : -kerf / 2;
      return offsetClosedAll(l.pts, d)
        .filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 0.25)
        .map((r) => loop(l.kind, true, r));
    }),
  }));

/**
 * Build the HWS internal-frame templates for `board`. Missing params fall back to
 * {@link DEFAULT_HWS_PARAMS}. Coordinates are centimetres; feed the result to
 * `sheetToDxf` / `sheetToSvg` / `sheetToPdf`.
 *
 * By default the geometry is **true** — tool-diameter offsets are the operator's
 * job in CAM/CNC programming. Set `kerfDiameter` to bake kerf compensation in.
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

  return {
    parts: p.kerfDiameter > 0 ? applyKerf(parts, p.kerfDiameter) : parts,
    units: 'cm',
    meta: { title: 'Hollow Wood Frame', generator: 'OpenShaper' },
  };
};
