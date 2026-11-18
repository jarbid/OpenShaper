// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What cannot run without a GPU is held to what can: the constants of the look reach the shader
 * from `patches.ts`, the one place they live, and the shader's source has the steps the plain-code
 * twin in `patches.ts` has (`patchColorAt` and the functions it is made of).
 */
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { createPatchMaterial, patchUniforms } from './patch-shader';
import { PATCH, SELECTION_LOOK, SPAN_FEATHER, TUCK, TUCK_SHADE } from './patches';

/** What three hands `onBeforeCompile`: the program's sources, with the includes the look edits at. */
const compiled = () => {
  const { material, uniforms } = createPatchMaterial();
  const program = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\n#include <color_fragment>\n#include <emissivemap_fragment>\n}',
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(program, {} as WebGLRenderer);
  return { material, uniforms, program };
};

describe('the Patches shader', () => {
  it('takes the selection look from the one place it lives, as uniforms', () => {
    expect(patchUniforms().uSelLook.value).toEqual([
      SELECTION_LOOK.lift,
      SELECTION_LOOK.add,
      SELECTION_LOOK.dim,
      SELECTION_LOOK.grey,
    ]);
  });

  it('splits the tuck from the part in the vertex shader, the part flat and the tuck smooth', () => {
    const { program } = compiled();
    expect(program.vertexShader).toContain('flat varying float vPatch;');
    expect(program.vertexShader).toContain('varying float vTuck;');
    expect(program.vertexShader).toContain(`aPatch >= ${TUCK.toFixed(1)} - 0.5`);
    expect(program.vertexShader).toContain(`vPatch = aPatch - ${TUCK.toFixed(1)} * onTuck;`);
    expect(program.fragmentShader).toContain('varying float vTuck;');
  });

  it('shades the tuck by the share patches.ts gives it, before the selection looks at the colour', () => {
    const { program } = compiled();
    const shade = `c *= mix(1.0, ${TUCK_SHADE.toFixed(2)}, vTuck);`;
    expect(program.fragmentShader).toContain(shade);
    expect(program.fragmentShader.indexOf(shade)).toBeLessThan(
      program.fragmentShader.indexOf('if (uSelPatch < 0) return c;'),
    );
  });

  it('feathers the chosen span by the width patches.ts gives it', () => {
    const { program } = compiled();
    const feather = SPAN_FEATHER.toFixed(2);
    expect(program.fragmentShader).toContain(`uSelSpan.x - ${feather}, uSelSpan.x + ${feather}`);
    expect(program.fragmentShader).toContain(`uSelSpan.y - ${feather}, uSelSpan.y + ${feather}`);
  });

  it('paints the rail by zone and every other part by its fixed colour', () => {
    const { program, uniforms } = compiled();
    expect(program.fragmentShader).toContain(
      `part == ${PATCH.rail} ? railZoneColor(vBoard.x, side) : uPatchColor[part]`,
    );
    // one colour per patch id, three components each
    expect(uniforms.uPatchColor.value).toHaveLength(3 * 5);
  });

  it('sits a little behind its true depth, so the seam lines on its edges show', () => {
    const { material } = compiled();
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBeGreaterThan(0);
    expect(material.polygonOffsetUnits).toBeGreaterThan(0);
  });
});
