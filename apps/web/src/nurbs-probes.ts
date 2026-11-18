// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The as-built sections the section pane draws as ghosts (docs/design/m2-editor.md §3, §4), passed between
 * the editor and the NURBS layer without either importing the other.
 *
 * - The editor says which station coordinates it wants ({@link setWantedProbes}): the selected station and
 *   the scrub position; the Rails step says the places it draws ({@link setWantedProbesFor}).
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
/** What each part of the app asked for, by name; `wanted` is every list together. */
const askedBy = new Map<string, readonly number[]>();
const wantedListeners = new Set<() => void>();
let answers: readonly SectionProbe[] = [];
const answerListeners = new Set<() => void>();

/** The name the section pane's own list goes by. */
const EDITOR = 'editor';

/**
 * The station coordinates `owner` wants probed (an empty list withdraws them). Several parts of the app ask
 * at once, the section pane for its station and scrub position and the Rails step for the place on its map,
 * so the layer is asked for the lists of all of them together, each place once, and one part changing its list
 * never takes another's away. A repeat of what an owner already asked changes nothing.
 */
export function setWantedProbesFor(owner: string, xis: readonly number[]): void {
  const had = askedBy.get(owner) ?? [];
  if (same(had, xis)) return;
  if (xis.length === 0) askedBy.delete(owner);
  else askedBy.set(owner, xis);
  const all = [...new Set([...askedBy.values()].flat())];
  if (same(wanted, all)) return;
  wanted = all;
  for (const l of [...wantedListeners]) l();
}

/** The section pane's list: the selected station and the scrub position. */
export const setWantedProbes = (xis: readonly number[]): void => setWantedProbesFor(EDITOR, xis);

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
  askedBy.clear();
  answers = [];
}
