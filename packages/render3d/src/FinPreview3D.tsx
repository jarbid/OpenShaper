// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A 3D preview of a fin design: the foiled blade and its Futures tab, orbitable
 * (docs/design/fin-designer.md, step 13). Presentational: the app passes the design to
 * show, and passes the *settled* one (not every move of a drag), so the mesh is
 * rebuilt per edit rather than per pointer move.
 *
 * Renders on demand (`frameloop="demand"`). The camera frames the fin on first show and
 * whenever `frameKey` changes (a new fin), never on an edit, so a view the user has
 * orbited to stays put while they work, like the 2D panes.
 *
 * Section analysis (`sections`): the fin turns see-through, and each section plane is
 * drawn translucent, with its cut over everything. The cut comes in ready-made (the
 * kernel's `sliceMesh`), so moving a plane only redraws.
 *
 * The panel fit (`view` 'panel', with `panel`): the whole fin from behind, along the
 * panel it is cut from, all but flat, with the panel's outline drawn over it.
 */
import { finOutward, type FinDesign } from '@openshaper/kernel';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import { BufferAttribute, BufferGeometry, DoubleSide, PerspectiveCamera, Vector3 } from 'three';
import {
  FIN_PANEL_VIEW_FOV,
  FIN_PREVIEW_FOV,
  finCameraPosition,
  finScene,
  sectionPlaneCorners,
  type FinPanelOutline,
  type FinPreviewView,
  type FinScene,
  type FinSectionPlane,
} from './fin-preview';

export interface FinPreview3DProps {
  design: FinDesign | null;
  /** Change it to re-frame the camera (a new fin). */
  frameKey?: string | number;
  /**
   * Beside the fin (default), from above, or the panel fit; changing it re-frames the
   * camera. The panel fit needs `panel`: without one it is seen from beside.
   */
  view?: FinPreviewView;
  /** The panel's outline, drawn in the panel fit view. */
  panel?: FinPanelOutline | null;
  /**
   * Section analysis: the fin turns see-through and each plane is drawn with its cut.
   * Null or absent for the plain preview.
   */
  sections?: readonly FinSectionPlane[] | null;
  background?: string;
  bladeColor?: string;
  tabColor?: string;
}

/** Puts the camera on the fin whenever `frameKey` changes. */
function Framer({
  scene,
  frameKey,
  outward,
  view,
  panelAngle,
}: {
  scene: FinScene;
  frameKey: unknown;
  outward: 1 | -1;
  view: FinPreviewView;
  panelAngle: number;
}) {
  const { camera, controls, size, invalidate } = useThree();
  const framed = useRef<unknown>(Symbol('never'));
  useEffect(() => {
    // Wait for the orbit controls: they mount after this on the first frame, and would
    // otherwise start aimed at the origin and override the camera set here.
    const orbit = controls as ComponentRef<typeof OrbitControls> | null;
    // The panel fit re-frames when the fin turns in the panel, to keep looking along it.
    const key = `${String(frameKey)}|${view}|${view === 'panel' ? panelAngle : ''}`;
    if (!orbit || framed.current === key || size.width === 0) return;
    framed.current = key;
    const [x, y, z] = finCameraPosition(
      scene.center,
      scene.radius,
      outward,
      size.width / size.height,
      view,
      panelAngle,
    );
    if (camera instanceof PerspectiveCamera) {
      camera.fov = view === 'panel' ? FIN_PANEL_VIEW_FOV : FIN_PREVIEW_FOV;
      // From that far back, a nearer near plane would waste the depth buffer's precision.
      camera.near = view === 'panel' ? 1 : 0.1;
      camera.far = view === 'panel' ? 10000 : 2000;
      camera.updateProjectionMatrix();
    }
    // From above, the nose is up the screen; beside the fin, the blade's height is.
    if (view === 'above') camera.up.set(1, 0, 0);
    else camera.up.set(0, 0, 1);
    camera.position.set(x, y, z);
    orbit.target.set(...scene.center);
    orbit.update();
    invalidate();
  }, [
    frameKey,
    view,
    panelAngle,
    scene,
    outward,
    camera,
    controls,
    size.width,
    size.height,
    invalidate,
  ]);
  return null;
}

/** A see-through section plane, and its cut drawn over everything so it reads from any angle. */
function SectionPlane({ scene, plane }: { scene: FinScene; plane: FinSectionPlane }) {
  const quad = useMemo(() => {
    const [a, b, c, d] = sectionPlaneCorners(scene, plane);
    const g = new BufferGeometry().setFromPoints(
      [a!, b!, c!, a!, c!, d!].map((p) => new Vector3(...p)),
    );
    g.computeVertexNormals();
    return g;
  }, [scene, plane]);
  const cut = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(plane.cut), 3));
    return g;
  }, [plane.cut]);
  useEffect(
    () => () => {
      quad.dispose();
      cut.dispose();
    },
    [quad, cut],
  );
  return (
    <>
      <mesh geometry={quad} renderOrder={1}>
        <meshBasicMaterial
          color={SECTION_PLANE}
          transparent
          opacity={0.22}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={cut} renderOrder={2}>
        <lineBasicMaterial color={SECTION_CUT} depthTest={false} transparent />
      </lineSegments>
    </>
  );
}

/** The panel's outline, over everything, so the fin can't hide it. */
function PanelOutline({ panel }: { panel: FinPanelOutline }) {
  const geometry = useMemo(
    () =>
      // Each side as its own segment: corner to next corner, round the loop.
      new BufferGeometry().setFromPoints(
        panel.corners.flatMap((p, i) => [
          new Vector3(...p),
          new Vector3(...panel.corners[(i + 1) % panel.corners.length]!),
        ]),
      ),
    [panel.corners],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry} renderOrder={3}>
      <lineBasicMaterial color={panel.fits ? PANEL_FIT : PANEL_OVER} depthTest={false} />
    </lineSegments>
  );
}

// One meaning per colour (owner review): orange is for limits and warnings only, so a
// panel the fin fits, the section planes and the tab's axis are quiet slate.
const PANEL_FIT = '#8A9BB3';
const PANEL_OVER = '#F97316';
const SECTION_PLANE = '#8A9BB3';
const SECTION_CUT = '#FDE047';

/** A faint line along the tab's centre: the box's direction. */
function TabAxis({
  from,
  to,
}: {
  from: readonly [number, number, number];
  to: readonly [number, number, number];
}) {
  const geometry = useMemo(
    () => new BufferGeometry().setFromPoints([new Vector3(...from), new Vector3(...to)]),
    [from, to],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#8A9BB3" transparent opacity={0.8} />
    </lineSegments>
  );
}

export function FinPreview3D({
  design,
  frameKey,
  view: wanted = 'side',
  panel = null,
  sections = null,
  background = '#0A1424',
  bladeColor = '#22D3EE',
  tabColor = '#8A9BB3',
}: FinPreview3DProps) {
  const scene = useMemo(() => (design ? finScene(design) : null), [design]);
  useEffect(
    () => () => {
      scene?.blade.dispose();
      scene?.tab.dispose();
    },
    [scene],
  );
  const outward = finOutward(design?.hand ?? null);
  const view = wanted === 'panel' && !panel ? 'side' : wanted;

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ fov: FIN_PREVIEW_FOV, near: 0.1, far: 2000, up: [0, 0, 1], position: [0, 40, 20] }}
      aria-label="Fin 3D preview"
    >
      <color attach="background" args={[background]} />
      <ambientLight intensity={0.45} />
      {/* Key lights on both sides, so a right fin's outside face (−Y) shades like a left one's. */}
      <directionalLight position={[60, 80, 120]} intensity={1} />
      <directionalLight position={[60, -80, 120]} intensity={1} />
      <directionalLight position={[-80, 0, -40]} intensity={0.35} />
      {scene && (
        <>
          {/* See-through while analysing, so the planes and cuts show through the fin. */}
          <mesh geometry={scene.blade}>
            <meshStandardMaterial
              key={sections ? 'clear' : 'solid'}
              color={bladeColor}
              roughness={0.35}
              side={DoubleSide}
              transparent={!!sections}
              opacity={sections ? 0.3 : 1}
              depthWrite={!sections}
            />
          </mesh>
          <mesh geometry={scene.tab}>
            <meshStandardMaterial
              key={sections ? 'clear' : 'solid'}
              color={tabColor}
              roughness={0.6}
              transparent={!!sections}
              opacity={sections ? 0.35 : 1}
              depthWrite={!sections}
            />
          </mesh>
          {view !== 'panel' && <TabAxis from={scene.tabAxis[0]} to={scene.tabAxis[1]} />}
          {view === 'panel' && panel && <PanelOutline panel={panel} />}
          {sections?.map((p) => (
            <SectionPlane key={p.axis} scene={scene} plane={p} />
          ))}
          <Framer
            scene={scene}
            frameKey={frameKey}
            outward={outward}
            view={view}
            panelAngle={panel?.angle ?? 0}
          />
        </>
      )}
      <OrbitControls makeDefault enableDamping={false} />
    </Canvas>
  );
}
