import {
  getLength,
  getMaxRocker,
  getMaxThickness,
  getMaxWidth,
  type BezierBoard,
} from '@openshaper/kernel';
import type { BoardState } from '@openshaper/store';
import { Edges, GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DoubleSide, ShaderMaterial, type BufferGeometry } from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { boardSpan, meshToGeometry, tessellateAsync } from './geometry';
import { Fins3D } from './Fins3D';

/** How the board surface is drawn. */
export type Board3DMode = 'shaded' | 'wireframe' | 'shaded-wire' | 'normals';
/** Lighting rig. `shaping-bay` mimics a shaper's side-lit room (raking rail shadows). */
export type LightingPreset = 'studio' | 'shaping-bay' | 'neutral';
/** Surface material look. */
export type MaterialPreset = 'foam' | 'gloss' | 'matte';
/** Surface-analysis overlay (replaces the shaded material). */
export type AnalysisMode = 'none' | 'zebra' | 'curvature' | 'slope';

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
  /** Surface-analysis overlay (defaults to 'none'). */
  analysis?: AnalysisMode;
  /** Target tessellation face size in cm (smaller = finer mesh). Defaults to ~0.9 cm. */
  targetFaceSize?: number;
  /** Board-length position of the active cross-section to highlight on the mesh, or null. */
  sectionX?: number | null;
  /** @deprecated use `mode="wireframe"`. Kept for back-compat. */
  wireframe?: boolean;
  className?: string;
}

/** Default viewport mesh density (cm per face) — noticeably finer than the legacy 120×48. */
const DEFAULT_FACE_SIZE = 0.9;

const BOARD_COLOR = '#E8EEF5';

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

/**
 * Translucent plane marking the active cross-section's length position. The mesh is
 * centered by geometry.center() (length axis = X, spanning ≈[0,length]), so the
 * station at board-x `x` sits at centered X = x − length/2; the plane is centered on
 * Y/Z (which are also centered) and sized to comfortably cover the section.
 */
function SectionPlane({ board, x }: { board: BezierBoard; x: number }) {
  const length = getLength(board);
  const yExtent = getMaxWidth(board) * 1.12;
  const zExtent = (getMaxThickness(board) + getMaxRocker(board)) * 1.4;
  return (
    <mesh position={[x - length / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
      {/* local X→world Z (height), local Y→world Y (width) after the Y-rotation. */}
      <planeGeometry args={[zExtent, yExtent]} />
      <meshBasicMaterial
        color="#22D3EE"
        transparent
        opacity={0.16}
        side={DoubleSide}
        depthWrite={false}
      />
      <Edges color="#22D3EE" />
    </mesh>
  );
}

/** Orbitable 3D view of the board, meshed from the kernel tessellation. */
export function Board3DView({
  store,
  mode,
  lighting = 'studio',
  material = 'gloss',
  color = BOARD_COLOR,
  analysis = 'none',
  targetFaceSize = DEFAULT_FACE_SIZE,
  sectionX = null,
  wireframe = false,
  className,
}: Board3DViewProps) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  const span = board ? boardSpan(board) : 200;
  const d = span * 1.1;
  const resolved: Board3DMode = mode ?? (wireframe ? 'wireframe' : 'shaded');

  return (
    <div className={className} style={{ width: '100%', height: '100%' }}>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, -d, d * 0.45], up: [0, 0, 1], fov: 35, near: 1, far: span * 50 }}
      >
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
          <Fins3D board={board} targetFaceSize={targetFaceSize} />
        )}
        {board && sectionX != null && <SectionPlane board={board} x={sectionX} />}
        <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
        <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
          <GizmoViewport axisColors={['#22D3EE', '#2DD4BF', '#A78BFA']} labelColor="#E6EDF5" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}
