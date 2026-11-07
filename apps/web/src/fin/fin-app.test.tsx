// SPDX-License-Identifier: GPL-3.0-or-later
import {
  defaultFinDesign,
  defaultKeel,
  defaultSingleFin,
  defaultTwinFin,
  finReadouts,
  placeOnBase,
} from '@openshaper/kernel';
import { writeFinJson } from '@openshaper/io';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinApp } from './FinApp';

// No WebGL under jsdom: the preview is checked in a real browser instead.
vi.mock('@openshaper/render3d', () => ({ FinPreview3D: () => null }));
import { finStore } from './fin-store';

beforeEach(() => {
  act(() => finStore.getState().load(defaultFinDesign('side', 'left')));
});

const measurements = () => within(screen.getByLabelText('Fin measurements'));
/** The Export menu's item `name`, the menu opened first if it is closed. */
const exportItem = (name: string) => {
  if (!screen.queryByRole('menuitem', { name })) {
    fireEvent.click(screen.getByRole('menuitem', { name: /^Export/ }));
  }
  return screen.getByRole('menuitem', { name }) as HTMLButtonElement;
};
/** The Export menu's left-and-right option, or null for a fin without a side. */
const pairOption = () => {
  if (!screen.queryByRole('menuitem', { name: 'STEP for CNC' })) {
    fireEvent.click(screen.getByRole('menuitem', { name: /^Export/ }));
  }
  return screen.queryByRole('menuitemcheckbox', { name: /^Left and right fin/ });
};
/** Start a new fin from the header's New fin menu. */
const pickNewFin = (label: string) => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'New fin' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};
const overhang = () => finReadouts(finStore.getState().design!).frontOverhang;

/** Tests that build real geometry (STEP export, many pointer probes): CI runners are slower. */
const HEAVY = 20_000;

describe('FinApp', () => {
  it('shows the fin’s measurements in mm', () => {
    render(<FinApp />);
    expect(screen.getByRole('heading', { name: 'OpenFinShaper' })).toBeTruthy();
    expect(measurements().getByText(/mm²$/)).toBeTruthy();
    expect(measurements().getByText('49.8°')).toBeTruthy(); // the default sweep
  });

  it('shows lengths in inches to the chosen fraction from File settings, remembered', () => {
    localStorage.removeItem('bs.fin.settings');
    const { unmount } = render(<FinApp />);
    const depth = () => measurements().getByText('Depth').nextElementSibling!.textContent;
    expect(depth()).toMatch(/ mm$/);
    fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
    const dialog = within(screen.getByRole('dialog', { name: 'File settings' }));
    fireEvent.click(dialog.getByRole('radio', { name: 'Inches' }));
    expect(depth()).toMatch(/"$/);
    expect(measurements().getByText(/in²$/)).toBeTruthy();
    // To the nearest half inch: nothing finer than a half shows.
    fireEvent.change(dialog.getByLabelText('Inch fraction'), { target: { value: '2' } });
    expect(depth()).toMatch(/^\d+( 1\/2)?"$/);
    // Fields take inches: the profile's depth field shows its value in inches.
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
    unmount();
    render(<FinApp />);
    expect(depth()).toMatch(/^\d+( 1\/2)?"$/);
    localStorage.removeItem('bs.fin.settings');
  });

  it('offers the grid sizes for the unit, and back to Auto when the unit changes', () => {
    localStorage.removeItem('bs.fin.settings');
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
    const dialog = within(screen.getByRole('dialog', { name: 'File settings' }));
    const grid = () => dialog.getByLabelText('Grid size') as HTMLSelectElement;
    expect([...grid().options].map((o) => o.text)).toEqual([
      'Auto (follows zoom)',
      '1 mm',
      '5 mm',
      '10 mm',
    ]);
    fireEvent.change(grid(), { target: { value: '1' } }); // 5 mm
    expect(JSON.parse(localStorage.getItem('bs.fin.settings')!).grid).toBe(0.5);
    fireEvent.click(dialog.getByRole('radio', { name: 'Inches' }));
    expect(grid().selectedOptions[0]!.text).toBe('Auto (follows zoom)');
    expect([...grid().options].map((o) => o.text).slice(1)).toEqual(['1/8"', '1/4"', '1/2"', '1"']);
    localStorage.removeItem('bs.fin.settings');
  });

  it(
    'checks the fin against a panel set in File settings, and fits it to the panel',
    () => {
      localStorage.removeItem('bs.fin.settings');
      localStorage.removeItem('bs.fin.views');
      act(() =>
        finStore.getState().load(placeOnBase(defaultFinDesign('side', 'left'), 'fcs-single')),
      );
      // A cambered foil, its inside face curved: turning it in the panel helps.
      act(() => {
        finStore.getState().applyNaca('2412');
      });
      render(<FinApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Show Foil in the large pane' }));
      expect(screen.queryByRole('group', { name: 'Panel' })).toBeNull(); // no panel yet
      fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
      const dialog = within(screen.getByRole('dialog', { name: 'File settings' }));
      const panel = dialog.getByLabelText('Panel thickness');
      fireEvent.change(panel, { target: { value: '9.525' } });
      fireEvent.keyDown(panel, { key: 'Enter' });
      expect(finStore.getState().design!.panel!.thickness).toBeCloseTo(0.9525, 12);
      expect(finStore.getState().design!.panel!.angle).toBe(0);
      fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
      expect(
        screen.getByText(/^Fits the 9\.5 mm panel: needs 8\.\d mm, tab included\.$/),
      ).toBeTruthy();
      // Too thin a panel: a warning, but the fin still exports.
      act(() => {
        finStore.getState().setPanelThickness(0.635);
      });
      expect(screen.getByTestId('panel-warning').textContent).toMatch(
        /Too thick for the 6\.4 mm panel/,
      );
      expect(exportItem('STEP for CNC').disabled).toBe(false);
      // Fit to panel turns the fin, undoably; the angle field follows.
      const tools = within(screen.getByRole('group', { name: 'Panel' }));
      fireEvent.click(tools.getByRole('button', { name: 'Fit to panel' }));
      expect(finStore.getState().past.at(-1)!.label).toBe('Fit to panel');
      const angle = finStore.getState().design!.panel!.angle;
      expect(angle).toBeLessThan(-0.5);
      expect((tools.getByLabelText(/^Panel angle/) as HTMLInputElement).value).toBe(
        angle.toFixed(1),
      );
      // Emptying the field clears the panel.
      fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
      const field = within(screen.getByRole('dialog', { name: 'File settings' })).getByLabelText(
        'Panel thickness',
      );
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(finStore.getState().design!.panel).toBeUndefined();
      expect(screen.queryByTestId('panel-warning')).toBeNull();
      localStorage.removeItem('bs.fin.settings');
      localStorage.removeItem('bs.fin.views');
    },
    HEAVY,
  );

  it(
    'shows a canted fin in its panel from behind, in the 3D view, and tilts the panel to fit it',
    () => {
      localStorage.removeItem('bs.fin.settings');
      localStorage.removeItem('bs.fin.views');
      act(() => finStore.getState().load(defaultKeel()));
      render(<FinApp />);
      const view3d = within(screen.getByRole('region', { name: '3D' }));
      // No panel yet: nothing to fit.
      const button = () => view3d.getByRole('button', { name: 'Panel fit' }) as HTMLButtonElement;
      expect(button().disabled).toBe(true);
      act(() => {
        finStore.getState().setPanelThickness(0.9525);
      });
      // Upright, the keel's leaning blade needs far more than its panel.
      expect(screen.getByTestId('panel-warning').textContent).toMatch(
        /Too thick for the 9\.5 mm panel/,
      );
      fireEvent.click(button());
      expect(button().getAttribute('aria-pressed')).toBe('true');
      const tools = within(view3d.getByRole('group', { name: 'Panel fit' }));
      fireEvent.click(tools.getByRole('button', { name: 'Fit to panel' }));
      expect(finStore.getState().past.at(-1)!.label).toBe('Fit to panel');
      const tilt = finStore.getState().design!.panel!.tilt!;
      expect(tilt).toBeGreaterThan(0);
      expect((tools.getByLabelText(/^Tilt/) as HTMLInputElement).value).toBe(tilt.toFixed(1));
      expect(screen.queryByTestId('panel-warning')).toBeNull();
      expect(screen.getByText(/^Fits the 9\.5 mm panel .*tilted \d+\.\d°: needs/)).toBeTruthy();
      // Typing a tilt sets it; Panel fit again goes back to the view beside the fin.
      const field = tools.getByLabelText(/^Tilt/);
      fireEvent.change(field, { target: { value: '0' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(finStore.getState().design!.panel!.tilt).toBeUndefined();
      fireEvent.click(button());
      expect(button().getAttribute('aria-pressed')).toBe('false');
      expect(tools.queryByLabelText(/^Tilt/)).toBeNull();
      localStorage.removeItem('bs.fin.settings');
      localStorage.removeItem('bs.fin.views');
    },
    HEAVY,
  );

  it('sets the core export’s laminate from File settings', () => {
    localStorage.removeItem('bs.fin.core');
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
    const dialog = within(screen.getByRole('dialog', { name: 'File settings' }));
    const ply = dialog.getByLabelText('Laminate thickness, per face');
    fireEvent.change(ply, { target: { value: '0.4' } });
    fireEvent.keyDown(ply, { key: 'Enter' });
    fireEvent.click(dialog.getByRole('radio', { name: 'Outside' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Include the tab' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
    fireEvent.click(exportItem('Core to laminate over…'));
    const core = within(screen.getByRole('dialog', { name: 'Export core' }));
    expect((core.getByLabelText('Laminate thickness') as HTMLInputElement).value).toBe('0.40');
    expect((core.getByRole('radio', { name: 'Outside' }) as HTMLInputElement).checked).toBe(true);
    expect(
      (core.getByRole('checkbox', { name: 'Include the tab' }) as HTMLInputElement).checked,
    ).toBe(true);
    localStorage.removeItem('bs.fin.core');
  });

  it('starts a new fin from the picker, undoably', () => {
    render(<FinApp />);
    pickNewFin('Centre');
    expect(finStore.getState().design!.position).toBe('centre');
    expect(screen.queryByLabelText(/Cant/)).toBeNull(); // a centre fin has no cant
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(finStore.getState().design!.position).toBe('side');
  });

  it.each([
    ['Twin fin, right', 'right'],
    ['Keel, left', 'left'],
  ] as const)('starts a %s from the picker', (label, hand) => {
    render(<FinApp />);
    pickNewFin(label);
    const d = finStore.getState().design!;
    expect([d.position, d.hand, d.cant, d.base]).toEqual(['side', hand, 7, 'futures-side']);
    const make = label.startsWith('Twin') ? defaultTwinFin : defaultKeel;
    expect(d.outline).toEqual(make(hand).outline);
  });

  it('switches the side', () => {
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    expect(finStore.getState().design!.hand).toBe('right');
    expect(screen.getByRole('button', { name: 'Right' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('nudges the fin with the arrow buttons and the arrow keys', () => {
    render(<FinApp />);
    const before = overhang();
    fireEvent.click(screen.getByRole('button', { name: 'Move the fin forward' }));
    expect(overhang()).toBeCloseTo(before + 0.05, 9);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(overhang()).toBeCloseTo(before + 0.1, 9);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(overhang()).toBeCloseTo(before + 0.05, 9);
    // Left/right follow the view from above, so which is outboard depends on the hand.
    const hand = finStore.getState().design!.hand;
    fireEvent.keyDown(window, { key: hand === 'right' ? 'ArrowRight' : 'ArrowLeft' });
    expect(finStore.getState().design!.lateralOffset).toBeCloseTo(0.01, 12);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(finStore.getState().design!.lateralOffset).toBe(0);
  });

  it('slides the blade left and right as the view from above shows it, for either hand', () => {
    render(<FinApp />);
    const offset = () => finStore.getState().design!.lateralOffset;
    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Slide the blade left (outboard)' }));
    expect(offset()).toBeCloseTo(0.01, 12);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(offset()).toBeCloseTo(0, 12);
    // A right fin is the mirror image: its outside face is on the right from above.
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    const start = offset();
    fireEvent.click(screen.getByRole('button', { name: 'Slide the blade right (outboard)' }));
    expect(offset()).toBeCloseTo(start + 0.01, 12);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(offset()).toBeCloseTo(start, 12);
  });

  it('on a US box, has forward and back arrows only, sliding the blade along the head', () => {
    act(() => finStore.getState().load(defaultSingleFin()));
    render(<FinApp />);
    expect(screen.queryByRole('button', { name: /Slide the blade (left|right)/ })).toBeNull();
    const te = () => {
      const k = finStore.getState().design!.outline.knots;
      return k[k.length - 1]!.end.x;
    };
    const before = te();
    fireEvent.click(screen.getByRole('button', { name: 'Slide the blade back along the head' }));
    expect(te()).toBeCloseTo(before - 0.05, 9);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(te()).toBeCloseTo(before, 9);
    // Left and right keys do nothing here.
    const lateral = finStore.getState().design!.lateralOffset;
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(finStore.getState().design!.lateralOffset).toBe(lateral);
  });

  it.each([
    ['a centre fin', () => defaultFinDesign('centre')],
    ['a US box fin', () => defaultSingleFin()],
  ])('greys out toe for %s, and keeps the view from above', (_, make) => {
    act(() => finStore.getState().load(make()));
    render(<FinApp />);
    const toe = within(screen.getByRole('group', { name: 'Toe' }));
    expect((toe.getByRole('button', { name: 'Toe in' }) as HTMLButtonElement).disabled).toBe(true);
    expect((toe.getByRole('button', { name: 'Toe out' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'View from above' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps toe for a side fin', () => {
    render(<FinApp />);
    const toe = within(screen.getByRole('group', { name: 'Toe' }));
    expect((toe.getByRole('button', { name: 'Toe in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clamps the cant field to the allowed range', () => {
    render(<FinApp />);
    const field = screen.getByLabelText(/Cant/);
    fireEvent.change(field, { target: { value: '35' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(finStore.getState().design!.cant).toBe(20);
  });

  it('swaps a small view into the large pane, bringing its controls with it', () => {
    localStorage.removeItem('bs.fin.views');
    render(<FinApp />);
    const pane = (name: string) => screen.getByRole('region', { name });
    expect(screen.getByLabelText(/^Depth/)).toBeTruthy(); // the profile is large
    expect(screen.queryByLabelText(/^Base thickness/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Thickness in the large pane' }));
    expect(screen.getByLabelText(/^Base thickness/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Depth/)).toBeNull();
    // The profile took the thickness view's place among the small panes.
    expect(pane('Thickness').dataset.slot).toBe('main');
    expect(pane('Profile').dataset.slot).toBe('small-2');
    expect(within(pane('Profile')).getByRole('button', { name: /in the large pane/ })).toBeTruthy();
    localStorage.removeItem('bs.fin.views');
  });

  it('keeps the 3D view’s controls under it when it is small', () => {
    localStorage.removeItem('bs.fin.views');
    render(<FinApp />);
    const threeD = within(screen.getByRole('region', { name: '3D' }));
    expect(threeD.getByRole('button', { name: 'Move the fin forward' })).toBeTruthy();
    expect(threeD.getByLabelText(/Cant/)).toBeTruthy();
  });

  it('adds, deletes and smooths points from the toolbar', () => {
    localStorage.removeItem('bs.fin.views');
    render(<FinApp />);
    const tools = within(screen.getByRole('region', { name: 'Profile' })).getByRole('group', {
      name: 'Point tools',
    });
    const button = (name: string) => within(tools).getByRole('button', { name });
    // Nothing selected: greyed out.
    expect((button('Add a point') as HTMLButtonElement).disabled).toBe(true);
    const n = finStore.getState().design!.outline.knots.length;
    act(() => finStore.getState().select({ curve: 'outline', index: 1, kind: 'end' }));
    fireEvent.click(button('Add a point'));
    expect(finStore.getState().design!.outline.knots).toHaveLength(n + 1);
    expect(finStore.getState().selection!.index).toBe(2); // the new point
    fireEvent.click(button('Corner'));
    expect(finStore.getState().design!.outline.knots[2]!.continuous).toBe(false);
    expect(button('Corner').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button('Smooth'));
    expect(finStore.getState().design!.outline.knots[2]!.continuous).toBe(true);
    fireEvent.click(button('Delete the selected point'));
    expect(finStore.getState().design!.outline.knots).toHaveLength(n);
  });

  it('won’t delete or smooth a curve’s end point', () => {
    localStorage.removeItem('bs.fin.views');
    render(<FinApp />);
    act(() => finStore.getState().select({ curve: 'outline', index: 0, kind: 'end' }));
    const tools = within(screen.getByRole('region', { name: 'Profile' }));
    expect(
      (tools.getByRole('button', { name: 'Delete the selected point' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((tools.getByRole('button', { name: 'Smooth' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((tools.getByRole('button', { name: 'Add a point' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it(
    'adds a foil slice from the profile, edits it from its tab, and removes it',
    () => {
      localStorage.removeItem('bs.fin.views');
      render(<FinApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Add control section' }));
      const d = () => finStore.getState().design!;
      expect(d().slices).toHaveLength(1);
      expect(d().slices[0]!.height).toBe(0.5); // halfway up: the biggest gap
      // The foil view's tools come with it into the large pane.
      fireEvent.click(screen.getByRole('button', { name: 'Show Foil in the large pane' }));
      const tabs = within(screen.getByRole('tablist', { name: 'Foil' }));
      expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual([
        'Base',
        'Tip',
        '50.0 mm',
      ]);
      expect(screen.getByTestId('foil-title').textContent).toMatch(/^Control section 50\.0 mm/);
      expect(tabs.getByRole('tab', { name: '50.0 mm' }).getAttribute('aria-selected')).toBe('true');
      fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: '0008' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(d().slices[0]!.section.inside).toBeNull(); // the slice took the NACA foil
      expect(d().section.inside).not.toBeNull(); // the root kept its flat inside
      fireEvent.click(tabs.getByRole('tab', { name: 'Tip' }));
      expect(finStore.getState().activeFoil).toBe(-1);
      expect(screen.getByTestId('foil-title').textContent).toMatch(/^Tip foil/);
      // The tip foil is its own: a preset here leaves the base foil alone.
      fireEvent.change(screen.getByLabelText('NACA preset'), { target: { value: '2410' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(d().tipSection).toBeDefined();
      expect(d().section.inside).not.toBeNull();
      fireEvent.click(tabs.getByRole('tab', { name: 'Base' }));
      expect(finStore.getState().activeFoil).toBe(0);
      expect(screen.getByTestId('foil-title').textContent).toMatch(/^Base foil/);
      // Remove slice sits beside Add slice in the profile's toolbar, not in the foil view's.
      expect(screen.queryByRole('button', { name: 'Remove control section' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show Profile in the large pane' }));
      const remove = () =>
        screen.getByRole('button', { name: 'Remove control section' }) as HTMLButtonElement;
      expect(remove().disabled).toBe(true); // the root is selected: no slice to remove
      act(() => finStore.getState().setActiveFoil(1));
      expect(remove().disabled).toBe(false);
      fireEvent.click(remove());
      expect(d().slices).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Remove control section' })).toBeNull(); // none left
      localStorage.removeItem('bs.fin.views');
    },
    HEAVY,
  ); // makes a slice from the fin, which builds its section

  it('moves a fin onto the FCS single tab: centred, cant set by the plug', () => {
    render(<FinApp />);
    fireEvent.change(screen.getByLabelText('Tab'), { target: { value: 'fcs-single' } });
    const d = finStore.getState().design!;
    expect(d.base).toBe('fcs-single');
    expect(d.cant).toBe(0);
    expect((screen.getByLabelText(/^Cant/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/on FCS single \(20\.5 mm × 13\.5 mm\)/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull(); // no rule broken
    fireEvent.change(screen.getByLabelText('Tab'), { target: { value: 'futures-side' } });
    expect((screen.getByLabelText(/^Cant/) as HTMLInputElement).disabled).toBe(false);
  });

  it('starts a canard on the FCS single tab', () => {
    render(<FinApp />);
    pickNewFin('Canard, right (FCS single)');
    const d = finStore.getState().design!;
    expect(d.base).toBe('fcs-single');
    expect(d.hand).toBe('right');
    expect((screen.getByLabelText(/^Cant/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('corrects toe a quarter-degree a click, within ±5°', () => {
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Toe in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toe in' }));
    expect(finStore.getState().design!.toe).toBe(0.5);
    expect(measurements().getByText('in 0.50°')).toBeTruthy();
    const field = screen.getAllByLabelText(/^Toe/).find((el) => el.tagName === 'INPUT')!;
    fireEvent.change(field, { target: { value: '-9' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(finStore.getState().design!.toe).toBe(-5);
    fireEvent.click(screen.getByRole('button', { name: 'Toe out' }));
    expect(finStore.getState().design!.toe).toBe(-5); // already at the limit
  });

  it('bends and twists the blade above a slice from the 3D view', () => {
    localStorage.removeItem('bs.fin.views');
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Add control section' }));
    const d = () => finStore.getState().design!;
    const threeD = within(screen.getByRole('region', { name: '3D' }));
    // The new slice is selected: cant and toe now set its change; the arrows are off.
    expect(threeD.getByLabelText('Shape at')).toHaveProperty('value', '1');
    // The whole fin's placement gives way to the control section's own cant and toe.
    expect(threeD.queryByRole('group', { name: 'Position on the tab' })).toBeNull();
    // No change yet; no transition zone either: a change eases in over the whole span.
    expect(threeD.queryByLabelText(/^Transition/)).toBeNull();
    expect(threeD.queryByRole('button', { name: 'Reset cant and toe' })).toBeNull();
    const cant = threeD.getByLabelText(/^Cant/);
    fireEvent.change(cant, { target: { value: '12' } });
    fireEvent.keyDown(cant, { key: 'Enter' });
    expect(d().slices[0]!.twist).toEqual({ cant: 12, toe: 0 });
    fireEvent.click(threeD.getByRole('button', { name: 'Toe out' }));
    expect(d().slices[0]!.twist!.toe).toBe(-0.25);
    expect(d().toe).toBe(0); // the whole fin's toe is untouched
    // The arrow keys don't move the fin while a slice is selected.
    const le = d().outline.knots[0]!.end.x;
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(d().outline.knots[0]!.end.x).toBe(le);
    fireEvent.click(threeD.getByRole('button', { name: 'Reset cant and toe' }));
    expect(d().slices[0]!.twist).toBeUndefined();
    // Back to the root: the arrows work again.
    fireEvent.change(threeD.getByLabelText('Shape at'), { target: { value: '0' } });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(d().outline.knots[0]!.end.x).toBeGreaterThan(le);
  });

  it('lists the rules the design breaks', () => {
    act(() => finStore.getState().load({ ...defaultFinDesign('side', 'left'), cant: 30 }));
    render(<FinApp />);
    expect(screen.getByRole('status').textContent).toMatch(/Cant must be 0° to 20°/);
  });
});

describe('FinApp: files', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the fin to a .fin.json download, from the button and ⌘S', () => {
    URL.createObjectURL = vi.fn(() => 'blob:fin');
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(names).toEqual(['fin-side-left.fin.json', 'fin-side-left.fin.json']);
  });

  it('saves a left and a right fin with R & L ticked, and remembers the choice', async () => {
    localStorage.removeItem('bs.fin.pair');
    URL.createObjectURL = vi.fn(() => 'blob:fin');
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const { unmount } = render(<FinApp />);
    const box = pairOption()!;
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(names).toEqual(['fin-side-left.fin.json', 'fin-side-right.fin.json']),
    );
    unmount();
    render(<FinApp />);
    expect(pairOption()!.getAttribute('aria-checked')).toBe('true');
    localStorage.removeItem('bs.fin.pair');
  });

  it('offers no R & L for a centre fin', () => {
    act(() => finStore.getState().load(defaultFinDesign('centre')));
    render(<FinApp />);
    expect(pairOption()).toBeNull();
  });

  it('opens a .fin.json file, replacing the fin', async () => {
    render(<FinApp />);
    const file = new File([writeFinJson(defaultFinDesign('centre'))], 'centre.fin.json');
    fireEvent.change(screen.getByLabelText('Open a fin file'), { target: { files: [file] } });
    await waitFor(() => expect(finStore.getState().design!.position).toBe('centre'));
    expect(finStore.getState().canUndo()).toBe(false); // opening starts a fresh history
  });

  it('explains a file it cannot open', async () => {
    render(<FinApp />);
    const file = new File(['{"format":"openshaper","version":2}'], 'board.board.json');
    fireEvent.change(screen.getByLabelText('Open a fin file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/can't be opened as a fin/),
    );
    expect(finStore.getState().design!.position).toBe('side');
  });
});

describe('FinApp: export', () => {
  afterEach(() => vi.restoreAllMocks());

  const captureDownloads = () => {
    URL.createObjectURL = vi.fn(() => 'blob:fin');
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    return names;
  };

  it('exports STEP and STL, named after the fin', async () => {
    const names = captureDownloads();
    render(<FinApp />);
    fireEvent.click(exportItem('STL for 3D printing'));
    await waitFor(() => expect(names).toEqual(['fin-side-left.stl']));
    fireEvent.click(exportItem('STEP for CNC'));
    await waitFor(() => expect(names).toEqual(['fin-side-left.stl', 'fin-side-left.step']), {
      timeout: 10_000,
    });
  }, 20_000);

  it('exports a core for laminating, with the thickness and faces chosen', async () => {
    localStorage.removeItem('bs.fin.core');
    const names = captureDownloads();
    render(<FinApp />);
    fireEvent.click(exportItem('Core to laminate over…'));
    const dialog = within(screen.getByRole('dialog', { name: 'Export core' }));
    const field = dialog.getByLabelText('Laminate thickness');
    expect((field as HTMLInputElement).value).toBe('0.20'); // one ply of 200 gsm uni
    expect((dialog.getByLabelText('Both') as HTMLInputElement).checked).toBe(true);
    // Out of range: nothing to export.
    fireEvent.change(field, { target: { value: '5' } });
    expect(
      (dialog.getByRole('button', { name: 'Export STL core' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(field, { target: { value: '0.25' } });
    fireEvent.click(dialog.getByLabelText('Inside'));
    fireEvent.click(dialog.getByRole('button', { name: 'Export STL core' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(names).toEqual(['fin-side-left-core.stl']), { timeout: 10_000 });
    // Remembered for next time.
    expect(JSON.parse(localStorage.getItem('bs.fin.core')!)).toEqual({
      thickness: 0.025,
      sides: 'inside',
      tab: false,
    });
  }, 20_000);

  it('can wrap the tab too, and remembers it', async () => {
    // Saved before the tab option existed: read as not wrapping it.
    localStorage.setItem('bs.fin.core', JSON.stringify({ thickness: 0.02, sides: 'inside' }));
    const names = captureDownloads();
    render(<FinApp />);
    fireEvent.click(exportItem('Core to laminate over…'));
    const dialog = within(screen.getByRole('dialog', { name: 'Export core' }));
    const tab = dialog.getByLabelText('Include the tab') as HTMLInputElement;
    expect(tab.checked).toBe(false);
    expect(dialog.getByText(/The tab stays its standard width/)).toBeTruthy();
    fireEvent.click(tab);
    expect(dialog.getByText(/The tab is thinned/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Export STL core' }));
    await waitFor(() => expect(names).toEqual(['fin-side-left-core.stl']), { timeout: 10_000 });
    const saved = JSON.parse(localStorage.getItem('bs.fin.core')!);
    expect(saved).toMatchObject({ sides: 'inside', tab: true });
    expect(saved.thickness).toBeCloseTo(0.02, 12);
  }, 20_000);

  it('has an export minimum in File settings, 1 mm by default, kept within 0.5–3 mm and remembered', () => {
    localStorage.removeItem('bs.fin.exportMin');
    localStorage.removeItem('bs.fin.settings');
    const { unmount } = render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
    const field = () => screen.getByLabelText('Export minimum thickness') as HTMLInputElement;
    expect(field().value).toBe('1.0');
    for (const [typed, shown] of [
      ['0.2', '0.5'],
      ['5', '3.0'],
      ['1.5', '1.5'],
    ] as const) {
      fireEvent.change(field(), { target: { value: typed } });
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(field().value).toBe(shown);
    }
    expect(JSON.parse(localStorage.getItem('bs.fin.settings')!).exportMin).toBeCloseTo(0.15, 9);
    unmount();
    render(<FinApp />);
    // The core export says what it won't go under.
    fireEvent.click(exportItem('Core to laminate over…'));
    expect(screen.getByText(/Never under the export minimum, 1\.50 mm/)).toBeTruthy();
    localStorage.removeItem('bs.fin.settings');
  });

  it('keeps an export minimum remembered before File settings existed', () => {
    localStorage.removeItem('bs.fin.settings');
    localStorage.setItem('bs.fin.exportMin', '0.2');
    render(<FinApp />);
    fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
    expect((screen.getByLabelText('Export minimum thickness') as HTMLInputElement).value).toBe(
      '2.0',
    );
    localStorage.removeItem('bs.fin.exportMin');
  });

  it(
    'is unavailable while the fin breaks a rule',
    () => {
      act(() => finStore.getState().load({ ...defaultFinDesign('side', 'left'), cant: 30 }));
      render(<FinApp />);
      expect(exportItem('STEP for CNC').disabled).toBe(true);
      expect(exportItem('STL for 3D printing').disabled).toBe(true);
      expect(exportItem('Core to laminate over…').disabled).toBe(true);
    },
    HEAVY,
  );
});

describe('FinApp: section analysis in the 3D view', () => {
  beforeEach(() => act(() => finStore.getState().load(defaultFinDesign('side', 'left'))));
  // The 3D view's: the foil view has an Analysis of its own, in the same place.
  const analysis = () =>
    within(screen.getByRole('region', { name: '3D' })).getByRole('button', { name: 'Analysis' });

  it('opens with the vertical plane, its slider and readout; closes again', () => {
    render(<FinApp />);
    expect(analysis().getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('Vertical plane position')).toBeNull();
    fireEvent.click(analysis());
    expect(analysis().getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Vertical') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Horizontal') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText('Vertical plane position')).toBeTruthy();
    expect(screen.getByText(/ mm back · .* mm high · .* mm thick$/)).toBeTruthy();
    fireEvent.click(analysis());
    expect(screen.queryByLabelText('Vertical plane position')).toBeNull();
  });

  it('adds the horizontal plane, reading the foil at its height', () => {
    render(<FinApp />);
    fireEvent.click(analysis());
    fireEvent.click(screen.getByLabelText('Horizontal'));
    const height = screen.getByLabelText('Horizontal plane height');
    fireEvent.change(height, { target: { value: '0' } });
    // At the root: the root chord, 101.7 mm on the starting side fin, and its 8 mm.
    expect(screen.getByText(/^0\.0 mm up · chord 101\.\d mm · [78]\.\d mm thick$/)).toBeTruthy();
    // Both planes can be on; either can be turned off.
    fireEvent.click(screen.getByLabelText('Vertical'));
    expect(screen.queryByLabelText('Vertical plane position')).toBeNull();
    expect(screen.getByLabelText('Horizontal plane height')).toBeTruthy();
  });

  it('runs the bottom slider the way the fin lies on screen', () => {
    render(<FinApp />);
    fireEvent.click(analysis());
    const slider = screen.getByLabelText('Vertical plane position');
    const back = () =>
      Number(/^([\d.-]+) mm back/.exec(screen.getByText(/ mm back · /).textContent!)![1]);
    // A left fin's nose is on the left of the starting view.
    fireEvent.change(slider, { target: { value: '20' } });
    const nearLeft = back();
    fireEvent.change(slider, { target: { value: '380' } });
    expect(back()).toBeGreaterThan(nearLeft);
  });

  it('resets the camera to its starting view', () => {
    render(<FinApp />);
    const above = screen.getByRole('button', { name: 'View from above' });
    fireEvent.click(above);
    expect(above.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(analysis());
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(
      screen.getByRole('button', { name: 'View from above' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
