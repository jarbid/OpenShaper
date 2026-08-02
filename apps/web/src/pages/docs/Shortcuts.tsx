// SPDX-License-Identifier: GPL-3.0-or-later
import { SHORTCUTS, type ShortcutGroup } from '../../shortcuts';
import { DocsPage, Section } from './DocsPage';

/**
 * Rendered directly from the SHORTCUTS table that the key handler and the
 * tooltips also read, so this page cannot describe a binding the app does not
 * have. Nothing here is transcribed by hand.
 */
const GROUPS: ShortcutGroup[] = ['File', 'Edit', 'View', 'Cross-sections'];

export default function DocsShortcuts() {
  return (
    <DocsPage
      route="/docs/shortcuts"
      title="Keyboard shortcuts"
      lede="Every key binding in the editor, generated from the same table the app itself uses."
      toc={GROUPS.map((g) => ({ id: g.toLowerCase().replace(/\s+/g, '-'), label: g }))}
    >
      <p className="text-muted-foreground">
        On Windows and Linux, ⌘ means Ctrl. Bindings without a modifier are ignored while you are
        typing in a text field.
      </p>

      {GROUPS.map((group) => {
        const rows = SHORTCUTS.filter((s) => s.group === group);
        if (rows.length === 0) return null;
        return (
          <Section key={group} id={group.toLowerCase().replace(/\s+/g, '-')} title={group}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="w-32 py-2 font-medium text-foreground">
                    Key
                  </th>
                  <th scope="col" className="py-2 font-medium text-foreground">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-border/60">
                    <td className="py-2">
                      <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {s.keys}
                      </kbd>
                    </td>
                    <td className="py-2">{s.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        );
      })}
    </DocsPage>
  );
}
