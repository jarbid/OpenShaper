// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Patches look: a lit material whose base colour is the board's part and, along a rail, its
 * zone. The material is a `MeshStandardMaterial` (so the scene's lights and the board's form
 * read as in any lit look) whose diffuse colour the fragment shader replaces.
 *
 * Each vertex carries `aPatch`, the patch id (`patches.ts`). It is passed on as a `flat`
 * varying, so a triangle is one patch even where its vertices are of two (on the seam between a
 * side and a corner), and the colour varies only by the rail's zone, read from the fragment's
 * own place along the board: the geometry is in board coordinates, so `position.x` is cm from
 * the tail and the sign of `position.y` is the side. The zones and the selection are uniforms,
 * so a new list or a new choice recolours the board and builds no mesh.
 *
 * `zoneColorAt` and `selectionSpan` in `patches.ts` are the same rules in plain code.
 */
import { MeshStandardMaterial, Vector2 } from 'three';
import {
  MAX_ZONES,
  NO_SELECTION,
  PATCH,
  PATCH_COLORS,
  RAIL_NO_ZONES_COLOR,
  SELECTION_LOOK,
  hexToLinear,
  packZones,
  selectionUniforms,
  type PatchSelection,
  type RailZones,
} from './patches';

/** The share of a part's colour added as light that needs no lamp. */
export const FILL = 0.3;

/** The half width, in cm along the board, over which the edge of a lit rail span fades. */
export const SPAN_FEATHER = 0.4;

const VERT_DECLARE = /* glsl */ `
  attribute float aPatch;
  flat varying float vPatch;
  varying vec2 vBoard;
`;

const VERT_SET = /* glsl */ `
  vPatch = aPatch;
  vBoard = position.xy;
`;

const FRAG_DECLARE = /* glsl */ `
  flat varying float vPatch;
  varying vec2 vBoard;
  uniform vec3 uPatchColor[5];
  uniform ivec2 uZoneCount;
  uniform vec2 uZoneSpan[${2 * MAX_ZONES}];
  uniform vec3 uZoneColor[${2 * MAX_ZONES}];
  uniform int uSelPatch;
  uniform int uSelSide;
  uniform vec2 uSelSpan;
  uniform vec4 uSelLook;
  vec3 patchBase;

  // The rail's colour at x on one side: the zone it is in, the smooth mix across the gap between
  // two zones, or the first or last zone's colour beyond the ends.
  vec3 railZoneColor(float x, int side) {
    int n = side == 0 ? uZoneCount.x : uZoneCount.y;
    if (n == 0) return uPatchColor[${PATCH.rail}];
    int base = side * ${MAX_ZONES};
    if (x <= uZoneSpan[base].x) return uZoneColor[base];
    for (int i = 0; i < ${MAX_ZONES - 1}; i++) {
      if (i >= n - 1) break;
      vec2 a = uZoneSpan[base + i];
      vec2 b = uZoneSpan[base + i + 1];
      if (x <= a.y) return uZoneColor[base + i];
      if (x < b.x) {
        float t = (x - a.y) / (b.x - a.y);
        return mix(uZoneColor[base + i], uZoneColor[base + i + 1], t * t * (3.0 - 2.0 * t));
      }
    }
    return uZoneColor[base + n - 1];
  }

  vec3 patchColor() {
    int part = int(vPatch + 0.5);
    int side = vBoard.y >= 0.0 ? 0 : 1;
    vec3 c = part == ${PATCH.rail} ? railZoneColor(vBoard.x, side) : uPatchColor[part];
    if (uSelPatch < 0) return c;
    float lit = part == uSelPatch ? 1.0 : 0.0;
    if (lit > 0.0 && part == ${PATCH.rail}) {
      lit = side == uSelSide
        ? smoothstep(uSelSpan.x - ${SPAN_FEATHER.toFixed(2)}, uSelSpan.x + ${SPAN_FEATHER.toFixed(2)}, vBoard.x)
          * (1.0 - smoothstep(uSelSpan.y - ${SPAN_FEATHER.toFixed(2)}, uSelSpan.y + ${SPAN_FEATHER.toFixed(2)}, vBoard.x))
        : 0.0;
    }
    // uSelLook: lift, add, dim, grey
    vec3 on = c * uSelLook.x + uSelLook.y;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 off = mix(c, vec3(l), uSelLook.w) * uSelLook.z;
    return mix(off, on, lit);
  }
`;

/** The uniforms of the Patches material, as three reads them. */
export interface PatchUniforms {
  uPatchColor: { value: number[] };
  uZoneCount: { value: Vector2 };
  uZoneSpan: { value: Float32Array };
  uZoneColor: { value: Float32Array };
  uSelPatch: { value: number };
  uSelSide: { value: number };
  uSelSpan: { value: Vector2 };
  uSelLook: { value: number[] };
}

/** The look's fixed colours: deck, bottom, the rail where it has no zones, tail edge, corner (linear rgb, flat). */
const fixedColors = (): number[] =>
  [
    PATCH_COLORS.deck,
    PATCH_COLORS.bottom,
    RAIL_NO_ZONES_COLOR,
    PATCH_COLORS.tailEdge,
    PATCH_COLORS.corner,
  ].flatMap(hexToLinear);

export const patchUniforms = (): PatchUniforms => {
  const packed = packZones({ plus: [], minus: [] });
  return {
    uPatchColor: { value: fixedColors() },
    uZoneCount: { value: new Vector2(0, 0) },
    uZoneSpan: { value: packed.span },
    uZoneColor: { value: packed.color },
    uSelPatch: { value: NO_SELECTION.patch },
    uSelSide: { value: NO_SELECTION.side },
    uSelSpan: { value: new Vector2(0, 0) },
    uSelLook: {
      value: [SELECTION_LOOK.lift, SELECTION_LOOK.add, SELECTION_LOOK.dim, SELECTION_LOOK.grey],
    },
  };
};

/**
 * Writes `zones` and the selection into `uniforms` (the material's own objects, changed in
 * place). The caller asks for a new frame: the canvas draws on demand.
 */
export function setPatchUniforms(
  uniforms: PatchUniforms,
  zones: RailZones,
  selection: PatchSelection | null | undefined,
): void {
  const packed = packZones(zones);
  uniforms.uZoneCount.value.set(packed.count[0], packed.count[1]);
  uniforms.uZoneSpan.value.set(packed.span);
  uniforms.uZoneColor.value.set(packed.color);
  const sel = selectionUniforms(selection, zones);
  uniforms.uSelPatch.value = sel.patch;
  uniforms.uSelSide.value = sel.side;
  uniforms.uSelSpan.value.set(sel.lo, sel.hi);
}

/**
 * The Patches material and its uniforms. Lit like the other shaded looks, a little matte so the
 * colours stay true under the gloss preset's highlights, double sided as they are.
 */
export function createPatchMaterial(): { material: MeshStandardMaterial; uniforms: PatchUniforms } {
  const uniforms = patchUniforms();
  const material = new MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECLARE}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_SET}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECLARE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n  patchBase = patchColor();\n  diffuseColor.rgb = patchBase;`,
      )
      // A floor of light in the part's own colour, so the bottom and any side the rig does not
      // reach (every preset lights from above) still reads as its colour, not as black.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n  totalEmissiveRadiance += patchBase * ${FILL.toFixed(2)};`,
      );
  };
  material.customProgramCacheKey = () => 'openshaper-patches';
  return { material, uniforms };
}
