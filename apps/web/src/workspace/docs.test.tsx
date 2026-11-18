// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace is documented where a person looks for it: a section of the editing page that names every
 * step with its key and says how to turn the layout on, and the shortcuts page lists the step keys in a group
 * of their own. (`docs/coverage.test.ts` holds the registry to the shortcut table; these hold the prose to
 * the step table, which the page reads rather than copies.)
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import DocsEditing from '../pages/docs/Editing';
import DocsShortcuts from '../pages/docs/Shortcuts';
import { DESIGN_STEPS, PANEL_ENTRIES } from './steps';

// the page head needs the static-site generator's provider
vi.mock('../seo/Seo', () => ({ Seo: () => null }));

const page = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('the editing page', () => {
  it('has a workspace section, linked from its contents', () => {
    page(<DocsEditing />);
    const section = document.getElementById('workspace');
    expect(section).not.toBeNull();
    expect(
      within(section!).getByRole('heading', { name: 'The workspace (rails boards)' }),
    ).toBeTruthy();
    expect(document.querySelector('a[href="#workspace"]')).not.toBeNull();
  });

  it('names every design step with its key, in the order of the list', () => {
    page(<DocsEditing />);
    const section = document.getElementById('workspace')!;
    const terms = Array.from(section.querySelectorAll('dt')).map((dt) => dt.textContent!.trim());
    for (const [i, s] of DESIGN_STEPS.entries()) {
      expect(terms[i], s.id).toBe(`${s.label} ${s.key}`);
    }
  });

  it('names Specs, Build and Compare as the entries that are not steps', () => {
    page(<DocsEditing />);
    const section = document.getElementById('workspace')!;
    const terms = Array.from(section.querySelectorAll('dt')).map((dt) => dt.textContent!.trim());
    expect(terms.slice(DESIGN_STEPS.length)).toEqual(PANEL_ENTRIES.map((p) => p.label));
  });

  it('says how to turn it on: both experimental switches, by their names in Settings', () => {
    page(<DocsEditing />);
    const section = document.getElementById('workspace')!;
    expect(section.textContent).toContain('Engine: NURBS (experimental)');
    expect(section.textContent).toContain('Rails engine (experimental)');
    expect(section.textContent).toContain('Settings');
    expect(section.textContent).toMatch(/phone/i);
  });

  it('describes the tap, the divider and the keys', () => {
    page(<DocsEditing />);
    const text = document.getElementById('workspace')!.textContent!;
    expect(text).toContain('Tapping the board');
    expect(text).toContain('The divider');
    expect(text).toMatch(/2%/);
    expect(text).toMatch(/Home and End/);
    expect(text).toMatch(/Patches/);
  });

  it('leaves the rest of the page where it was', () => {
    page(<DocsEditing />);
    for (const id of ['views', 'guides', 'analysis', 'nurbs', 'points', 'undo']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});

describe('the shortcuts page', () => {
  it('lists the seven step keys in a Design steps group, from the shortcut table', () => {
    page(<DocsShortcuts />);
    const group = document.getElementById('design-steps')!;
    expect(group).not.toBeNull();
    expect(within(group).getByRole('heading', { name: 'Design steps' })).toBeTruthy();
    const rows = within(group).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(
      DESIGN_STEPS.map((s) => `${s.key}${s.label} step`),
    );
  });

  it('still lists the view keys, with a note that the workspace has none', () => {
    page(<DocsShortcuts />);
    const view = document.getElementById('view')!;
    expect(within(view).getByText('Quad view')).toBeTruthy();
    expect(within(view).getByText('Split view')).toBeTruthy();
    expect(view.textContent).toMatch(/workspace/);
    expect(screen.getAllByRole('link', { name: 'workspace' }).length).toBeGreaterThan(0);
  });
});
