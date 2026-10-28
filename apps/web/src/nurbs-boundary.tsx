// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A local error boundary around the experimental NURBS layer (docs/design/board2.md,
 * "V1 viewer"). The layer is a lazy chunk behind a setting that persists, so a
 * browser that is offline, or a deploy that removed the old hashed chunk, would
 * otherwise reject the dynamic import into the route's error screen and the whole
 * editor would not load. Here the failure stays local: the classic 3D view carries on
 * and a short note says why the NURBS layer is missing.
 *
 * In the main chunk and dependency-free on purpose: it must not fail for the reason
 * it is shown.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from './analytics';

export const NURBS_UNAVAILABLE_TEXT = 'NURBS viewer unavailable (offline?)';

interface Props {
  children: ReactNode;
  /** Called once when the layer failed, so the caller can drop the surface it holds. */
  onFail?: (error: unknown) => void;
}

export class NurbsBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    captureError('nurbs_layer', error);
    this.props.onFail?.(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="status"
        data-testid="nurbs-unavailable"
        className="absolute right-2 top-2 z-[2] rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-lg"
      >
        {NURBS_UNAVAILABLE_TEXT}
      </div>
    );
  }
}
