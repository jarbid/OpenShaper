// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo } from 'react';
import { DoubleSide, ShaderMaterial, Vector3 } from 'three';
import { DIVERGING_RAMP, NO_DATA_STRIPES, hexToRgb } from './analysis-palette';
import type { DeviationMesh } from './deviation-mesh';
import { boardCenter, deviationGeometry } from './geometry';
import { RAMP_GLSL, rampUniforms } from './ramp-shader';

/**
 * `aDeviation` is (signed distance in cm, 1 where measured / 0 where not). The ramp
 * position is 0.5 + 0.5·d/band, clamped: the middle of the diverging ramp is "no
 * difference", and anything past ±band saturates to its end colour.
 */
const VERT = /* glsl */ `
  attribute vec2 aDeviation;
  uniform float uBand;
  varying float vT;
  varying float vData;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vT = 0.5 + 0.5 * clamp(aDeviation.x / uBand, -1.0, 1.0);
    vData = aDeviation.y;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/**
 * The ramp, lightly shaded by facing like the curvature surface, and diagonal
 * stripes where there is no data. A triangle between a measured vertex and one
 * that is not splits halfway, so the edge of the ghost's length reads as a line.
 */
const FRAG = /* glsl */ `
  precision highp float;
  ${RAMP_GLSL}
  uniform vec3 uNoData[2];
  varying float vT;
  varying float vData;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
    vec3 c;
    if (vData < 0.5) {
      float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 14.0));
      c = mix(uNoData[0], uNoData[1], stripe);
    } else {
      c = ramp(vT);
    }
    gl_FragColor = vec4(c * (0.6 + 0.4 * facing), 1.0);
  }
`;

/** Shader uniforms for a band (cm). Exported for the tests. */
export const deviationUniforms = (band: number) => ({
  // A zero band would divide by zero; anything this small is all saturated anyway.
  uBand: { value: Math.max(1e-6, band) },
  uNoData: { value: NO_DATA_STRIPES.map((hex) => new Vector3(...hexToRgb(hex))) },
  ...rampUniforms(DIVERGING_RAMP),
});

/**
 * The board painted by its deviation from the ghost, on the deviation job's own
 * mesh: the hull's, for the board it was computed for. Centred on that mesh's own
 * bounding box, exactly as the hull would be.
 */
export function DeviationSurface({ mesh, band }: { mesh: DeviationMesh; band: number }) {
  const geometry = useMemo(() => deviationGeometry(mesh), [mesh]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const [cx, cy, cz] = useMemo(() => boardCenter(mesh), [mesh]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: deviationUniforms(band),
        side: DoubleSide,
      }),
    [band],
  );
  useEffect(() => () => material.dispose(), [material]);

  return (
    <group position={[-cx, -cy, -cz]}>
      <mesh geometry={geometry} material={material} />
    </group>
  );
}
