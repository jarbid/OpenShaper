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
  readonly loops: readonly Loop[];
  readonly labels?: readonly Label[];
}

export interface TemplateSheet {
  readonly parts: readonly Part[];
  /** Source units of all coordinates. Always 'cm' (kernel unit). */
  readonly units: 'cm';
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
  /** Extra perimeter inset of ribs beyond the skin (room for rail build-up). */
  railInset: number;
  /** Keep ribs at least this far from the nose/tail tips. */
  endMargin: number;

  // --- Joinery ---
  /** Fit clearance added to slot width (material + fit). */
  slotFit: number;
  /** Fraction of the local internal height the stringer slot takes from the top (rest is the rib slot). */
  halfLapFraction: number;

  // --- Lightening ---
  lighteningHoles: boolean;
  /** Web left around a rib's perimeter when lightening holes are on. */
  webMargin: number;

  // --- Parts to emit ---
  includeStringer: boolean;
  includeRibs: boolean;
  includeDeckSkin: boolean;
  includeBottomSkin: boolean;

  // --- Output / cutting ---
  /** Tool-diameter kerf compensation; cut loops grow by kerf/2. Default 0 (let CAM do it). */
  kerf: number;
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
  railInset: 0,
  endMargin: 8,
  slotFit: 0.01, // 0.1 mm
  halfLapFraction: 0.5,
  lighteningHoles: false,
  webMargin: 2.5,
  includeStringer: true,
  includeRibs: true,
  includeDeckSkin: true,
  includeBottomSkin: true,
  kerf: 0,
  skinOverhang: 1,
  sampleTolerance: 0.02, // 0.2 mm chord deviation
};
