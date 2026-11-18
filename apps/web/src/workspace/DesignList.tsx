// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The design list: the steps of a board down the left of the workspace, and under a divider the
 * sidebar tabs that are not steps (Specs, Build, Compare).
 *
 * - **Marks.** The current step is `aria-current="step"`. A panel entry whose tab the sidebar is
 *   showing is `aria-current="true"`: the step, which decides the drawing, stays marked as well.
 * - **Keyboard.** One tab stop for the whole list (the roving tabindex of a toolbar). Up and Down
 *   move focus a row, Home and End to the ends, Enter chooses what has focus. The arrows are
 *   consumed (`preventDefault`) because the point editor nudges the selected point on any arrow
 *   that nobody else has used.
 * - **Sizes.** From `lg` up (`compact` false) a 168 px column of icon and name. Below it
 *   (`compact`) a 56 px column of icons whose names are tooltips and accessible names, every
 *   button 44 px square whatever the pointer. Above `lg` the 44 px floor applies to a finger only
 *   (`pointer-coarse:`), as everywhere in the editor.
 * - **Tooltips** carry the key that chooses the step, read from the shortcut table.
 */
import { Button, cn, Tooltip } from '@openshaper/ui';
import { memo, useRef, useState, type KeyboardEvent } from 'react';
import { shortcutKeys } from '../shortcuts';
import type { TabId } from '../sidebar-sections';
import {
  DESIGN_STEPS,
  PANEL_ENTRIES,
  WORKSPACE_ENTRIES,
  type PanelId,
  type StepId,
  type WorkspaceEntry,
} from './steps';

export interface DesignListProps {
  /** The current design step. */
  step: StepId;
  onStep: (step: StepId) => void;
  /** The tab the sidebar is showing, or null when it is folded away. */
  sidebarTab: TabId | null;
  onPanel: (panel: PanelId) => void;
  /** Below `lg`: the icon column. */
  compact?: boolean;
}

const ORDER: readonly string[] = WORKSPACE_ENTRIES.map((e) => e.id);

export const DesignList = memo(function DesignList({
  step,
  onStep,
  sidebarTab,
  onPanel,
  compact = false,
}: DesignListProps) {
  // The entry that is the list's tab stop: the one last focused, the current step to begin with and
  // whenever the step changes (re-synced while rendering, not in an effect, which would cost a
  // second commit per change).
  const [stop, setStop] = useState<string>(step);
  const [seenStep, setSeenStep] = useState(step);
  if (step !== seenStep) {
    setSeenStep(step);
    setStop(step);
  }
  const nav = useRef<HTMLElement>(null);

  const choose = (entry: WorkspaceEntry) =>
    entry.kind === 'design' ? onStep(entry.id) : onPanel(entry.id);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]')?.dataset.entry;
    const at = from ? ORDER.indexOf(from) : -1;
    if (at < 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = WORKSPACE_ENTRIES[at];
      if (entry) choose(entry);
      return;
    }
    const last = ORDER.length - 1;
    const to =
      e.key === 'ArrowDown'
        ? Math.min(at + 1, last)
        : e.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1;
    if (to < 0) return;
    e.preventDefault();
    nav.current?.querySelector<HTMLElement>(`[data-entry="${ORDER[to]}"]`)?.focus();
  };

  const entry = (e: WorkspaceEntry) => {
    const Icon = e.icon;
    const isStep = e.kind === 'design' && e.id === step;
    const isShown = e.kind === 'panel' && e.tab === sidebarTab;
    return (
      <Tooltip
        key={e.id}
        label={e.label}
        shortcut={e.kind === 'design' ? shortcutKeys(`step-${e.key}`) : undefined}
      >
        <Button
          type="button"
          size="sm"
          variant={isStep ? 'secondary' : 'ghost'}
          data-entry={e.id}
          aria-current={isStep ? 'step' : isShown ? 'true' : undefined}
          aria-label={compact ? e.label : undefined}
          tabIndex={stop === e.id ? 0 : -1}
          onFocus={() => setStop(e.id)}
          onClick={() => choose(e)}
          className={cn(
            'text-sm',
            compact ? 'size-11 shrink-0 px-0' : 'h-9 w-full justify-start px-2 pointer-coarse:h-11',
            isShown && 'bg-accent text-accent-foreground',
          )}
        >
          <Icon aria-hidden />
          {!compact && <span className="truncate">{e.label}</span>}
        </Button>
      </Tooltip>
    );
  };

  return (
    <nav
      ref={nav}
      aria-label="Design steps"
      onKeyDown={onKeyDown}
      className={cn(
        'flex shrink-0 flex-col overflow-y-auto rounded-lg border border-border bg-card p-1.5',
        compact ? 'w-14 items-center gap-1' : 'w-[168px] gap-0.5',
      )}
    >
      {!compact && (
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          Design
        </p>
      )}
      {DESIGN_STEPS.map(entry)}
      <div aria-hidden className="my-1 h-px w-full shrink-0 bg-border" />
      {PANEL_ENTRIES.map(entry)}
    </nav>
  );
});
