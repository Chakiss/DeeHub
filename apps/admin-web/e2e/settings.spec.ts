import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/** A 1×1 transparent PNG — enough to be a real image the bucket can serve back. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * The hotel's own description of itself — what the booking page and Google
 * read. The rule worth a browser test is the coordinate pairing: a latitude
 * saved alone would put the hotel on the prime meridian, so the form refuses
 * before the API does.
 */
test.describe('property settings', () => {
  test('saves the address, coordinates and description', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/settings`);

    await expect(page.getByRole('heading', { name: 'Property settings' })).toBeVisible();

    await page.getByLabel('Address line 1').fill('60/11 Huai Yai');
    await page.getByLabel('City / district').fill('Bang Lamung');
    await page.getByLabel('Latitude').fill('12.9236');
    await page.getByLabel('Longitude').fill('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Give both latitude and longitude')).toBeVisible();

    await page.getByLabel('Longitude').fill('100.8825');
    await page.getByLabel('Description (English)').fill('A quiet resort near Huai Yai.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await page.reload();
    await expect(page.getByLabel('City / district')).toHaveValue('Bang Lamung');
    await expect(page.getByLabel('Latitude')).toHaveValue('12.9236');
    await expect(page.getByRole('link', { name: 'Check the pin on Google Maps' })).toBeVisible();
  });

  test('uploads a photo straight to the bucket and shows it as the cover', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/settings`);

    // The API says whether a store is configured; without one the page
    // explains instead of offering a button, and there is nothing to test.
    const input = page.getByLabel('Add photos: Hotel photos');
    if ((await input.count()) === 0) {
      await expect(page.getByText('Photo storage is not configured')).toBeVisible();
      test.skip(true, 'no object store in this environment');
      return;
    }

    await input.setInputFiles({
      name: 'lobby.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG, 'base64'),
    });

    const cover = page.locator('img[alt=""]').first();
    await expect(cover).toBeVisible();
    // Loaded from the bucket, not a broken link: the browser decoded pixels.
    await expect
      .poll(async () => cover.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByText('Cover')).toBeVisible();

    await cover.hover();
    await page.getByRole('button', { name: /Remove: Hotel photos 1/ }).click();
    await expect(page.getByText('No photos yet.').first()).toBeVisible();
  });

  test('a rate plan can be kept off the booking page', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/rate-plans`);

    await page.getByRole('button', { name: 'Add rate plan' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Code').fill('DESK1');
    await dialog.getByLabel('Name', { exact: true }).fill('Walk-in special');
    await dialog.getByLabel('Sell online').uncheck();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const row = page.getByRole('row', { name: /Walk-in special/ });
    await expect(row).toContainText('Desk only');
  });
});
