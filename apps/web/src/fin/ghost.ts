// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A ghost (owner request): a vector drawing shown half transparent behind a view's curves,
 * to trace over. Only a reference: it isn't part of the fin, isn't saved and isn't undone.
 * A dot at its centre moves it and one at the corner of its box scales it.
 */
import type { FinCurveMarker } from '@openshaper/render2d';
import type { Vec2 } from '@openshaper/kernel';

type P = { readonly x: number; readonly y: number };

export interface Ghost {
  /** The lines as drawn, about their own centre. */
  readonly lines: readonly (readonly P[])[];
  /** Half the size of their box, as drawn. */
  readonly halfW: number;
  readonly halfH: number;
  /** Where its centre is, and how much it is scaled. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export const GHOST_MOVE = 'ghost-move';
export const GHOST_SCALE = 'ghost-scale';

/** The smallest a ghost goes: a tenth of a percent, so it can always be grabbed again. */
const MIN_SCALE = 1e-3;

/** A ghost of `lines`, placed by `place` from its size. */
export const makeGhost = (
  lines: readonly (readonly P[])[],
  place: (size: { w: number; h: number }) => { x: number; y: number; scale: number },
): Ghost => {
  const pts = lines.flat();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    lines: lines.map((l) => l.map((p) => ({ x: p.x - cx, y: p.y - cy }))),
    halfW: (x1 - x0) / 2,
    halfH: (y1 - y0) / 2,
    ...place({ w: x1 - x0, h: y1 - y0 }),
  };
};

/** Its handles, in the view's data: y divided by `yDiv` (the foil view's true-scale stretch). */
export const ghostMarkers = (g: Ghost, yDiv = 1): FinCurveMarker[] => [
  {
    id: GHOST_MOVE,
    at: { x: g.x, y: g.y / yDiv } as Vec2,
    color: '#C9D2DF',
    label: 'Move the ghost',
  },
  {
    id: GHOST_SCALE,
    at: { x: g.x + g.halfW * g.scale, y: (g.y + g.halfH * g.scale) / yDiv } as Vec2,
    color: '#C9D2DF',
    label: 'Scale the ghost',
  },
];

/** The ghost with handle `id` dragged to `to` (the view's data). */
export const dragGhost = (g: Ghost, id: string, to: P, yDiv = 1): Ghost => {
  const y = to.y * yDiv;
  if (id === GHOST_MOVE) return { ...g, x: to.x, y };
  const scale = Math.hypot(to.x - g.x, y - g.y) / (Math.hypot(g.halfW, g.halfH) || 1);
  return { ...g, scale: Math.max(MIN_SCALE, scale) };
};

/** Draw the ghost at 50% and its box, under the curves. */
export const drawGhost = (
  ctx: CanvasRenderingContext2D,
  g: Ghost,
  toScreen: (p: P) => P,
  yDiv = 1,
): void => {
  const at = (p: P) => toScreen({ x: g.x + p.x * g.scale, y: (g.y + p.y * g.scale) / yDiv });
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (const l of g.lines) {
    l.forEach((p, i) => {
      const s = at(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
  }
  ctx.fillStyle = '#8A9BB3';
  ctx.fill('evenodd');
  ctx.strokeStyle = '#C9D2DF';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([3, 4]);
  const a = at({ x: -g.halfW, y: -g.halfH });
  const b = at({ x: g.halfW, y: g.halfH });
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
};

/** A view's marker handlers with the ghost's handles taken out and sent to `onGhost`. */
export const withGhostHandles = <
  H extends {
    onMarkerDragStart: (id: string) => void;
    onMarkerDrag: (id: string, to: Vec2) => void;
    onMarkerDragEnd: () => void;
  },
>(
  handlers: H,
  ghost: Ghost | null | undefined,
  onGhost: ((g: Ghost | null) => void) | undefined,
  yDiv = 1,
): H => {
  let dragging = false;
  return {
    ...handlers,
    onMarkerDragStart: (id: string) => {
      dragging = id.startsWith('ghost-');
      if (!dragging) handlers.onMarkerDragStart(id);
    },
    onMarkerDrag: (id: string, to: Vec2) => {
      if (id.startsWith('ghost-')) {
        if (ghost && onGhost) onGhost(dragGhost(ghost, id, to, yDiv));
      } else handlers.onMarkerDrag(id, to);
    },
    onMarkerDragEnd: () => {
      if (!dragging) handlers.onMarkerDragEnd();
      dragging = false;
    },
  };
};
