// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The foil view's analysis (owner request): the fin's other sections drawn faintly behind
 * the foil being edited, to compare them. Each is the blade cut as it really is, seen from
 * above (plan: x along the tab, y across it, cant and toe included), then placed in the
 * active foil's frame:
 *
 * - **Tab**: as they sit on the tab, like the 3D view's horizontal cuts, so lean and toe
 *   show;
 * - **Front**, **Rear**, **Thickest point**: each in its own chord's frame, lined up with
 *   the active foil at its leading edge, its trailing edge or its thickest point.
 *
 * What is shown: the base and tip foils and every control section, each as it lies (the
 * tip foil along the tip line, so a steep tip line is seen nearly edge-on, a line); or
 * horizontal cuts every so many millimetres.
 *
 * Points come back in the active foil's chord units (its chord 1 long, leading edge at
 * the origin, + toward the outside face), true to scale: the pane divides y by its own
 * true-scale stretch.
 */
import {
  bladeSection,
  chordAt,
  cosineStations,
  finReadouts,
  prepareBlade,
  sweepGrid,
  sweepSectionLine,
  vec2,
  type FinDesign,
  type PreparedBlade,
  type Vec2,
} from '@openshaper/kernel';
import { TIP_FOIL } from '@openshaper/store';

/** How the other sections line up with the active foil. */
export type FoilAlign = 'thickest' | 'front' | 'rear' | 'tab';

/** Which sections to show. */
export type FoilShow = 'sections' | 'every';

export interface FoilAnalysis {
  readonly on: boolean;
  readonly align: FoilAlign;
  readonly show: FoilShow;
  /** The spacing of the cuts for `every` (cm). */
  readonly every: number;
}

export const FOIL_ANALYSIS_DEFAULT: FoilAnalysis = {
  on: false,
  align: 'thickest',
  show: 'sections',
  every: 1,
};

/** The spacing's range (cm): 2 mm to 50 mm. */
export const FOIL_ANALYSIS_EVERY = { min: 0.2, max: 5 } as const;

/** A section of the blade, seen from above (cm, fin frame), and where it is. */
interface PlanSection {
  readonly kind: 'base' | 'tip' | 'control' | 'cut';
  /** Its height above the tab top (cm), the tip foil's its mean. */
  readonly height: number;
  readonly outside: readonly Vec2[];
  readonly inside: readonly Vec2[];
}

/** One section to draw: a closed outline in the active foil's chord units. */
export interface FoilGhost {
  readonly kind: PlanSection['kind'];
  readonly height: number;
  /** How high it is, 0 at the base and 1 at the tip: the stack order. */
  readonly level: number;
  /** Outside face from the leading edge, then the inside face back to it. */
  readonly outline: readonly Vec2[];
}

const STATIONS = cosineStations(40);

const plan = (s: ReturnType<typeof bladeSection>): Pick<PlanSection, 'outside' | 'inside'> => ({
  outside: s.outside.map((p) => vec2(p.x, p.y)),
  inside: s.inside.map((p) => vec2(p.x, p.y)),
});

const horizontal = (b: PreparedBlade, kind: PlanSection['kind'], h: number): PlanSection => ({
  kind,
  height: h,
  ...plan(bladeSection(b, h, STATIONS)),
});

/**
 * The tip foil as it lies: the blade sampled along the tip line, each point cut from the
 * horizontal section through it.
 */
const tipSection = (d: FinDesign, b: PreparedBlade): PlanSection => {
  const g = sweepGrid(d);
  const line = sweepSectionLine(g, g.tipRow);
  const outside: Vec2[] = [];
  const inside: Vec2[] = [];
  let sum = 0;
  for (const p of line) {
    const h = Math.min(b.depth, Math.max(0, p.y));
    const { leading, trailing } = chordAt(b, h);
    const u = trailing === leading ? 0 : (p.x - leading) / (trailing - leading);
    const s = bladeSection(b, h, [Math.min(1, Math.max(0, u))]);
    outside.push(vec2(s.outside[0]!.x, s.outside[0]!.y));
    inside.push(vec2(s.inside[0]!.x, s.inside[0]!.y));
    sum += h;
  }
  return { kind: 'tip', height: sum / Math.max(1, line.length), outside, inside };
};

/** A section's own frame: its chord from the leading edge, + toward the outside face. */
interface Frame {
  readonly le: Vec2;
  readonly dir: Vec2;
  readonly normal: Vec2;
  readonly chord: number;
  /** Its thickest point in its own frame (cm). */
  readonly thickest: Vec2;
}

const mid = (a: Vec2, b: Vec2) => vec2((a.x + b.x) / 2, (a.y + b.y) / 2);

const frameOf = (s: PlanSection): Frame => {
  const n = s.outside.length - 1;
  const le = mid(s.outside[0]!, s.inside[0]!);
  const te = mid(s.outside[n]!, s.inside[n]!);
  const chord = Math.hypot(te.x - le.x, te.y - le.y) || 1;
  const dir = vec2((te.x - le.x) / chord, (te.y - le.y) / chord);
  let normal = vec2(-dir.y, dir.x);
  // + toward the outside face, whichever hand the fin is.
  let side = 0;
  s.outside.forEach((o, i) => {
    const q = s.inside[i]!;
    side += (o.x - q.x) * normal.x + (o.y - q.y) * normal.y;
  });
  if (side < 0) normal = vec2(-normal.x, -normal.y);
  const local = (p: Vec2) =>
    vec2(
      (p.x - le.x) * dir.x + (p.y - le.y) * dir.y,
      (p.x - le.x) * normal.x + (p.y - le.y) * normal.y,
    );
  let k = 0;
  let most = -Infinity;
  s.outside.forEach((o, i) => {
    const t = local(o).y - local(s.inside[i]!).y;
    if (t > most) {
      most = t;
      k = i;
    }
  });
  return { le, dir, normal, chord, thickest: local(mid(s.outside[k]!, s.inside[k]!)) };
};

const inFrame = (f: Frame, p: Vec2) =>
  vec2(
    (p.x - f.le.x) * f.dir.x + (p.y - f.le.y) * f.dir.y,
    (p.x - f.le.x) * f.normal.x + (p.y - f.le.y) * f.normal.y,
  );

/** The active foil's section: the base foil, the tip foil, or a control section's cut. */
const activeSection = (d: FinDesign, b: PreparedBlade, foil: number): PlanSection =>
  foil === TIP_FOIL
    ? tipSection(d, b)
    : foil > 0 && d.slices[foil - 1]
      ? horizontal(b, 'control', d.slices[foil - 1]!.height * b.depth)
      : horizontal(b, 'base', 0);

/**
 * The sections to draw behind foil `foil` (0 the base foil, {@link TIP_FOIL} the
 * tip foil, k the k-th control section), lowest first, so higher ones draw over them.
 */
export const foilGhosts = (d: FinDesign, foil: number, a: FoilAnalysis): FoilGhost[] => {
  const b = prepareBlade(d);
  const depth = finReadouts(d).depth || 1;
  const sections: PlanSection[] = [];
  if (a.show === 'sections') {
    if (foil !== 0) sections.push(horizontal(b, 'base', 0));
    d.slices.forEach((sl, i) => {
      if (foil !== i + 1) sections.push(horizontal(b, 'control', sl.height * b.depth));
    });
    if (foil !== TIP_FOIL) sections.push(tipSection(d, b));
  } else {
    const step = Math.min(FOIL_ANALYSIS_EVERY.max, Math.max(FOIL_ANALYSIS_EVERY.min, a.every));
    // Up to just short of the top, where the chord closes to a point.
    for (let h = 0; h < b.depth - step * 0.25; h += step) sections.push(horizontal(b, 'cut', h));
  }
  const active = frameOf(activeSection(d, b, foil));
  const A = active.chord;
  return sections
    .sort((p, q) => p.height - q.height)
    .map((s) => {
      const own = frameOf(s);
      const place = (p: Vec2): Vec2 => {
        if (a.align === 'tab') {
          const q = inFrame(active, p);
          return vec2(q.x / A, q.y / A);
        }
        const q = inFrame(own, p);
        const shift =
          a.align === 'front'
            ? vec2(0, 0)
            : a.align === 'rear'
              ? vec2(A - own.chord, 0)
              : vec2(active.thickest.x - own.thickest.x, active.thickest.y - own.thickest.y);
        return vec2((q.x + shift.x) / A, (q.y + shift.y) / A);
      };
      return {
        kind: s.kind,
        height: s.height,
        level: Math.min(1, Math.max(0, s.height / depth)),
        outline: [...s.outside.map(place), ...[...s.inside].reverse().map(place)],
      };
    });
};

/** Which ghost is under `p` (the active foil's chord units), within `tol`; -1 if none. */
export const ghostAt = (ghosts: readonly FoilGhost[], p: Vec2, tol: number): number => {
  let best = -1;
  let bestD = tol;
  ghosts.forEach((g, i) => {
    for (let k = 1; k < g.outline.length; k++) {
      const a = g.outline[k - 1]!;
      const c = g.outline[k]!;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
      );
      const d2 = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
  });
  return best;
};
