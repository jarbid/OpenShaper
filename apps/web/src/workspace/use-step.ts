// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace's current step, and the one-time Patches default.
 *
 * The step is one module-level value, like the patch the last tap chose (`patch-look.ts`): the
 * shell's key handler sets it without subscribing to it, so a step change re-renders the
 * workspace and not the whole shell. It is remembered under its own key, not in the view state.
 * It is read from storage the first time it is asked for, and an id this build does not know
 * (a step renamed or removed since it was saved) reads as the first step.
 */
import { useSyncExternalStore } from 'react';
import { readStored, writeStored } from '../persisted';
import { DEFAULT_STEP, isStepId, type StepId } from './steps';

export const STEP_STORAGE_KEY = 'bs.workspaceStep';
export const PATCHES_STORAGE_KEY = 'bs.workspacePatches';

/** A stored value as a step: the id if it names one, the first step otherwise. */
export const parseStep = (value: unknown): StepId => (isStepId(value) ? value : DEFAULT_STEP);

let current: StepId | undefined;
const listeners = new Set<() => void>();

/** The current step, read from storage the first time. */
export function getWorkspaceStep(): StepId {
  current ??= readStored(STEP_STORAGE_KEY, DEFAULT_STEP, parseStep);
  return current;
}

/** Choose a step and remember it. Choosing the current step does nothing. */
export function setWorkspaceStep(next: StepId): void {
  if (next === getWorkspaceStep()) return;
  current = next;
  writeStored(STEP_STORAGE_KEY, next);
  for (const l of [...listeners]) l();
}

/** Forget what was read, so the next read comes from storage again (tests). */
export function resetWorkspaceStep(): void {
  current = undefined;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The current step and the function that chooses one (the same function every render). */
export function useWorkspaceStep(): readonly [StepId, (step: StepId) => void] {
  const step = useSyncExternalStore(subscribe, getWorkspaceStep, () => DEFAULT_STEP);
  return [step, setWorkspaceStep];
}

/**
 * Whether this is the first time the workspace has been entered: true once, and false for ever
 * after (the answer is kept in storage, and read from it every time). The caller applies the
 * workspace's default look on a true.
 */
export function claimPatchesDefault(): boolean {
  if (readStored(PATCHES_STORAGE_KEY, false, (v) => v === true)) return false;
  writeStored(PATCHES_STORAGE_KEY, true);
  return true;
}
