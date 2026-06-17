// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fins — surfboard fin configuration, placement, and geometry.
 *
 * The legacy BoardCAD-LE stored a flat `double[9]` (side/center front & back x,y,
 * depths, splay) plus a free-text type string, defaulted to all zeros and drawn as
 * three plain lines. We deliberately supersede that with a parametric, system-aware
 * model (see docs/specs/divergences.md): a {@link FinConfig} is the persisted design
 * *intent* — a named setup + fin system + per-fin parametric specs — and
 * {@link resolveFins} computes the absolute geometry on demand against the current
 * board shape. Nothing resolved is stored, so the kernel stays pure and the geometry
 * golden suite is untouched (fins default to `none`).
 *
 * Why parametric (not absolute) placement: a fin's lateral position is an *inset from
 * the rail edge*, so it follows the outline when the plan-shape is edited; its base
 * rides the *bottom rocker surface*, so it follows the profile. Editing the board
 * moves the fins, exactly as a shaper marks a blank relative to the rail and tail.
 *
 * Coordinate convention matches {@link BoardMesh} (cm): X = nose..tail length axis,
 * Y = width (rail-to-rail, stringer at 0), Z = height (up). Fins hang in −Z below the
 * bottom surface.
 */
import { valueAt } from './bezier-spline';
import { DEG_TO_RAD } from './constants';
import { getLength, getRockerAtPos, getWidthAtPos, type BezierBoard } from './board';
import { FIN_TEMPLATES, FIN_TEMPLATE_CHORD } from './fin-templates.generated';
import type { BoardMesh } from './tessellate';
import { vec2, type Vec2 } from './vec2';

// --- model -----------------------------------------------------------------

/** Named fin configurations (count of fins differs per setup). */
export type FinSetup = 'none' | 'single' | 'twin' | 'thruster' | 'quad' | '2+1' | '5-fin';

/** Mounting system — drives the box/plug geometry routed into the board. */
export type FinSystem = 'glass-on' | 'fcs-ii' | 'fcs-x2' | 'futures';

/** Foil (cross-section) of a fin blade. Sides are usually flat-inside (80/20). */
export type FinFoil = 'flat' | '80/20' | '50/50';

/**
 * Blade outline family — real surf-fin template shapes traced from FinFoil reference
 * outlines (docs/specs/fins/*.foil, see fin-templates.generated.ts):
 *   - `thruster`: classic dolphin side/center fin, moderate rake (thruster / quad / 5-fin).
 *   - `single`: performance single fin, upright with a raked tip (shortboard / mid single).
 *   - `noserider`: tall longboard single with a flex tip (2+1 center / longboard single).
 *   - `keel`: long, low-aspect swept twin keel.
 */
export type FinProfile = 'thruster' | 'single' | 'noserider' | 'keel';

export const FIN_PROFILES_LIST: readonly FinProfile[] = ['thruster', 'single', 'noserider', 'keel'];

export const FIN_PROFILE_LABELS: Record<FinProfile, string> = {
  thruster: 'Thruster / side',
  single: 'Single',
  noserider: 'Noserider',
  keel: 'Keel / twin',
};

export const FIN_SETUPS: readonly FinSetup[] = [
  'none',
  'single',
  'twin',
  'thruster',
  'quad',
  '2+1',
  '5-fin',
];

export const FIN_SETUP_LABELS: Record<FinSetup, string> = {
  none: 'No fins',
  single: 'Single',
  twin: 'Twin',
  thruster: 'Thruster',
  quad: 'Quad',
  '2+1': '2 + 1',
  '5-fin': '5-Fin',
};

export const FIN_SYSTEMS: readonly FinSystem[] = ['glass-on', 'fcs-ii', 'fcs-x2', 'futures'];

export const FIN_SYSTEM_LABELS: Record<FinSystem, string> = {
  'glass-on': 'Glass-on',
  'fcs-ii': 'FCS II',
  'fcs-x2': 'FCS (x2 plug)',
  futures: 'Futures',
};

/**
 * Parametric spec for ONE fin, all relative to the board so it resolves with shape.
 * Lengths are cm, angles degrees.
 */
export interface FinSpec {
  /** -1 port, 0 center (on the stringer), +1 starboard. */
  readonly side: -1 | 0 | 1;
  /** Trailing-edge distance from the tail tip, measured along the stringer (cm). */
  readonly trailingFromTail: number;
  /** Lateral inset from the rail edge at the fin's position (cm); ignored for center fins. */
  readonly insetFromRail: number;
  /** Footprint length along the stringer (cm). */
  readonly base: number;
  /** Blade height below the bottom surface (cm). */
  readonly depth: number;
  /** Rake: backward sweep of the blade (deg). */
  readonly sweep: number;
  /** Toe-in toward the nose centerline (deg). */
  readonly toe: number;
  /** Cant: outward lean from vertical (deg). */
  readonly cant: number;
  readonly foil: FinFoil;
  /** Blade outline family (pivot / raked / performance). */
  readonly profile: FinProfile;
}

/** Persisted fin configuration on a {@link BezierBoard}. */
export interface FinConfig {
  readonly setup: FinSetup;
  readonly system: FinSystem;
  /**
   * When true (default), the port/starboard side-fin pairs are kept mirror-symmetric:
   * editing or dragging one fin applies the same change to its opposite-side partner.
   */
  readonly symmetrical: boolean;
  /** One spec per fin; `length` matches the setup's fin count (empty for `none`). */
  readonly fins: readonly FinSpec[];
}

export const noFins = (): FinConfig => ({
  setup: 'none',
  system: 'fcs-ii',
  symmetrical: true,
  fins: [],
});

// --- system box geometry ---------------------------------------------------

/** One routed footprint of a fin box/plug — a rectangular slot or a round plug. */
export interface BoxFootprint {
  /** Offset of this footprint's center along the base from the base center (cm); + toward the nose. */
  readonly along: number;
  readonly shape:
    | { readonly kind: 'rect'; readonly length: number; readonly width: number }
    | { readonly kind: 'circle'; readonly diameter: number };
}

/**
 * The geometry routed into the board to mount a fin, as a set of {@link BoxFootprint}s
 * laid along the fin base. Glass-on fins route nothing (`none`).
 */
export type BoxGeometry =
  | { readonly kind: 'none' }
  | { readonly kind: 'shapes'; readonly footprints: readonly BoxFootprint[] };

const inch = (n: number): number => n * 2.54;

const rect = (along: number, length: number, width: number): BoxFootprint => ({
  along,
  shape: { kind: 'rect', length, width },
});
const circle = (along: number, diameter: number): BoxFootprint => ({
  along,
  shape: { kind: 'circle', diameter },
});

/**
 * Fin-mounting footprints per system, at true manufacturer hardware dimensions (cm),
 * laid along the fin base. Fixed sizes — independent of the blade base. Sources:
 *   - **Futures**: one continuous box, routed slot ≈ 4.5" × 5/16" (side boxes 3/4" deep,
 *     center/quad-rear 1/2"; depth doesn't affect the plan footprint).
 *   - **FCS II**: a single "8"-shaped unit = a long front slot (with the locking groove)
 *     + a shorter rear slot — modeled as two rectangular slots.
 *   - **FCS / X-2**: two round plugs, ≈ 5/8" holes, ≈ 3" centre-to-centre.
 * Pinned by fins.test.ts so a refit is a deliberate change.
 */
/** Total along-base extent (cm) covered by a box geometry's footprints (0 if none). */
export const boxSpan = (box: BoxGeometry): number => {
  if (box.kind !== 'shapes') return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const fp of box.footprints) {
    const half = fp.shape.kind === 'rect' ? fp.shape.length / 2 : fp.shape.diameter / 2;
    lo = Math.min(lo, fp.along - half);
    hi = Math.max(hi, fp.along + half);
  }
  return hi > lo ? hi - lo : 0;
};

export const SYSTEM_BOX: Record<FinSystem, BoxGeometry> = {
  'glass-on': { kind: 'none' },
  futures: { kind: 'shapes', footprints: [rect(0, inch(4.5), inch(0.3125))] },
  'fcs-ii': {
    kind: 'shapes',
    footprints: [
      rect(inch(1.0), inch(1.5), inch(0.31)), // front slot (toward nose), longer — has the key groove
      rect(-inch(1.1), inch(0.85), inch(0.31)), // rear slot
    ],
  },
  'fcs-x2': {
    kind: 'shapes',
    footprints: [circle(inch(1.5), inch(0.625)), circle(-inch(1.5), inch(0.625))],
  },
};

// --- real-world default placements -----------------------------------------

/** Footprint base (cm) that renders `profile` at its true aspect for a blade `depth`. */
const baseFor = (depth: number, profile: FinProfile): number => depth * FIN_TEMPLATE_CHORD[profile];

/**
 * One side/center fin sized by its blade `depth`; the base follows from the profile's
 * true aspect ratio so the seed shape matches the FinFoil outline (keel low and wide,
 * noserider tall and narrow). Every field stays independently editable afterwards.
 */
const side = (
  s: -1 | 0 | 1,
  trailingFromTail: number,
  insetFromRail: number,
  depth: number,
  toe: number,
  cant: number,
  foil: FinFoil,
  profile: FinProfile,
): FinSpec => ({
  side: s,
  trailingFromTail,
  insetFromRail,
  base: baseFor(depth, profile),
  depth,
  sweep: 0, // natural rake lives in the profile outline; sweep is an extra adjustment
  toe,
  cant,
  foil,
  profile,
});

/** A symmetric pair of side fins (port + starboard) sharing one spec. */
const pair = (
  trailingFromTail: number,
  insetFromRail: number,
  depth: number,
  toe: number,
  cant: number,
  profile: FinProfile = 'thruster',
): FinSpec[] => [
  side(-1, trailingFromTail, insetFromRail, depth, toe, cant, '80/20', profile),
  side(1, trailingFromTail, insetFromRail, depth, toe, cant, '80/20', profile),
];

/** A center (on-stringer) fin, defaulting to the tall longboard noserider outline. */
const center = (
  trailingFromTail: number,
  depth: number,
  profile: FinProfile = 'noserider',
): FinSpec => side(0, trailingFromTail, 0, depth, 0, 0, '50/50', profile);

/**
 * Seed a fin configuration with shaper / FCS / Futures standard placements (cm) and the
 * matching blade outline per role (single → single, 2+1 center → noserider, twin → keel,
 * thruster/quad/5-fin → thruster). Each fin is sized by blade depth; its base follows the
 * outline's true aspect. Sensible starting points, not legacy-pinned — every field is
 * editable.
 */
export function defaultFinConfig(setup: FinSetup, system: FinSystem): FinConfig {
  const fins = ((): FinSpec[] => {
    switch (setup) {
      case 'single':
        return [center(inch(8.5), 16, 'single')];
      case 'twin':
        return pair(inch(11.5), 3.2, 12, 3, 7, 'keel');
      case 'thruster':
        return [...pair(inch(11), 2.9, 11.5, 3, 6.5), center(inch(3.5), 11.5, 'thruster')];
      case 'quad':
        return [...pair(inch(11.5), 2.9, 11, 4, 6), ...pair(inch(6.2), 4.4, 10, 2, 4.5)];
      case '2+1':
        return [...pair(inch(12.5), 3.4, 9, 3, 6), center(inch(5.5), 16)];
      case '5-fin':
        return [
          ...pair(inch(11.5), 2.9, 11, 4, 6),
          ...pair(inch(6.2), 4.4, 10, 2, 4.5),
          center(inch(3.5), 11, 'thruster'),
        ];
      default:
        return [];
    }
  })();
  return { setup, system, symmetrical: true, fins };
}

/** The index of `i`'s mirror side fin (the adjacent opposite-side partner), or null. */
export const mirrorFinIndex = (fins: readonly FinSpec[], i: number): number | null => {
  const f = fins[i];
  if (!f || f.side === 0) return null;
  for (const j of [i - 1, i + 1]) {
    if (fins[j] && fins[j]!.side === -f.side) return j;
  }
  return null;
};

// --- resolution to absolute geometry ---------------------------------------

/** Absolute, board-resolved fin geometry for rendering and export. Never persisted. */
export interface ResolvedFin {
  readonly spec: FinSpec;
  readonly side: -1 | 0 | 1;
  /** Plan base-center (x = length axis, y = lateral), cm. */
  readonly center: Vec2;
  /** Plan footprint after toe: fore (toward nose) and aft (toward tail) base corners. */
  readonly baseLine: { readonly fore: Vec2; readonly aft: Vec2 };
  /** Bottom-surface height (Z) at the base center, cm. The blade hangs to surfaceZ − depth. */
  readonly surfaceZ: number;
  /**
   * Blade side-profile silhouette, local coords: +x toward the nose along the base
   * (0 at the trailing-edge root), +y downward (depth). Closed polygon (base → tip).
   */
  readonly template: readonly Vec2[];
  /** Max foil thickness at the root (cm). */
  readonly maxThickness: number;
  readonly foil: FinFoil;
  readonly box: BoxGeometry;
  readonly toe: number;
  readonly cant: number;
  readonly sweep: number;
}

/**
 * Build a blade silhouette of `profile`, scaled to (base, depth) and raked back by any
 * extra `sweepDeg` (0 keeps the profile's natural rake). Returns world-ish 2D points
 * (x along base toward the nose, y depth downward).
 *
 * The silhouettes live in {@link FIN_TEMPLATES} (generated from the FinFoil reference
 * outlines) in aspect-true space: x = 0 at the trailing-edge root, the leading-edge root
 * at x = {@link FIN_TEMPLATE_CHORD} (root chord ÷ depth), x < 0 for a raked tip, and
 * y = 0 root → 1 tip. Dividing x by the chord fraction maps the root chord onto `base`,
 * so the rendered footprint is exactly `base` while the natural proportions are preserved
 * whenever `depth = base / chordFrac`.
 */
export const finTemplate = (
  base: number,
  depth: number,
  sweepDeg: number,
  profile: FinProfile = 'thruster',
): Vec2[] => {
  const shear = Math.tan(sweepDeg * DEG_TO_RAD);
  const xScale = base / FIN_TEMPLATE_CHORD[profile];
  return FIN_TEMPLATES[profile].map((p) => {
    const y = p.y * depth;
    // Shear the upper outline toward the tail (−x) by the extra rake angle.
    return vec2(p.x * xScale - y * shear, y);
  });
};

/** Default max foil thickness for a blade of the given base (cm). */
const foilThickness = (base: number): number => Math.max(0.5, base * 0.085);

/**
 * Resolve a {@link FinConfig} into absolute per-fin geometry against the board's
 * current shape. Lateral position is an inset from the rail edge (follows the
 * outline); the base sits on the bottom rocker (follows the profile). The tail end is
 * detected from the geometry (the wider end is the tail), so placement is correct
 * regardless of which x-end a loaded board calls the nose.
 */
export function resolveFins(b: BezierBoard, cfg: FinConfig = b.fins): ResolvedFin[] {
  if (!cfg || cfg.setup === 'none' || cfg.fins.length === 0) return [];
  const length = getLength(b);
  const tailAtZero = getWidthAtPos(b, 5) >= getWidthAtPos(b, length - 5);
  const tailX = tailAtZero ? 0 : length;
  const noseDir = tailAtZero ? 1 : -1; // sign toward the nose along x
  const box = SYSTEM_BOX[cfg.system];
  return cfg.fins.map((spec) => resolveOne(b, spec, box, length, tailX, noseDir));
}

const clampPos = (x: number, length: number): number => Math.max(0.1, Math.min(length - 0.1, x));

const resolveOne = (
  b: BezierBoard,
  spec: FinSpec,
  box: BoxGeometry,
  length: number,
  tailX: number,
  noseDir: number,
): ResolvedFin => {
  // Base center along the stringer: trailing edge + half the base toward the nose.
  const cx = clampPos(tailX + noseDir * (spec.trailingFromTail + spec.base / 2), length);

  // Lateral position: inset from the rail edge (half-width) for side fins; 0 for center.
  const railHalf = valueAt(b.outline, cx); // outline value = half-width at cx
  const cy = spec.side === 0 ? 0 : spec.side * Math.max(0, railHalf - spec.insetFromRail);

  const surfaceZ = getRockerAtPos(b, cx);

  // Plan base line oriented fore-aft, then rotated by toe about the base center.
  // Nominal fore direction along x is `noseDir`. Toe-in turns the fore end toward the
  // stringer (y → 0): pick the rotation sign so the fore end's lateral magnitude shrinks.
  const toeRad = spec.toe * DEG_TO_RAD;
  const sgn = spec.side === 0 ? 0 : -spec.side * noseDir; // rotation sign for toe-in
  const a = sgn * toeRad;
  const dx = noseDir * Math.cos(a);
  const dy = noseDir * Math.sin(a);
  const half = spec.base / 2;
  const fore = vec2(cx + dx * half, cy + dy * half);
  const aft = vec2(cx - dx * half, cy - dy * half);

  return {
    spec,
    side: spec.side,
    center: vec2(cx, cy),
    baseLine: { fore, aft },
    surfaceZ,
    template: finTemplate(spec.base, spec.depth, spec.sweep, spec.profile ?? 'thruster'),
    maxThickness: foilThickness(spec.base),
    foil: spec.foil,
    box,
    toe: spec.toe,
    cant: spec.cant,
    sweep: spec.sweep,
  };
};

// --- 3D mesh ----------------------------------------------------------------

/**
 * Signed lateral offsets [inner, outer] of the two skins as fractions of the local
 * thickness, by foil type. "outer" faces away from the stringer; side fins are flatter
 * on the inboard (stringer) side (80/20), center fins symmetric (50/50).
 */
const foilOffsets = (foil: FinFoil): [number, number] => {
  switch (foil) {
    case 'flat':
      return [0, 1]; // flat inner face
    case '80/20':
      return [-0.2, 0.8];
    case '50/50':
    default:
      return [-0.5, 0.5];
  }
};

const FIN_DEPTH_LEVELS = 14;
const FIN_CHORD_SAMPLES = 16;

/** Chordwise thickness factor (0..1) at chord position p (0 = leading, 1 = trailing): a
 * foil that rounds at the leading edge, peaks near 35% chord, and thins to the trailing. */
const foilThicknessAcross = (p: number): number => Math.sin(Math.PI * Math.pow(p, 0.7));

/** Thickness taper down the depth (0 = root, 1 = tip): full at the base, thin at the tip. */
const depthTaper = (f: number): number => Math.max(0, 1 - 0.82 * f * f);

/** Min/max along-base x where the silhouette polygon crosses depth `v`, or null. */
const chordAtDepth = (template: readonly Vec2[], v: number): [number, number] | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < template.length; i++) {
    const a = template[i]!;
    const b = template[(i + 1) % template.length]!;
    if (a.y === b.y) continue;
    const t = (v - a.y) / (b.y - a.y);
    if (t < 0 || t > 1) continue;
    const x = a.x + (b.x - a.x) * t;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : null;
};

/**
 * Build a foiled blade solid for a resolved fin in world (board-mesh) coordinates:
 * X = length, Y = width, Z = height. The blade is a proper lofted foil — at each of
 * {@link FIN_DEPTH_LEVELS} depths the silhouette chord is foiled across
 * {@link FIN_CHORD_SAMPLES} samples (rounded leading edge, sharp trailing, tapering to
 * the tip) — hung from `surfaceZ` downward, canted outward and toed-in.
 */
export const buildFinBladeMesh = (fin: ResolvedFin): BoardMesh => {
  const { template, cant, side, surfaceZ, maxThickness, foil } = fin;
  const maxD = maxDepth(template);
  if (maxD <= 1e-6) return finalizeMesh([], []);

  // Orientation, as for the 2D placement.
  const baseDir = unit(sub2(fin.baseLine.fore, fin.baseLine.aft)); // toward nose, toed
  const outward = side === 0 ? vec2(0, 1) : vec2(0, side); // away from the stringer
  const cantRad = cant * DEG_TO_RAD;
  const downY = Math.sin(cantRad) * (side === 0 ? 0 : side);
  const downZ = -Math.cos(cantRad);
  const root = fin.baseLine.aft; // trailing-edge root, on the surface

  const [innerFrac, outerFrac] = foilOffsets(foil);

  const place = (along: number, depth: number, lateral: number): [number, number, number] => [
    root.x + baseDir.x * along + outward.x * lateral,
    root.y + baseDir.y * along + downY * depth + outward.y * lateral,
    surfaceZ + downZ * depth,
  ];

  const positions: number[] = [];
  const indices: number[] = [];
  // outer[j][k] / inner[j][k] vertex indices.
  const outer: number[][] = [];
  const inner: number[][] = [];

  for (let j = 0; j < FIN_DEPTH_LEVELS; j++) {
    const f = j / (FIN_DEPTH_LEVELS - 1);
    const v = f * maxD * 0.999;
    const chord = chordAtDepth(template, v) ?? [0, 0];
    const [uTrail, uLead] = chord;
    const taper = depthTaper(f);
    const oRow: number[] = [];
    const iRow: number[] = [];
    for (let k = 0; k < FIN_CHORD_SAMPLES; k++) {
      const p = k / (FIN_CHORD_SAMPLES - 1); // 0 = leading, 1 = trailing
      const along = uLead + (uTrail - uLead) * p;
      const th = maxThickness * taper * foilThicknessAcross(p);
      oRow.push(pushVert(positions, place(along, v, outerFrac * th)));
      iRow.push(pushVert(positions, place(along, v, innerFrac * th)));
    }
    outer.push(oRow);
    inner.push(iRow);
  }

  // Stitch the two skins (outer outward, inner reversed). Coincident leading/trailing
  // edge verts (thickness → 0) auto-close the seam, the collapsed tip caps the top.
  for (let j = 0; j < FIN_DEPTH_LEVELS - 1; j++) {
    for (let k = 0; k < FIN_CHORD_SAMPLES - 1; k++) {
      const o = outer;
      const n = inner;
      indices.push(o[j]![k]!, o[j]![k + 1]!, o[j + 1]![k + 1]!);
      indices.push(o[j]![k]!, o[j + 1]![k + 1]!, o[j + 1]![k]!);
      indices.push(n[j]![k]!, n[j + 1]![k + 1]!, n[j]![k + 1]!);
      indices.push(n[j]![k]!, n[j + 1]![k]!, n[j + 1]![k + 1]!);
    }
  }
  // Cap the base (j = 0) so the solid is closed: a strip between the outer and inner rows.
  for (let k = 0; k < FIN_CHORD_SAMPLES - 1; k++) {
    indices.push(outer[0]![k]!, inner[0]![k]!, inner[0]![k + 1]!);
    indices.push(outer[0]![k]!, inner[0]![k + 1]!, outer[0]![k + 1]!);
  }

  return finalizeMesh(positions, indices);
};

const maxDepth = (template: readonly Vec2[]): number => {
  let m = 0;
  for (const p of template) if (p.y > m) m = p.y;
  return m;
};

// --- small mesh / vec helpers (kept local; kernel Vec2 is 2D) ---------------

const sub2 = (a: Vec2, b: Vec2): Vec2 => vec2(a.x - b.x, a.y - b.y);
const unit = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? vec2(1, 0) : vec2(a.x / l, a.y / l);
};

const pushVert = (positions: number[], v: [number, number, number]): number => {
  const idx = positions.length / 3;
  positions.push(v[0], v[1], v[2]);
  return idx;
};

/** Compute area-weighted vertex normals and return a {@link BoardMesh}. */
const finalizeMesh = (positions: number[], indices: number[]): BoardMesh => {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;
    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const az = positions[ia * 3 + 2]!;
    const e1x = positions[ib * 3]! - ax;
    const e1y = positions[ib * 3 + 1]! - ay;
    const e1z = positions[ib * 3 + 2]! - az;
    const e2x = positions[ic * 3]! - ax;
    const e2y = positions[ic * 3 + 1]! - ay;
    const e2z = positions[ic * 3 + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const vi of [ia, ib, ic]) {
      normals[vi * 3] = normals[vi * 3]! + nx;
      normals[vi * 3 + 1] = normals[vi * 3 + 1]! + ny;
      normals[vi * 3 + 2] = normals[vi * 3 + 2]! + nz;
    }
  }
  for (let v = 0; v < positions.length / 3; v++) {
    const len = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    if (len > 1e-9) {
      normals[v * 3] = normals[v * 3]! / len;
      normals[v * 3 + 1] = normals[v * 3 + 1]! / len;
      normals[v * 3 + 2] = normals[v * 3 + 2]! / len;
    } else {
      normals[v * 3 + 2] = 1;
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
  };
};
