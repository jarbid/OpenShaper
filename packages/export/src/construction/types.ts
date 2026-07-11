// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Abstract construction-template model.
 *
 * A {@link TemplateSheet} is the format-neutral result of a template builder (e.g.
 * {@link buildHwsTemplates}): a list of named {@link Part}s, each a set of
 * {@link Loop}s tagged by purpose (`cut` / `cutInner` / `mark`). The DXF / SVG / PDF
 * writers render the same sheet three ways — geometry is defined once.
 *
 * All coordinates are in **centimetres** (the kernel's unit). Writers convert at the
 * boundary (SVG → mm, PDF → points). Each part is built in its own local frame,
 * roughly centred on the origin; the row-layout helper in `geom.ts` arranges parts
 * for the multi-part formats (DXF/SVG), while PDF places one part per page.
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** What a loop represents on the machine: a through-cut, an inner cut-out, or a non-cutting mark. */
export type LoopKind = 'cut' | 'cutInner' | 'mark';

export interface Loop {
  readonly kind: LoopKind;
  /** Whether the polyline is a closed contour. `mark` loops are usually open. */
  readonly closed: boolean;
  readonly pts: readonly Pt[];
  /** Render hint for `mark` loops (registration / station lines). */
  readonly dashed?: boolean;
}

/** An engraved/printed text label (mark layer). */
export interface Label {
  readonly text: string;
  readonly at: Pt;
  /** Text height in cm. */
  readonly height: number;
}

export interface Part {
  readonly id: string;
  readonly label: string;
  /** Longitudinal board position (cm) this part belongs to (ribs) — the UI formats it per the active display unit. */
  readonly station?: number;
  readonly loops: readonly Loop[];
  readonly labels?: readonly Label[];
}

/**
 * A non-fatal problem the builder worked around: a part it skipped, a joint it
 * couldn't cut, lightening that didn't fit. Surfaced to the UI as a notice —
 * the writers ignore warnings entirely.
 */
export interface TemplateWarning {
  /** Stable machine code, e.g. `rib-skipped`, `lightening-dropped`. */
  readonly code: string;
  /** Human-readable explanation. Lengths are quoted in cm; the UI may reformat. */
  readonly message: string;
  /** Id of the affected part, when one exists (it may have been skipped entirely). */
  readonly partId?: string;
}

export interface TemplateSheet {
  readonly parts: readonly Part[];
  /** Source units of all coordinates. Always 'cm' (kernel unit). */
  readonly units: 'cm';
  /** Non-fatal build problems (omitted when the build was clean). */
  readonly warnings?: readonly TemplateWarning[];
  readonly meta?: {
    readonly title?: string;
    readonly generator?: string;
    /** One-line annotation (board dims + file units) printed on the sheet. */
    readonly note?: string;
  };
}

/** How rib stations are chosen along the board. */
export type RibMode = 'crossSections' | 'evenCount' | 'spacing';

/**
 * How a rib is lightened. `none` = solid, `pocket` = one filleted cut-out,
 * `circles` = a row of holes, `truss` = a Warren truss (alternating diagonal
 * webs forming triangular pockets between an outer rim).
 */
export type LighteningStyle = 'none' | 'pocket' | 'circles' | 'truss';

/** Rail lamination orientation for the rail-band template. */
export type RailLamination = 'vertical' | 'horizontal';

/** Rib↔rail-band joint style. */
export type RailJoint = 'butt' | 'tabSlot';

/**
 * Parameters for the Hollow-Wood-Surfboard (HWS) internal-frame template builder.
 * All lengths in **centimetres** (the UI converts from mm at its boundary).
 */
export interface HwsParams {
  // --- Material ---
  /** Frame ply thickness — drives slot width. */
  materialThickness: number;
  /** Deck/bottom skin thickness — the frame is inset this far from the board surface. */
  skinThickness: number;

  // --- Ribs ---
  ribMode: RibMode;
  /** Number of ribs for `evenCount`. */
  ribCount: number;
  /** Spacing between ribs (cm) for `spacing`. */
  ribSpacing: number;
  /** Keep ribs at least this far from the nose/tail tips. */
  endMargin: number;

  // --- Rail band (laminated rail build-up) ---
  /**
   * Vertical lamination: number of strips laminated per side. The band's plan
   * offset from the outline is `railStripThickness × railLaminations` (the
   * stock thickness times the layer count — see {@link railOffset}). 0 disables
   * the rail band in vertical mode.
   */
  railLaminations: number;
  /**
   * Horizontal lamination: plan width of the band (cm), inward from the outline.
   * Set directly — unlike vertical strips, horizontal layers stack UP the rail,
   * so their count follows from the rail height, not from this width. 0 disables
   * the rail band in horizontal mode.
   */
  railBandWidth: number;
  /** Stop the rail band this far from the tail (room for a tail block). */
  railTailTrim: number;
  /** Stop the rail band this far from the nose (room for a nose block). */
  railNoseTrim: number;
  /**
   * Vertical lamination only: flattened strip (default) — the strip follows the
   * rocker as it bends, template height ≈ board thickness, unrolled along the 3D
   * mid-curve. Off = exact vertical-ribbon development (plan arc length; rocker
   * appears as wavy edges, needing wider stock).
   */
  railFlatten: boolean;
  /**
   * Rail lamination orientation: `vertical` strips stand on edge bent around the
   * outline; `horizontal` layers lie flat, stacked from the bottom skin up, bent
   * over the rocker.
   */
  railLamination: RailLamination;
  /**
   * Rib↔rail joint: `butt` = flat faces with reference marks on the template;
   * `tabSlot` = each rib carries a locating tab that keys the FIRST lamination
   * layer (the template sheet then holds a slotted layer-1 part + a plain part
   * for the remaining layers).
   */
  railJoint: RailJoint;
  /**
   * Material thickness of one lamination layer of rail stock (cm). Vertical
   * mode: multiplies `railLaminations` into the band offset. Both modes: the
   * rib tab protrusion / layer-1 notch depth.
   */
  railStripThickness: number;

  // --- Joinery ---
  /** Fit clearance added to slot width (material + fit). */
  slotFit: number;
  /** Fraction of the local internal height the stringer slot takes from the top (rest is the rib slot). */
  halfLapFraction: number;

  // --- Lightening ---
  /** Lightening pattern for the ribs. */
  lighteningStyle: LighteningStyle;
  /** Web (cm) left around every rib cut edge — rails AND the stringer slot. */
  webMargin: number;
  /** Internal fillet radius (cm) for the `pocket` style; avoids re-entrant 90° corners that crack ply. */
  pocketCornerRadius: number;
  /** Hole diameter (cm) for the `circles` style. */
  holeDiameter: number;
  /** Centre-to-centre spacing (cm) for the `circles` style. */
  holeSpacing: number;
  /** Also apply the lightening style to the stringer spine (default: ribs only). */
  lightenStringer: boolean;
  /** Strut width (cm) of the internal `truss` webs (distinct from the perimeter `webMargin` rim). */
  webThickness: number;
  /** Diagonal lean of the `truss` webs, in degrees: 0 = vertical posts, 45 = 45°. */
  trussAngle: number;
  /** Target bay pitch (cm) for the `truss`; the actual pitch is rounded so bays divide each rib's width evenly. */
  trussSpacing: number;

  // --- Parts to emit ---
  includeStringer: boolean;
  includeRibs: boolean;
  includeDeckSkin: boolean;
  includeBottomSkin: boolean;
  /** Emit the rail-band template(s) (needs `railOffset(p) > 0`). */
  includeRailTemplate: boolean;

  // --- Output ---
  /** Extra material around the skin planshape. */
  skinOverhang: number;
  /** Adaptive sampling tolerance (cm): max chord deviation. Smaller = smoother. */
  sampleTolerance: number;
}

export const DEFAULT_HWS_PARAMS: HwsParams = {
  materialThickness: 0.6, // 6 mm ply
  skinThickness: 0.4, // 4 mm skin
  ribMode: 'crossSections',
  ribCount: 12,
  ribSpacing: 15,
  endMargin: 8,
  railLaminations: 0, // 0 = no rail band (vertical mode)
  railBandWidth: 0, // 0 = no rail band (horizontal mode)
  railTailTrim: 3.5, // legacy BoardCAD default
  railNoseTrim: 3.5,
  railFlatten: true,
  railLamination: 'vertical',
  railJoint: 'butt',
  railStripThickness: 0.6, // 6 mm strips
  slotFit: 0.01, // 0.1 mm
  halfLapFraction: 0.5,
  lighteningStyle: 'none',
  webMargin: 1.5, // 15 mm rim
  pocketCornerRadius: 0.3, // 3 mm fillet
  holeDiameter: 3, // 30 mm
  holeSpacing: 5, // 50 mm centre-to-centre
  lightenStringer: false,
  webThickness: 1.2, // 12 mm truss struts
  trussAngle: 45, // 45° diagonals
  trussSpacing: 8, // 80 mm target bay pitch
  includeStringer: true,
  includeRibs: true,
  includeDeckSkin: true,
  includeBottomSkin: true,
  includeRailTemplate: true,
  skinOverhang: 1,
  sampleTolerance: 0.02, // 0.2 mm chord deviation
};

/**
 * Effective plan offset (cm) of the rail band's inner face from the outline.
 * Vertical lamination: the stack builds inward strip by strip, so the offset is
 * `stock thickness × layer count`. Horizontal lamination: layers stack UP the
 * rail, so the plan width is set directly. 0 = rail band disabled.
 */
export const railOffset = (p: HwsParams): number =>
  p.railLamination === 'vertical'
    ? Math.max(0, p.railStripThickness) * Math.max(0, Math.round(p.railLaminations))
    : Math.max(0, p.railBandWidth);
