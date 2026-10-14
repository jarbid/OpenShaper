// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The editor's help layer: tooltips that explain, and `?` links to the docs.
 *
 * `@openshaper/ui`'s `Tooltip` only lays a description out; whether there is one is
 * decided here, from the help-text table and the Show tips setting. The setting
 * reaches every tooltip through {@link ShowTipsContext} rather than as a prop, so the
 * memoised panels that render tooltips (`Sidebar`) are not re-rendered or rethreaded
 * for it — a context change re-renders only the tooltips that read it.
 */
import { Tooltip, TooltipsEnabledContext, type TooltipProps } from '@openshaper/ui';
import { CircleHelp } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { docsHref, toolbarHelp, type HelpEntry, type ToolbarHelpId } from './help-text';

/**
 * The Show tips setting. Off hides every tooltip: `ShowTipsProvider` switches the
 * ui `Tooltip` off too, not just the help descriptions.
 */
export const ShowTipsContext = createContext(true);

export function ShowTipsProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return (
    <ShowTipsContext.Provider value={value}>
      <TooltipsEnabledContext.Provider value={value}>{children}</TooltipsEnabledContext.Provider>
    </ShowTipsContext.Provider>
  );
}

/** A `Tooltip` whose description comes from the help table while tips are on. */
export function HelpTooltip({
  helpId,
  ...props
}: Omit<TooltipProps, 'description'> & { helpId: ToolbarHelpId }) {
  const showTips = useContext(ShowTipsContext);
  const description = showTips ? toolbarHelp(helpId)?.description : undefined;
  return <Tooltip {...props} description={description} />;
}

/**
 * The small `?` beside a section header, linking to the docs that explain it.
 *
 * A plain same-tab link, like Help ▸ Documentation: the docs are their own pages,
 * and the editor's board survives the trip in the session store. It sits beside
 * the header's toggle button, never inside it, so it is a link of its own and not
 * a link nested in a button.
 */
export function DocsHelpLink({ topic, entry }: { topic: string; entry: HelpEntry }) {
  const label = `Learn more about ${topic}`;
  return (
    <Tooltip label={label}>
      <a
        href={docsHref(entry)}
        aria-label={label}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground pointer-coarse:size-11"
      >
        <CircleHelp aria-hidden className="size-3.5" />
      </a>
    </Tooltip>
  );
}
