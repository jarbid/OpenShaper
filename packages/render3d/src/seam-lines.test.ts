// SPDX-License-Identifier: GPL-3.0-or-later
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { createPatchMaterial, createSeamMaterial } from './patch-shader';
import { SEAM_LOOK, type PatchSeams } from './patches';
import { seamGeometry } from './seam-lines';

// four segments: the first two are band edges, the other two are not
const seams: PatchSeams = {
  positions: Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 2, 0, 5, 5, 5, 6, 6, 6,
  ]),
  bandEdges: 2,
};

describe('the seam lines as geometry', () => {
  it('uses the seams own positions, and marks the vertices of the band edges only', () => {
    const g = seamGeometry(seams);
    expect(g.getAttribute('position').array).toBe(seams.positions);
    expect(g.getAttribute('position').count).toBe(8);
    expect([...g.getAttribute('aEdge').array]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(g.index).toBeNull();
    g.dispose();
  });

  it('is built for lines that all sit in one bounding sphere', () => {
    const g = seamGeometry(seams);
    expect(g.boundingSphere!.radius).toBeGreaterThan(0);
    g.dispose();
  });
});

/** What three hands `onBeforeCompile`: the program's sources with the includes the shader edits at. */
const program = (): WebGLProgramParametersWithUniforms =>
  ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\nvec4 diffuseColor = vec4(1.0);\n#include <color_fragment>\n}',
  }) as unknown as WebGLProgramParametersWithUniforms;

describe('the seam material', () => {
  it('is a dark neutral at partial opacity, depth-tested, and writes no depth', () => {
    const { uniforms } = createPatchMaterial();
    const m = createSeamMaterial(uniforms);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(SEAM_LOOK.opacity);
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.color.getHexString()).not.toBe('ffffff');
    m.dispose();
  });

  it('reads the selection from the very uniform objects of the Patches material', () => {
    const { uniforms } = createPatchMaterial();
    const m = createSeamMaterial(uniforms);
    const shader = program();
    m.onBeforeCompile(shader, {} as WebGLRenderer);
    expect(shader.uniforms.uSelPatch).toBe(uniforms.uSelPatch);
    expect(shader.uniforms.uSelSide).toBe(uniforms.uSelSide);
    expect(shader.uniforms.uSelSpan).toBe(uniforms.uSelSpan);
    m.dispose();
  });

  it('carries the band-edge mark and the board place to the fragment, and lights by the span rule', () => {
    const { uniforms } = createPatchMaterial();
    const m = createSeamMaterial(uniforms);
    const shader = program();
    m.onBeforeCompile(shader, {} as WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute float aEdge');
    expect(shader.vertexShader).toContain('vBoard = position.xy');
    expect(shader.fragmentShader).toContain('spanLit(vBoard.x');
    // the same stretch the surface lights: one definition of the span's edge in GLSL
    const surface = program();
    surface.fragmentShader =
      '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>';
    surface.vertexShader = '#include <common>\n#include <begin_vertex>';
    createPatchMaterial().material.onBeforeCompile(surface, {} as WebGLRenderer);
    const rule = (src: string) => src.match(/float spanLit[\s\S]*?\n {2}}\n/)?.[0];
    expect(rule(shader.fragmentShader)).toBeDefined();
    expect(rule(shader.fragmentShader)).toBe(rule(surface.fragmentShader));
    m.dispose();
  });
});
