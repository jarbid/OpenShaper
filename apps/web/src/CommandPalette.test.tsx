import type { MenuItem } from '@openshaper/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette, commandsFromMenus, searchCommands, type Command } from './CommandPalette';
import type { HelpEntry } from './help-text';

describe('commandsFromMenus', () => {
  it('flattens actions and checkboxes, skipping labels and separators', () => {
    const open = vi.fn();
    const grid = vi.fn();
    const menus: [string, MenuItem[]][] = [
      [
        'File',
        [
          { kind: 'label', label: 'New' },
          { kind: 'action', label: 'Open…', onSelect: open, shortcut: 'Ctrl O' },
          { kind: 'separator' },
          { kind: 'action', label: 'Save', onSelect: vi.fn(), disabled: true },
        ],
      ],
      ['View', [{ kind: 'checkbox', label: 'Grid & guides', checked: false, onSelect: grid }]],
    ];

    const commands = commandsFromMenus(menus);

    expect(commands.map((c) => c.id)).toEqual(['File/Open…', 'File/Save', 'View/Grid & guides']);
    expect(commands[0]).toMatchObject({
      label: 'File: Open…',
      menu: 'File',
      name: 'Open…',
      shortcut: 'Ctrl O',
    });
    expect(commands[1]!.disabled).toBe(true);
    commands[2]!.run();
    expect(grid).toHaveBeenCalledOnce();
  });

  it('attaches help from the table, falling back to the group a data item sits under', () => {
    const table: Record<string, HelpEntry> = {
      'Board/Resize…': {
        description: 'Scales the board.',
        route: '/docs/specs',
        anchor: 'resize',
        keywords: ['scale'],
        addedOn: '2026-10-10',
      },
      'File/New/*': { description: 'A starter template.', route: '/docs/files' },
    };
    const help = (menu: string, label: string, group?: string) =>
      table[`${menu}/${label}`] ?? (group ? table[`${menu}/${group}/*`] : undefined);
    const menus: [string, MenuItem[]][] = [
      [
        'File',
        [
          { kind: 'label', label: 'New' },
          { kind: 'action', label: 'Shortboard', onSelect: vi.fn() },
          { kind: 'separator' },
          // An item's own description beats the table's.
          { kind: 'action', label: 'Open…', onSelect: vi.fn(), description: 'Own words.' },
        ],
      ],
      ['Board', [{ kind: 'action', label: 'Resize…', onSelect: vi.fn() }]],
    ];

    const [shortboard, open, resize] = commandsFromMenus(menus, help);

    expect(shortboard).toMatchObject({ description: 'A starter template.', href: '/docs/files' });
    expect(open!.description).toBe('Own words.');
    expect(resize).toMatchObject({
      description: 'Scales the board.',
      keywords: ['scale'],
      href: '/docs/specs#resize',
      addedOn: '2026-10-10',
    });
  });

  it('ends a group at the next separator, so a later item gets none of its help', () => {
    const help = (_menu: string, _label: string, group?: string) =>
      group === 'New'
        ? { description: 'A starter template.', route: '/docs/files' as const }
        : undefined;
    const [shortboard, imported] = commandsFromMenus(
      [
        [
          'File',
          [
            { kind: 'label', label: 'New' },
            { kind: 'action', label: 'Shortboard', onSelect: vi.fn() },
            { kind: 'separator' },
            { kind: 'action', label: 'Import…', onSelect: vi.fn() },
          ],
        ],
      ],
      help,
    );
    expect(shortboard!.description).toBe('A starter template.');
    expect(imported!.description).toBeUndefined();
    expect(imported!.href).toBeUndefined();
  });
});

const cmd = (menu: string, name: string, extra: Partial<Command> = {}): Command => ({
  id: `${menu}/${name}`,
  label: `${menu}: ${name}`,
  menu,
  name,
  run: vi.fn(),
  ...extra,
});

const cmds = (overrides: Partial<Command>[] = []): Command[] => [
  cmd('File', 'Open…'),
  cmd('File', 'Save'),
  cmd('View', 'Grid & guides'),
  ...overrides.map((o, i) => cmd('Extra', `Extra ${i}`, o)),
];

const option = (name: string) => screen.getByRole('option', { name });
const search = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(/command/i), { target: { value } });

describe('<CommandPalette />', () => {
  it('lists enabled commands and filters as you type', () => {
    const commands = cmds([{ label: 'Hidden', disabled: true }]);
    render(<CommandPalette commands={commands} onClose={() => {}} />);

    expect(option('File: Open…')).toBeTruthy();
    expect(screen.queryByText('Hidden')).toBeNull(); // disabled commands are not offered

    search('grid');
    expect(option('View: Grid & guides')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'File: Open…' })).toBeNull();
  });

  it('Enter runs the highlighted command and closes', () => {
    const commands = cmds();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} />);
    const input = screen.getByPlaceholderText(/command/i);

    fireEvent.change(input, { target: { value: 'save' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(commands[1]!.run).toHaveBeenCalledOnce();
    expect(commands[0]!.run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('arrow keys move the highlight before Enter', () => {
    const commands = cmds();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} />);
    const input = screen.getByPlaceholderText(/command/i);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(commands[1]!.run).toHaveBeenCalledOnce();
  });

  it('Escape closes without running anything', () => {
    const commands = cmds();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} />);

    fireEvent.keyDown(screen.getByPlaceholderText(/command/i), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    for (const c of commands) expect(c.run).not.toHaveBeenCalled();
  });
});

describe('palette search', () => {
  const resize = cmd('Board', 'Resize…', {
    description: 'Scales the board to a new length, width and thickness.',
    keywords: ['scale', 'resize'],
    href: '/docs/specs#resize',
  });
  // Earlier in menu order, and mentions "scale" only in passing.
  const lifeSize = cmd('View', 'Life-size (1:1)', {
    description: 'Zooms the 2D view to real size, at true scale.',
  });
  const volume = cmd('View', 'Volume distribution', {
    description: 'Plots how the volume is spread along the board.',
    keywords: ['volume', 'litres', 'liters'],
  });

  it('finds a command by a keyword that is not in its label', () => {
    render(<CommandPalette commands={[lifeSize, volume, resize]} onClose={() => {}} />);

    search('litres');
    expect(option('View: Volume distribution')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Board: Resize…' })).toBeNull();
  });

  it('finds a command by its description', () => {
    render(<CommandPalette commands={[lifeSize, volume, resize]} onClose={() => {}} />);

    search('spread along');
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
      'View: Volume distribution',
    ]);
  });

  it('needs every word to match somewhere', () => {
    const groups = searchCommands([lifeSize, volume, resize], 'board volume');
    expect(groups.flatMap((g) => g.commands)).toEqual([volume]);
    expect(searchCommands([lifeSize, volume, resize], 'volume nonsense')).toEqual([]);
  });

  it('ranks a keyword hit above a description hit, so Enter runs the better match', () => {
    const onClose = vi.fn();
    render(<CommandPalette commands={[lifeSize, volume, resize]} onClose={onClose} />);

    search('scale');
    // Board comes first although View precedes it in the menus.
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
      'Board: Resize…',
      'View: Life-size (1:1)',
    ]);
    fireEvent.keyDown(screen.getByPlaceholderText(/command/i), { key: 'Enter' });
    expect(resize.run).toHaveBeenCalledOnce();
    expect(lifeSize.run).not.toHaveBeenCalled();
  });

  it('groups results under their menu, with the description under each name', () => {
    render(<CommandPalette commands={[...cmds(), resize]} onClose={() => {}} />);

    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => within(g).getAllByRole('presentation')[0]!.textContent)).toEqual([
      'File',
      'View',
      'Board',
    ]);
    expect(screen.getByRole('group', { name: 'Board' })).toBeTruthy();
    const row = option('Board: Resize…');
    expect(within(row).getByText('Resize…')).toBeTruthy();
    // The description is read after the name, not run into it.
    expect(row.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(row.getAttribute('aria-describedby')!)!.textContent).toBe(
      resize.description,
    );
  });

  it('keeps arrow keys moving through the results across groups', () => {
    const commands = [...cmds(), resize];
    render(<CommandPalette commands={commands} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/command/i);

    // File: Open…, File: Save, View: Grid & guides, Board: Resize…
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(option('Board: Resize…').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(option('File: Open…').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(resize.run).toHaveBeenCalledOnce();
  });

  it('links the highlighted command to its docs', () => {
    render(<CommandPalette commands={[resize, volume]} onClose={() => {}} />);

    expect(
      screen.getByRole('link', { name: 'More about Resize… in the docs' }).getAttribute('href'),
    ).toBe('/docs/specs#resize');
    // A command with no route has nothing to link to.
    search('volume');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the "New" badge', () => {
  const day = 86_400_000;
  const today = Date.parse('2026-10-14T12:00:00Z');
  const fresh = cmd('Board', 'Resize…', { addedOn: '2026-10-10' });
  const old = cmd('Export', 'STL', { addedOn: '2026-01-01' });
  const undated = cmd('Edit', 'Undo');

  const badged = () =>
    screen
      .getAllByRole('option')
      .filter((o) => within(o).queryByText('New'))
      .map((o) => o.getAttribute('aria-label'));

  it('marks commands added within the last 60 days, by the injected clock', () => {
    render(
      <CommandPalette commands={[fresh, old, undated]} onClose={() => {}} now={() => today} />,
    );
    expect(badged()).toEqual(['Board: Resize…']);
  });

  it('drops the badge once 60 days have passed', () => {
    const later = Date.parse('2026-10-10T00:00:00Z') + 61 * day;
    render(
      <CommandPalette commands={[fresh, old, undated]} onClose={() => {}} now={() => later} />,
    );
    expect(badged()).toEqual([]);
  });
});
