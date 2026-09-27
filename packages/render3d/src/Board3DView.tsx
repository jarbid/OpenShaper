import type { BezierBoard } from '@openshaper/kernel';
import type { BoardState } from '@openshaper/store';
import { GizmoHelper, OrbitControls } from '@react-three/drei';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from 'react';
import {
  BufferGeometry,
  DoubleSide,
  OrthographicCamera,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { boardSpan, meshToGeometry, tessellateAsync } from './geometry';
import { BoardViewcube } from './BoardViewcube';
import { orthographicZoomFor, upForViewDirection } from './view-framing';
import { Fins3D } from './Fins3D';
import { Guides3D } from './Guides3D';
import { objectCenteredRotation } from './object-centered-navigation';

/** How the board surface is drawn. */
export type Board3DMode = 'shaded' | 'wireframe' | 'shaded-wire' | 'normals';
/** Lighting rig. `shaping-bay` mimics a shaper's side-lit room (raking rail shadows). */
export type LightingPreset = 'studio' | 'shaping-bay' | 'neutral';
/** Surface material look. */
export type MaterialPreset = 'foam' | 'gloss' | 'matte';
/** Surface-analysis overlay (replaces the shaded material). */
export type AnalysisMode = 'none' | 'zebra' | 'curvature' | 'slope';

/** Orbit pose: camera position and look-at target, world cm. */
export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export interface Board3DViewProps {
  store: StoreApi<BoardState>;
  /** Surface rendering mode (defaults to 'shaded'). */
  mode?: Board3DMode;
  /** Lighting rig (defaults to 'studio'). */
  lighting?: LightingPreset;
  /** Material look (defaults to 'gloss'). */
  material?: MaterialPreset;
  /** Board surface color (defaults to a warm tan). */
  color?: string;
  /** Fin blade color (defaults to the brand cyan). */
  finColor?: string;
  /** View-cube labels and borders (defaults to the primary 2D curve color). */
  viewCubeLineColor?: string;
  /** Surface-analysis overlay (defaults to 'none'). */
  analysis?: AnalysisMode;
  /** Target tessellation face size in cm (smaller = finer mesh). Defaults to ~0.9 cm. */
  targetFaceSize?: number;
  /** Draw the stringer plane's silhouette on the hull (defaults to false). */
  showStringer?: boolean;
  /** Draw a ring at every real cross-section (defaults to false). */
  showSections?: boolean;
  /** Board-length position of the active cross-section, drawn in cyan. */
  activeSectionX?: number | null;
  /** @deprecated use `mode="wireframe"`. Kept for back-compat. */
  wireframe?: boolean;
  /**
   * Restored orbit pose applied at mount instead of the default framing, so a
   * reloaded session reopens with the camera where it was. Pass a stable
   * object — it is read as the Canvas's initial camera state.
   */
  initialCamera?: CameraPose;
  /** Report the orbit pose whenever the user moves the camera (for persistence). */
  onCameraChange?: (pose: CameraPose) => void;
  className?: string;
}

/** Default viewport mesh density (cm per face) — noticeably finer than the legacy 120×48. */
const DEFAULT_FACE_SIZE = 0.9;

const BOARD_COLOR = '#E8EEF5';

/** Gizmo placement, shared by the view cube and the flip button stacked above it. */
const GIZMO_MARGIN = 56;
const FLIP_BUTTON_SIZE = 60;

/**
 * Frame the board to the view, for as long as the framing is still ours.
 *
 * An orthographic `camera.zoom` assignment is absolute, so refitting on every
 * `size.width` change would throw away whatever the user had scrolled to — and
 * `size.width` changes on every pane resize, maximise and quad/single switch.
 * Fitting only once is no good either: this pane first mounts inside the quad
 * layout, so a one-shot fit sizes the board for a quarter-width pane and leaves
 * it stranded there when the user opens the full-width 3D view.
 *
 * So: keep refitting while `camera.zoom` is the value we last wrote, and stand
 * down permanently once it isn't — that difference *is* the user having zoomed.
 * `initialCamera` gets a fit like any other mount; a restored `CameraPose`
 * carries position and target but no zoom, so there is nothing of theirs to keep.
 */
function OrthographicFit({ span }: { span: number }) {
  const { camera, size } = useThree();
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (!(camera instanceof OrthographicCamera) || size.width <= 0) return;
    if (applied.current !== null && Math.abs(camera.zoom - applied.current) > 1e-6) return;
    const zoom = orthographicZoomFor(size.width, span);
    applied.current = zoom;
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
  }, [camera, size.width, span]);
  return null;
}

function ObjectCenteredNavigation({
  initialCamera,
  onCameraChange,
  flipViewSequence,
}: {
  initialCamera?: CameraPose;
  onCameraChange?: (pose: CameraPose) => void;
  flipViewSequence: number;
}) {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, gl } = useThree();

  const reportPose = () => {
    const controls = controlsRef.current;
    if (!controls || !onCameraChange) return;
    onCameraChange({
      position: controls.object.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
    });
  };

  useEffect(() => {
    if (flipViewSequence === 0) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const flip = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    camera.position.applyQuaternion(flip);
    controls.target.applyQuaternion(flip);
    camera.up.applyQuaternion(flip);
    camera.lookAt(controls.target);
    controls.update();
    reportPose();
  }, [camera, flipViewSequence]);

  useEffect(() => {
    const controls = controlsRef.current;
    const element = gl.domElement;
    if (!controls) return;
    let pointerId: number | null = null;
    let previousX = 0;
    let previousY = 0;
    const eye = new Vector3();

    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Leave the bottom-right view cube and its flip button to their own handlers.
      if (event.offsetX > element.clientWidth - 140 && event.offsetY > element.clientHeight - 180)
        return;
      pointerId = event.pointerId;
      previousX = event.clientX;
      previousY = event.clientY;
      element.setPointerCapture(pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (pointerId !== event.pointerId || !(event.buttons & 1)) return;
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      previousX = event.clientX;
      previousY = event.clientY;

      eye.copy(camera.position).sub(controls.target);
      if (eye.lengthSq() === 0) return;
      const horizontal = dx / Math.max(1, element.clientWidth);
      const vertical = -dy / Math.max(1, element.clientHeight);
      const rotation = objectCenteredRotation(eye, camera.up, horizontal, vertical);

      // Rotate both the camera and its zoom/pan focus around the fixed board
      // origin. Their relative framing is preserved, but the orbit pivot never
      // drifts away from the object.
      camera.position.applyQuaternion(rotation);
      controls.target.applyQuaternion(rotation);
      camera.up.applyQuaternion(rotation);
      camera.lookAt(controls.target);
      controls.update();
      reportPose();
    };
    const pointerUp = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      pointerId = null;
    };

    element.addEventListener('pointerdown', pointerDown);
    element.addEventListener('pointermove', pointerMove);
    element.addEventListener('pointerup', pointerUp);
    element.addEventListener('pointercancel', pointerUp);
    return () => {
      element.removeEventListener('pointerdown', pointerDown);
      element.removeEventListener('pointermove', pointerMove);
      element.removeEventListener('pointerup', pointerUp);
      element.removeEventListener('pointercancel', pointerUp);
    };
  }, [camera, gl]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      rotateSpeed={1}
      enableRotate={false}
      enableDamping={false}
      screenSpacePanning
      zoomToCursor
      target={initialCamera?.target}
      onChange={reportPose}
    />
  );
}

function BoardGizmo({ lineColor }: { lineColor: string }) {
  const { camera, controls } = useThree();
  const fallbackTarget = useMemo(() => new Vector3(), []);

  const snapToView = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const orbit = controls as ComponentRef<typeof OrbitControls> | null;
    const target = orbit?.target ?? fallbackTarget;
    const radius = camera.position.distanceTo(target);
    if (radius <= 0) return null;

    // Faces expose their direction through the hit normal. Edge and corner hit
    // meshes are positioned in the direction they represent.
    const direction = event.object.position.lengthSq()
      ? event.object.position.clone()
      : event.face?.normal.clone();
    if (!direction?.lengthSq()) return null;
    direction.normalize();

    camera.position.copy(target).addScaledVector(direction, radius);
    camera.up.set(...upForViewDirection(direction));
    camera.lookAt(target);
    orbit?.update();
    return null;
  };

  return (
    <GizmoHelper alignment="bottom-right" margin={[GIZMO_MARGIN, GIZMO_MARGIN]}>
      <BoardViewcube
        onClick={snapToView}
        color="#0F1C30"
        hoverColor="#1E3149"
        textColor={lineColor}
        strokeColor="#1E3149"
      />
    </GizmoHelper>
  );
}

/** Background color per lighting preset (dark room makes side-lit rails pop). */
const BACKGROUND: Record<LightingPreset, string> = {
  studio: '#0A1424',
  'shaping-bay': '#06101A',
  neutral: '#14233A',
};

// --- analysis shader (zebra / curvature / slope) ---------------------------

const ANALYSIS_VERT = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const ANALYSIS_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  uniform int uMode;   // 1 = zebra, 2 = curvature, 3 = slope
  uniform float uFreq;

  // blue -> cyan -> green -> yellow -> red
  vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c1 = vec3(0.05, 0.15, 0.65);
    vec3 c2 = vec3(0.0, 0.75, 0.85);
    vec3 c3 = vec3(0.15, 0.8, 0.2);
    vec3 c4 = vec3(0.95, 0.9, 0.1);
    vec3 c5 = vec3(0.9, 0.12, 0.1);
    if (t < 0.25) return mix(c1, c2, t / 0.25);
    if (t < 0.5)  return mix(c2, c3, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c3, c4, (t - 0.5) / 0.25);
    return mix(c4, c5, (t - 0.75) / 0.25);
  }

  void main() {
    vec3 N = normalize(vWorldNormal);
    if (uMode == 1) {
      // Zebra: reflect the view direction and band by the reflection's elevation,
      // simulating a striped reflection room — aligned stripes = smooth (G1/G2).
      vec3 V = normalize(vViewDir);
      vec3 R = reflect(-V, N);
      float a = asin(clamp(R.z, -1.0, 1.0));
      float s = smoothstep(0.4, 0.6, fract(a * uFreq));
      gl_FragColor = vec4(mix(vec3(0.04), vec3(0.96), s), 1.0);
    } else if (uMode == 2) {
      // Curvature: screen-space change of the normal (rails / nose light up).
      float curv = length(fwidth(N)) * uFreq;
      gl_FragColor = vec4(ramp(curv), 1.0);
    } else {
      // Slope: angle of the surface normal away from vertical (z up).
      float slope = acos(clamp(abs(N.z), 0.0, 1.0)) / 1.5707963;
      gl_FragColor = vec4(ramp(slope), 1.0);
    }
  }
`;

const ANALYSIS_FREQ: Record<Exclude<AnalysisMode, 'none'>, number> = {
  zebra: 9.0,
  curvature: 60.0,
  slope: 1.0,
};

/** Light rig for the given preset, scaled to the board span. */
function Lights({ preset, span }: { preset: LightingPreset; span: number }) {
  if (preset === 'shaping-bay') {
    // Side lighting: grazing light from both rails in a dark room, plus a faint
    // fill, so subtle high/low spots cast shadows along the rail — the way a
    // shaper reads contours in a side-lit bay.
    return (
      <>
        <ambientLight intensity={0.06} />
        <directionalLight position={[0, span, span * 0.16]} intensity={1.5} />
        <directionalLight position={[0, -span, span * 0.16]} intensity={1.5} />
        <directionalLight position={[span * 0.5, 0, span * 0.08]} intensity={0.2} />
      </>
    );
  }
  if (preset === 'neutral') {
    return (
      <>
        <hemisphereLight args={['#ffffff', '#9a9a9a', 0.9]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[span, span, span]} intensity={0.5} />
      </>
    );
  }
  // studio (default)
  return (
    <>
      <hemisphereLight args={['#cfd6e4', '#0F1C30', 0.55]} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[span, -span, span * 1.5]} intensity={1.1} />
      <directionalLight position={[-span, span, span]} intensity={0.4} />
    </>
  );
}

/** Standard material for a surface preset. */
function SurfaceMaterial({
  preset,
  color,
  wireframe,
}: {
  preset: MaterialPreset;
  color: string;
  wireframe: boolean;
}) {
  if (preset === 'gloss') {
    return (
      <meshPhysicalMaterial
        color={color}
        roughness={0.15}
        metalness={0.0}
        clearcoat={1.0}
        clearcoatRoughness={0.12}
        side={DoubleSide}
        wireframe={wireframe}
      />
    );
  }
  // foam = matte off-white-ish high roughness; matte = mid roughness.
  return (
    <meshStandardMaterial
      color={color}
      roughness={preset === 'foam' ? 0.95 : 0.7}
      metalness={0.0}
      side={DoubleSide}
      wireframe={wireframe}
    />
  );
}

function BoardMesh({
  board,
  mode,
  material,
  color,
  analysis,
  targetFaceSize,
}: {
  board: BezierBoard;
  mode: Board3DMode;
  material: MaterialPreset;
  color: string;
  analysis: AnalysisMode;
  targetFaceSize: number;
}) {
  // Tessellation runs in a worker; while a new mesh computes we keep showing the
  // previous geometry so dragging control points stays smooth. A monotonically
  // increasing request token guards against out-of-order worker responses
  // (rapid edits enqueue many requests — only the latest may win).
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;
    tessellateAsync(board, targetFaceSize)
      .then((mesh) => {
        if (!cancelled) setGeometry(meshToGeometry(mesh));
      })
      .catch(() => {
        /* leave the last good geometry in place on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [board, targetFaceSize]);

  // Free the previous geometry when it changes, and on unmount.
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const analysisMaterial = useMemo(() => {
    const uMode = analysis === 'zebra' ? 1 : analysis === 'curvature' ? 2 : 3;
    const m = new ShaderMaterial({
      vertexShader: ANALYSIS_VERT,
      fragmentShader: ANALYSIS_FRAG,
      uniforms: {
        uMode: { value: uMode },
        uFreq: { value: analysis === 'none' ? 1.0 : ANALYSIS_FREQ[analysis] },
      },
      side: DoubleSide,
    });
    // fwidth() in the curvature path is core in WebGL2 (the renderer used here).
    return m;
  }, [analysis]);
  useEffect(() => () => analysisMaterial.dispose(), [analysisMaterial]);

  if (!geometry) return null;

  // Analysis overlay replaces the lit surface entirely.
  if (analysis !== 'none') {
    return <mesh geometry={geometry} material={analysisMaterial} />;
  }

  // `normals` mode swaps in a debug material that colors faces by orientation —
  // a flipped shell is then immediately obvious.
  if (mode === 'normals') {
    return (
      <mesh geometry={geometry}>
        <meshNormalMaterial side={DoubleSide} />
      </mesh>
    );
  }

  return (
    <>
      <mesh geometry={geometry} castShadow receiveShadow>
        <SurfaceMaterial preset={material} color={color} wireframe={mode === 'wireframe'} />
      </mesh>
      {/* Shaded + an overlaid wireframe: a second pass in a contrasting color. */}
      {mode === 'shaded-wire' && (
        <mesh geometry={geometry}>
          <meshBasicMaterial color="#0A1424" wireframe transparent opacity={0.25} />
        </mesh>
      )}
    </>
  );
}

/** Orbitable 3D view of the board, meshed from the kernel tessellation. */
export function Board3DView({
  store,
  mode,
  lighting = 'studio',
  material = 'gloss',
  color = BOARD_COLOR,
  finColor,
  viewCubeLineColor = '#22D3EE',
  analysis = 'none',
  targetFaceSize = DEFAULT_FACE_SIZE,
  showStringer = false,
  showSections = false,
  activeSectionX = null,
  wireframe = false,
  initialCamera,
  onCameraChange,
  className,
}: Board3DViewProps) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  const span = board ? boardSpan(board) : 200;
  const d = span * 1.1;
  const resolved: Board3DMode = mode ?? (wireframe ? 'wireframe' : 'shaded');
  const [flipViewSequence, setFlipViewSequence] = useState(0);
  const [flipHovered, setFlipHovered] = useState(false);

  return (
    <div className={className} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        dpr={[1, 2]}
        orthographic
        camera={{
          position: initialCamera?.position ?? [0, -d, d * 0.45],
          up: [0, 0, 1],
          near: 1,
          far: span * 50,
        }}
      >
        <OrthographicFit span={span} />
        <color attach="background" args={[BACKGROUND[lighting]]} />
        <Lights preset={lighting} span={span} />
        {board && (
          <BoardMesh
            board={board}
            mode={resolved}
            material={material}
            color={color}
            analysis={analysis}
            targetFaceSize={targetFaceSize}
          />
        )}
        {board && board.fins.setup !== 'none' && (
          <Fins3D board={board} targetFaceSize={targetFaceSize} color={finColor} />
        )}
        {board && (showStringer || showSections) && (
          <Guides3D
            board={board}
            targetFaceSize={targetFaceSize}
            showStringer={showStringer}
            showSections={showSections}
            activeSectionX={activeSectionX}
          />
        )}
        <ObjectCenteredNavigation
          initialCamera={initialCamera}
          onCameraChange={onCameraChange}
          flipViewSequence={flipViewSequence}
        />
        <BoardGizmo lineColor={viewCubeLineColor} />
      </Canvas>
      <button
        type="button"
        onClick={() => setFlipViewSequence((sequence) => sequence + 1)}
        onMouseEnter={() => setFlipHovered(true)}
        onMouseLeave={() => setFlipHovered(false)}
        style={{
          position: 'absolute',
          // Centred on the gizmo's column, one button-height above it.
          right: GIZMO_MARGIN - FLIP_BUTTON_SIZE / 2,
          bottom: GIZMO_MARGIN + FLIP_BUTTON_SIZE,
          zIndex: 1,
          border: 0,
          padding: 0,
          background: 'transparent',
          // The cube's own label colour: the scene background is near-black, so the
          // panel navy this used to draw in came out at 1.08:1 against it.
          color: viewCubeLineColor,
          opacity: flipHovered ? 1 : 0.75,
          cursor: 'pointer',
        }}
        aria-label="Flip view"
        title="Flip the view 180° around the board length axis"
      >
        <svg
          width={FLIP_BUTTON_SIZE}
          height={FLIP_BUTTON_SIZE}
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M2.6 5.6c.9-2.1 3-3.6 5.4-3.6 3 0 5.4 2.2 5.9 5h2C15.4 3.1 12.1 0 8 0 5 0 2.4 1.6 1.1 4.1L0 3v4h4L2.6 5.6z"
          />
          <path
            fill="currentColor"
            d="M16 9h-4.1l1.5 1.4c-.9 2.1-3 3.6-5.5 3.6C5 14 2.5 11.8 2 9H0c.5 3.9 3.9 7 7.9 7 3 0 5.6-1.7 7-4.1L16 13V9z"
          />
        </svg>
      </button>
    </div>
  );
}
