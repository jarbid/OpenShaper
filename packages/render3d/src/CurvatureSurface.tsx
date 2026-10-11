// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo } from 'react';
import { DoubleSide, MeshStandardMaterial, ShaderMaterial, Vector3 } from 'three';
import { hexToRgb } from './analysis-palette';
import { rampFor, type ExactAnalysisMode } from './analysis';
import type { CurvatureMesh, CurvatureScale } from './curvature-mesh';
import { curvatureGeometry } from './geometry';

/** The longest ramp the shader takes. */
const MAX_STOPS = 7;

/**
 * Each vertex carries all three quantities; `uMode` picks one and maps it to a
 * ramp position `t` in [0, 1]. Interpolating `t` rather than colour keeps the
 * ramp's own stops between vertices.
 *
 *  1 mean curvature:      0.5 + 0.5·H/limit, clamped (diverging, 0 at the middle)
 *  2 Gaussian curvature:  0.5 + 0.5·sign(K)·sqrt|K| / sqrt(limit), clamped
 *  3 rail radius:         log(r/lo) / log(hi/lo), clamped (tight = 0)
 */
const VERT = /* glsl */ `
  attribute float aMean;
  attribute float aGauss;
  attribute float aRadius;
  uniform int uMode;
  uniform float uLimit;
  uniform float uLo;
  uniform float uHi;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float t;
    if (uMode == 1) {
      t = 0.5 + 0.5 * clamp(aMean / uLimit, -1.0, 1.0);
    } else if (uMode == 2) {
      t = 0.5 + 0.5 * clamp(sign(aGauss) * sqrt(abs(aGauss)) / uLimit, -1.0, 1.0);
    } else {
      t = clamp(log(aRadius / uLo) / log(uHi / uLo), 0.0, 1.0);
    }
    vT = t;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/**
 * The ramp, lightly shaded by how squarely the surface faces the viewer so the
 * form still reads. Written straight out — no tone mapping or colour-space
 * conversion — so a flat-on patch is the legend's colour.
 */
const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uStops[${MAX_STOPS}];
  uniform int uCount;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  vec3 ramp(float t) {
    float x = clamp(t, 0.0, 1.0) * float(uCount - 1);
    vec3 c = uStops[0];
    for (int i = 0; i < ${MAX_STOPS - 1}; i++) {
      if (i >= uCount - 1) break;
      c = mix(c, uStops[i + 1], clamp(x - float(i), 0.0, 1.0));
    }
    return c;
  }

  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
    gl_FragColor = vec4(ramp(vT) * (0.6 + 0.4 * facing), 1.0);
  }
`;

/** Shader uniforms for a mode and the result's scale. Exported for the tests. */
export const curvatureUniforms = (mode: ExactAnalysisMode, scale: CurvatureScale) => {
  const ramp = rampFor(mode);
  const stops = Array.from({ length: MAX_STOPS }, (_, i) => {
    const [r, g, b] = hexToRgb(ramp[Math.min(i, ramp.length - 1)]!);
    return new Vector3(r, g, b);
  });
  const tiny = 1e-12;
  const [lo, hi] = scale.radius;
  return {
    uMode: { value: mode === 'mean-curvature' ? 1 : mode === 'gaussian-curvature' ? 2 : 3 },
    uLimit: {
      value: Math.max(tiny, mode === 'gaussian-curvature' ? Math.sqrt(scale.gaussian) : scale.mean),
    },
    uLo: { value: Math.max(tiny, lo) },
    // log(hi/lo) is the divisor: keep the range open even on a degenerate board.
    uHi: { value: Math.max(hi, Math.max(tiny, lo) * 2) },
    uStops: { value: stops },
    uCount: { value: ramp.length },
  };
};

/**
 * The fitted hull painted by its exact curvature, in board coordinates. The caller
 * places it on the centred hull, as it does fins and guides.
 */
export function CurvatureSurface({ mesh, mode }: { mesh: CurvatureMesh; mode: ExactAnalysisMode }) {
  const geometry = useMemo(() => curvatureGeometry(mesh), [mesh]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const materials = useMemo(
    () => [
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: curvatureUniforms(mode, mesh.scale),
        side: DoubleSide,
      }),
      // The end caps carry no curvature: a plain lit grey, as neutral as the
      // ramp's middle.
      new MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.8, side: DoubleSide }),
    ],
    [mode, mesh.scale],
  );
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  return <mesh geometry={geometry} material={materials} />;
}
