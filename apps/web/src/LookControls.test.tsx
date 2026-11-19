// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace's Look and Show controls: what the Look button says, the three groups, what a choice
 * changes in the settings, the rows that cannot be chosen and their reasons, Show's guides, wireframe,
 * normals and mesh quality, and that a new callback or an equal reason does not render the menus again.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { lengthUnitByKey } from './format';
import { LOOKS } from './look';
import { swatchFor, WorkspaceLooks } from './LookControls';
import { swallowBoard } from './test/swallow-board';
import {
  DEFAULT_VIEW_3D,
  exactAnalysisUnavailable,
  ghostDeviationUnavailable,
  type View3DSettings,
} from './view3d-settings';

/** How often a menu button has rendered, to see what the shell's re-render reaches. */
const menuRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./menu-button', async (importOriginal) => {
  const real = await importOriginal<typeof import('./menu-button')>();
  return {
    ...real,
    MenuButton: (props: React.ComponentProps<typeof real.MenuButton>) => {
      menuRenders.count++;
      return real.MenuButton(props);
    },
  };
});

const MM = lengthUnitByKey('mm');
const settings = (patch: Partial<View3DSettings> = {}): View3DSettings => ({
  ...DEFAULT_VIEW_3D,
  ...patch,
});

function setup(
  patch: Partial<View3DSettings> = {},
  props: Partial<React.ComponentProps<typeof WorkspaceLooks>> = {},
) {
  const onChange = vi.fn();
  const view = render(
    <WorkspaceLooks settings={settings(patch)} onChange={onChange} units={MM} patches {...props} />,
  );
  return { onChange, ...view };
}

const lookButton = () => screen.getByRole('button', { name: /^Look/ });
const showButton = () => screen.getByRole('button', { name: 'Show' });
const lookMenu = () => screen.getByRole('menu', { name: 'Look' });
const showMenu = () => screen.getByRole('menu', { name: 'Show' });
const names = (items: HTMLElement[]) => items.map((i) => i.textContent);

describe('the Look button', () => {
  it('says the look the settings show, and carries its id', () => {
    setup();
    expect(lookButton().getAttribute('aria-label')).toBe('Look: Glassed gloss');
    expect(lookButton().getAttribute('data-look')).toBe('gloss');
  });

  it('reads every look: its name for the button, whatever else the settings hold', () => {
    const cases: [Partial<View3DSettings>, string, string][] = [
      [{ analysis: 'patches' }, 'Patches', 'patches'],
      [{ analysis: 'zebra' }, 'Zebra', 'zebra'],
      [{ analysis: 'curvature' }, 'Normal change (approx.)', 'curvature'],
      [{ analysis: 'none', material: 'foam' }, 'Raw foam', 'foam'],
      [
        { analysis: 'none', material: 'matte', lighting: 'neutral', mode: 'wireframe' },
        'Matte',
        'matte',
      ],
      // not a look the workspace offers: it reads as the realistic look of the material
      [{ analysis: 'nurbs-deviation', material: 'foam' }, 'Raw foam', 'foam'],
    ];
    for (const [patch, label, id] of cases) {
      const { unmount } = setup(patch);
      expect(lookButton().getAttribute('aria-label'), id).toBe(`Look: ${label}`);
      expect(lookButton().getAttribute('data-look'), id).toBe(id);
      unmount();
    }
  });

  it('shows a swatch of the board colour for a realistic look, and of the look’s own colours otherwise', () => {
    const real = LOOKS.find((l) => l.id === 'gloss')!;
    const zebra = LOOKS.find((l) => l.id === 'zebra')!;
    const patches = LOOKS.find((l) => l.id === 'patches')!;
    expect(swatchFor(real, '#123456')).toBe('#123456');
    expect(swatchFor(zebra, '#123456')).toMatch(/repeating-linear-gradient/);
    expect(swatchFor(patches, '#123456')).toMatch(/linear-gradient/);
    // each look has one, and only a realistic one follows the board colour
    for (const l of LOOKS) {
      expect(swatchFor(l, '#abcdef') === '#abcdef', l.id).toBe(l.group === 'realistic');
    }
  });
});

describe('the Look menu', () => {
  it('has the three groups, with every look in its group', () => {
    setup();
    fireEvent.click(lookButton());
    const group = (name: string) => within(screen.getByRole('group', { name }));
    expect(names(group('Shaping').getAllByRole('menuitemradio'))).toEqual(['Patches']);
    expect(names(group('Surface').getAllByRole('menuitemradio'))).toEqual([
      'Zebra',
      'Mean curvature',
      'Gaussian curvature',
      'Rail radius',
      'Normal change (approx.)',
      'Slope',
      'Deviation from ghost',
    ]);
    // the realistic group holds the light as a group of its own, and the board colour
    const realistic = group('Realistic');
    expect(names(realistic.getAllByRole('menuitemradio'))).toEqual([
      'Glassed gloss',
      'Raw foam',
      'Matte',
      'Studio',
      'Shaping bay',
      'Neutral',
    ]);
    expect(realistic.getByRole('group', { name: 'Light' })).toBeTruthy();
    expect(realistic.getByRole('menuitem', { name: 'Board colour' })).toBeTruthy();
  });

  it('marks the current look, and the current light, and no other', () => {
    setup({ analysis: 'zebra', lighting: 'shaping-bay' });
    fireEvent.click(lookButton());
    const checked = within(lookMenu())
      .getAllByRole('menuitemradio')
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(names(checked)).toEqual(['Zebra', 'Shaping bay']);
  });

  it('chooses a look: its analysis, and a realistic look’s material, and closes', () => {
    const { onChange } = setup();
    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Zebra' }));
    expect(onChange).toHaveBeenLastCalledWith({ analysis: 'zebra' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Raw foam' }));
    expect(onChange).toHaveBeenLastCalledWith({ analysis: 'none', material: 'foam' });

    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Patches' }));
    expect(onChange).toHaveBeenLastCalledWith({ analysis: 'patches' });
  });

  it('chooses the light without changing the look, and stays open for the next', () => {
    const { onChange } = setup({ analysis: 'zebra' });
    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shaping bay' }));
    expect(onChange).toHaveBeenLastCalledWith({ lighting: 'shaping-bay' });
    expect(lookMenu()).toBeTruthy();
  });

  it('chooses the board colour through the colour input, which is outside the menu', () => {
    const { onChange } = setup();
    const input = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(input.value).toBe('#e8eef5');
    expect(input.getAttribute('aria-label')).toBe('Board colour');
    fireEvent.click(lookButton());
    expect(lookMenu().contains(input)).toBe(false);
    fireEvent.change(input, { target: { value: '#112233' } });
    expect(onChange).toHaveBeenLastCalledWith({ color: '#112233' });
  });

  it('opens the browser’s colour picker from the Board colour row', () => {
    setup();
    const input = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    const showPicker = vi.fn();
    Object.defineProperty(input, 'showPicker', { value: showPicker, configurable: true });
    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Board colour' }));
    expect(showPicker).toHaveBeenCalledTimes(1);
    // the menu closes, and the input it belongs to stays, so the picker is not taken down with it
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.body.contains(input)).toBe(true);
  });

  it('falls back to a click on the input where the picker cannot be shown', () => {
    setup();
    const input = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    Object.defineProperty(input, 'showPicker', {
      value: () => {
        throw new DOMException('not allowed', 'NotAllowedError');
      },
      configurable: true,
    });
    const click = vi.spyOn(input, 'click');
    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Board colour' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('lists a look that cannot be drawn, disabled, with its reason', () => {
    const exact = exactAnalysisUnavailable(swallowBoard())!;
    const ghost = ghostDeviationUnavailable(null)!;
    const { onChange } = setup(
      {},
      { exactUnavailable: exact, ghostUnavailable: ghost, patches: false },
    );
    fireEvent.click(lookButton());
    const blocked: [string, string, string][] = [
      ['Mean curvature (not for concave tails)', exact.reason, 'mean-curvature'],
      ['Gaussian curvature (not for concave tails)', exact.reason, 'gaussian-curvature'],
      ['Rail radius (not for concave tails)', exact.reason, 'rail-radius'],
      ['Deviation from ghost (load a ghost first)', ghost.reason, 'ghost-deviation'],
      ['Patches (needs the rails engine)', '', 'patches'],
    ];
    for (const [name, reason] of blocked) {
      const row = screen.getByRole('menuitemradio', { name });
      expect(row.getAttribute('aria-disabled'), name).toBe('true');
      expect(row.getAttribute('title')?.startsWith(reason), name).toBe(true);
      fireEvent.click(row);
    }
    expect(onChange).not.toHaveBeenCalled();
    // the ones that need nothing are as they were
    expect(
      screen.getByRole('menuitemradio', { name: 'Zebra' }).getAttribute('aria-disabled'),
    ).toBeNull();
    expect(
      screen.getByRole('menuitemradio', { name: 'Slope' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });
});

describe('the deviation band', () => {
  const ready = { ghostUnavailable: null, exactUnavailable: null };

  it('stands beside the Look button with Deviation from ghost, when a ghost is loaded', () => {
    const { onChange } = setup({ analysis: 'ghost-deviation' }, ready);
    const band = screen.getByRole('slider', { name: 'Deviation band' });
    fireEvent.change(band, { target: { value: '1' } });
    expect(onChange).toHaveBeenLastCalledWith({ deviationBand: 1 });
  });

  it('is not there under another look, nor without a ghost, nor for “Deviation from classic”', () => {
    setup({ analysis: 'zebra' }, ready);
    expect(screen.queryByRole('slider', { name: 'Deviation band' })).toBeNull();
    setup({ analysis: 'ghost-deviation' }, { ghostUnavailable: ghostDeviationUnavailable(null) });
    expect(screen.queryAllByRole('slider', { name: 'Deviation band' })).toHaveLength(0);
    setup({ analysis: 'nurbs-deviation' }, ready);
    expect(screen.queryAllByRole('slider', { name: 'Deviation band' })).toHaveLength(0);
  });
});

describe('the Show menu', () => {
  it('has the guides, the wireframe, the normals and the mesh quality, with their state', () => {
    setup({ showApex: true, meshQuality: 'fine' });
    fireEvent.click(showButton());
    const guides = within(screen.getByRole('group', { name: 'Guides' }));
    expect(
      guides
        .getAllByRole('menuitemcheckbox')
        .map((r) => [r.textContent, r.getAttribute('aria-checked')]),
    ).toEqual([
      ['Stringer', 'false'],
      ['Stations', 'false'],
      ['Apex line', 'true'],
    ]);
    const wire = within(screen.getByRole('group', { name: 'Wireframe' }));
    expect(
      wire
        .getAllByRole('menuitemradio')
        .map((r) => [r.textContent, r.getAttribute('aria-checked')]),
    ).toEqual([
      ['Off', 'true'],
      ['Over the surface', 'false'],
      ['Alone', 'false'],
    ]);
    expect(showMenu().querySelector('[role="menuitemcheckbox"][aria-checked="true"]')).toBeTruthy();
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Normals' }).getAttribute('aria-checked'),
    ).toBe('false');
    const quality = within(screen.getByRole('group', { name: 'Mesh quality' }));
    expect(
      quality
        .getAllByRole('menuitemradio')
        .map((r) => [r.textContent, r.getAttribute('aria-checked')]),
    ).toEqual([
      ['Draft', 'false'],
      ['Standard', 'false'],
      ['Fine', 'true'],
    ]);
  });

  it('switches the guides, one setting each, and stays open', () => {
    const { onChange } = setup({ showSections: true });
    fireEvent.click(showButton());
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Stringer' }));
    expect(onChange).toHaveBeenLastCalledWith({ showStringer: true });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Stations' }));
    expect(onChange).toHaveBeenLastCalledWith({ showSections: false });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Apex line' }));
    expect(onChange).toHaveBeenLastCalledWith({ showApex: true });
    expect(showMenu()).toBeTruthy();
  });

  it('chooses the wireframe, the normals and the mesh quality', () => {
    const { onChange } = setup();
    fireEvent.click(showButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Over the surface' }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'shaded-wire' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Alone' }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'wireframe' });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Normals' }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'normals' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Draft' }));
    expect(onChange).toHaveBeenLastCalledWith({ meshQuality: 'draft' });
  });

  it('reads the normals as on with the wireframe Off, and turns them off to the plain surface', () => {
    const { onChange } = setup({ mode: 'normals' });
    fireEvent.click(showButton());
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Normals' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Off' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Normals' }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'shaded' });
  });

  it('lists the wireframe and the normals disabled, with the reason, under a look that paints the board itself', () => {
    for (const analysis of ['patches', 'zebra'] as const) {
      const { onChange, unmount } = setup({ analysis });
      fireEvent.click(showButton());
      const group = within(screen.getByRole('group', { name: 'Wireframe and normals' }));
      expect(group.getByText('realistic looks only')).toBeTruthy();
      for (const name of ['Off', 'Over the surface', 'Alone', 'Normals']) {
        const row = group.getByRole(name === 'Normals' ? 'menuitemcheckbox' : 'menuitemradio', {
          name,
        });
        expect(row.getAttribute('aria-disabled'), `${analysis} ${name}`).toBe('true');
        expect(row.getAttribute('title')).toMatch(/realistic looks/);
        fireEvent.click(row);
      }
      expect(onChange).not.toHaveBeenCalled();
      // the guides and the mesh quality have an effect under every look
      expect(
        screen.getByRole('menuitemcheckbox', { name: 'Stringer' }).getAttribute('aria-disabled'),
      ).toBeNull();
      expect(
        screen.getByRole('menuitemradio', { name: 'Draft' }).getAttribute('aria-disabled'),
      ).toBeNull();
      unmount();
    }
  });

  it('has the wireframe and the normals available under every realistic look', () => {
    setup({ analysis: 'none', material: 'matte' });
    fireEvent.click(showButton());
    const rows = screen
      .getByRole('group', { name: 'Wireframe and normals' })
      .querySelectorAll('[role^="menuitem"]');
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('the two menus', () => {
  it('open one at a time: a press on the other button closes the first', () => {
    setup();
    fireEvent.click(lookButton());
    expect(lookMenu()).toBeTruthy();
    fireEvent.pointerDown(showButton());
    fireEvent.click(showButton());
    expect(screen.queryByRole('menu', { name: 'Look' })).toBeNull();
    expect(showMenu()).toBeTruthy();
  });

  it('close on Escape and return focus to their own button', () => {
    setup();
    for (const [button, name] of [
      [lookButton, 'Look'],
      [showButton, 'Show'],
    ] as const) {
      fireEvent.click(button());
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('menu', { name }), name).toBeNull();
      expect(document.activeElement, name).toBe(button());
    }
  });
});

describe('rendering', () => {
  it('does not render the menus again for a new callback or an equal reason, and does when a setting changes', () => {
    const board = swallowBoard();
    const again = (patch: Partial<View3DSettings> = {}) => (
      // what the shell does on every drag move: a new callback, and new objects that say the same
      <WorkspaceLooks
        settings={{ ...DEFAULT_VIEW_3D, ...patch }}
        onChange={() => undefined}
        units={MM}
        patches
        exactUnavailable={exactAnalysisUnavailable(board)}
        ghostUnavailable={ghostDeviationUnavailable(null)}
      />
    );
    const settled = settings();
    const view = render(
      <WorkspaceLooks
        settings={settled}
        onChange={() => undefined}
        units={MM}
        patches
        exactUnavailable={exactAnalysisUnavailable(board)}
        ghostUnavailable={ghostDeviationUnavailable(null)}
      />,
    );
    const first = menuRenders.count;
    expect(first).toBeGreaterThanOrEqual(2);
    view.rerender(
      <WorkspaceLooks
        settings={settled}
        onChange={() => undefined}
        units={MM}
        patches
        exactUnavailable={exactAnalysisUnavailable(board)}
        ghostUnavailable={ghostDeviationUnavailable(null)}
      />,
    );
    expect(menuRenders.count).toBe(first);
    // a setting that changed is drawn
    view.rerender(again({ analysis: 'zebra' }));
    expect(menuRenders.count).toBeGreaterThan(first);
  });

  it('calls the latest callback the shell gave, not the first', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <WorkspaceLooks settings={DEFAULT_VIEW_3D} onChange={first} units={MM} patches />,
    );
    view.rerender(
      <WorkspaceLooks settings={DEFAULT_VIEW_3D} onChange={second} units={MM} patches />,
    );
    fireEvent.click(lookButton());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Zebra' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ analysis: 'zebra' });
  });
});
