// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The panel of the step that is open, in the column above the sidebar: the rail panel for the Rails step, the
 * deck panel for the Deck step, and nothing for a step that has no panel of its own. It decides for itself
 * whether to show, so the shell mounts it once and a step change re-renders it and nothing else.
 */
import { memo } from 'react';
import type { LengthUnit } from '../format';
import { DeckPanel } from './DeckPanel';
import { RailPanel } from './RailPanel';
import { useWorkspaceStep } from './use-step';

export const StepPanelSlot = memo(function StepPanelSlot({
  units,
  slice,
  fluid,
}: {
  units: LengthUnit;
  /** The classic slice index of the chosen station: the Deck step's panel is for the deck there. */
  slice: number;
  /** Fill the width it is given (the bottom sheet) instead of the sidebar's own 20 rem. */
  fluid?: boolean;
}) {
  const [step] = useWorkspaceStep();
  if (step === 'rails') return <RailPanel units={units} fluid={fluid} />;
  if (step === 'deck') return <DeckPanel units={units} slice={slice} fluid={fluid} />;
  return null;
});
