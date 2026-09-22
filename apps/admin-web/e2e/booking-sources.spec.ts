import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * Where a booking came through: the list a property keeps, and the booking
 * form offering it. Serial: the second test relies on the first having added
 * the usual OTAs.
 */
test.describe.configure({ mode: 'serial' });

test.describe('booking sources', () => {
  test('adds the usual OTAs, then an agent of its own', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/booking-sources`);

    await page.getByRole('button', { name: 'Add the usual OTAs' }).click();
    await expect(page.getByRole('row', { name: /Agoda/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Booking\.com/ })).toBeVisible();

    await page.getByRole('button', { name: 'Add booking source' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add booking source' });
    await dialog.getByLabel('Name').fill('Bangkok Tours');
    await dialog.getByLabel('Kind').selectOption('TRAVEL_AGENT');
    await dialog.getByRole('button', { name: 'Save' }).click();

    const row = page.getByRole('row', { name: /Bangkok Tours/ });
    await expect(row).toContainText('Travel agent');

    // Retiring keeps the row — bookings point at it — but takes it off the form.
    await row.getByRole('button', { name: 'Retire' }).click();
    await expect(row).toContainText('Retired');
    await row.getByRole('button', { name: 'Reinstate' }).click();
    await expect(row).toContainText('In use');
  });

  test('a hand-keyed OTA booking says which OTA, and the list shows it', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);

    await page.getByLabel('Check-in').fill('2030-04-02');
    await page.getByLabel('Check-out').fill('2030-04-04');
    await page.getByLabel('Name', { exact: true }).fill('Agoda Guest');

    // One select, three groups: plain categories, OTAs, agents.
    const source = page.getByLabel('Booked through');
    await expect(source.locator('optgroup[label="OTA"] option', { hasText: 'Agoda' })).toHaveCount(
      1,
    );
    await expect(
      source.locator('optgroup[label="Travel agents"] option', { hasText: 'Bangkok Tours' }),
    ).toHaveCount(1);
    await source.selectOption({ label: 'Agoda' });
    await page.getByRole('button', { name: 'Create booking' }).click();

    await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);
    await expect(page.getByText('OTA · Agoda')).toBeVisible();

    await page.goto(`/properties/${data.propertyId}/reservations?source=OTA`);
    const row = page.locator('tbody tr').filter({ hasText: 'Agoda Guest' });
    await expect(row).toContainText('Agoda');
    // The filter narrowed the list to OTA bookings only.
    await expect(page.locator('tbody tr').filter({ hasText: 'Ploy Wattana' })).toHaveCount(0);
  });
});
