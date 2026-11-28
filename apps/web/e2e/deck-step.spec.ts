// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  board3d,
  currentStep,
  drag,
  entry,
  lookButton,
  openFunboard,
  rebuilt,
  selectPoint,
  seedSwitches,
  trackErrors,
  updates,
} from './workspace-helpers';

/**
 * The Deck step of the workspace on the Funboard template: the deck's shape named in the panel and chosen from
 * its menu, the crown set by its handle and by a key (the 3D board changes), Edit curve and a knot dragged (the
 * panel reads Custom), undo, and the station strip: a station added, moved, chosen and removed, by pointer and by
 * keyboard, and a tap on the 3D board's deck choosing the station nearest it.
 *
 * The Funboard arrives with a drawn deck at each of its five stations, so the deck reads Custom and the step opens
 * with the cross-section editor.
 */
/** Storage seeded before the page loads: centimetres to read numbers in, and the consent banner answered (it sits over the strip while it is up). */
const QUIET = { 'bs.lengthUnit': 'cm', 'bs.consent': 'rejected' };

test.describe('the Deck step', () => {
  test.setTimeout(240_000);

  const panel = (page: Page) => page.getByRole('region', { name: 'Deck panel' });
  const shape = (page: Page) => panel(page).getByRole('combobox', { name: 'Deck shape' });
  const crownField = (page: Page) => panel(page).getByRole('textbox', { name: 'Crown number' });
  const handle = (page: Page) => page.getByTestId('crown-handle');
  const lane = (page: Page) => page.getByRole('toolbar', { name: 'Stations along the board' });
  const ticks = (page: Page) => lane(page).getByRole('button', { name: /^Station \d/ });
  const readout = (page: Page) =>
    page.getByRole('region', { name: 'Stations' }).locator('p').first();
  /** The place, in cm from the tail, a tick's name gives. */
  const placeOf = async (tick: Locator): Promise<number> =>
    Number(/, ([\d.]+) cm from the tail/.exec((await tick.getAttribute('aria-label')) ?? '')![1]);
  /** Undo, with the focus off any field. */
  const undo = async (page: Page) => {
    await page.mouse.click(1, 1);
    await page.keyboard.press('Control+z');
  };
  /** The 3D board's pixels now. */
  const snapshot = (page: Page) => board3d(page).screenshot();
  const changesFrom = async (page: Page, before: Buffer) =>
    expect.poll(async () => !(await snapshot(page)).equals(before), { timeout: 20_000 }).toBe(true);

  test('choose Domed, move the crown, edit the curve, undo; the 3D board follows', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, QUIET);
    await openFunboard(page);
    await entry(page, 'Deck').click();
    await expect(entry(page, 'Deck')).toHaveAttribute('aria-current', 'step');
    await expect(panel(page)).toBeVisible();

    // the board's deck is close to a dome: Domed by name, the dial on, the slice with its one handle
    await expect(shape(page)).toHaveValue('domed');
    await expect(panel(page).getByRole('slider', { name: 'Crown' })).toBeEnabled();
    await expect(page.getByTestId('deck-slice')).toBeVisible();
    await expect(handle(page)).toBeVisible();
    await expect(lane(page)).toBeVisible();
    await expect(ticks(page)).toHaveCount(5);
    // the thickest station of the board, so the crown has room to move
    await ticks(page).nth(2).click();
    await expect(readout(page)).toContainText('Station 3 of 5');

    // Flat takes the crown off at once, with no question, and the 3D board is rebuilt and changes
    let n = await updates(page);
    const shipped = await snapshot(page);
    await shape(page).selectOption('flat');
    await expect(shape(page)).toHaveValue('flat');
    await expect(panel(page).getByRole('slider', { name: 'Crown' })).toBeDisabled();
    await expect(panel(page)).toContainText('A flat deck has no crown');
    await expect(handle(page)).toHaveAttribute('aria-disabled', 'true');
    await rebuilt(page, n);
    n = await updates(page);
    await changesFrom(page, shipped);
    const flat = await snapshot(page);

    // Domed gives the dome a new Domed has, and the board changes again
    await shape(page).selectOption('domed');
    await expect(shape(page)).toHaveValue('domed');
    await expect(page.getByTestId('deck-slice')).toBeVisible();
    await expect(handle(page)).toBeVisible();
    await rebuilt(page, n);
    n = await updates(page);
    await changesFrom(page, flat);

    // the crown handle dragged down: the crown grows, the board is rebuilt and changes again
    const before = Number(await crownField(page).inputValue());
    expect(before).toBeGreaterThan(0);
    const domed = await snapshot(page);
    const h = (await handle(page).boundingBox())!;
    await drag(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, 40);
    await expect.poll(async () => Number(await crownField(page).inputValue())).toBeGreaterThan(before); // prettier-ignore
    await rebuilt(page, n);
    n = await updates(page);
    await changesFrom(page, domed);

    // and by a key: Up is less crown, ten presses a step of a millimetre each
    const dragged = Number(await crownField(page).inputValue());
    await handle(page).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
    await expect.poll(async () => Number(await crownField(page).inputValue())).toBeLessThan(dragged); // prettier-ignore
    await rebuilt(page, n);
    n = await updates(page);

    // typed in the panel: the number is the station's, in the display unit
    await crownField(page).fill('1.2');
    await crownField(page).press('Enter');
    await expect(crownField(page)).toHaveValue('1.20');
    await rebuilt(page, n);
    n = await updates(page);

    // Flat turns the dial off and says why
    await shape(page).selectOption('flat');
    await expect(shape(page)).toHaveValue('flat');
    await expect(panel(page).getByRole('slider', { name: 'Crown' })).toBeDisabled();
    await expect(panel(page)).toContainText('A flat deck has no crown');
    await expect(handle(page)).toHaveAttribute('aria-disabled', 'true');
    await rebuilt(page, n);
    n = await updates(page);
    await shape(page).selectOption('domed');
    await expect(shape(page)).toHaveValue('domed');
    await rebuilt(page, n);
    n = await updates(page);

    // Edit curve shows the curve's own points; a point dragged makes the deck Custom, and the panel says so
    await page.getByRole('button', { name: 'Edit curve' }).first().click();
    await expect(page.getByRole('heading', { name: 'Cross-section: deck' })).toBeVisible();
    await expect(page.getByTestId('deck-slice')).toHaveCount(0);
    // far enough from a dome (a deck within four millimetres of one still reads Domed)
    const at = await selectPoint(page, [0.6, 0.97], [0.06, 0.95]);
    await drag(page, at, 150);
    await expect(shape(page)).toHaveValue('custom');
    await expect(panel(page)).toContainText('drawn point by point');
    await rebuilt(page, n);
    n = await updates(page);

    // undo steps the drag back to the shape; a shape chosen again replaces the drawn curve, and undo brings it back
    await undo(page);
    await expect(shape(page)).toHaveValue('domed');
    await rebuilt(page, n);
    n = await updates(page);
    await drag(page, at, 150);
    await expect(shape(page)).toHaveValue('custom');
    await shape(page).selectOption('domed');
    await expect(shape(page)).toHaveValue('domed');
    await expect(panel(page)).toContainText('Undo brings');
    await undo(page);
    await expect(shape(page)).toHaveValue('custom');

    expect(errors).toEqual([]);
  });

  test('add, move, choose and remove a station, by pointer and by keyboard; undo', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, QUIET);
    await openFunboard(page);
    await entry(page, 'Deck').click();
    await expect(ticks(page)).toHaveCount(5);
    await expect(lane(page)).toBeVisible();

    // the strip is tail to nose: the places grow, the chosen tick is marked
    const places = await Promise.all([0, 1, 2, 3, 4].map((i) => placeOf(ticks(page).nth(i))));
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    await expect(page.locator('[data-testid="station-strip"] [aria-pressed="true"]')).toHaveCount(1); // prettier-ignore

    // choose by a click on a tick: the readout and the panel follow
    await ticks(page).nth(3).click();
    await expect(readout(page)).toContainText('Station 4 of 5');
    await expect(panel(page)).toContainText('Station 4 of 5');
    await expect(ticks(page).nth(3)).toHaveAttribute('aria-pressed', 'true');

    // add one after the chosen station: it is chosen, the 3D model is rebuilt
    let n = await updates(page);
    await page.getByRole('button', { name: 'Add station' }).click();
    await expect(ticks(page)).toHaveCount(6);
    await expect(readout(page)).toContainText('Station 5 of 6');
    await expect(readout(page)).toContainText('Added station 5.');
    const added = await placeOf(ticks(page).nth(4));
    expect(added).toBeGreaterThan(await placeOf(ticks(page).nth(3)));
    expect(added).toBeLessThan(await placeOf(ticks(page).nth(5)));
    await rebuilt(page, n);
    n = await updates(page);

    // move it by a drag: held between its neighbours
    const tick = ticks(page).nth(4);
    const box = (await tick.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    const moved = await placeOf(ticks(page).nth(4));
    expect(moved).toBeGreaterThan(added + 1);
    // the drag went further than the room there is: it stops a thousandth of a centimetre short of the next station
    expect(moved).toBeLessThanOrEqual(await placeOf(ticks(page).nth(5)));
    await expect(ticks(page)).toHaveCount(6);
    await rebuilt(page, n);
    n = await updates(page);

    // by keyboard: an arrow chooses the next, Shift with one moves the chosen station half a centimetre
    await ticks(page).nth(4).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(ticks(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect(ticks(page).nth(3)).toBeFocused();
    await page.keyboard.press('End');
    await expect(ticks(page).nth(5)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Home');
    await expect(ticks(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const third = await placeOf(ticks(page).nth(2));
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => placeOf(ticks(page).nth(2))).toBeCloseTo(third + 0.5, 1);
    await rebuilt(page, n);
    n = await updates(page);

    // Delete removes the chosen station, the board is rebuilt; a click on the "+" under the mouse adds one
    await page.keyboard.press('Delete');
    await expect(ticks(page)).toHaveCount(5);
    await rebuilt(page, n);
    n = await updates(page);
    const strip = (await lane(page).boundingBox())!;
    const second = (await ticks(page).nth(1).boundingBox())!;
    const third2 = (await ticks(page).nth(2).boundingBox())!;
    const between = (second.x + second.width / 2 + third2.x + third2.width / 2) / 2;
    await page.mouse.move(between, strip.y + strip.height / 2);
    await page.getByRole('button', { name: 'Add a station here' }).click();
    await expect(ticks(page)).toHaveCount(6);
    await rebuilt(page, n);

    // undo steps each back
    await undo(page);
    await expect(ticks(page)).toHaveCount(5);
    await undo(page);
    await expect(ticks(page)).toHaveCount(6);

    expect(errors).toEqual([]);
  });

  test('a tap on the 3D board’s deck chooses the Deck step and the station nearest the tap', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    // a three-quarter view, so the deck is in sight
    const D = 230;
    await seedSwitches(page, {
      ...QUIET,
      'bs.viewState': JSON.stringify({
        version: 1,
        view: 'quad',
        views2d: {},
        camera3d: { position: [-0.55 * D, -0.8 * D, 0.7 * D], target: [0, 0, 0] },
      }),
    });
    await openFunboard(page);
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');
    await page.waitForTimeout(2500);
    await entry(page, 'Outline').click();

    const box = (await board3d(page).boundingBox())!;
    const phrase = page.getByTestId('patch-readout');
    let tapped = NaN;
    outer: for (let fy = 0.45; fy <= 0.7; fy += 0.05) {
      for (let fx = 0.3; fx <= 0.55; fx += 0.05) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        if ((await phrase.getAttribute('data-patch')) === 'deck') {
          tapped = Number(/Deck, ([\d.]+) cm from the tail/.exec(await phrase.innerText())![1]);
          break outer;
        }
      }
    }
    expect(tapped).not.toBeNaN();
    expect(await currentStep(page)).toEqual(['Deck']);
    // the strip's chosen station is the one nearest the place tapped
    const all = await Promise.all([0, 1, 2, 3, 4].map((i) => placeOf(ticks(page).nth(i))));
    const nearest = all.reduce((best, x, i) => (Math.abs(x - tapped) < Math.abs(all[best]! - tapped) ? i : best), 0); // prettier-ignore
    await expect(ticks(page).nth(nearest)).toHaveAttribute('aria-pressed', 'true');
    await expect(readout(page)).toContainText(`Station ${nearest + 1} of 5`);
    // the drawing is the section at that station: the strip and the panel agree
    await expect(panel(page)).toContainText(`Station ${nearest + 1} of 5`);

    expect(errors).toEqual([]);
  });
});
