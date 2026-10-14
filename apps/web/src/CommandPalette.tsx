import { Input, Panel, type MenuItem } from '@openshaper/ui';
import { useId, useMemo, useState } from 'react';
import { Modal } from './components/modal';
import { docsHref, isNew, type HelpEntry } from './help-text';

/** One executable entry in the command palette, derived from a menu item. */
export interface Command {
  id: string;
  /** `Menu: Item` — the accessible name, which stays unique across menus. */
  label: string;
  /** The menu it came from; results are grouped under it. */
  menu: string;
  /** The item's own label, shown under the menu's heading. */
  name: string;
  shortcut?: string;
  disabled?: boolean;
  /** One sentence on what it does, shown under the name and searched. */
  description?: string;
  /** Synonyms the search also matches. */
  keywords?: readonly string[];
  /** Where "learn more" goes, e.g. `/docs/specs#resize`. */
  href?: string;
  /** `YYYY-MM-DD` it shipped; recent ones get a "New" badge. */
  addedOn?: string;
  run: () => void;
}

/**
 * Looks up the help for a menu item: the menu, the item's label, and the menu's
 * `label` row the item sits under (if any), for groups whose items are data.
 */
export type HelpLookup = (menu: string, label: string, group?: string) => HelpEntry | undefined;

/**
 * Flatten the menubar's `MenuItem[]` arrays into palette commands, so the
 * palette always offers exactly what the menus do — no second registry to
 * keep in sync. Labels and separators are structure, not commands; checkbox
 * items toggle like their menu counterparts.
 *
 * `help` attaches the help-text table. A description or keywords set on the menu
 * item itself win over the table's.
 */
export const commandsFromMenus = (
  menus: readonly (readonly [string, readonly MenuItem[]])[],
  help?: HelpLookup,
): Command[] =>
  menus.flatMap(([menu, items]) => {
    let group: string | undefined;
    return items.flatMap((item): Command[] => {
      if (item.kind === 'label') group = item.label;
      if (item.kind !== 'action' && item.kind !== 'checkbox') return [];
      const entry = help?.(menu, item.label, group);
      return [
        {
          id: `${menu}/${item.label}`,
          label: `${menu}: ${item.label}`,
          menu,
          name: item.label,
          shortcut: item.kind === 'action' ? item.shortcut : undefined,
          disabled: item.kind === 'action' ? item.disabled : undefined,
          description: item.description ?? entry?.description,
          keywords: item.keywords ?? entry?.keywords,
          href: entry ? docsHref(entry) : undefined,
          addedOn: entry?.addedOn,
          run: item.onSelect,
        },
      ];
    });
  });

/**
 * How well `c` matches the query's words, lower is better, or `null` for no match.
 *
 * Every word has to appear somewhere — in the `Menu: Item` label, a keyword or the
 * description. Where the words are found ranks the result: the label, then a keyword
 * that is exactly the word, then one that contains it, then the description. So
 * "scale" puts Resize (keyword `scale`) above an item that merely mentions scale.
 */
function matchRank(c: Command, words: readonly string[]): number | null {
  const label = c.label.toLowerCase();
  const keywords = (c.keywords ?? []).map((k) => k.toLowerCase());
  const description = (c.description ?? '').toLowerCase();
  let rank = 0;
  for (const w of words) {
    let r: number;
    if (label.includes(w)) r = 0;
    else if (keywords.includes(w)) r = 1;
    else if (keywords.some((k) => k.includes(w))) r = 2;
    else if (description.includes(w)) r = 3;
    else return null;
    rank = Math.max(rank, r);
  }
  return rank;
}

interface Group {
  menu: string;
  commands: Command[];
}

/**
 * Matching commands, grouped by menu. Groups keep menu order, except that a group
 * holding a better match comes first: the first result is what Enter runs.
 */
export function searchCommands(commands: readonly Command[], query: string): Group[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, { best: number; order: number; hits: [number, Command][] }>();
  for (const c of commands) {
    if (c.disabled) continue;
    const rank = matchRank(c, words);
    if (rank === null) continue;
    let g = groups.get(c.menu);
    if (!g) groups.set(c.menu, (g = { best: rank, order: groups.size, hits: [] }));
    g.best = Math.min(g.best, rank);
    g.hits.push([rank, c]);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.best - b.best || a.order - b.order)
    .map(([menu, g]) => ({
      menu,
      // Array.prototype.sort is stable, so equal ranks keep menu order.
      commands: g.hits.sort((a, b) => a[0] - b[0]).map(([, c]) => c),
    }));
}

/**
 * Ctrl/Cmd+K quick-command search over all menu actions. Disabled commands are
 * hidden (matching their greyed-out menu state); Enter runs the highlighted
 * match, arrows move the highlight, Escape or a backdrop click dismisses.
 *
 * The search reads each command's label, keywords and description, so "scale" finds
 * Resize and "litres" finds the volume tools. Results sit under their menu's name,
 * each with its one-line description, and a footer links the highlighted command's
 * documentation. Commands added in the last 60 days are badged "New"; `now` is the
 * clock that decides it, injectable so tests do not depend on the date.
 */
export function CommandPalette({
  commands,
  onClose,
  now = Date.now,
}: {
  commands: readonly Command[];
  onClose: () => void;
  now?: () => number;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();
  // Read once per open: a badge should not appear or vanish while the palette is up.
  const [today] = useState(now);

  const groups = useMemo(() => searchCommands(commands, query), [commands, query]);
  const visible = useMemo(() => groups.flatMap((g) => g.commands), [groups]);
  const highlighted = Math.min(active, Math.max(0, visible.length - 1));
  const current = visible[highlighted];

  const runCommand = (c: Command) => {
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (visible.length) setActive((highlighted + 1) % visible.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (visible.length) setActive((highlighted - 1 + visible.length) % visible.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) runCommand(current);
    }
  };

  let index = 0;
  return (
    <Modal
      name="command-palette"
      label="Command palette"
      onClose={onClose}
      className="flex justify-center px-4 pt-20 sm:pt-24"
    >
      <Panel
        className="flex h-fit max-h-[60vh] w-full max-w-lg flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            placeholder="Type a command…"
            aria-label="Search commands"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox">
          {groups.map((g) => {
            const headingId = `${baseId}-${g.menu}`;
            return (
              <div key={g.menu} role="group" aria-labelledby={headingId}>
                <div
                  id={headingId}
                  role="presentation"
                  className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {g.menu}
                </div>
                {g.commands.map((c) => {
                  const i = index++;
                  const fresh = isNew(c.addedOn, today);
                  const descId = `${baseId}-d${i}`;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={i === highlighted}
                      // The name stays `Menu: Item`; the description and badge are read
                      // after it rather than run into it.
                      aria-label={c.label}
                      aria-describedby={c.description || fresh ? descId : undefined}
                      className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm ${
                        i === highlighted ? 'bg-accent text-accent-foreground' : ''
                      }`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => runCommand(c)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-2">
                          {c.name}
                          {fresh && (
                            <span className="rounded bg-primary/15 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              New
                            </span>
                          )}
                        </span>
                        {(c.description || fresh) && (
                          <span id={descId} className="text-xs text-muted-foreground">
                            {fresh && <span className="sr-only">New. </span>}
                            {c.description}
                          </span>
                        )}
                      </span>
                      {c.shortcut && (
                        <span className="text-xs text-muted-foreground">{c.shortcut}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {visible.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground">No matching command</div>
          )}
        </div>
        {current?.href && (
          <div className="border-t border-border px-3 py-1.5 text-xs">
            {/* Same-tab navigation, like Help ▸ Documentation: the board is kept by the
                session store and comes back with the editor. */}
            <a
              href={current.href}
              className="inline-flex items-center text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
            >
              More about {current.name} in the docs
            </a>
          </div>
        )}
      </Panel>
    </Modal>
  );
}
