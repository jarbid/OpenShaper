import { expect, test, type Page } from '@playwright/test';
import {
  board3d,
  currentStep,
  divider,
  entry,
  list,
  openFunboard,
  PANELS,
  seedSwitches,
  selectPoint,
  STEPS,
  trackErrors,
  updates,
} from './workspace-helpers';

/**
 * The workspace (apps/web/src/workspace): the design list, the keys, the divider, the tap on the board, and the
 * tablet and phone layouts. With the NURBS and rails switches on and a rails board open it replaces the view tabs;
 * `rails-editor.spec.ts` edits the board in it.
 */
test.describe('the workspace', () => {
  test.setTimeout(180_000);

  test('lists the design steps and the panel entries, marks the current one, and has no view tabs', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page);
    await openFunboard(page);

    const names = await list(page).getByRole('button').allInnerTexts();
    expect(names.map((n) => n.trim())).toEqual([...STEPS, ...PANELS]);
    expect(await currentStep(page)).toEqual(['Outline']);
    await expect(page.getByRole('group', { name: 'Views' })).toHaveCount(0);
    for (const tab of ['Quad', 'Split', 'Cross-section']) {
      await expect(page.getByRole('button', { name: tab, exact: true })).toHaveCount(0);
    }
    // the board is always on screen, with its looks, over the drawing
    await expect(page.getByRole('heading', { name: '3D' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Outline', exact: true })).toBeVisible();

    await entry(page, 'Deck').click();
    expect(await currentStep(page)).toEqual(['Deck']);
    await expect(page.getByRole('heading', { name: 'Cross-section: deck' })).toBeVisible();

    // Specs, Build and Compare show a tab of the sidebar and leave the step where it is
    await entry(page, 'Build').click();
    await expect(page.getByRole('tab', { name: 'Build' })).toHaveAttribute('aria-selected', 'true');
    await expect(entry(page, 'Build')).toHaveAttribute('aria-current', 'true');
    await entry(page, 'Compare').click();
    await expect(page.getByRole('tab', { name: 'Reference' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await currentStep(page)).toEqual(['Deck']);
    expect(errors).toEqual([]);
  });

  test('has the sidebar follow the step', async ({ page }) => {
    await seedSwitches(page);
    await openFunboard(page);
    const aside = page.getByRole('complementary', { name: 'Board panels' });
    const section = (name: string) => aside.getByRole('button', { name, exact: true });

    await entry(page, 'Tail').click();
    await expect(page.getByRole('tab', { name: 'Shape' })).toHaveAttribute('aria-selected', 'true');
    await expect(section('Board shape')).toHaveAttribute('aria-expanded', 'true');

    await entry(page, 'Fins').click();
    await expect(page.getByRole('tab', { name: 'Build' })).toHaveAttribute('aria-selected', 'true');
    await expect(section('Fins')).toHaveAttribute('aria-expanded', 'true');

    await entry(page, 'Bottom').click();
    await expect(page.getByRole('tab', { name: 'Shape' })).toHaveAttribute('aria-selected', 'true');
    await expect(section('Bottom features')).toHaveAttribute('aria-expanded', 'true');

    // what a step opened, the next one shuts
    await entry(page, 'Outline').click();
    await expect(section('Bottom features')).toHaveAttribute('aria-expanded', 'false');
  });

  test('chooses a step with the number keys 1 to 7, and no other number does anything', async ({
    page,
  }) => {
    await seedSwitches(page);
    await openFunboard(page);
    for (const [i, name] of STEPS.entries()) {
      await page.keyboard.press(String(i + 1));
      expect(await currentStep(page), `key ${i + 1}`).toEqual([name]);
    }
    await page.keyboard.press('8');
    await page.keyboard.press('0');
    expect(await currentStep(page)).toEqual(['Fins']);
    // the view keys are not views here: still the workspace
    await page.keyboard.press('6');
    await expect(page.getByRole('group', { name: 'Views' })).toHaveCount(0);
    expect(await currentStep(page)).toEqual(['Tail']);
    // and a key typed in a text field is a character, not a step
    await entry(page, 'Specs').click();
    const unit = page.getByLabel('Display units');
    await unit.focus();
    await page.keyboard.press('2');
    await expect(unit).toBeFocused();
  });

  test('is operable by keyboard: arrows move through the list, Enter chooses, and the board is not nudged', async ({
    page,
  }) => {
    await seedSwitches(page);
    await openFunboard(page);
    // a selected control point is nudged by the arrow keys: not while the list has focus
    await selectPoint(page);
    const before = await updates(page);

    await entry(page, 'Outline').focus();
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Rocker and foil')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Deck')).toBeFocused();
    expect(await currentStep(page)).toEqual(['Outline']);
    await page.keyboard.press('Enter');
    expect(await currentStep(page)).toEqual(['Deck']);
    await page.keyboard.press('End');
    await expect(entry(page, 'Compare')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entry(page, 'Compare')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Reference' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Home');
    await expect(entry(page, 'Outline')).toBeFocused();
    await page.waitForTimeout(600);
    expect(await updates(page)).toBe(before);
  });

  test('has a divider that moves by keys and by a drag, stays between 25% and 75%, and is remembered', async ({
    page,
  }) => {
    await seedSwitches(page);
    await openFunboard(page);
    const bar = divider(page);
    await expect(bar).toHaveAttribute('aria-valuemin', '25');
    await expect(bar).toHaveAttribute('aria-valuemax', '75');
    await expect(bar).toHaveAttribute('aria-valuenow', '55');

    await bar.focus();
    const now = async () => Number(await bar.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowDown');
    expect(await now()).toBe(57);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await now()).toBe(53);
    await page.keyboard.press('Home');
    expect(await now()).toBe(25);
    await page.keyboard.press('ArrowUp');
    expect(await now()).toBe(25);
    await page.keyboard.press('End');
    expect(await now()).toBe(75);
    await page.keyboard.press('ArrowDown');
    expect(await now()).toBe(75);

    // a drag: up shrinks the board, and the limit holds
    const box = (await bar.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x, y - i * 20);
    await page.mouse.up();
    const dragged = await now();
    expect(dragged).toBeLessThan(75);
    expect(dragged).toBeGreaterThanOrEqual(25);
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('bs.workspaceSplit')!),
    );
    expect(Math.round(stored * 100)).toBe(dragged);

    // the board is above the divider and the drawing below it, and the divider is where its value says
    // (the headings, not the canvases: a canvas takes a moment to follow its panel)
    const barBox = (await bar.boundingBox())!;
    const above = (await page.getByRole('heading', { name: '3D' }).boundingBox())!;
    const below = (await page
      .getByRole('heading', { name: 'Outline', exact: true })
      .boundingBox())!;
    expect(above.y).toBeLessThan(barBox.y);
    expect(below.y).toBeGreaterThan(barBox.y + barBox.height);
    const column = (await bar.locator('xpath=..').boundingBox())!;
    const at = (barBox.y + barBox.height / 2 - column.y) / column.height;
    expect(Math.abs(at - dragged / 100)).toBeLessThan(0.03);

    // remembered after a reload (the session brings the board back)
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(list(page)).toBeVisible({ timeout: 60_000 });
    await expect(divider(page)).toHaveAttribute('aria-valuenow', String(dragged));
  });

  test('remembers the step, and opens on the Patches look once', async ({ page }) => {
    await seedSwitches(page);
    await openFunboard(page);
    const look = page.getByTitle(/^Surface analysis/);
    await expect(look).toHaveValue('patches');

    await entry(page, 'Rails').click();
    await look.selectOption('none');
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(list(page)).toBeVisible({ timeout: 60_000 });
    expect(await currentStep(page)).toEqual(['Rails']);
    // the choice of no analysis is not put back to Patches
    await expect(page.getByTitle(/^Surface analysis/)).toHaveValue('none');
  });

  test('a tap on the board chooses the step for what was tapped, and a tap on nothing changes none', async ({
    page,
  }) => {
    // a three-quarter view, so the deck and the rail are both in sight
    const D = 230;
    await seedSwitches(page, {
      'bs.viewState': JSON.stringify({
        version: 1,
        view: 'quad',
        views2d: {},
        camera3d: { position: [-0.55 * D, -0.8 * D, 0.7 * D], target: [0, 0, 0] },
      }),
    });
    await openFunboard(page);
    await expect(page.getByTitle(/^Surface analysis/)).toHaveValue('patches');
    await page.waitForTimeout(2500);

    const box = (await board3d(page).boundingBox())!;
    const readout = page.getByTestId('patch-readout');
    const tapUntil = async (patch: string, points: Iterable<[number, number]>) => {
      for (const [fx, fy] of points) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        if ((await readout.getAttribute('data-patch')) === patch) return;
      }
      throw new Error(`no ${patch} found by tapping the board`);
    };
    function* grid(x0: number, x1: number, dx: number, y0: number, y1: number, dy: number) {
      for (let y = y0; y <= y1; y += dy)
        for (let x = x0; x <= x1; x += dx) yield [x, y] as [number, number];
    }

    await entry(page, 'Outline').click();
    await tapUntil('deck', grid(0.3, 0.55, 0.05, 0.45, 0.7, 0.05));
    expect(await currentStep(page)).toEqual(['Deck']);
    await expect(page.getByRole('heading', { name: 'Cross-section: deck' })).toBeVisible();

    await entry(page, 'Outline').click();
    await tapUntil('rail', grid(0.3, 0.7, 0.05, 0.35, 0.85, 0.008));
    expect(await currentStep(page)).toEqual(['Rails']);
    await expect(page.getByRole('region', { name: 'Rail keys' })).toBeVisible();

    // the patch stays lit (the readout still names it), and a tap on nothing clears it and changes no step.
    // Empty canvas at the top left: the bottom left is the Patches key, and the right edge holds the chips.
    await entry(page, 'Fins').click();
    await page.mouse.click(box.x + 40, box.y + 40);
    await expect(readout).not.toHaveAttribute('data-patch', /.+/);
    expect(await currentStep(page)).toEqual(['Fins']);
  });
});

test.describe('the tablet and phone layouts', () => {
  test.setTimeout(180_000);

  async function open(page: Page, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await seedSwitches(page);
    await openFunboard(page);
  }

  test('is a column of icons below 1024px, with 44px targets, names as labels and tooltips, and the sidebar in the sheet', async ({
    page,
  }) => {
    await open(page, 1023, 768);
    const nav = list(page);
    const box = (await nav.boundingBox())!;
    expect(box.width).toBeGreaterThan(48);
    expect(box.width).toBeLessThan(64);
    const buttons = nav.getByRole('button');
    await expect(buttons).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      const b = buttons.nth(i);
      const r = (await b.boundingBox())!;
      expect(r.width, `button ${i} width`).toBeGreaterThanOrEqual(43.5);
      expect(r.height, `button ${i} height`).toBeGreaterThanOrEqual(43.5);
      expect(await b.getAttribute('aria-label')).toBeTruthy();
      expect((await b.innerText()).trim()).toBe('');
    }
    // the sidebar is the sheet's: its one aside is inside the dialog, none beside the drawing
    const sheet = page.getByRole('dialog', { name: 'Board panels' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('complementary', { name: 'Board panels' })).toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'Board panels' })).toHaveCount(1);

    // the name is a tooltip, with the key
    await entry(page, 'Rails').hover();
    await expect(
      page.locator('[role=presentation][aria-hidden=true]').filter({ hasText: 'Rails' }),
    ).toContainText('5');

    // the board and the drawing are stacked, and the keys work as on a desktop
    await page.keyboard.press('3');
    expect(await currentStep(page)).toEqual(['Deck']);
    const board = (await board3d(page).boundingBox())!;
    const drawn = (await page.locator('canvas').last().boundingBox())!;
    expect(drawn.y).toBeGreaterThan(board.y + board.height - 1);

    // a panel entry is a request to see the sheet
    await expect(page.getByRole('button', { name: 'Show board panels' })).toBeVisible();
    await entry(page, 'Specs').click();
    await expect(page.getByRole('button', { name: 'Hide board panels' })).toBeVisible();
  });

  test('keeps the board mounted through a change of layout, and the view tabs return on a phone', async ({
    page,
  }) => {
    await open(page, 1280, 800);
    await entry(page, 'Rails').click();
    const canvas = board3d(page);
    await canvas.evaluate((el) => ((el as HTMLElement).dataset.keep = 'same'));

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(list(page)).toBeVisible();
    await expect(board3d(page)).toHaveAttribute('data-keep', 'same');
    expect(await currentStep(page)).toEqual(['Rails']);

    // a phone keeps today's layout: the tabs, the sheet, no list
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('group', { name: 'Views' })).toBeVisible();
    await expect(list(page)).toHaveCount(0);

    // and wide again: the workspace is back on the step it had
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Views' })).toHaveCount(0);
    expect(await currentStep(page)).toEqual(['Rails']);
  });
});
