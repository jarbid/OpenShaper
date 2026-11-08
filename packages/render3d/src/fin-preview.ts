// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The pure half of `FinPreview3D` (docs/design/fin-designer.md, step 13): the fin's
 * meshes as three.js geometry, and where the camera looks from. Kept apart from the
 * component so it can be tested without WebGL.
 *
 * Frame: the kernel's fin frame (blade.ts), cm. X along the tab toward the nose, Y
 * across (a left fin's outside face toward +Y), Z up the blade from the tab top. The
 * scene keeps it, with the camera's up set to +Z, so nothing is rotated or re-centred:
 * the blade and tab stay where the kernel and the STEP/STL files put them.
 */
import { FIN_MESH_PREVIEW, finMesh, type BoardMesh, type FinDesign } from '@openshaper/kernel';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
} from 'three';

/** Kernel mesh → BufferGeometry, in place (no centring). */
export const finMeshGeometry = (mesh: BoardMesh): BufferGeometry => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(mesh.normals), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(mesh.indices), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
};

export interface FinScene {
  readonly blade: BufferGeometry;
  readonly tab: BufferGeometry;
  /** Centre and radius of everything, for framing (cm). */
  readonly center: [number, number, number];
  readonly radius: number;
  /** Everything's bounds (cm): what a section plane is sized to. */
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  /**
   * The tab's centre line on the tab top, run on past both ends: the box's direction,
   * to judge a toe correction against (start and end, cm).
   */
  readonly tabAxis: [[number, number, number], [number, number, number]];
}

/**
 * Finer than the preview, for the zebra stripes: on the preview's mesh, the stripes wobble
 * with its facets on a face that is smooth.
 */
export const FIN_MESH_ZEBRA = { ...FIN_MESH_PREVIEW, rows: 120, stations: 64 };

/**
 * The fin's preview meshes (preview quality: a few ms, rebuilt per settled edit), or
 * finer ones for the zebra stripes.
 */
export const finScene = (d: FinDesign, fine = false): FinScene => {
  const m = finMesh(d, fine ? FIN_MESH_ZEBRA : FIN_MESH_PREVIEW);
  const blade = finMeshGeometry(m.blade);
  const tab = finMeshGeometry(m.tab);
  const box = new Box3().copy(blade.boundingBox!).union(tab.boundingBox!);
  const c = box.getCenter(new Vector3());
  const t = tab.boundingBox!;
  const yc = (t.min.y + t.max.y) / 2;
  const reach = (t.max.x - t.min.x) * 0.25;
  return {
    blade,
    tab,
    center: [c.x, c.y, c.z],
    radius: box.getSize(new Vector3()).length() / 2,
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
    tabAxis: [
      [t.min.x - reach, yc, 0.001],
      [t.max.x + reach, yc, 0.001],
    ],
  };
};

/**
 * A section plane for the analysis view: `z` horizontal at a height, `x` upright at a
 * point along the base (cm, fin frame), and where it cuts the fin, as segment endpoints
 * from the kernel's `sliceMesh`.
 */
export interface FinSectionPlane {
  readonly axis: 'x' | 'z';
  readonly at: number;
  readonly cut: readonly number[];
}

/** How far a section plane runs past the fin on each side (cm). */
const PLANE_MARGIN = 1.5;

/**
 * The four corners of a section plane, sized to the scene with a margin: a horizontal
 * plane across x and y at its height, an upright one across y and z at its x.
 */
export const sectionPlaneCorners = (
  scene: Pick<FinScene, 'min' | 'max'>,
  plane: Pick<FinSectionPlane, 'axis' | 'at'>,
): [number, number, number][] => {
  const m = PLANE_MARGIN;
  const [x0, y0, z0] = scene.min.map((v) => v - m) as [number, number, number];
  const [x1, y1, z1] = scene.max.map((v) => v + m) as [number, number, number];
  const a = plane.at;
  return plane.axis === 'z'
    ? [
        [x0, y0, a],
        [x1, y0, a],
        [x1, y1, a],
        [x0, y1, a],
      ]
    : [
        [a, y0, z0],
        [a, y1, z0],
        [a, y1, z1],
        [a, y0, z1],
      ];
};

/**
 * Where the preview looks from: beside the fin, from above (down the blade from the
 * tip), or the panel fit (from behind, along the panel the fin is cut from).
 */
export type FinPreviewView = 'side' | 'above' | 'panel';

/** Vertical field of view of the preview camera (deg). */
export const FIN_PREVIEW_FOV = 35;

/**
 * The panel fit view's field of view (deg): so narrow, from so far back, that it is all
 * but flat, and the fin's leading and trailing edges line up with the panel drawn
 * across it, as on a drawing.
 */
export const FIN_PANEL_VIEW_FOV = 1;

/** The panel's outline in the panel fit view, and how it sits. */
export interface FinPanelOutline {
  /** The fin turned in the panel, seen from above (deg): the view looks along the panel. */
  readonly angle: number;
  /** The panel's cross-section round the fin, four corners (cm, fin frame). */
  readonly corners: readonly (readonly [number, number, number])[];
  /** Whether the fin fits: green if so, orange if not. */
  readonly fits: boolean;
}

/**
 * Where the camera sits to frame the whole fin: looking at the outside face (so a right
 * fin is seen from −Y), a little from behind and above, far enough back that a sphere
 * of `radius` fills the view with some margin.
 */
export const finCameraPosition = (
  center: readonly [number, number, number],
  radius: number,
  outward: 1 | -1,
  aspect = 1,
  view: FinPreviewView = 'side',
  panelAngle = 0,
): [number, number, number] => {
  // From above: straight down the blade from past its tip, the tab's axis across the
  // view, so a toe correction shows as the blade turned against it. The panel fit:
  // from behind the fin, level, along the panel (turned with the fin's angle in it).
  const a = (panelAngle * Math.PI) / 180;
  const dir =
    view === 'above'
      ? new Vector3(0, 0, 1)
      : view === 'panel'
        ? new Vector3(-Math.cos(a), -Math.sin(a), 0)
        : new Vector3(-0.35, outward, 0.4).normalize();
  const fov = view === 'panel' ? FIN_PANEL_VIEW_FOV : FIN_PREVIEW_FOV;
  const half = ((fov / 2) * Math.PI) / 180;
  // Fit the narrower of the vertical and horizontal fields.
  const fit = Math.min(half, Math.atan(Math.tan(half) * aspect));
  const dist = (radius / Math.sin(fit)) * 1.1;
  return [center[0] + dir.x * dist, center[1] + dir.y * dist, center[2] + dir.z * dist];
};

/** Stripes across the zebra texture: many, as a fin's faces point within a narrow range of directions. */
export const ZEBRA_STRIPES = 48;

/**
 * The zebra stripes (owner request, 2026-11: the surface's smoothness, seen): a matcap
 * texture of upright black and white stripes. A matcap colours each point by which way
 * its face points, as seen from the camera, so each stripe follows the points facing one
 * band of directions. Over a smooth face the stripes run on unbroken and bend gently; at a
 * crease they break, and where the face's curvature jumps they kink. Soft-edged (a pixel
 * or two), so a stripe's edge doesn't shimmer.
 */
export const zebraTexture = (size = 1024, stripes = ZEBRA_STRIPES): DataTexture => {
  const data = new Uint8Array(size * size * 4);
  for (let x = 0; x < size; x++) {
    // Distance into the stripe from its nearer edge, in pixels: a smooth step over ~1.5 px.
    const f = ((x + 0.5) / size) * stripes;
    const into = (0.5 - Math.abs((f % 1) - 0.5)) * (size / stripes);
    const light = Math.floor(f) % 2 === 0;
    const w = Math.min(1, into / 1.5);
    const v = Math.round(255 * (light ? 0.5 + 0.5 * w : 0.5 - 0.5 * w) * 0.92 + 10);
    for (let y = 0; y < size; y++) {
      const k = (y * size + x) * 4;
      data[k] = v;
      data[k + 1] = v;
      data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat);
  t.colorSpace = SRGBColorSpace;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
};
