import { Input, Panel, type MenuItem } from '@openshaper/ui';
import { useMemo, useState } from 'react';

/** One executable entry in the command palette, derived from a menu item. */
export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Flatten the menubar's `MenuItem[]` arrays into palette commands, so the
 * palette always offers exactly what the menus do — no second registry to
 * keep in sync. Labels and separators are structure, not commands; checkbox
 * items toggle like their menu counterparts.
 */
export const commandsFromMenus = (
  menus: readonly (readonly [string, readonly MenuItem[]])[],
): Command[] =>
  menus.flatMap(([menu, items]) =>
    items.flatMap((item): Command[] => {
      if (item.kind !== 'action' && item.kind !== 'checkbox') return [];
      return [
        {
          id: `${menu}/${item.label}`,
          label: `${menu}: ${item.label}`,
          shortcut: item.kind === 'action' ? item.shortcut : undefined,
          disabled: item.kind === 'action' ? item.disabled : undefined,
          run: item.onSelect,
        },
      ];
    }),
  );

/**
 * Ctrl/Cmd+K quick-command search over all menu actions. Disabled commands are
 * hidden (matching their greyed-out menu state); Enter runs the highlighted
 * match, arrows move the highlight, Escape or a backdrop click dismisses.
 */
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: readonly Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => !c.disabled && (!q || c.label.toLowerCase().includes(q)));
  }, [commands, query]);
  const highlighted = Math.min(active, Math.max(0, visible.length - 1));

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
      const c = visible[highlighted];
      if (c) runCommand(c);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/60 px-4 pt-20 sm:pt-24"
      onClick={onClose}
    >
      <Panel
        className="flex h-fit max-h-[60vh] w-full max-w-lg flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            placeholder="Type a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox">
          {visible.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                i === highlighted ? 'bg-accent text-accent-foreground' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => runCommand(c)}
            >
              <span className="flex-1">{c.label}</span>
              {c.shortcut && <span className="text-xs text-muted-foreground">{c.shortcut}</span>}
            </button>
          ))}
          {visible.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground">No matching command</div>
          )}
        </div>
      </Panel>
    </div>
  );
}
