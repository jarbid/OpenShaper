import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseBrd } from '@openshaper/io';
import { ExportRailBandsDialog } from './ExportRailBandsDialog';
import { DEFAULT_RAIL_BANDS } from './rail-bands-settings';
import { lengthUnitByKey } from './format';
import { BOARD_TEMPLATES } from './templates';

/** The real shortboard the app opens with — the dialog runs the geometry live. */
const board = parseBrd(BOARD_TEMPLATES[0]!.brd).board;

const renderDialog = (unitKey: string, onExport = vi.fn(), onClose = vi.fn()) => {
  render(
    <ExportRailBandsDialog
      board={board}
      units={lengthUnitByKey(unitKey)}
      settings={DEFAULT_RAIL_BANDS}
      onExport={onExport}
      onClose={onClose}
    />,
  );
  return { onExport, onClose };
};

describe('<ExportRailBandsDialog />', () => {
  it('shows the station interval in the editor’s unit, not a fixed one', () => {
    // The same stored value (30.48 cm) has to read as 12 in inches and 304.8 in
    // millimetres — the display-units rule in apps/web/CLAUDE.md.
    const { unmount } = render(
      <ExportRailBandsDialog
        board={board}
        units={lengthUnitByKey('in')}
        settings={DEFAULT_RAIL_BANDS}
        onExport={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByDisplayValue('12')).toBeTruthy();
    unmount();

    renderDialog('mm');
    expect(screen.getByDisplayValue('304.8')).toBeTruthy();
  });

  it('shows the angles the fit chose, and what each band count would buy', () => {
    renderDialog('cm');
    // Fitted per station, so the dialog quotes the widepoint's and says as much.
    expect(screen.getByText(/at the widepoint/)).toBeTruthy();
    expect(screen.getByText(/takes out \d+% of the foam left proud/)).toBeTruthy();
    expect(screen.getByText(/By band count: 1: \d+%/)).toBeTruthy();
  });

  it('reveals the shaper’s own marks in manual mode, in the editor’s unit', () => {
    renderDialog('mm');
    fireEvent.change(screen.getByLabelText('Placement'), { target: { value: 'manual' } });
    // a percentage, so dimensionless and unit-free whatever the selector says
    expect((screen.getByLabelText('Rail mark (% up the rail face)') as HTMLInputElement).value).toBe(
      '60',
    );
    // deck marks are lengths, so they follow the selector: 2.5 cm shows as 25 mm
    // the label carries the unit suffix, hence the loose match
    expect((screen.getByLabelText(/Deck mark 1/) as HTMLInputElement).value).toBe('25');
    expect(screen.getByText(/midpoint of the one before/)).toBeTruthy();
    // the mark is not the rail's name, and the dialog has to say so
    expect(screen.getByText(/names where that apex lands, counted from the deck/)).toBeTruthy();
  });

  it('seeds the manual marks from this board rather than from a chart', () => {
    // A chart written for a 2 1/2 in board is the wrong starting point for the board in
    // front of you: Greenlight's egg-rail tuck cuts millimetres into a hard rail.
    renderDialog('cm');
    fireEvent.change(screen.getByLabelText('Placement'), { target: { value: 'manual' } });
    const before = (screen.getByLabelText(/Deck mark 1/) as HTMLInputElement).value;
    fireEvent.click(screen.getByText('Start from the fitted marks'));
    expect((screen.getByLabelText(/Deck mark 1/) as HTMLInputElement).value).not.toBe(before);
    // every field, not just the deck marks — the tuck is the one a chart gets most wrong
    expect((screen.getByLabelText(/Tuck up from the corner/) as HTMLInputElement).value).not.toBe(
      '2',
    );
  });

  it('switches manual mode to plain angles when asked', () => {
    renderDialog('cm');
    fireEvent.change(screen.getByLabelText('Placement'), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText('Set out'), { target: { value: 'angle' } });
    expect(screen.getByLabelText('Band 1 angle')).toBeTruthy();
    expect(screen.queryByLabelText('Rail mark (% up the rail face)')).toBeNull();
  });

  it('still offers the halving ladder, and names what it is', () => {
    renderDialog('cm');
    const select = screen.getByLabelText('Placement') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ladder' } });
    expect(screen.getByText(/45 \/ 22\.5 \/ 11\.25/)).toBeTruthy();
  });

  it('reports the stations the current settings actually give, end to end', () => {
    // The spacing is a target that gets fitted, so the dialog has to say what came out
    // of it — a user who types 12 in and gets 11 3/8 in should learn that here, not by
    // measuring the printed sheet.
    renderDialog('cm');
    expect(screen.getByText(/stations? from .* to /)).toBeTruthy();
    expect(screen.getByText(/apart/)).toBeTruthy();
    expect(screen.getByText(/land on both ends and on the widepoint/)).toBeTruthy();
  });

  it('hands the draft settings to onExport and closes', () => {
    const { onExport, onClose } = renderDialog('cm');
    fireEvent.click(screen.getByText('Export'));
    expect(onExport).toHaveBeenCalledWith(DEFAULT_RAIL_BANDS);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape without exporting', () => {
    const { onExport, onClose } = renderDialog('cm');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
  });
});
