import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * The chrome every screen sits inside.
 *
 * These exist because the header overflowed a phone viewport by ~108px on EVERY
 * page in the dashboard, which is exactly why no individual page looked
 * responsible for it and nobody found it by opening one. A shared shell needs
 * its own test or its faults get attributed to whatever screen you happen to
 * be looking at.
 */

test.describe.configure({ mode: 'serial' });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

function overflowOf(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('app shell', () => {
  test('no page scrolls sideways on a phone', async ({ page }) => {
    const data = testData();
    await page.setViewportSize(PHONE);
    await login(page, data.ownerEmail);

    // Both shells: the property layout and the organization one, which carry
    // separate copies of the same header.
    for (const path of [
      `/properties/${data.propertyId}/inventory`,
      `/properties/${data.propertyId}/reservations`,
      `/properties/${data.propertyId}/reports`,
      `/properties/${data.propertyId}/accounting`,
      '/team',
      '/account',
    ]) {
      await page.goto(path);
      expect(await overflowOf(page), `horizontal overflow on ${path}`).toBe(0);
    }
  });

  /**
   * The constraint the fix had to respect. On a phone this link is the only
   * route to /account, where a handed-out password gets changed — hiding it to
   * save width is what stranded the pilot's first real user (2bca487), and it
   * is the obvious wrong way to stop a header overflowing.
   */
  test('keeps the account link reachable at phone width', async ({ page }) => {
    const data = testData();
    await page.setViewportSize(PHONE);
    await login(page, data.ownerEmail);

    for (const path of [`/properties/${data.propertyId}/inventory`, '/team']) {
      await page.goto(path);
      const account = page.getByRole('link', { name: data.ownerEmail });
      await expect(account).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    }

    await page.getByRole('link', { name: data.ownerEmail }).click();
    await page.waitForURL(/\/account$/);
  });

  test('still puts the header on one row on a desktop', async ({ page }) => {
    const data = testData();
    await page.setViewportSize(DESKTOP);
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/inventory`);

    // Vertical centres rather than tops: the bar is `items-center`, so items of
    // different heights sit at different tops while sharing a row.
    const centres = await page.evaluate(() => {
      const bar = document.querySelector('header > div');
      return [...(bar?.children ?? [])].map((el) => {
        const box = el.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      });
    });

    expect(centres.length).toBeGreaterThan(1);
    expect(new Set(centres).size).toBe(1);
  });
});
