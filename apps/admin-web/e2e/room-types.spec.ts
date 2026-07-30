import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * Room type setup through the browser.
 *
 * These mutate shared configuration for the run's property, so they run in
 * order against codes unique to each case.
 */
test.describe.configure({ mode: 'serial' });

test.describe('room types', () => {
  test('creates a room type and shows it in the list', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/room-types`);
    await page.getByRole('button', { name: 'Add room type' }).click();

    await page.getByLabel('Code').fill('e2e-fam');
    await page.getByLabel('Name', { exact: true }).fill('Family Suite');
    await page.getByLabel('Maximum').fill('4');
    await page.getByLabel('Max adults').fill('4');

    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.getByRole('row', { name: /Family Suite/ });
    await expect(row).toBeVisible();
    // Normalised on the server, so the list must show the stored form.
    await expect(row).toContainText('E2E-FAM');
  });

  test('refuses a duplicate code with a message naming the cause', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/room-types`);
    await page.getByRole('button', { name: 'Add room type' }).click();
    await page.getByLabel('Code').fill('E2E-FAM');
    await page.getByLabel('Name', { exact: true }).fill('Another Family');
    await page.getByRole('button', { name: 'Save' }).click();

    // A conflict has one cause here, so the UI says which field to change
    // rather than echoing a constraint name.
    await expect(page.locator('form').getByRole('alert')).toContainText(/code is already used/i);
  });

  test('rejects an occupancy combination that cannot hold together', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/room-types`);
    await page.getByRole('button', { name: 'Add room type' }).click();
    await page.getByLabel('Code').fill('E2E-BAD');
    await page.getByLabel('Name', { exact: true }).fill('Impossible Room');
    await page.getByLabel('Maximum').fill('2');
    await page.getByLabel('Max adults').fill('5');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.locator('form').getByRole('alert')).toContainText(/max adults/i);
  });

  test('the code cannot be changed once the room type exists', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/room-types`);
    await page
      .getByRole('row', { name: /Family Suite/ })
      .getByRole('button', { name: 'Edit' })
      .click();

    // OTA mappings and imports refer to it; editing it would repoint them at a
    // different room with no error anywhere.
    await expect(page.getByLabel('Code')).toBeDisabled();
  });

  test('stops and resumes selling instead of deleting', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/room-types`);
    const row = page.getByRole('row', { name: /Family Suite/ });

    // There is deliberately no delete control anywhere on the page.
    await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

    await row.getByRole('button', { name: 'Stop selling' }).click();
    await expect(row).toContainText('Not selling');

    await row.getByRole('button', { name: 'Resume selling' }).click();
    await expect(row).toContainText('Selling');
  });

  test('a read-only user gets no editing controls', async ({ page }) => {
    const data = testData();
    await login(page, data.frontDeskEmail);

    await page.goto(`/properties/${data.propertyId}/room-types`);
    await expect(page.getByRole('row', { name: /Family Suite/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add room type' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop selling' })).toHaveCount(0);
  });
});
