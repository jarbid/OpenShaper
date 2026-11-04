// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Native fin document (`.fin.json`): a versioned, lossless serialization of a kernel
 * `FinDesign` (docs/design/fin-designer.md, step 8).
 *
 * Lengths are millimetres, as the fin designer shows them; the kernel works in cm and
 * this module converts both ways. Curves keep their frames:
 *   - `outline`: the blade's side profile in the tab frame, mm.
 *   - `section`: the two foil faces, x and y in chords (unitless). `inside: null` is a
 *     symmetric foil.
 *   - `taper`: x = height as a fraction of the depth (unitless), y = thickness in mm.
 * A design is saved as it is, valid or not: someone may save half-way through an
 * edit. The reader checks the file's structure, not the fin's rules.
 *
 * Handle-lock directions are unit vectors in the design's own frame (for the taper,
 * height fraction × cm), not rescaled to mm; see `scaleSpline`.
 *
 * Version history:
 *   1 — position, hand, cant, lateral offset, outline, section, taper, metadata.
 *   2 — adds `slices` (foils at other heights) and `base` (the tab: Futures 3/4",
 *       Futures 1/2" or FCS single). Written only when a fin has slices or a base other
 *       than its position's default; read as absent, version 1 means no slices and the
 *       default base. Also `toe` (deg, + toe in): absent means 0. Also `panel`: the
 *       panel it's cut from, `{ thickness (mm), angle (deg), tilt? (deg) }`; absent
 *       means none set, and an absent tilt means 0.
 *   3 — the swept loft (swept-loft.ts): the same fields, read the same way, but the
 *       blade is foiled along sections swept from the base to a tip line, so an older
 *       file comes out a little differently. Adds `tipLine` (`{ start, end }`, fractions
 *       of the outline's length), `tipSection` (the tip foil, as `section`) and
 *       `thicknessMid` (where the sweep's middle section is thickest), absent for the
 *       defaults. A slice's `transition` is gone: read and dropped. So is `tipScale` (the
 *       tip foil's thickness against the thickness curve's, set by an editor that no
 *       longer does): the thickness curve alone sets the thickness.
 *       Always written as version 3.
 */
import {
  FIN_BASES,
  FIN_POSITIONS,
  defaultFinBase,
  knot,
  splineFromKnots,
  vec2,
  type FinBase,
  type FinDesign,
  type FinHand,
  type FinPosition,
  type FinSection,
  type Knot,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { assertKnots, isObject, splineFromJson, splineToJson, type KnotJson } from './knot-json';

/** Newest version this reads and writes (see the history above). */
export const FIN_JSON_VERSION = 3;
export const FIN_JSON_FORMAT = 'openshaper-fin';

interface SectionJson {
  outside: KnotJson[];
  inside: KnotJson[] | null;
}

const sectionToJson = (s: FinSection): SectionJson => ({
  outside: splineToJson(s.outside),
  inside: s.inside ? splineToJson(s.inside) : null,
});

const sectionFromJson = (s: SectionJson): FinSection => ({
  outside: splineFromJson(s.outside),
  inside: s.inside ? splineFromJson(s.inside) : null,
});

export interface FinJson {
  format: typeof FIN_JSON_FORMAT;
  version: number;
  units: 'mm';
  position: FinPosition;
  hand: FinHand | null;
  /** Blade lean from the tab, degrees. */
  cant: number;
  /** Blade's sideways offset on the tab, mm, + outboard. */
  lateralOffset: number;
  outline: KnotJson[];
  section: SectionJson;
  /** Version 2: toe correction, deg, + toe in. Absent means 0. */
  toe?: number;
  /** Version 3: where the foil sweep ends (fractions of the outline). Absent: the default. */
  tipLine?: { start: number; end: number };
  /** Version 3: the foil at the tip line. Absent: the base foil (`section`) all the way. */
  tipSection?: SectionJson;
  /** Version 3: where the sweep's middle section is thickest. Absent: halfway along the path. */
  thicknessMid?: number;
  /** Version 3, no longer used: the tip foil's thickness against the curve's. Dropped. */
  tipScale?: unknown;
  /** Version 2: the panel it's cut from (thickness in mm, angle and tilt in deg). Absent: none. */
  panel?: { thickness: number; angle: number; tilt?: number };
  /** Version 2: the tab. Absent means the position's default Futures tab. */
  base?: FinBase;
  /** Version 2: foils at other heights, lowest first; height is a fraction of the depth. */
  slices?: {
    height: number;
    section: SectionJson;
    /**
     * A cant and toe change at the slice (deg). Version 2 also had `transition` (how far
     * below the slice it eased in): read and dropped, it eases over the whole span now.
     */
    twist?: { cant: number; toe: number; transition?: number };
  }[];
  taper: KnotJson[];
  metadata?: Record<string, unknown>;
}

export class FinJsonError extends Error {}

const MM_PER_CM = 10;

/**
 * Every point of a spline mapped through linear scalings `fx`, `fy` (×10 to write mm,
 * ÷10 to read them back: dividing rather than multiplying by 0.1 keeps the round trip
 * exact in practice). A locked handle's direction is kept as it is, in the design's
 * own frame: renormalising it after unequal scaling (the taper's) drifts by an ulp on
 * every save, and autosave would then rewrite the file forever. The outline scales
 * equally, where a direction doesn't change anyway.
 */
const scaleSpline = (s: Spline, fx: (n: number) => number, fy: (n: number) => number): Spline => {
  const p = (v: Vec2) => vec2(fx(v.x), fy(v.y));
  return splineFromKnots(
    s.knots.map(
      (k): Knot =>
        knot(p(k.end), p(k.tangentToPrev), p(k.tangentToNext), k.continuous, k.other, k.lock),
    ),
  );
};

const toMm = (n: number) => n * MM_PER_CM;
const toCm = (n: number) => n / MM_PER_CM;
const same = (n: number) => n;

/** Serialize a fin design to a `.fin.json` string. */
export const writeFinJson = (d: FinDesign, metadata?: Record<string, unknown>): string => {
  const doc: FinJson = {
    format: FIN_JSON_FORMAT,
    version: FIN_JSON_VERSION,
    units: 'mm',
    position: d.position,
    hand: d.hand,
    cant: d.cant,
    lateralOffset: toMm(d.lateralOffset),
    ...(d.base !== defaultFinBase(d.position) ? { base: d.base } : {}),
    ...(d.toe ? { toe: d.toe } : {}),
    ...(d.tipLine ? { tipLine: { start: d.tipLine.start, end: d.tipLine.end } } : {}),
    ...(d.tipSection ? { tipSection: sectionToJson(d.tipSection) } : {}),
    ...(d.thicknessMid !== undefined ? { thicknessMid: d.thicknessMid } : {}),
    ...(d.panel
      ? {
          panel: {
            thickness: toMm(d.panel.thickness),
            angle: d.panel.angle,
            ...(d.panel.tilt ? { tilt: d.panel.tilt } : {}),
          },
        }
      : {}),
    outline: splineToJson(scaleSpline(d.outline, toMm, toMm)),
    section: sectionToJson(d.section),
    ...(d.slices.length
      ? {
          slices: d.slices.map((sl) => ({
            height: sl.height,
            section: sectionToJson(sl.section),
            ...(sl.twist ? { twist: { ...sl.twist } } : {}),
          })),
        }
      : {}),
    taper: splineToJson(scaleSpline(d.taper, same, toMm)),
    ...(metadata ? { metadata } : {}),
  };
  return JSON.stringify(doc, null, 2);
};

const fail = (message: string): never => {
  throw new FinJsonError(message);
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A curve needs two points to be a curve at all. */
const assertCurve = (v: unknown, where: string): void => {
  assertKnots(v, where, FinJsonError);
  if ((v as unknown[]).length < 2) fail(`Malformed fin: ${where} needs at least two points`);
};

const assertStructure = (doc: Record<string, unknown>): void => {
  if (!(FIN_POSITIONS as readonly unknown[]).includes(doc.position)) {
    fail('Malformed fin: unknown position');
  }
  if (doc.hand !== null && doc.hand !== 'left' && doc.hand !== 'right') {
    fail('Malformed fin: hand must be left, right or null');
  }
  if (!isNumber(doc.cant)) fail('Malformed fin: cant is not a number');
  if (doc.toe !== undefined && !isNumber(doc.toe)) fail('Malformed fin: toe is not a number');
  const panel = doc.panel;
  if (
    panel !== undefined &&
    (!isObject(panel) ||
      !isNumber(panel.thickness) ||
      !isNumber(panel.angle) ||
      (panel.tilt !== undefined && !isNumber(panel.tilt)))
  ) {
    fail('Malformed fin: panel needs a thickness and an angle');
  }
  const tip = doc.tipLine;
  if (tip !== undefined && (!isObject(tip) || !isNumber(tip.start) || !isNumber(tip.end))) {
    fail('Malformed fin: the tip line needs a start and an end');
  }
  if (doc.thicknessMid !== undefined && !isNumber(doc.thicknessMid)) {
    fail('Malformed fin: the thickness path needs a number for its middle');
  }
  if (doc.tipSection !== undefined) assertSection(doc.tipSection, 'tip section');
  if (doc.base !== undefined && !(FIN_BASES as readonly unknown[]).includes(doc.base)) {
    fail('Malformed fin: unknown base');
  }
  if (!isNumber(doc.lateralOffset)) fail('Malformed fin: lateralOffset is not a number');
  if (doc.units !== 'mm') fail('Malformed fin: units must be mm');
  assertCurve(doc.outline, 'outline');
  assertCurve(doc.taper, 'taper');
  assertSection(doc.section, 'section');
  if (doc.slices !== undefined) {
    if (!Array.isArray(doc.slices)) fail('Malformed fin: slices is not a list');
    (doc.slices as unknown[]).forEach((sl, i) => {
      if (!isObject(sl) || !isNumber(sl.height))
        fail(`Malformed fin: slice ${i + 1} has no height`);
      assertSection((sl as Record<string, unknown>).section, `slice ${i + 1}`);
      const tw = (sl as Record<string, unknown>).twist;
      if (tw !== undefined && (!isObject(tw) || !isNumber(tw.cant) || !isNumber(tw.toe))) {
        fail(`Malformed fin: slice ${i + 1} has a damaged cant / toe change`);
      }
    });
  }
};

const assertSection = (section: unknown, where: string): void => {
  if (!isObject(section)) return fail(`Malformed fin: ${where} is missing`);
  assertCurve(section.outside, `${where} outside face`);
  if (section.inside !== null) assertCurve(section.inside, `${where} inside face`);
};

/** Parse a `.fin.json` string back into a fin design (+ any metadata). */
export const readFinJson = (
  text: string,
): { design: FinDesign; metadata?: Record<string, unknown> } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return fail(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed) || parsed.format !== FIN_JSON_FORMAT) {
    return fail('Not an OpenShaper fin (missing format marker)');
  }
  if (!isNumber(parsed.version) || parsed.version > FIN_JSON_VERSION) {
    return fail(
      `Fin version ${String(parsed.version)} is newer than supported (${FIN_JSON_VERSION})`,
    );
  }
  assertStructure(parsed);
  const doc = parsed as unknown as FinJson;
  const design: FinDesign = {
    position: doc.position,
    hand: doc.hand,
    cant: doc.cant,
    base: doc.base ?? defaultFinBase(doc.position),
    toe: doc.toe ?? 0,
    lateralOffset: toCm(doc.lateralOffset),
    outline: scaleSpline(splineFromJson(doc.outline), toCm, toCm),
    section: sectionFromJson(doc.section),
    slices: (doc.slices ?? []).map((sl) => ({
      height: sl.height,
      section: sectionFromJson(sl.section),
      ...(sl.twist ? { twist: { cant: sl.twist.cant, toe: sl.twist.toe } } : {}),
    })),
    taper: scaleSpline(splineFromJson(doc.taper), same, toCm),
    ...(doc.tipLine ? { tipLine: { start: doc.tipLine.start, end: doc.tipLine.end } } : {}),
    ...(doc.tipSection ? { tipSection: sectionFromJson(doc.tipSection) } : {}),
    ...(doc.thicknessMid !== undefined ? { thicknessMid: doc.thicknessMid } : {}),
    ...(doc.panel
      ? {
          panel: {
            thickness: toCm(doc.panel.thickness),
            angle: doc.panel.angle,
            ...(doc.panel.tilt ? { tilt: doc.panel.tilt } : {}),
          },
        }
      : {}),
  };
  return doc.metadata ? { design, metadata: doc.metadata } : { design };
};
