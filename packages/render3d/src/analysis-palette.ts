// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Colour ramps for the exact curvature analysis, shared by the shader that paints
 * the hull and the legend that explains it (the legend gets these through
 * `AnalysisStatus`, so the two cannot disagree).
 *
 * - **Diverging** (mean and Gaussian curvature): two hues that read as opposites,
 *   blue for negative (concave / saddle) and red for positive (convex / dome),
 *   meeting at a neutral grey that means "flat". Lightness falls symmetrically
 *   away from the middle, so the strength of a colour reads as magnitude in both
 *   directions and the zero crossing stays visible to colour-blind readers.
 * - **Sequential** (rail radius): one hue, light to dark. Dark is the tight end —
 *   a hard rail edge — so what matters most is what stands out most against the
 *   pale, nearly flat deck and bottom.
 *
 * Plain hex, low to high, in sRGB. The shader writes them straight to the screen
 * (no tone mapping, no colour-space conversion), so the legend's CSS gradient is
 * the same colour.
 */

/** Concave … flat … convex. Seven stops, the middle one neutral. */
export const DIVERGING_RAMP: readonly string[] = [
  '#184f95',
  '#3987e5',
  '#9ec5f4',
  '#dcdcd8',
  '#f4b3a6',
  '#e34948',
  '#9b1c1f',
];

/** Tight (a hard rail) … flat. Five stops of one hue, dark to light. */
export const SEQUENTIAL_RAMP: readonly string[] = [
  '#5c1d06',
  '#a83a12',
  '#eb6834',
  '#f6b183',
  '#fbe6d6',
];

/** A `#rrggbb` colour as linear-in-the-shader 0..1 components (no gamma applied). */
export const hexToRgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
};
