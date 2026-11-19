import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { editorReady } from './helpers';
import {
  badge,
  board3d,
  chooseLook,
  currentStep,
  divider,
  entry,
  list,
  lookButton,
  menu,
  openFunboard,
  PANELS,
  seedSwitches,
  selectPoint,
  showButton,
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
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');

    await entry(page, 'Rails').click();
    await chooseLook(page, 'Glassed gloss');
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(list(page)).toBeVisible({ timeout: 60_000 });
    expect(await currentStep(page)).toEqual(['Rails']);
    // the choice of a realistic look (no analysis) is not put back to Patches
    await expect(lookButton(page)).toHaveAttribute('data-look', 'gloss');
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
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');
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
    // the Rails step shows the rail map, and the tap is its choice too: the panel names the zone or blend tapped
    await expect(page.getByRole('toolbar', { name: 'Rail zones and blends' })).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Rail panel' })
        .getByRole('heading', { name: /(Zone|Blend) \d/ }),
    ).toBeVisible();

    // the patch stays lit (the readout still names it), and a tap on nothing clears it and changes no step.
    // Empty canvas at the top left: the bottom left is the Patches key, and the status line there takes no pointer.
    await entry(page, 'Fins').click();
    await page.mouse.click(box.x + 40, box.y + 40);
    await expect(readout).not.toHaveAttribute('data-patch', /.+/);
    expect(await currentStep(page)).toEqual(['Fins']);
  });
});

/** A hash of the middle of the board's canvas: clear of the key, the legend and the status line at its edges. */
async function middleOfBoard(page: Page) {
  const box = (await board3d(page).boundingBox())!;
  return {
    x: box.x + box.width * 0.3,
    y: box.y + box.height * 0.3,
    width: box.width * 0.4,
    height: box.height * 0.4,
  };
}
type Clip = { x: number; y: number; width: number; height: number };
const hashOf = async (page: Page, clip: Clip) =>
  createHash('sha256')
    .update(await page.screenshot({ clip }))
    .digest('hex');
/** A hash of the clip once the board has stopped changing: two shots in a row alike. */
async function settledHash(page: Page, clip: Clip): Promise<string> {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await hashOf(page, clip);
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(500);
  }
  throw new Error('the board kept changing');
}

test.describe('the Look and Show controls', () => {
  test.setTimeout(180_000);

  test('are one Look button and Show over the board, with none of the old toolbar and none of the engine chips', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page);
    await openFunboard(page);
    await expect(lookButton(page)).toBeVisible();
    await expect(showButton(page)).toBeVisible();
    for (const name of ['Shaded', '+Wire', 'Wire', 'Normals', 'Stringer', 'Sections', 'Apex']) {
      await expect(page.getByRole('button', { name, exact: true }), name).toHaveCount(0);
    }
    for (const title of [/^Surface analysis/, 'Lighting', 'Mesh quality']) {
      await expect(page.getByTitle(title, { exact: typeof title === 'string' })).toHaveCount(0);
    }
    // the engine chips are gone: no toggle, no test board, no label
    await expect(page.getByRole('button', { name: 'Classic', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'NURBS', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('nurbs-test-board')).toHaveCount(0);
    await expect(page.getByText('Test board')).toHaveCount(0);
    await expect(page.getByText('Showing the NURBS surface')).toHaveCount(0);
    // the badge is still in the page for the scripts that read it, out of sight and of the accessibility tree
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails');
    await expect(badge(page)).toHaveAttribute('data-showing', 'nurbs');
    await expect(badge(page)).toHaveAttribute('aria-hidden', 'true');
    expect(await badge(page).boundingBox()).toMatchObject({ width: 1, height: 1 });
    await expect(page.getByTestId('nurbs-layer')).toBeAttached();
    // one line says what a tap does, over the empty top left of the board, and takes no pointer
    const readout = page.getByTestId('patch-readout');
    await expect(readout).toHaveText('Tap the board to choose a patch');
    const at = (await readout.boundingBox())!;
    const canvas = (await board3d(page).boundingBox())!;
    expect(at.x - canvas.x).toBeLessThan(24);
    expect(at.y - canvas.y).toBeLessThan(24);
    expect(
      await readout.evaluate(
        (el) => getComputedStyle(el.closest('[data-testid=nurbs-layer]')!).pointerEvents,
      ),
    ).toBe('none');
    expect(errors).toEqual([]);
  });

  test('Look has the three groups, choosing Zebra repaints the board, and Patches brings it back', async ({
    page,
  }) => {
    await seedSwitches(page);
    await openFunboard(page);
    const middle = await middleOfBoard(page);
    const patches = await settledHash(page, middle);

    await lookButton(page).click();
    const look = page.getByRole('menu', { name: 'Look' });
    await expect(look).toBeVisible();
    for (const group of ['Shaping', 'Surface', 'Realistic']) {
      await expect(look.getByRole('group', { name: group, exact: true })).toBeVisible();
    }
    await expect(look.getByRole('menuitemradio', { name: 'Patches' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // the light and the board colour are in the Realistic group
    await expect(look.getByRole('group', { name: 'Light' })).toBeVisible();
    await expect(look.getByRole('menuitem', { name: 'Board colour' })).toBeVisible();
    await look.getByRole('menuitemradio', { name: 'Zebra' }).click();
    await expect(look).toHaveCount(0);
    await expect(lookButton(page)).toHaveAttribute('data-look', 'zebra');
    await expect.poll(() => hashOf(page, middle), { timeout: 20_000 }).not.toBe(patches);

    await chooseLook(page, 'Patches');
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');
    await expect.poll(() => hashOf(page, middle), { timeout: 20_000 }).toBe(patches);
  });

  test('Show turns the stringer on and off over the look', async ({ page }) => {
    await seedSwitches(page);
    await openFunboard(page);
    const middle = await middleOfBoard(page);
    const plain = await settledHash(page, middle);

    await showButton(page).click();
    const show = page.getByRole('menu', { name: 'Show' });
    for (const group of ['Guides', 'Mesh quality']) {
      await expect(show.getByRole('group', { name: group })).toBeVisible();
    }
    const stringer = show.getByRole('menuitemcheckbox', { name: 'Stringer' });
    await stringer.click();
    // a switch leaves the menu open
    await expect(stringer).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(show).toHaveCount(0);
    // the line is drawn over the Patches look
    await expect.poll(() => hashOf(page, middle), { timeout: 20_000 }).not.toBe(plain);

    // and off again: the board is repainted without the line, as it was before it was drawn
    await showButton(page).click();
    await stringer.click();
    await expect(stringer).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect.poll(() => hashOf(page, middle), { timeout: 20_000 }).toBe(plain);
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => JSON.parse(localStorage.getItem('bs.viewState') ?? '{}').view3d?.showStringer,
          ),
        { timeout: 10_000 },
      )
      .toBe(false);
  });

  test('are kept by the keyboard: Enter opens Look, the arrows move, Escape closes and focus returns, Tab leaves', async ({
    page,
  }) => {
    await seedSwitches(page);
    await openFunboard(page);
    expect(await currentStep(page)).toEqual(['Outline']);

    await lookButton(page).focus();
    await page.keyboard.press('Enter');
    const look = page.getByRole('menu', { name: 'Look' });
    await expect(look).toBeVisible();
    // focus goes in, to the look on screen
    await expect(look.getByRole('menuitemradio', { name: 'Patches' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(look.getByRole('menuitemradio', { name: 'Zebra' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(look.getByRole('menuitem', { name: 'Board colour' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(look.getByRole('menuitemradio', { name: 'Patches' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(look.getByRole('menuitem', { name: 'Board colour' })).toBeFocused();
    // a digit is not a design step while the menu has the keys
    await page.keyboard.press('3');
    expect(await currentStep(page)).toEqual(['Outline']);
    await page.keyboard.press('Escape');
    await expect(look).toHaveCount(0);
    await expect(lookButton(page)).toBeFocused();
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');

    // Enter on a row chooses it, closes the menu and gives focus back
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(look).toHaveCount(0);
    await expect(lookButton(page)).toHaveAttribute('data-look', 'zebra');
    await expect(lookButton(page)).toBeFocused();

    // Tab leaves an open menu, and goes on from its button to the next control
    await page.keyboard.press('Enter');
    await expect(look).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(look).toHaveCount(0);
    await expect(showButton(page)).toBeFocused();

    // Show is the same
    await page.keyboard.press('Enter');
    const show = page.getByRole('menu', { name: 'Show' });
    await expect(show.getByRole('menuitemcheckbox', { name: 'Stringer' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(show.getByRole('menuitemcheckbox', { name: 'Stringer' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(show).toHaveCount(0);
    await expect(showButton(page)).toBeFocused();
  });

  test('close on a press outside and give focus back to their own button', async ({ page }) => {
    await seedSwitches(page);
    await openFunboard(page);
    const canvas = (await board3d(page).boundingBox())!;
    for (const [button, name] of [
      [lookButton(page), 'Look'],
      [showButton(page), 'Show'],
    ] as const) {
      await button.click();
      const open = page.getByRole('menu', { name });
      await expect(open).toBeVisible();
      // the press goes to the empty left of the board, not to anything with focus of its own
      await page.mouse.click(canvas.x + canvas.width * 0.08, canvas.y + canvas.height * 0.5);
      await expect(open).toHaveCount(0);
      await expect(button, name).toBeFocused();
      // and the button still opens it again
      await button.click();
      await expect(open).toBeVisible();
      await button.click();
      await expect(open).toHaveCount(0);
    }
  });

  test('ignore a Classic choice made in the tabbed layout, which that layout still keeps', async ({
    page,
  }) => {
    // the NURBS engine alone: the tabbed layout, with its engine chips over the 3D pane
    await page.addInitScript(() => {
      if (localStorage.getItem('bs.settings')) return;
      localStorage.setItem('bs.settings', JSON.stringify({ version: 2, nurbsEngine: true }));
    });
    await page.goto('/app');
    await editorReady(page);
    await expect(badge(page)).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    await expect(badge(page)).toHaveAttribute('data-showing', 'classic');

    // then the rails engine, through Settings, and a rails board: the workspace opens
    await menu(page, 'Edit').click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await page.getByLabel('Rails engine (experimental)').check();
    await page.getByRole('button', { name: 'Apply' }).click();
    await menu(page, 'File').click();
    await page.getByRole('menuitem', { name: 'Funboard', exact: true }).click();
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 60_000 });
    await expect(list(page)).toBeVisible();

    // the workspace shows the surface of the person's own board, and Patches needs it
    await expect(badge(page)).toHaveAttribute('data-showing', 'nurbs');
    await expect(lookButton(page)).toHaveAttribute('data-look', 'patches');
    await expect(page.getByTestId('patch-readout')).toBeVisible();

    // back in the tabbed layout (a phone keeps it) the choice is still in force: it was not erased
    await page.setViewportSize({ width: 390, height: 844 });
    const tabs = page.getByRole('group', { name: 'Views' });
    await expect(tabs).toBeVisible();
    await tabs.getByRole('button', { name: '3D', exact: true }).click();
    await expect(badge(page)).toHaveAttribute('data-showing', 'classic');
  });
});

test.describe('the Look and Show controls under a coarse pointer', () => {
  test.use({ viewport: { width: 1023, height: 768 }, hasTouch: true, isMobile: true });
  test.setTimeout(180_000);

  test('have 44px targets: the buttons and every row of both menus', async ({ page }) => {
    await seedSwitches(page);
    await openFunboard(page);
    for (const button of [lookButton(page), showButton(page)]) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.width).toBeGreaterThanOrEqual(43.5);
    }
    for (const [button, name] of [
      [lookButton(page), 'Look'],
      [showButton(page), 'Show'],
    ] as const) {
      await button.tap();
      const rows = page.getByRole('menu', { name }).locator('[role^=menuitem]');
      const count = await rows.count();
      expect(count).toBeGreaterThan(5);
      for (let i = 0; i < count; i++) {
        const box = (await rows.nth(i).boundingBox())!;
        expect(box.height, `${name} row ${i}`).toBeGreaterThanOrEqual(43.5);
      }
      await page.keyboard.press('Escape');
    }
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
