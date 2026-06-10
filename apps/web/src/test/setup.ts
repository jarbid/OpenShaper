/** jsdom shims for the component tests. */

// SplineEditor sizes its canvas with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no canvas implementation; SplineEditor handles a null 2D context,
// so return null quietly instead of jsdom's noisy "not implemented" error.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
