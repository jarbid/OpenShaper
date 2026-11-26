// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Locator, type Page } from '@playwright/test';
import { board3d, entry, menu, openFunboard, seedSwitches, trackErrors } from './workspace-helpers';

/**
 * The Tail step of the workspace on the Funboard template: the tail named in the panel and chosen from its picker (the 3D
 * board changes), the tail width typed and set by its handle and by a key, a round handle on each corner dragged and
 * stepped (the radius changes, one undo step), a point of the outline dragged (the panel reads Custom), undo, and a tap
 * on a corner of the 3D board choosing that corner.
 *
 * The Funboard draws its tail as one curve from the tail point, which reads as a Round.
 */
/** Storage seeded before the page loads: centimetres to read numbers in, and the consent banner answered. */
const QUIET = { 'bs.lengthUnit': 'cm', 'bs.consent': 'rejected' };

test.describe('the Tail step', () => {
  test.setTimeout(240_000);

  const panel = (page: Page) => page.getByRole('region', { name: 'Tail panel' });
  const shapeButton = (page: Page, name: string) => page.getByTestId(`tail-shape-${name}`);
  const widthField = (page: Page) =>
    panel(page).getByRole('textbox', { name: 'Tail width number' });
  const heading = (page: Page) => page.getByTestId('tail-shape-name');
  const radiusHandle = (page: Page, key = 'plus:0:1') =>
    page.getByTestId(`tail-radius-handle-${key}`);
  const widthHandle = (page: Page, key = ':1') => page.getByTestId(`tail-width-handle-plus${key}`);
  const openMore = async (page: Page) => {
    const more = panel(page).getByRole('button', { name: /More/ });
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  };
  const row = (page: Page, side = 'plus', index = 0) =>
    page.getByTestId(`tail-corner-${side}-${index}`);
  /** The radius, cm, a corner's row in the panel shows. */
  const radiusOf = async (page: Page, side = 'plus', index = 0): Promise<number> =>
    Number(
      /([\d.]+) cm/.exec(
        (await row(page, side, index).getByRole('button').first().textContent()) ?? '',
      )![1],
    );
  const undo = async (page: Page) => {
    await page.mouse.click(1, 1);
    await page.keyboard.press('Control+z');
  };
  const centre = async (target: Locator) => {
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const snapshot = (page: Page) => board3d(page).screenshot();
  const changesFrom = async (page: Page, before: Buffer) =>
    expect.poll(async () => !(await snapshot(page)).equals(before), { timeout: 20_000 }).toBe(true);

  test.beforeEach(async ({ page }) => {
    await seedSwitches(page, QUIET);
    await openFunboard(page);
    await entry(page, 'Tail').click();
    await expect(entry(page, 'Tail')).toHaveAttribute('aria-current', 'step');
    await expect(panel(page)).toBeVisible();
  });

  test('names the tail, and choosing a shape changes the 3D board; undo brings the tail back', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    // the Funboard draws one curve from the tail point: a Round, with no corner to round
    await expect(heading(page)).toHaveText('Round');
    await expect(shapeButton(page, 'round')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByRole('slider', { name: 'Notch depth' })).toBeDisabled();
    await expect(panel(page)).toContainText('A round tail has no notch');
    await expect(page.getByRole('heading', { name: 'Outline: tail' })).toBeVisible();

    const round = await snapshot(page);
    await shapeButton(page, 'swallow').click();
    await expect(heading(page)).toHaveText('Swallow');
    await changesFrom(page, round);
    await expect(panel(page).getByRole('slider', { name: 'Notch depth' })).toBeEnabled();
    // a corner on each tip, and one on the crotch, each with its handle
    await expect(radiusHandle(page, 'plus:0:1')).toBeVisible();
    await expect(radiusHandle(page, 'plus:0:-1')).toBeVisible();
    await expect(radiusHandle(page, 'tail:0:1')).toBeVisible();

    await undo(page);
    await expect(heading(page)).toHaveText('Round');
    await changesFrom(page, await snapshot(page).then(() => Buffer.alloc(0)));
    expect(errors).toEqual([]);
  });

  test('a width typed, set by its handle and by a key: the 3D board follows, one undo step each', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await shapeButton(page, 'squash').click();
    await expect(heading(page)).toHaveText('Squash');
    const was = Number(await widthField(page).inputValue());
    const before = await snapshot(page);
    await widthField(page).fill('20');
    await widthField(page).press('Enter');
    await expect(widthField(page)).toHaveValue('20.00');
    await changesFrom(page, before);

    // its handle, on the drawing: drag it outward across the board
    const handle = widthHandle(page);
    const from = await centre(handle);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 25, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await widthField(page).inputValue()))
      .toBeGreaterThan(20.5);

    // a key on the handle
    const wide = Number(await widthField(page).inputValue());
    await handle.focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => Number(await widthField(page).inputValue()))
      .toBeCloseTo(wide - 0.1, 1);

    // each is one undo step: the key, the drag, the typed width, then the shape
    await undo(page);
    await expect.poll(async () => Number(await widthField(page).inputValue())).toBeCloseTo(wide, 1);
    await undo(page);
    await expect(widthField(page)).toHaveValue('20.00');
    await undo(page);
    await expect.poll(async () => Number(await widthField(page).inputValue())).not.toBe(20);
    await undo(page);
    await expect(heading(page)).toHaveText('Round');
    expect(was).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('a round handle on a corner is dragged: the radius changes, shown while dragging, one undo step', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await shapeButton(page, 'squash').click();
    await expect(radiusHandle(page)).toBeVisible();
    await openMore(page);
    const start = await radiusOf(page);
    expect(start).toBeCloseTo(0.6, 2);

    const handle = radiusHandle(page);
    await expect(handle).toHaveAttribute('aria-label', 'Tail corner radius');
    await expect(handle).toHaveAttribute('title', /^Tail corner: radius 0\.60 cm$/);
    const from = await centre(handle);
    const before = await snapshot(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // along the line from the corner into the board, which on the plan is down and to the right of a corner on the top side
    await page.mouse.move(from.x + 12, from.y + 20, { steps: 8 });
    await expect(page.getByTestId('tail-radius-readout')).toBeVisible();
    await expect(page.getByTestId('tail-radius-readout')).toContainText(/Radius \d+\.\d\d cm/);
    await page.mouse.up();
    const after = await radiusOf(page);
    expect(after).toBeGreaterThan(start + 0.3);
    await changesFrom(page, before);
    // the chosen corner is marked in the panel, and the other side's handle is the same corner
    await expect(row(page)).toHaveAttribute('aria-current', 'true');
    await expect(radiusHandle(page, 'plus:0:-1')).toHaveAttribute(
      'aria-valuetext',
      `${after.toFixed(2)} cm`,
    );

    await undo(page);
    await expect.poll(() => radiusOf(page)).toBeCloseTo(start, 2);
    expect(errors).toEqual([]);
  });

  test('a corner handle by keyboard: arrows step it, Home and End take it to its ends, a held key is one undo step', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await shapeButton(page, 'diamond').click();
    await openMore(page);
    const handle = radiusHandle(page, 'plus:0:1');
    await handle.focus();
    await expect(row(page)).toHaveAttribute('aria-current', 'true');
    const start = await radiusOf(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => radiusOf(page)).toBeCloseTo(start + 0.1, 2);
    await page.keyboard.press('Shift+ArrowUp');
    await expect.poll(() => radiusOf(page)).toBeCloseTo(start + 1.1, 2);
    await page.keyboard.press('Home');
    await expect.poll(() => radiusOf(page)).toBeCloseTo(0.05, 2);
    await page.keyboard.press('End');
    await expect.poll(() => radiusOf(page)).toBeGreaterThan(2);

    // a held key is one step: three repeats, one undo
    await page.keyboard.press('Home');
    const low = await radiusOf(page);
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowUp');
    await page.keyboard.up('ArrowUp');
    await expect.poll(() => radiusOf(page)).toBeCloseTo(low + 0.3, 2);
    await undo(page);
    await expect.poll(() => radiusOf(page)).toBeCloseTo(low, 2);
    expect(errors).toEqual([]);
  });

  test('a point of the outline dragged makes the tail Custom, the panel says so, and choosing a shape replaces it; undo restores it', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await shapeButton(page, 'squash').click();
    await expect(heading(page)).toHaveText('Squash');
    // the outline's own point at the corner is under the width handle's tether: 22 px in from the handle
    const handle = await centre(widthHandle(page));
    const knot = { x: handle.x, y: handle.y + 22 };
    await page.mouse.move(knot.x, knot.y);
    await page.mouse.down();
    await page.mouse.move(knot.x + 4, knot.y + 30, { steps: 8 });
    await page.mouse.up();
    await expect(heading(page)).toHaveText('Custom');
    await expect(panel(page)).toContainText('drawn, or moved since a shape was chosen');
    await expect(panel(page).getByRole('slider', { name: 'Tail width' })).toBeDisabled();
    await expect(panel(page)).toContainText(
      'This tail is drawn by hand, and a width would replace it.',
    );

    await shapeButton(page, 'fish').click();
    await expect(heading(page)).toHaveText('Fish');
    await expect(panel(page)).toContainText(
      'Replaced the tail’s points with Fish. Undo brings them back.',
    );
    await undo(page);
    await expect(heading(page)).toHaveText('Custom');
    expect(errors).toEqual([]);
  });

  test('a tap on a corner of the 3D board chooses that corner, and a tap on the tail end chooses the tail with no corner', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await shapeButton(page, 'squash').click();
    await openMore(page);
    // a corner with a radius a tap can land on
    const field = panel(page).getByRole('textbox', { name: 'Radius of the tail corner number' });
    await field.fill('4');
    await field.press('Enter');
    await page.waitForTimeout(2500);
    // leave the Tail step, so that the tap is what comes back to it
    const outline = entry(page, 'Outline');
    await outline.click();
    await expect(page.getByTestId('tail-handles')).toHaveCount(0);

    /** Tap the 3D board on a grid of places, until a tap has chosen the Tail step and `want` says its corner is the one. */
    const tapUntil = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      want: () => Promise<boolean>,
    ) => {
      const box = (await board3d(page).boundingBox())!;
      for (let y = from.y; y <= to.y; y += 0.006) {
        for (let x = from.x; x <= to.x; x += 0.0025) {
          await page.mouse.click(box.x + x * box.width, box.y + y * box.height);
          if ((await entry(page, 'Tail').getAttribute('aria-current')) === 'step') {
            if (await want()) return true;
          } else {
            await outline.click();
          }
          await outline.click();
        }
      }
      return false;
    };

    // the tail end stands near a fifth of the way along the board's pane and three quarters of the way down it
    const cornerChosen = async () =>
      (await row(page)
        .getAttribute('aria-current')
        .catch(() => null)) === 'true';
    expect(await tapUntil({ x: 0.2, y: 0.74 }, { x: 0.27, y: 0.8 }, cornerChosen)).toBe(true);
    await expect(entry(page, 'Tail')).toHaveAttribute('aria-current', 'step');
    await expect(row(page)).toHaveAttribute('aria-current', 'true');
    await expect(radiusHandle(page)).toHaveAttribute('data-chosen', 'true');

    // between the two corners is the tail's edge: the tail, and no corner
    await outline.click();
    const noCorner = async () =>
      (await row(page)
        .getAttribute('aria-current')
        .catch(() => null)) !== 'true';
    expect(await tapUntil({ x: 0.215, y: 0.755 }, { x: 0.24, y: 0.79 }, noCorner)).toBe(true);
    await expect(entry(page, 'Tail')).toHaveAttribute('aria-current', 'step');
    await expect(radiusHandle(page)).not.toHaveAttribute('data-chosen', 'true');
    expect(errors).toEqual([]);
  });
});

test.describe('the Tail step under a coarse pointer', () => {
  // `isMobile` is what makes `pointer-coarse` match, which grows the handles and the shape buttons to 44 px
  test.use({ viewport: { width: 1023, height: 768 }, hasTouch: true, isMobile: true });
  test.setTimeout(180_000);

  const widthHandle = (page: Page) => page.getByTestId('tail-width-handle-plus:1');
  const centre = async (target: Locator) => {
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  test('the shape buttons and both kinds of handle are 44 px targets', async ({ page }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, QUIET);
    await openFunboard(page);
    await entry(page, 'Tail').tap();
    await expect(entry(page, 'Tail')).toHaveAttribute('aria-current', 'step');
    await page.getByTestId('tail-shape-squash').tap();
    await expect(page.getByTestId('tail-shape-name')).toHaveText('Squash');
    const targets = [
      page.getByTestId('tail-shape-squash'),
      page.getByTestId('tail-shape-swallow'),
      page.getByTestId('tail-radius-handle-plus:0:1'),
      page.getByTestId('tail-width-handle-plus:1'),
    ];
    for (const target of targets) {
      await expect(target).toBeVisible();
      const box = (await target.boundingBox())!;
      expect(box.width, await target.getAttribute('data-testid')).toBeGreaterThanOrEqual(43.5);
      expect(box.height, await target.getAttribute('data-testid')).toBeGreaterThanOrEqual(43.5);
    }
    expect(errors).toEqual([]);
  });

  /**
   * What is wrong with the handles on the pane now: a handle under 44 px, outside the pane, or with its centre inside another's
   * square (a press on it would reach the other).
   */
  const faults = (page: Page) =>
    page.evaluate(() => {
      const layer = document.querySelector('[data-testid="tail-handles"]')!.getBoundingClientRect();
      const boxes = [
        ...document.querySelectorAll(
          '[data-testid^="tail-radius-handle-"], [data-testid^="tail-width-handle-"]',
        ),
      ].map((b) => ({ id: b.getAttribute('data-testid')!, r: b.getBoundingClientRect() }));
      const out: string[] = [];
      for (const { id, r } of boxes) {
        if (r.width < 43.5 || r.height < 43.5) out.push(`${id} is ${r.width}x${r.height}`);
        if (
          r.left < layer.left - 1 ||
          r.top < layer.top - 1 ||
          r.right > layer.right + 1 ||
          r.bottom > layer.bottom + 1
        ) {
          out.push(`${id} is outside the pane`);
        }
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!.r;
          const b = boxes[j]!.r;
          const dx = Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
          const dy = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
          if (dx < 22 && dy < 22) out.push(`${boxes[i]!.id} is on ${boxes[j]!.id}`);
        }
      }
      return out;
    });

  test('on the short pane of a tablet every shape has its handles inside it, none on another, and the plan keeps its scale as the width is set', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page, QUIET);
    await openFunboard(page);
    // a board with a swallow tail: the notch and its tips are the densest of the handles
    await menu(page, 'File').click();
    await page.getByRole('menuitem', { name: 'Swallow shortboard', exact: true }).click();
    await entry(page, 'Tail').click();
    await expect(entry(page, 'Tail')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('tail-handles')).toBeAttached();

    for (const shape of ['squash', 'round', 'pin', 'diamond', 'swallow', 'fish']) {
      // the panel is a strip in the sheet's peek, where the buttons scroll: the click is the button's own
      await page.getByTestId(`tail-shape-${shape}`).dispatchEvent('click');
      await expect(page.getByTestId('tail-shape-name')).toHaveText(new RegExp(`^${shape}$`, 'i'));
      // the plan is fitted to the shape in an effect after the board changes
      await expect.poll(() => faults(page), { message: shape, timeout: 15_000 }).toEqual([]);
    }

    // the width set by its handle's key: the handle moves out and the plan does not rescale (the tail line stays where it is)
    await page.getByTestId('tail-shape-squash').dispatchEvent('click');
    await expect(page.getByTestId('tail-shape-name')).toHaveText('Squash');
    const handle = widthHandle(page);
    await expect(handle).toBeVisible();
    const before = await centre(handle);
    await handle.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowUp');
    await expect.poll(async () => (await centre(handle)).y).toBeLessThan(before.y - 8);
    expect((await centre(handle)).x).toBeCloseTo(before.x, 0);
    // a width well past the shape's usual one may take the handle's square past the pane's edge, but its centre is still on the pane
    const pane = (await page.getByTestId('tail-handles').boundingBox())!;
    const now = await centre(handle);
    expect(now.y).toBeGreaterThan(pane.y);
    expect(now.y).toBeLessThan(pane.y + pane.height);
    expect(errors).toEqual([]);
  });
});
