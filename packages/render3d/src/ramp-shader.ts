// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The colour ramp as a fragment-shader function, shared by the surfaces that paint
 * an analysis (curvature, deviation) so the GPU and the legend read the same stops
 * (`analysis-palette.ts`) the same way.
 */
import { Vector3 } from 'three';
import { hexToRgb } from './analysis-palette';

/** The longest ramp the shader takes. */
export const MAX_RAMP_STOPS = 7;

/**
 * `uStops` / `uCount` and `vec3 ramp(float t)`: the ramp at `t` in [0, 1], its
 * stops evenly spaced, clamped at both ends. Interpolating a ramp position between
 * vertices rather than a colour keeps the ramp's own stops in between.
 */
export const RAMP_GLSL = /* glsl */ `
  uniform vec3 uStops[${MAX_RAMP_STOPS}];
  uniform int uCount;

  vec3 ramp(float t) {
    float x = clamp(t, 0.0, 1.0) * float(uCount - 1);
    vec3 c = uStops[0];
    for (int i = 0; i < ${MAX_RAMP_STOPS - 1}; i++) {
      if (i >= uCount - 1) break;
      c = mix(c, uStops[i + 1], clamp(x - float(i), 0.0, 1.0));
    }
    return c;
  }
`;

/** The uniforms {@link RAMP_GLSL} reads, for a ramp of `#rrggbb` stops, low to high. */
export const rampUniforms = (ramp: readonly string[]) => ({
  // Padded with the last stop: the array uniform is always full length.
  uStops: {
    value: Array.from({ length: MAX_RAMP_STOPS }, (_, i) => {
      const [r, g, b] = hexToRgb(ramp[Math.min(i, ramp.length - 1)]!);
      return new Vector3(r, g, b);
    }),
  },
  uCount: { value: ramp.length },
});
