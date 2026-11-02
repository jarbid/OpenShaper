// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The as-built sections the section pane draws as ghosts (docs/design/m2-editor.md §3, §4), passed between
 * the editor and the NURBS layer without either importing the other.
 *
 * - The editor says which station coordinates it wants ({@link setWantedProbes}): the selected station and
 *   the scrub position.
 * - The layer (which owns the worker) feeds them to the viewer and publishes the answers
 *   ({@link publishProbes}).
 * - The editor reads the answers ({@link useProbes}) and turns the section at a coordinate into a spline
 *   to draw ({@link probeSpline}).
 *
 * Nothing here is board2's: a probe is plain numbers (`SectionProbe`).
 */
import { knot, splineFromKnots, vec2, type Spline } from '@openshaper/kernel';
import { useSyncExternalStore } from 'react';
import type { SectionProbe } from './workers/nurbs-protocol';

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

let wanted: readonly number[] = [];
const wantedListeners = new Set<() => void>();
let answers: readonly SectionProbe[] = [];
const answerListeners = new Set<() => void>();

/** The station coordinates the editor wants probed. A repeat of the current list changes nothing. */
export function setWantedProbes(xis: readonly number[]): void {
  if (same(wanted, xis)) return;
  wanted = xis;
  for (const l of [...wantedListeners]) l();
}

export const getWantedProbes = (): readonly number[] => wanted;
export const subscribeWantedProbes = (l: () => void): (() => void) => {
  wantedListeners.add(l);
  return () => void wantedListeners.delete(l);
};

/** The layer's latest answer; an empty list when no layer is showing. */
export function publishProbes(items: readonly SectionProbe[]): void {
  if (answers === items) return;
  answers = items;
  for (const l of [...answerListeners]) l();
}

const subscribeAnswers = (l: () => void) => {
  answerListeners.add(l);
  return () => void answerListeners.delete(l);
};

/** The latest probe answers. */
export const useProbes = (): readonly SectionProbe[] =>
  useSyncExternalStore(
    subscribeAnswers,
    () => answers,
    () => answers,
  );

/** The probe taken at `xi`, if the latest answer has one. */
export const probeAt = (items: readonly SectionProbe[], xi: number): SectionProbe | undefined =>
  items.find((p) => p.xi === xi);

const splines = new WeakMap<readonly number[], Spline>();

/**
 * A probe's polyline as a spline of corner knots (collapsed handles), the ghost the pane draws. One spline
 * per polyline, so a ghost that did not change is not redrawn.
 */
export function probeSpline(points: readonly number[]): Spline {
  let s = splines.get(points);
  if (s === undefined) {
    const knots = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      const p = vec2(points[i]!, points[i + 1]!);
      knots.push(knot(p, p, p, false));
    }
    s = splineFromKnots(knots);
    splines.set(points, s);
  }
  return s;
}

/** Forget everything (tests). */
export function resetProbes(): void {
  wanted = [];
  answers = [];
}
