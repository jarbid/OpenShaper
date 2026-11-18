// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import {
  badge,
  entry,
  openFunboard,
  rebuilt,
  savedText,
  seedSwitches,
  trackErrors,
  updates,
} from './workspace-helpers';

/**
 * The Rails step of the workspace on the Funboard template: the rail map's zones and blends, a zone added, a
 * rail picked from the menu, a dial moved, a zone's end dragged, undo, and the board saved and reopened with
 * its zones. The 3D model is rebuilt after each edit and nothing logs an error.
 *
 * The Funboard arrives as a rails board with a rail at each of its five stations: five zones of no length
 * and four blends between them.
 */
test.describe('the Rails step', () => {
  test.setTimeout(240_000);

  test('add a zone, pick a rail, move a dial, drag an end, undo, save and reopen', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await seedSwitches(page);
    await openFunboard(page);
    await entry(page, 'Rails').click();
    await expect(entry(page, 'Rails')).toHaveAttribute('aria-current', 'step');

    const map = page.getByRole('toolbar', { name: 'Rail zones and blends' });
    const panel = page.getByRole('region', { name: 'Rail panel' });
    const stops = map.getByRole('button', { name: /^(Zone|Blend) \d/ });
    await expect(map).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Tap a rail zone on the board or the strip to choose it.');
    // five zones and the four blends between them, in board order
    await expect(stops).toHaveCount(9);
    await expect(stops.first()).toHaveAttribute('aria-label', /^Zone 1: /);
    await expect(stops.nth(1)).toHaveAttribute('aria-label', /^Blend 1: /);

    // a zone added: point at the second blend and click the +
    let n = await updates(page);
    const blend = await map.getByRole('button', { name: /^Blend 2:/ }).boundingBox();
    expect(blend).not.toBeNull();
    await page.mouse.move(blend!.x + blend!.width / 2, blend!.y + blend!.height / 2);
    await page.getByRole('button', { name: 'Add a zone here' }).click();
    await expect(stops).toHaveCount(11);
    await rebuilt(page, n);
    n = await updates(page);
    // the new zone is chosen, between zone 2 and the zone that was 3
    await expect(panel.getByRole('heading', { name: /Zone 3/ })).toBeVisible();

    // a rail from the menu names it
    await panel.getByRole('combobox', { name: 'Rail' }).selectOption({ label: 'Tucked' });
    await expect(map.getByRole('button', { name: /^Zone 3: Tucked,/ })).toBeVisible();
    await rebuilt(page, n);
    n = await updates(page);

    // a dial moved with the keyboard: the number follows, and the rail is Custom again
    const apex = panel.getByRole('slider', { name: 'Apex' });
    await apex.focus();
    const before = await panel.getByRole('textbox', { name: 'Apex number' }).inputValue();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect(panel.getByRole('textbox', { name: 'Apex number' })).not.toHaveValue(before);
    await expect(panel.getByRole('combobox', { name: 'Rail' })).toHaveValue('custom');
    await rebuilt(page, n);
    n = await updates(page);

    // a zone's end dragged: the new zone is a tick, drawn out with the grip beside it
    await expect(map.getByRole('slider', { name: 'End of zone 3' })).toHaveCount(0);
    const grip = map.getByRole('slider', { name: 'Draw out zone 3' });
    await expect(grip).toBeVisible();
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(g.x + g.width / 2 + i * 8, g.y + g.height / 2);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    const start = Number(await map.getByRole('slider', { name: 'Start of zone 3' }).getAttribute('aria-valuenow')); // prettier-ignore
    const end = map.getByRole('slider', { name: 'End of zone 3' });
    await expect(end).toBeVisible();
    expect(Number(await end.getAttribute('aria-valuenow'))).toBeGreaterThan(start + 20);
    await rebuilt(page, n);
    n = await updates(page);

    // undo steps the drag back: a tick again
    await page.mouse.click(1, 1);
    await page.keyboard.press('Control+z');
    await expect(map.getByRole('slider', { name: 'End of zone 3' })).toHaveCount(0);
    await rebuilt(page, n);
    // and redo brings it back
    await page.keyboard.press('Control+Shift+z');
    await expect(map.getByRole('slider', { name: 'End of zone 3' })).toBeVisible();

    // save, reopen: the zones come back, and the text is the same
    const saved = await savedText(page);
    const doc = JSON.parse(saved) as { model: string; rails: { plus: { x: number }[] } };
    expect(doc.model).toBe('rails');
    expect(doc.rails.plus.length).toBeGreaterThanOrEqual(7);
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'rails.board',
        mimeType: 'application/json',
        buffer: Buffer.from(saved),
      });
    await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 30_000 });
    await entry(page, 'Rails').click();
    await expect(stops).toHaveCount(11);
    await expect(map.getByRole('button', { name: /^Zone 3: Custom/ })).toBeVisible();
    expect(await savedText(page)).toBe(saved);

    expect(errors).toEqual([]);
  });
});
