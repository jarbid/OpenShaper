/**
 * Shared rig for driving a real `SplineEditor` under jsdom.
 *
 * jsdom has no layout, so the pane's size and page position are variables the
 * test moves directly, and the canvas's `getBoundingClientRect` /
 * `clientWidth` / `clientHeight` are wired to them. `screenOf` maps world cm to
 * the pixel a pointer event should carry, reading the framing the editor itself
 * reported — so tests never hard-code the result of `fitToBounds`.
 */
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type Vec2,
} from '@openshaper/kernel';
import {
  SplineEditor,
  turnedCanvasToPane,
  viewportFromCenter,
  worldToScreen,
  type ViewCenter,
} from '@openshaper/render2d';
import { createBoardStore } from '@openshaper/store';
import { act, render } from '@testing-library/react';
import type { ComponentProps } from 'react';

/** A small valid board: outline (half-width), flat-ish bottom and deck. */
export const makeBoard = (): BezierBoard => {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  return board(
    splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]),
    splineFromKnots([k(0, 5), k(100, 5)]),
    splineFromKnots([k(0, 11), k(100, 11)]),
    [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)],
  );
};

export const pane = { w: 600, h: 400, top: 0 };

/** ResizeObserver callbacks registered by the component under test. */
let observers: ResizeObserverCallback[] = [];

/** Resize the pane the way a wrapping header used to, and flush the observer. */
export const resizeTo = (w: number, h: number) => {
  pane.w = w;
  pane.h = h;
  act(() => {
    for (const cb of observers) cb([], {} as ResizeObserver);
  });
};

/** Move the canvas down the page without resizing it — no observer fires. */
export const shiftTo = (top: number) => {
  act(() => {
    pane.top = top;
  });
};

class TestResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observers.push(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((c) => c !== this.cb);
  }
}

const protos = [HTMLDivElement.prototype, HTMLCanvasElement.prototype];
const props = ['clientWidth', 'clientHeight', 'getBoundingClientRect'] as const;
let realRO: typeof ResizeObserver;
let saved: { p: object; entries: (readonly [string, PropertyDescriptor | undefined])[] }[] = [];

/** Call from `beforeEach`: stub layout onto `pane` and reset it to a fresh 600x400. */
export const installLayoutStubs = () => {
  observers = [];
  pane.w = 600;
  pane.h = 400;
  pane.top = 0;
  realRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  saved = protos.map((p) => ({
    p,
    entries: props.map((n) => [n, Object.getOwnPropertyDescriptor(p, n)] as const),
  }));
  for (const p of protos) {
    Object.defineProperty(p, 'clientWidth', { configurable: true, get: () => pane.w });
    Object.defineProperty(p, 'clientHeight', { configurable: true, get: () => pane.h });
    Object.defineProperty(p, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: pane.top,
        right: pane.w,
        bottom: pane.top + pane.h,
        width: pane.w,
        height: pane.h,
      }),
    });
  }
};

/** Call from `afterEach`. */
export const removeLayoutStubs = () => {
  globalThis.ResizeObserver = realRO;
  for (const { p, entries } of saved) {
    for (const [name, d] of entries) {
      if (d) Object.defineProperty(p, name, d);
      else delete (p as unknown as Record<string, unknown>)[name];
    }
  }
};

type EditorProps = ComponentProps<typeof SplineEditor>;

/** Mount the outline editor over a loaded board. */
export const mountEditor = (overrides: Partial<EditorProps> = {}) => {
  const store = createBoardStore();
  act(() => store.getState().load(makeBoard()));
  let view: ViewCenter | null = null;
  const rendered = render(
    <SplineEditor
      store={store}
      targets={[{ kind: 'outline' }]}
      colors={['#fff']}
      onViewChange={(v) => {
        view = v;
      }}
      {...overrides}
    />,
  );
  const canvas = rendered.container.querySelector('canvas')!;
  /**
   * The client coordinates a pointer event must carry to sit on `world`.
   *
   * A turned pane draws into a canvas whose axes are the swapped pair, rotated into
   * the pane by CSS. `turnedCanvasToPane` is the same mapping `localPoint` inverts,
   * imported rather than re-derived — a test that re-implements the transform it is
   * checking proves only that two copies of a mistake agree.
   */
  const screenOf = (world: Vec2) => {
    const turned = overrides.allowTurn === true && pane.h > pane.w;
    const cw = turned ? pane.h : pane.w;
    const ch = turned ? pane.w : pane.h;
    const local = worldToScreen(viewportFromCenter(view!, cw, ch), world);
    const inPane = turned ? turnedCanvasToPane(local, cw) : local;
    return { clientX: inPane.x, clientY: inPane.y + pane.top };
  };
  const knotAt = (index = 1) => store.getState().board!.outline.knots[index]!;
  return {
    store,
    canvas,
    screenOf,
    knotAt,
    midKnot: () => knotAt().end,
    scale: () => view!.scale,
    unmount: rendered.unmount,
  };
};

export const MOUSE = { pointerId: 1, button: 0, pointerType: 'mouse' } as const;
export const TOUCH = { pointerId: 1, button: 0, pointerType: 'touch' } as const;
