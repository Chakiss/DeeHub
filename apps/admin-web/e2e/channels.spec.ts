import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * Channel administration through the browser.
 *
 * The rule worth covering end to end is the one that prevents a silent
 * oversell: a channel cannot go live while any room type is unmapped, because
 * an active channel with a gap does not fail — it just stops pushing that room
 * type, and the OTA carries on selling numbers nobody updates.
 *
 * The fixture property has two active room types and only one is mapped below,
 * which is exactly the trap.
 */

test.describe('channels', () => {
  test('creates a channel that starts inactive and unmapped', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    // Only ADMIN and above may create; the fixture manager cannot, so this uses
    // the organization owner.
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);

    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Mock OTA connection');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);
    await expect(page.getByText('inactive')).toBeVisible();
    await expect(page.getByText('Map every room type before activating.').first()).toBeVisible();
  });

  test('refuses a channel type no connector implements', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);

    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByLabel('Type').selectOption('AGODA');
    await page.getByLabel('Name', { exact: true }).fill('Agoda');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // The message names which types actually work; rewording it would hide that.
    await expect(page.getByText(/No connector is implemented for AGODA/)).toBeVisible();
  });

  test('blocks activation until every room type is mapped, then allows it', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);

    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Mapping test');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);

    // Activation is not even offered while a room type is unmapped.
    await expect(page.getByRole('button', { name: 'Activate' })).toBeDisabled();

    const mappingCard = page.locator('section', { hasText: 'Room type mapping' });
    // One of two. The Standard Twin is deliberately left alone.
    await mappingCard
      .locator('li', { hasText: 'Deluxe Double' })
      .getByPlaceholder('OTA id')
      .fill('EXT-DLX');
    await page.getByRole('button', { name: 'Save mapping' }).click();

    await expect(page.getByText('Standard Twin')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate' })).toBeDisabled();

    // Now the second one, and activation becomes possible.
    await mappingCard
      .locator('li', { hasText: 'Standard Twin' })
      .getByPlaceholder('OTA id')
      .fill('EXT-STD');
    await page.getByRole('button', { name: 'Save mapping' }).click();

    const activate = page.getByRole('button', { name: 'Activate' });
    await expect(activate).toBeEnabled();
    await activate.click();

    await expect(page.getByText('active', { exact: true })).toBeVisible();
  });

  /**
   * Credentials are write-only. There is no field that loads a stored value
   * back, and the list only says whether any exist.
   */
  test('never shows a stored credential back', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);

    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Credential test');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);

    await page.getByPlaceholder('Key').fill('apiKey');
    await page.getByPlaceholder('Value').fill('never-show-me-again');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.reload();
    await expect(page.getByPlaceholder('Value')).toHaveValue('');
    expect(await page.content()).not.toContain('never-show-me-again');

    await page.goto(`/properties/${data.propertyId}/channels`);
    await expect(page.getByRole('row', { name: /Credential test/ })).toContainText('Stored');
  });

  test('a manager can read channels but not create one', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);

    await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible();
    // channel:create is ADMIN and above.
    await expect(page.getByRole('button', { name: 'Add channel' })).toHaveCount(0);
  });

  /**
   * The two buttons that talk to the OTA rather than to us.
   *
   * The fixture channel points at a mock endpoint that is not running, so both
   * come back refused — which is the interesting case: the screen has to tell a
   * failed CONVERSATION apart from a failed REQUEST, because they send somebody
   * to look at completely different things.
   */
  test('reports a channel it cannot reach without looking like a broken page', async ({ page }) => {
    const data = testData();
    // Only ADMIN and above may create a channel; the fixture manager cannot.
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);
    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByLabel('Name', { exact: true }).fill(`Reach ${Date.now().toString(36)}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Test connection' }).click();

    // A status, not an alert: the request worked and the answer was no.
    await expect(page.getByRole('status')).toContainText('did not accept us');
  });

  test('offers no push until the channel is actually selling', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.goto(`/properties/${data.propertyId}/channels`);
    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByLabel('Name', { exact: true }).fill(`Push ${Date.now().toString(36)}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);

    // Pushing to an inactive channel would make an OTA start selling rooms the
    // hotel deliberately took off it.
    await expect(page.getByRole('button', { name: 'Push everything now' })).toBeDisabled();
  });
});
