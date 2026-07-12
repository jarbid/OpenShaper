/**
 * Trace-image state for the editor.
 *
 * Manages an independent reference image per length-axis view (outline / rocker):
 * loading, placement transform, opacity, mirror, the 4-click / typed-length
 * calibration flows, IndexedDB persistence (survives reload), and object-URL
 * lifecycle. See docs plan `help-me-write-a-jolly-rivest.md`.
 */
import type { Vec2 } from '@openshaper/kernel';
import {
  scaleFromTypedLength,
  solveSimilarity,
  toggleFlip,
  type Calibration,
  type SimilarityParams,
} from '@openshaper/render2d';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteTrace,
  getAllTraces,
  putTrace,
  TRACE_STORE_VERSION,
  type StoredTrace,
  type TraceView,
} from './trace-store';

export type { TraceView };

export interface TraceImage {
  image: HTMLImageElement;
  objectUrl: string;
  /** Original bytes, kept so the image can be re-persisted on transform changes. */
  blob: Blob;
  naturalWidth: number;
  naturalHeight: number;
  opacity: number;
  transform: SimilarityParams;
  refPointsImg?: [Vec2, Vec2];
}

/** The `background` prop shape consumed by SplineEditor. */
export interface TraceBackground {
  image: HTMLImageElement;
  opacity: number;
  naturalWidth: number;
  naturalHeight: number;
  transform: SimilarityParams;
}

const VIEWS: TraceView[] = ['outline', 'rocker'];

const emptyTraces = (): Record<TraceView, TraceImage | null> => ({ outline: null, rocker: null });

const toStored = (view: TraceView, t: TraceImage): StoredTrace => ({
  view,
  blob: t.blob,
  mime: t.blob.type,
  naturalWidth: t.naturalWidth,
  naturalHeight: t.naturalHeight,
  opacity: t.opacity,
  transform: t.transform,
  refPointsImg: t.refPointsImg,
  version: TRACE_STORE_VERSION,
  updatedAt: Date.now(),
});

/** Default placement: fit the image width to the board length, centred, upright. */
const initialTransform = (w: number, h: number, boardLengthCm: number): SimilarityParams => {
  const len = boardLengthCm > 0 ? boardLengthCm : w;
  const scale = len / w;
  return { scale, rotation: 0, flipX: false, tx: len / 2 - (scale * w) / 2, ty: (scale * h) / 2 };
};

export interface UseTrace {
  traces: Record<TraceView, TraceImage | null>;
  /** The view whose image is currently being edited / calibrated. */
  activeView: TraceView;
  setActiveView: (v: TraceView) => void;
  /** Calibration flow in progress (for the active view), or null. */
  calibration: Calibration;
  /** True while the typed-length tool is waiting for a distance to be entered. */
  lengthPending: boolean;
  /** Whether the active view's image is directly manipulable (not mid-calibration). */
  interactive: boolean;
  loadImage: (view: TraceView, file: File, boardLengthCm: number) => void;
  clear: (view: TraceView) => void;
  setOpacity: (view: TraceView, o: number) => void;
  flip: (view: TraceView) => void;
  commitTransform: (view: TraceView, t: SimilarityParams) => void;
  beginAlign: (view: TraceView) => void;
  beginLength: (view: TraceView) => void;
  cancelCalibration: () => void;
  onCalibrationClick: (pt: Vec2) => void;
  applyLength: (cm: number) => void;
  backgroundFor: (view: TraceView) => TraceBackground | undefined;
}

export function useTrace(): UseTrace {
  const [traces, setTraces] = useState<Record<TraceView, TraceImage | null>>(emptyTraces);
  const [activeView, setActiveView] = useState<TraceView>('outline');
  const [calibration, setCalibration] = useState<Calibration>(null);
  const [lengthPts, setLengthPts] = useState<[Vec2, Vec2] | null>(null);

  const tracesRef = useRef(traces);
  tracesRef.current = traces;

  // Central write: update state, revoke a superseded object URL, and persist to IndexedDB.
  const writeTrace = useCallback((view: TraceView, next: TraceImage | null) => {
    setTraces((prev) => {
      const old = prev[view];
      if (old && (!next || next.objectUrl !== old.objectUrl)) URL.revokeObjectURL(old.objectUrl);
      return { ...prev, [view]: next };
    });
    if (next) void putTrace(toStored(view, next)).catch(() => {});
    else void deleteTrace(view).catch(() => {});
  }, []);

  const updateTransform = useCallback(
    (view: TraceView, transform: SimilarityParams, refPointsImg?: [Vec2, Vec2]) => {
      const cur = tracesRef.current[view];
      if (!cur) return;
      writeTrace(view, { ...cur, transform, refPointsImg: refPointsImg ?? cur.refPointsImg });
    },
    [writeTrace],
  );

  const loadImage = useCallback(
    (view: TraceView, file: File, boardLengthCm: number) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        writeTrace(view, {
          image: img,
          objectUrl: url,
          blob: file,
          naturalWidth: w,
          naturalHeight: h,
          opacity: tracesRef.current[view]?.opacity ?? 0.5,
          transform: initialTransform(w, h, boardLengthCm),
        });
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
      setActiveView(view);
    },
    [writeTrace],
  );

  const clear = useCallback(
    (view: TraceView) => {
      writeTrace(view, null);
      setCalibration(null);
      setLengthPts(null);
    },
    [writeTrace],
  );

  const setOpacity = useCallback(
    (view: TraceView, o: number) => {
      const cur = tracesRef.current[view];
      if (cur) writeTrace(view, { ...cur, opacity: o });
    },
    [writeTrace],
  );

  const flip = useCallback(
    (view: TraceView) => {
      const cur = tracesRef.current[view];
      if (cur)
        updateTransform(view, toggleFlip(cur.transform, cur.naturalWidth, cur.naturalHeight));
    },
    [updateTransform],
  );

  const commitTransform = useCallback(
    (view: TraceView, t: SimilarityParams) => updateTransform(view, t),
    [updateTransform],
  );

  const beginAlign = useCallback((view: TraceView) => {
    setActiveView(view);
    setLengthPts(null);
    setCalibration({ tool: 'align', step: 0, imgPts: [], worldPts: [] });
  }, []);

  const beginLength = useCallback((view: TraceView) => {
    setActiveView(view);
    setLengthPts(null);
    setCalibration({ tool: 'length', step: 0, imgPts: [] });
  }, []);

  const cancelCalibration = useCallback(() => {
    setCalibration(null);
    setLengthPts(null);
  }, []);

  const onCalibrationClick = useCallback(
    (pt: Vec2) => {
      const cal = calibration;
      if (!cal) return;
      if (cal.tool === 'align') {
        const collectingImage = cal.imgPts.length < 2;
        const imgPts = collectingImage ? [...cal.imgPts, pt] : cal.imgPts;
        const worldPts = collectingImage ? cal.worldPts : [...cal.worldPts, pt];
        if (imgPts.length === 2 && worldPts.length === 2) {
          const cur = tracesRef.current[activeView];
          const flipX = cur?.transform.flipX ?? false;
          const t = solveSimilarity(imgPts[0]!, imgPts[1]!, worldPts[0]!, worldPts[1]!, flipX);
          updateTransform(activeView, t, [imgPts[0]!, imgPts[1]!]);
          setCalibration(null);
          return;
        }
        setCalibration({
          tool: 'align',
          step: (imgPts.length + worldPts.length) as 0 | 1 | 2 | 3,
          imgPts,
          worldPts,
        });
      } else {
        const imgPts = [...cal.imgPts, pt];
        if (imgPts.length === 2) {
          setLengthPts([imgPts[0]!, imgPts[1]!]);
          setCalibration(null); // hide the overlay; the owner now prompts for a distance
          return;
        }
        setCalibration({ tool: 'length', step: 1, imgPts });
      }
    },
    [calibration, activeView, updateTransform],
  );

  const applyLength = useCallback(
    (cm: number) => {
      const pts = lengthPts;
      const cur = tracesRef.current[activeView];
      if (!pts || !cur || !(cm > 0)) {
        setLengthPts(null);
        return;
      }
      const scale = scaleFromTypedLength(pts[0], pts[1], cm);
      updateTransform(activeView, { ...cur.transform, scale });
      setLengthPts(null);
    },
    [lengthPts, activeView, updateTransform],
  );

  const backgroundFor = useCallback(
    (view: TraceView): TraceBackground | undefined => {
      const t = traces[view];
      return t
        ? {
            image: t.image,
            opacity: t.opacity,
            naturalWidth: t.naturalWidth,
            naturalHeight: t.naturalHeight,
            transform: t.transform,
          }
        : undefined;
    },
    [traces],
  );

  // Rehydrate persisted traces on mount.
  useEffect(() => {
    let cancelled = false;
    getAllTraces()
      .then((recs) => {
        for (const rec of recs) {
          const url = URL.createObjectURL(rec.blob);
          const img = new Image();
          img.onload = () => {
            if (cancelled) {
              URL.revokeObjectURL(url);
              return;
            }
            setTraces((prev) => ({
              ...prev,
              [rec.view]: {
                image: img,
                objectUrl: url,
                blob: rec.blob,
                naturalWidth: rec.naturalWidth,
                naturalHeight: rec.naturalHeight,
                opacity: rec.opacity,
                transform: rec.transform,
                refPointsImg: rec.refPointsImg,
              },
            }));
          };
          img.onerror = () => URL.revokeObjectURL(url);
          img.src = url;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape cancels an in-progress calibration.
  useEffect(() => {
    if (!calibration && !lengthPts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCalibration(null);
        setLengthPts(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [calibration, lengthPts]);

  // Revoke every object URL on unmount.
  useEffect(
    () => () => {
      for (const v of VIEWS) {
        const t = tracesRef.current[v];
        if (t) URL.revokeObjectURL(t.objectUrl);
      }
    },
    [],
  );

  return useMemo(
    () => ({
      traces,
      activeView,
      setActiveView,
      calibration,
      lengthPending: lengthPts !== null,
      interactive: calibration === null && lengthPts === null,
      loadImage,
      clear,
      setOpacity,
      flip,
      commitTransform,
      beginAlign,
      beginLength,
      cancelCalibration,
      onCalibrationClick,
      applyLength,
      backgroundFor,
    }),
    [
      traces,
      activeView,
      calibration,
      lengthPts,
      loadImage,
      clear,
      setOpacity,
      flip,
      commitTransform,
      beginAlign,
      beginLength,
      cancelCalibration,
      onCalibrationClick,
      applyLength,
      backgroundFor,
    ],
  );
}
