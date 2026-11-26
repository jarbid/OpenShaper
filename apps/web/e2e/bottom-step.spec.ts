// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
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
 * The Bottom step of the workspace on the Funboard template, which carries no contour: a board with none says so,
 * Add contour adds one and the 3D board follows its depth, its end is dragged on the plan from below, Edit curve
 * shows the bottom curve and a knot is dragged, undo steps each of them back, Remove, the keyboard on the numbers
 * and on the handles, and a tap on the bottom of the 3D board choosing the Bottom step, the station nearest the tap
 * and the contour it is over.
 */
/** Storage seeded before the page loads: centimetres to read numbers in, and the consent banner answered (it sits over the drawing's foot while it is up). */
const QUIET = { 'bs.lengthUnit': 'cm', 'bs.consent': 'rejected' };

test.describe('the Bottom step', () => {
  test.setTimeout(240_000);
  // the plan and its handles are at the foot of the page: a window with room for the whole workspace
  test.use({ viewport: { width: 1440, height: 900 } });

  const panel = (page: Page) => page.getByRole('region', { name: 'Bottom panel' });
  const number = (page: Page, name: string) => panel(page).getByRole('textbox', { name });
  const add = (page: Page, kind: string) =>
    panel(page)
      .getByRole('group', { name: 'Add a contour' })
      .getByRole('button', { name: kind })
      .click();
  const planEnd = (page: Page) => page.getByTestId('plan-to');
  const lane = (page: Page) => page.getByRole('toolbar', { name: 'Stations along the board' });
  /** Undo, with the focus off any field. */
  const undo = async (page: Page) => {
    await page.mouse.click(1, 1);
    await page.keyboard.press('Control+z');
  };
  const value = async (page: Page, name: string): Promise<number> =>
    Number(await number(page, name).inputValue());
  const snapshot = (page: Page) => board3d(page).screenshot();
  const changesFrom = async (page: Page, before: Buffer) =>
    expect.poll(async () => !(await snapshot(page)).equals(before), { timeout: 20_000 }).toBe(true);
  /** A camera under the board, a three-quarter view from below the tail, so the bottom is in sight. */
  const below = (D = 230) => ({
    ...QUIET,
    'bs.viewState': JSON.stringify({
      version: 1,
      view: 'quad',
      views2d: {},
      camera3d: { position: [-0.55 * D, -0.8 * D, -0.7 * D], target: [0, 0, 0] },
    }),
  });

  test('add a contour, move its depth and its end, edit the curve, undo, remove; the 3D board follows', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, below());
    await openFunboard(page);
    await entry(page, 'Bottom').click();
    await expect(entry(page, 'Bottom')).toHaveAttribute('aria-current', 'step');
    await expect(panel(page)).toBeVisible();

    // a board with no contour says so and offers the four kinds
    await expect(panel(page).getByTestId('no-contours')).toContainText('The bottom is flat');
    await expect(page.getByRole('heading', { name: /^Bottom: station \d/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bottom seen from below' })).toBeVisible();
    await expect(page.getByTestId('contour-plan')).toBeVisible();
    await expect(page.getByTestId('relief-strip')).toHaveCount(0);

    // Add contour: a single concave through the middle third, chosen, with its dials; the board is rebuilt
    let n = await updates(page);
    const flat = await snapshot(page);
    await add(page, 'Single concave');
    await expect(panel(page).getByTestId('contour-list')).toContainText('Single concave');
    await expect(page.getByRole('heading', { name: /Bottom.*Single concave/ })).toBeVisible();
    await expect(number(page, 'Depth number')).toHaveValue('0.30');
    await expect(number(page, 'Width number')).toHaveValue('70');
    await rebuilt(page, n);
    n = await updates(page);
    await expect(page.getByTestId('relief-strip')).toContainText('height ×');
    await expect(page.getByTestId('depth-handle')).toBeVisible();

    // the depth, typed: the board changes under the camera, and the slice's handle reads it
    const shallow = await snapshot(page);
    await number(page, 'Depth number').fill('1.2');
    await number(page, 'Depth number').press('Enter');
    await expect(number(page, 'Depth number')).toHaveValue('1.20');
    await rebuilt(page, n);
    n = await updates(page);
    await changesFrom(page, shallow);
    await expect(page.getByTestId('depth-handle')).toHaveAttribute('aria-valuenow', '1.2');
    expect(flat.equals(shallow)).toBe(false);

    // its end, dragged on the plan from below: To follows the pointer, and the number shows while it is held
    const to = await value(page, 'To number');
    await planEnd(page).scrollIntoViewIfNeeded();
    const handle = (await planEnd(page).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(handle.x + handle.width / 2 + 10 * i, handle.y + handle.height / 2);
      await page.waitForTimeout(30);
    }
    await expect(page.getByTestId('plan-number')).toContainText('To ');
    await page.mouse.up();
    await expect(page.getByTestId('plan-number')).toHaveCount(0);
    const moved = await value(page, 'To number');
    expect(moved).toBeGreaterThan(to + 10);
    await rebuilt(page, n);
    n = await updates(page);
    // one undo step brings the end back where it was
    await undo(page);
    await expect.poll(() => value(page, 'To number')).toBeCloseTo(to, 1);
    await rebuilt(page, n);
    n = await updates(page);

    // Edit curve shows the bottom curve's own points, in place of the slice and the plan; a knot is dragged
    await page.getByRole('button', { name: 'Edit curve' }).first().click();
    await expect(page.getByRole('heading', { name: 'Cross-section: bottom' })).toBeVisible();
    await expect(page.getByTestId('bottom-slice')).toHaveCount(0);
    await expect(page.getByTestId('contour-plan')).toHaveCount(0);
    const at = await selectPoint(page, [0.6, 0.97], [0.06, 0.95]);
    await drag(page, at, 30);
    await rebuilt(page, n);
    n = await updates(page);
    await undo(page);
    await rebuilt(page, n);
    n = await updates(page);
    // the button takes the drawing back to the slice and the plan
    await page.getByRole('button', { name: 'Edit curve' }).first().click();
    await expect(page.getByTestId('bottom-slice')).toBeVisible();

    // Remove: the board is flat again, and undo brings the contour back with its numbers
    await panel(page).getByRole('button', { name: 'Remove Single concave' }).click();
    await expect(panel(page).getByTestId('no-contours')).toBeVisible();
    await rebuilt(page, n);
    n = await updates(page);
    await undo(page);
    await expect(panel(page).getByTestId('contour-list')).toContainText('Single concave');
    await expect(number(page, 'Depth number')).toHaveValue('1.20');

    expect(errors).toEqual([]);
  });

  test('the keyboard: numbers, the depth handle, the ends of the run and the stations', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, QUIET);
    await openFunboard(page);
    await entry(page, 'Bottom').click();
    await add(page, 'Vee');
    await add(page, 'Channels');
    await expect(page.getByRole('heading', { name: /Bottom.*Channels/ })).toBeVisible();
    // the list chooses by keyboard: a row is a button, and the panel follows it
    await panel(page).getByRole('button', { name: /^Vee/ }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Bottom.*Vee/ })).toBeVisible();

    // arrow keys on the Depth number step it, a held key one undo step
    const depth = await value(page, 'Depth number');
    await number(page, 'Depth number').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await number(page, 'Depth number').blur();
    expect(await value(page, 'Depth number')).toBeCloseTo(depth + 0.04, 2);

    // the depth handle on the slice: a station along the run is chosen, then the handle's keys
    const ticks = lane(page).getByRole('button', { name: /^Station \d/ });
    await ticks.nth(1).click();
    await expect(ticks.nth(1)).toHaveAttribute('aria-pressed', 'true');
    const handle = page.getByTestId('depth-handle');
    await handle.focus();
    await page.keyboard.press('Home');
    await expect(number(page, 'Depth number')).toHaveValue('0.00');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(number(page, 'Depth number')).toHaveValue('0.04');

    // the ends of the run, by the arrow keys on the plan's handles (a centimetre, ten with Shift)
    const to = await value(page, 'To number');
    await planEnd(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => value(page, 'To number')).toBeCloseTo(to + 11, 1);
    await page.getByTestId('plan-from').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => value(page, 'From number')).toBeCloseTo(10.5, 1);
    await page.keyboard.press('Home');
    await expect.poll(() => value(page, 'From number')).toBeCloseTo(0.5, 1);
    await expect(panel(page)).toContainText('out of the tail');

    // the stations of the plan are one tab stop, moved by the arrow keys
    await ticks.nth(0).focus();
    await page.keyboard.press('End');
    await expect(ticks.last()).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Home');
    await expect(ticks.first()).toHaveAttribute('aria-pressed', 'true');

    expect(errors).toEqual([]);
  });

  test('a tap on the 3D board’s bottom chooses the Bottom step, the station nearest the tap and the contour it is over', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, below());
    await openFunboard(page);
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');
    await page.waitForTimeout(2500);
    await entry(page, 'Outline').click();
    // a vee out of the tail and channels forward of it; the channels are the one chosen when they are added
    await entry(page, 'Bottom').click();
    await add(page, 'Vee');
    await add(page, 'Channels');
    await expect(page.getByRole('heading', { name: /Bottom.*Channels/ })).toBeVisible();
    await entry(page, 'Outline').click();

    const box = (await board3d(page).boundingBox())!;
    const phrase = page.getByTestId('patch-readout');
    let tapped = NaN;
    // scan for a tap on the bottom in the tail's first fifteen centimetres, where only the vee runs
    outer: for (let fy = 0.3; fy <= 0.8; fy += 0.04) {
      for (let fx = 0.15; fx <= 0.85; fx += 0.04) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        if ((await phrase.getAttribute('data-patch')) === 'bottom') {
          const at = Number(/([\d.]+) cm from the tail/.exec(await phrase.innerText())?.[1] ?? NaN);
          if (at < 15) {
            tapped = at;
            break outer;
          }
        }
      }
    }
    expect(tapped).not.toBeNaN();
    expect(await currentStep(page)).toEqual(['Bottom']);
    // the station nearest the tap: the first of the board's, and the slice, the panel and the plan agree
    const ticks = lane(page).getByRole('button', { name: /^Station \d/ });
    await expect(ticks.first()).toHaveAttribute('aria-pressed', 'true');
    // the contour it is over: the vee, which runs there and the channels do not
    await expect(page.getByRole('heading', { name: /Bottom.*Vee/ })).toBeVisible();

    expect(errors).toEqual([]);
  });
});

test.describe('the Bottom step under a coarse pointer', () => {
  test.setTimeout(240_000);
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: true });

  test('every handle has a 44 px target, and every button is 44 px tall', async ({ page }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, { 'bs.lengthUnit': 'cm', 'bs.consent': 'rejected' });
    await openFunboard(page);
    await entry(page, 'Bottom').click();
    const panel = page.getByRole('region', { name: 'Bottom panel' });
    await panel
      .getByRole('group', { name: 'Add a contour' })
      .getByRole('button', { name: 'Single concave' })
      .click();
    const ticks = page
      .getByRole('toolbar', { name: 'Stations along the board' })
      .getByRole('button', { name: /^Station \d/ });
    await ticks.nth(2).click();
    await page.getByTestId('plan-to').scrollIntoViewIfNeeded();

    // a handle's target is the 16 px circle and the hit area round it: a point 20 px either side still reaches it
    for (const id of ['plan-from', 'plan-move', 'plan-to', 'depth-handle', 'law-key-1']) {
      const handle = page.getByTestId(id);
      await handle.scrollIntoViewIfNeeded();
      const box = (await handle.boundingBox())!;
      for (const [dx, dy] of [
        [-20, 0],
        [20, 0],
        [0, -20],
        [0, 20],
      ] as const) {
        const hit = await page.evaluate(
          ([x, y]) =>
            (document.elementFromPoint(x!, y!) as HTMLElement | null)
              ?.closest('[data-testid]')
              ?.getAttribute('data-testid') ?? null,
          [box.x + box.width / 2 + dx, box.y + box.height / 2 + dy],
        );
        expect(hit, `${id} ${dx},${dy}`).toBe(id);
      }
    }
    // the buttons and the stations' ticks
    const buttons = {
      remove: panel.getByRole('button', { name: 'Remove Single concave' }),
      add: panel.getByRole('group', { name: 'Add a contour' }).getByRole('button', { name: 'Vee' }),
      row: panel.getByTestId('contour-list').getByRole('button').first(),
      editCurve: page.getByRole('button', { name: 'Edit curve' }).first(),
      tick: ticks.first(),
    };
    for (const [name, button] of Object.entries(buttons)) {
      await button.scrollIntoViewIfNeeded();
      expect((await button.boundingBox())!.height, name).toBeGreaterThanOrEqual(43.5);
    }
    expect(errors).toEqual([]);
  });
});
